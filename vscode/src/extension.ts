import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { DSH_ORIGIN, DshClient, DshHttpError, PACKAGED_DSH_ORIGIN, exchangeLaunchUrl } from './dshClient';
import { renderMarkdown } from './markdown';
import { RuntimeControl } from './runtimeControl';
import { connectRuntime } from './runtimeInstaller';
import { WebviewMessenger } from './webviewMessenger';

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

interface CopySessionIdMessage {
  readonly type: 'copySessionId';
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

interface SelectPermissionMessage {
  readonly type: 'selectPermission';
  readonly preset: string;
}

interface CompactMessage {
  readonly type: 'compact';
}

interface RefreshProviderUsageMessage {
  readonly type: 'refreshProviderUsage';
  readonly provider: string;
}

interface OpenLinkMessage {
  readonly type: 'openLink';
  readonly href: string;
}

interface ReadyMessage {
  readonly type: 'ready';
}

interface ChatEditorState {
  readonly version: 1 | 2;
  readonly sessionId?: string;
}

interface ConnectedChat {
  readonly client: DshClient;
  readonly backendVersion: string;
}

const panelMessengers = new WeakMap<vscode.WebviewPanel, WebviewMessenger>();

/** Registers the DSH Companion editor and runtime commands. */
export function activate(context: vscode.ExtensionContext): void {
  const runtimeControl = connectRuntime(context, authorizeRuntimeReplacement);
  context.subscriptions.push({
    dispose: () => { void runtimeControl.then((control) => { control?.dispose(); }, () => {}); },
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('dshCompanion.openDevelopmentWebUi', async () => {
      try {
        await openDevelopmentWebUi(context, runtimeControl);
      } catch (error) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('dshCompanion.newChatEditor', () => {
      openChatEditor(context, runtimeControl);
    }),
    vscode.commands.registerCommand('dshCompanion.stopManagedRuntime', async () => {
      const selected = await vscode.window.showWarningMessage(
        'Stopping the managed DSH runtime can interrupt active agents, jobs, terminals, and schedules.',
        { modal: true },
        'Stop Runtime',
      );
      if (selected !== 'Stop Runtime') return;
      const control = await runtimeControl;
      if (control === undefined) {
        await vscode.window.showInformationMessage('No managed DSH runtime is connected.');
        return;
      }
      await control.stop();
      control.dispose();
    }),
    vscode.window.registerWebviewPanelSerializer(CHAT_EDITOR_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state: unknown): Promise<void> {
        configureChatEditor(context, runtimeControl, panel, isChatEditorState(state) ? state.sessionId : undefined);
      },
    }),
  );
}

/** Releases resources owned by editor-panel subscriptions. */
export function deactivate(): void {}

async function openDevelopmentWebUi(
  context: vscode.ExtensionContext,
  runtimeControlPromise: Promise<RuntimeControl | undefined>,
): Promise<void> {
  let runtime = await runtimeControlPromise;
  if (runtime === undefined) {
    runtime = await connectRuntime(context, authorizeRuntimeReplacement);
    if (runtime !== undefined) context.subscriptions.push(runtime);
  }
  if (runtime?.runtimeId !== 'source' || runtime.origin !== DSH_ORIGIN) {
    throw new Error('The DSH Companion source development runtime is unavailable');
  }
  await vscode.env.openExternal(vscode.Uri.parse(await runtime.bootstrapUrl()));
}

function openChatEditor(
  context: vscode.ExtensionContext,
  runtimeControl: Promise<RuntimeControl | undefined>,
): void {
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
  configureChatEditor(context, runtimeControl, panel);
}

function configureChatEditor(
  context: vscode.ExtensionContext,
  runtimeControl: Promise<RuntimeControl | undefined>,
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
    vscode.Uri.joinPath(mediaRoot, 'transcript-state.js'),
    vscode.Uri.joinPath(mediaRoot, 'main.js'),
    vscode.Uri.joinPath(mediaRoot, 'style.css'),
  );

  const messenger = new WebviewMessenger(panel.webview, (error) => {
    console.warn('DSH Companion Webview message delivery failed', error);
  });
  panelMessengers.set(panel, messenger);
  let client: DshClient | undefined;
  const ready = connect(context, runtimeControl, panel, restoredSessionId).then((connected) => {
    client = connected.client;
    post(panel, { type: 'session', sessionId: connected.client.sessionId });
    post(panel, {
      type: 'sessionInformation',
      sessionId: connected.client.sessionId,
      companionVersion: String(context.extension.packageJSON.version),
      backendVersion: connected.backendVersion,
    });
    return connected.client;
  });
  void ready.catch((error: unknown) => {
    post(panel, {
      type: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
  });
  const receive = panel.webview.onDidReceiveMessage((message: unknown) => {
    if (isReadyMessage(message)) messenger.markReady();
    if (isSubmitMessage(message)) void submit(panel, ready, message.requestId, message.text);
    if (isStopMessage(message)) void stop(panel, ready);
    if (isCopySessionIdMessage(message)) void copySessionId(panel, ready);
    if (isLoadOlderMessage(message)) void loadOlder(panel, ready);
    if (isSelectModelMessage(message)) void selectModel(panel, ready, message);
    if (isSelectPermissionMessage(message)) void selectPermission(panel, ready, message.preset);
    if (isCompactMessage(message)) void compact(panel, ready);
    if (isRefreshProviderUsageMessage(message)) void refreshProviderUsage(panel, ready, message.provider);
    if (isOpenLinkMessage(message)) void vscode.env.openExternal(vscode.Uri.parse(message.href));
  });
  panel.onDidDispose(() => {
    receive.dispose();
    messenger.dispose();
    panelMessengers.delete(panel);
    client?.dispose();
  });
}

async function connect(
  context: vscode.ExtensionContext,
  runtimeControlPromise: Promise<RuntimeControl | undefined>,
  panel: vscode.WebviewPanel,
  restoredSessionId?: string,
): Promise<ConnectedChat> {
  let cookie = await context.secrets.get(COOKIE_SECRET_KEY);
  let runtime = await runtimeControlPromise;
  if (runtime === undefined) {
    runtime = await connectRuntime(context, authorizeRuntimeReplacement);
    if (runtime !== undefined) context.subscriptions.push(runtime);
  }
  if (runtime === undefined) throw new Error('Managed DSH runtime is unavailable');
  if (runtime.origin !== DSH_ORIGIN && runtime.origin !== PACKAGED_DSH_ORIGIN) {
    throw new Error(`DSH runtime origin ${runtime.origin} does not match a Companion runtime origin`);
  }
  if (runtime.clientModule === undefined) throw new Error('Managed DSH runtime does not provide its Client module');
  let backendVersion = 'Unavailable';
  try {
    backendVersion = await runtime.backendVersion();
  } catch {
    // A retained rollback runtime may predate the authenticated version endpoint.
  }
  let streamingAssistant = '';
  const sink = {
    reset: () => {
      streamingAssistant = '';
      post(panel, { type: 'resetTranscript' });
    },
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
    sessionCost: (cost: import('./dshClient').DshCostSummary | undefined) => post(panel, {
      type: 'sessionCost', cost,
    }),
    providerAccounts: (snapshots: readonly import('./dshClient').DshProviderAccountSnapshot[]) => post(panel, {
      type: 'providerAccounts', snapshots,
    }),
    permissionSelection: (selection: import('./dshClient').DshPermissionSelection | undefined) => post(panel, {
      type: 'permissionSelection', selection,
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
    submissionObserved: (requestId: string) => post(panel, { type: 'submissionObserved', requestId }),
    userCommitted: (requestId: string | undefined, text: string, time: number, turn: number) => post(panel, {
      type: 'userCommitted', requestId, text, time, turn,
    }),
  };
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    if (cookie !== undefined) {
      const client = await DshClient.connect(cookie, cwd, sink, restoredSessionId, runtime.clientModule, runtime.origin);
      return { client, backendVersion };
    }
  } catch (error) {
    if (!(error instanceof DshHttpError) || error.status !== 401) throw error;
    await context.secrets.delete(COOKIE_SECRET_KEY);
    cookie = undefined;
  }

  sink.status('Authentication required');
  const launchUrl = await runtime.bootstrapUrl();
  cookie = await exchangeLaunchUrl(launchUrl, runtime.origin);
  await context.secrets.store(COOKIE_SECRET_KEY, cookie);
  return {
    client: await DshClient.connect(cookie, cwd, sink, restoredSessionId, runtime.clientModule, runtime.origin),
    backendVersion,
  };
}

async function authorizeRuntimeReplacement(): Promise<boolean> {
  const selected = await vscode.window.showWarningMessage(
    'A different DSH Companion Managed Runtime is still running. Replacing it can interrupt active agents, jobs, terminals, and schedules. Continue only after its work has finished.',
    { modal: true },
    'Replace Runtime',
  );
  return selected === 'Replace Runtime';
}

async function copySessionId(panel: vscode.WebviewPanel, ready: Promise<DshClient>): Promise<void> {
  try {
    await vscode.env.clipboard.writeText((await ready).sessionId);
    post(panel, { type: 'sessionIdCopied' });
  } catch (error) {
    post(panel, {
      type: 'sessionIdCopyFailed',
      text: error instanceof Error ? error.message : String(error),
    });
  }
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

async function selectPermission(
  panel: vscode.WebviewPanel,
  ready: Promise<DshClient>,
  preset: string,
): Promise<void> {
  post(panel, { type: 'permissionSelecting', value: true });
  try {
    if (preset === 'danger-full-access') {
      const selected = await vscode.window.showWarningMessage(
        'Full access disables filesystem sandboxing for this Session. Commands can read or modify files outside the workspace.',
        { modal: true },
        'Enable Full Access',
      );
      if (selected !== 'Enable Full Access') return;
    }
    await (await ready).selectPermission(preset);
  } catch (error) {
    post(panel, {
      type: 'permissionSelectionFailed',
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'permissionSelecting', value: false });
  }
}

async function refreshProviderUsage(
  panel: vscode.WebviewPanel,
  ready: Promise<DshClient>,
  provider: string,
): Promise<void> {
  post(panel, { type: 'providerUsageRefreshing', provider, value: true });
  try {
    await (await ready).refreshProviderAccount(provider);
  } catch (error) {
    post(panel, {
      type: 'providerUsageFailed',
      provider,
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'providerUsageRefreshing', provider, value: false });
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
  panelMessengers.get(panel)?.send(message);
}

function isReadyMessage(value: unknown): value is ReadyMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && Reflect.get(value, 'type') === 'ready';
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

function isCopySessionIdMessage(value: unknown): value is CopySessionIdMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && Reflect.get(value, 'type') === 'copySessionId';
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

function isSelectPermissionMessage(value: unknown): value is SelectPermissionMessage {
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'type') === 'selectPermission'
    && typeof Reflect.get(value, 'preset') === 'string'
    && /^[a-z0-9][a-z0-9-]*$/u.test(Reflect.get(value, 'preset'));
}

function isCompactMessage(value: unknown): value is CompactMessage {
  return typeof value === 'object' && value !== null && Reflect.get(value, 'type') === 'compact';
}

function isRefreshProviderUsageMessage(value: unknown): value is RefreshProviderUsageMessage {
  return typeof value === 'object' && value !== null
    && Reflect.get(value, 'type') === 'refreshProviderUsage'
    && typeof Reflect.get(value, 'provider') === 'string'
    && Reflect.get(value, 'provider').length > 0;
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

function editorHtml(
  webview: vscode.Webview,
  transcriptState: vscode.Uri,
  script: vscode.Uri,
  style: vscode.Uri,
): string {
  const nonce = randomBytes(16).toString('base64');
  const transcriptStateUri = webview.asWebviewUri(transcriptState);
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
    <button id="sticky-prompt-jump" type="button" aria-label="Jump to prompt" title="Jump to prompt">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 10 8 5.5l4.5 4.5"/></svg>
    </button>
    <span id="sticky-prompt-text"></span>
    <time id="sticky-prompt-time"></time>
  </aside>
  <button id="scroll-bottom" type="button" aria-label="Scroll to latest output" title="Scroll to latest output" hidden>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 6 4.5 4.5L12.5 6"/></svg>
  </button>
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
      <div id="permission-control" hidden>
        <select id="permission-select" aria-label="Session permission" title="Session permission"></select>
      </div>
      <div id="provider-usage" hidden>
        <button id="provider-usage-trigger" type="button" aria-haspopup="dialog" aria-expanded="false">Usage</button>
        <div id="provider-usage-panel" role="dialog" aria-label="Provider usage and allowances" hidden></div>
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
      <div id="session-info" hidden>
        <button id="session-info-trigger" type="button" aria-label="Session information" aria-haspopup="dialog" aria-expanded="false" title="Session information">
          <span aria-hidden="true">i</span>
        </button>
        <div id="session-info-panel" role="dialog" aria-label="Session information" hidden>
          <div class="session-info-row session-info-session">
            <span>Session</span>
            <div class="session-info-value-with-action">
              <code id="session-info-id"></code>
              <button id="session-info-copy" type="button" aria-label="Copy session ID" title="Copy session ID">Copy</button>
            </div>
          </div>
          <div class="session-info-row"><span>DSH Companion</span><code id="session-info-companion-version"></code></div>
          <div class="session-info-row"><span>DSH backend</span><code id="session-info-backend-version"></code></div>
          <div id="session-cost-row" class="session-info-row" hidden>
            <span>Session cost</span>
            <div id="session-cost-control">
              <strong id="session-cost-summary"></strong>
              <div id="session-cost-breakdown"></div>
            </div>
          </div>
          <div id="session-info-status" role="status" hidden></div>
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
  <script nonce="${nonce}" src="${transcriptStateUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
