import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { DSH_ORIGIN, DshClient, DshHttpError, exchangeLaunchUrl } from './dshClient';
import { renderMarkdown } from './markdown';

const CHAT_EDITOR_VIEW_TYPE = 'dshCompanion.chatEditor';
const COOKIE_SECRET_KEY = 'dshCompanion.developmentCookie';

interface SubmitMessage {
  readonly type: 'submit';
  readonly requestId: string;
  readonly text: string;
}

interface StopMessage {
  readonly type: 'stop';
}

interface LoadOlderMessage {
  readonly type: 'loadOlder';
}

interface SelectModelMessage {
  readonly type: 'selectModel';
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

interface CompactMessage {
  readonly type: 'compact';
}

interface OpenLinkMessage {
  readonly type: 'openLink';
  readonly href: string;
}

interface ChatEditorState {
  readonly version: 1 | 2;
  readonly sessionId?: string;
}

interface DevelopmentRuntime {
  readonly version: 1;
  readonly origin: string;
  readonly bootstrapUrl?: string;
  readonly pid: number;
  readonly startedAt: string;
}

/** Registers the DSH Companion chat editor command. */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dshCompanion.newChatEditor', () => {
      openChatEditor(context);
    }),
    vscode.window.registerWebviewPanelSerializer(CHAT_EDITOR_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state: unknown): Promise<void> {
        configureChatEditor(context, panel, isChatEditorState(state) ? state.sessionId : undefined);
      },
    }),
  );
}

/** Releases resources owned by editor-panel subscriptions. */
export function deactivate(): void {}

function openChatEditor(context: vscode.ExtensionContext): void {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel(
    CHAT_EDITOR_VIEW_TYPE,
    'DSH Chat',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    },
  );
  configureChatEditor(context, panel);
}

function configureChatEditor(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  restoredSessionId?: string,
): void {
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [mediaRoot],
  };
  panel.webview.html = editorHtml(
    panel.webview,
    vscode.Uri.joinPath(mediaRoot, 'main.js'),
    vscode.Uri.joinPath(mediaRoot, 'style.css'),
  );

  let client: DshClient | undefined;
  const ready = connect(context, panel, restoredSessionId).then((connected) => {
    client = connected;
    post(panel, { type: 'session', sessionId: connected.sessionId });
    return connected;
  });
  void ready.catch((error: unknown) => {
    post(panel, {
      type: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
  });
  const receive = panel.webview.onDidReceiveMessage((message: unknown) => {
    if (isSubmitMessage(message)) void submit(panel, ready, message.requestId, message.text);
    if (isStopMessage(message)) void stop(panel, ready);
    if (isLoadOlderMessage(message)) void loadOlder(panel, ready);
    if (isSelectModelMessage(message)) void selectModel(panel, ready, message);
    if (isCompactMessage(message)) void compact(panel, ready);
    if (isOpenLinkMessage(message)) void vscode.env.openExternal(vscode.Uri.parse(message.href));
  });
  panel.onDidDispose(() => {
    receive.dispose();
    client?.dispose();
  });
}

async function connect(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  restoredSessionId?: string,
): Promise<DshClient> {
  let cookie = await context.secrets.get(COOKIE_SECRET_KEY);
  const runtime = await readDevelopmentRuntime(context.extensionUri);
  let streamingAssistant = '';
  const sink = {
    history: (role: 'user' | 'assistant' | 'error', text: string, time?: number) => post(panel, {
      type: 'message',
      role,
      text,
      ...(role === 'assistant' ? { html: renderMarkdown(text) } : {}),
      ...(time === undefined ? {} : { time }),
    }),
    historyPrependStart: () => post(panel, { type: 'historyPrependStart' }),
    historyPrependEnd: () => post(panel, { type: 'historyPrependEnd' }),
    historyState: (hasMore: boolean) => post(panel, { type: 'historyState', hasMore }),
    modelCatalog: (catalog: import('./dshClient').DshModelCatalog) => post(panel, { type: 'modelCatalog', catalog }),
    modelSelection: (selection: import('./dshClient').DshModelSelection) => post(panel, {
      type: 'modelSelection', selection,
    }),
    contextPressure: (pressure: import('./dshClient').DshContextPressure | undefined) => post(panel, {
      type: 'contextPressure', pressure,
    }),
    compactAvailable: (value: boolean) => post(panel, { type: 'compactAvailable', value }),
    compaction: (event: import('./dshClient').DshCompactionEvent) => post(panel, { type: 'compaction', event }),
    compacting: (value: boolean) => post(panel, { type: 'compacting', value }),
    assistantStart: () => {
      streamingAssistant = '';
      post(panel, { type: 'assistantStart' });
    },
    assistantDelta: (text: string) => {
      streamingAssistant += text;
      post(panel, { type: 'assistantRender', html: renderMarkdown(streamingAssistant) });
    },
    assistantTime: (time: number) => post(panel, { type: 'assistantTime', time }),
    process: (event: import('./dshClient').DshProcessEvent) => post(panel, { type: 'process', event }),
    queue: (items: readonly import('./dshClient').DshQueuedPrompt[]) => post(panel, { type: 'queue', items }),
    running: (value: boolean) => post(panel, { type: 'running', value }),
    status: (text: string) => post(panel, { type: 'status', text }),
    userCommitted: (requestId: string | undefined, text: string, time: number, turn: number) => post(panel, {
      type: 'userCommitted', requestId, text, time, turn,
    }),
  };
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    if (cookie !== undefined) {
      const client = await DshClient.connect(cookie, cwd, sink, restoredSessionId);
      await consumeBootstrapUrl(context.extensionUri, runtime);
      return client;
    }
  } catch (error) {
    if (!(error instanceof DshHttpError) || error.status !== 401) throw error;
    await context.secrets.delete(COOKIE_SECRET_KEY);
    cookie = undefined;
  }

  sink.status('Authentication required');
  const launchUrl = runtime?.bootstrapUrl ?? await vscode.window.showInputBox({
      title: 'Connect DSH Companion',
      prompt: `Paste the launch URL printed by the DSH instance at ${DSH_ORIGIN}`,
      placeHolder: `${DSH_ORIGIN}/?token=…`,
      ignoreFocusOut: true,
    });
  if (launchUrl === undefined) throw new Error('DSH authentication was cancelled');
  cookie = await exchangeLaunchUrl(launchUrl);
  await context.secrets.store(COOKIE_SECRET_KEY, cookie);
  await consumeBootstrapUrl(context.extensionUri, runtime);
  return DshClient.connect(cookie, cwd, sink, restoredSessionId);
}

async function readDevelopmentRuntime(extensionUri: vscode.Uri): Promise<DevelopmentRuntime | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(developmentRuntimePath(extensionUri), 'utf8'));
    if (!isDevelopmentRuntime(value)) throw new Error('Invalid DSH development runtime state');
    return value;
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

async function consumeBootstrapUrl(
  extensionUri: vscode.Uri,
  runtime: DevelopmentRuntime | undefined,
): Promise<void> {
  if (runtime?.bootstrapUrl === undefined) return;
  const { bootstrapUrl: _bootstrapUrl, ...publicState } = runtime;
  await writeFile(
    developmentRuntimePath(extensionUri),
    `${JSON.stringify(publicState, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function developmentRuntimePath(extensionUri: vscode.Uri): string {
  return resolve(extensionUri.fsPath, '..', '..', '.dev', 'dsh-companion', 'runtime.json');
}

function isDevelopmentRuntime(value: unknown): value is DevelopmentRuntime {
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'version') === 1
    && Reflect.get(value, 'origin') === DSH_ORIGIN
    && Number.isSafeInteger(Reflect.get(value, 'pid'))
    && typeof Reflect.get(value, 'startedAt') === 'string'
    && (Reflect.get(value, 'bootstrapUrl') === undefined
      || typeof Reflect.get(value, 'bootstrapUrl') === 'string');
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

async function submit(
  panel: vscode.WebviewPanel,
  ready: Promise<DshClient>,
  requestId: string,
  text: string,
): Promise<void> {
  post(panel, { type: 'sending', value: true });
  try {
    const client = await ready;
    await client.prompt(text, requestId);
  } catch (error) {
    post(panel, { type: 'submissionFailed', requestId });
    post(panel, {
      type: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'sending', value: false });
  }
}

async function stop(panel: vscode.WebviewPanel, ready: Promise<DshClient>): Promise<void> {
  post(panel, { type: 'stopping', value: true });
  try {
    await (await ready).cancel();
  } catch (error) {
    post(panel, {
      type: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'stopping', value: false });
  }
}

async function loadOlder(panel: vscode.WebviewPanel, ready: Promise<DshClient>): Promise<void> {
  try {
    await (await ready).loadOlder();
  } catch (error) {
    post(panel, {
      type: 'historyLoadFailed',
      text: error instanceof Error ? error.message : String(error),
    });
  }
}

async function selectModel(
  panel: vscode.WebviewPanel,
  ready: Promise<DshClient>,
  message: SelectModelMessage,
): Promise<void> {
  post(panel, { type: 'modelSelecting', value: true });
  try {
    await (await ready).selectModel({
      provider: message.provider,
      model: message.model,
      ...(message.reasoningEffort === undefined ? {} : { reasoningEffort: message.reasoningEffort }),
    });
  } catch (error) {
    post(panel, {
      type: 'modelSelectionFailed',
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'modelSelecting', value: false });
  }
}

async function compact(panel: vscode.WebviewPanel, ready: Promise<DshClient>): Promise<void> {
  post(panel, { type: 'compacting', value: true });
  try {
    const result = await (await ready).compact();
    post(panel, { type: 'compactResult', kind: result.kind, text: result.text });
  } catch (error) {
    post(panel, {
      type: 'compactResult',
      kind: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'compacting', value: false });
  }
}

function post(panel: vscode.WebviewPanel, message: object): void {
  void panel.webview.postMessage(message);
}

function isSubmitMessage(value: unknown): value is SubmitMessage {
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'type') === 'submit'
    && typeof Reflect.get(value, 'requestId') === 'string'
    && Reflect.get(value, 'requestId').length > 0
    && typeof Reflect.get(value, 'text') === 'string'
    && Reflect.get(value, 'text').trim().length > 0;
}

function isStopMessage(value: unknown): value is StopMessage {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'stop';
}

function isLoadOlderMessage(value: unknown): value is LoadOlderMessage {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'loadOlder';
}

function isSelectModelMessage(value: unknown): value is SelectModelMessage {
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'type') === 'selectModel'
    && typeof Reflect.get(value, 'provider') === 'string'
    && Reflect.get(value, 'provider').length > 0
    && typeof Reflect.get(value, 'model') === 'string'
    && Reflect.get(value, 'model').length > 0
    && (Reflect.get(value, 'reasoningEffort') === undefined
      || (typeof Reflect.get(value, 'reasoningEffort') === 'string'
        && Reflect.get(value, 'reasoningEffort').length > 0));
}

function isCompactMessage(value: unknown): value is CompactMessage {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'compact';
}

function isOpenLinkMessage(value: unknown): value is OpenLinkMessage {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'type') !== 'openLink'
    || typeof Reflect.get(value, 'href') !== 'string') return false;
  try {
    const url = new URL(Reflect.get(value, 'href'));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isChatEditorState(value: unknown): value is ChatEditorState {
  return typeof value === 'object' && value !== null
    && (Reflect.get(value, 'version') === 1 || Reflect.get(value, 'version') === 2)
    && (Reflect.get(value, 'sessionId') === undefined
      || typeof Reflect.get(value, 'sessionId') === 'string');
}

function editorHtml(webview: vscode.Webview, script: vscode.Uri, style: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const scriptUri = webview.asWebviewUri(script);
  const styleUri = webview.asWebviewUri(style);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>DSH Chat</title>
</head>
<body>
  <main id="output" aria-live="polite"></main>
  <aside id="sticky-prompt" aria-label="Current prompt" hidden>
    <button id="sticky-prompt-jump" type="button" aria-label="Jump to prompt" title="Jump to prompt">↑</button>
    <span id="sticky-prompt-text"></span>
    <time id="sticky-prompt-time"></time>
  </aside>
  <section id="queue" aria-label="Pending messages" hidden></section>
  <div id="status" role="status">Connecting…</div>
  <form id="composer">
    <textarea id="prompt" rows="1" aria-label="Message" placeholder="Ask DSH Companion… (Enter sends, Shift+Enter = newline)"></textarea>
    <div id="composer-toolbar">
      <div id="model-controls">
        <button id="model-trigger" type="button" aria-haspopup="dialog" aria-expanded="false" disabled>Loading models…</button>
        <div id="model-picker" role="dialog" aria-label="Choose model and reasoning effort" hidden>
          <input id="model-search" type="search" aria-label="Search models" placeholder="Search models…">
          <div id="model-list"></div>
          <div id="effort-menu" role="menu" aria-label="Choose reasoning effort" hidden></div>
        </div>
      </div>
      <div id="context-meter" hidden>
        <button id="context-trigger" type="button" aria-haspopup="dialog" aria-expanded="false">
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
            <circle class="context-track" cx="7" cy="7" r="5.5"></circle>
            <circle class="context-fill" cx="7" cy="7" r="5.5" transform="rotate(-90 7 7)"></circle>
          </svg>
        </button>
        <div id="context-panel" role="dialog" aria-label="Context usage" hidden>
          <div id="context-reading"></div>
          <div id="context-figures"></div>
          <button id="compact" type="button" hidden>Compact</button>
          <div id="compact-result" role="status" hidden></div>
        </div>
      </div>
      <div id="composer-actions">
        <button id="stop" type="button" aria-label="Stop" title="Stop">
          <span aria-hidden="true"></span>
        </button>
        <button id="send" type="submit">Send</button>
      </div>
    </div>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
