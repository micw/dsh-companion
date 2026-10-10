import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  DSH_ORIGIN, DshClient, DshHttpError, DshSessionBrowser, PACKAGED_DSH_ORIGIN, exchangeLaunchUrl,
} from './dshClient';
import { renderMarkdown } from './markdown';
import { RuntimeControl } from './runtimeControl';
import { RuntimeProgress, runtimePhaseText } from './runtimeProgress';
import { connectRuntime } from './runtimeInstaller';
import { SessionSidebarProvider } from './sessionTree';
import { sessionWorkspaceKind } from './sessionWorkspace';
import { publishSessionHandoff, receiveSessionHandoffs } from './sessionHandoff';
import { companionLifecycleRoot } from './runtimeInstaller';
import { installRestoreTraceSink, isDiagnosticBatchMessage, isDiagnosticScrollMessage, restoreTrace } from './restoreDiagnostics';
import { TabStatusProjection } from './tabStatus';
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

interface RefreshSessionTitleMessage {
  readonly type: 'refreshSessionTitle';
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

interface LoadProviderSettingsMessage {
  readonly type: 'loadProviderSettings';
  readonly requestId: number;
}

interface SaveProviderSettingsMessage {
  readonly type: 'saveProviderSettings';
  readonly provider: string;
  readonly displayName?: string;
  readonly enabled: boolean;
  readonly baseURL?: string;
  readonly apiKey?: string;
  readonly test?: boolean;
  readonly revision: number;
}

interface CreateProviderInstanceMessage {
  readonly type: 'createProviderInstance';
  readonly family: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly baseURL?: string;
  readonly apiKey?: string;
}

interface DeleteProviderInstanceMessage {
  readonly type: 'deleteProviderInstance';
  readonly family: string;
  readonly instance: string;
  readonly provider: string;
  readonly displayName: string;
}

interface SetProviderModelEnabledMessage {
  readonly type: 'setProviderModelEnabled';
  readonly provider: string;
  readonly model: string;
  readonly enabled: boolean;
  readonly revision: number;
}

interface SetProviderModelsEnabledMessage {
  readonly type: 'setProviderModelsEnabled';
  readonly provider: string;
  readonly models: readonly string[];
  readonly enabled: boolean;
  readonly revision: number;
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
const panelsBySessionId = new Map<string, vscode.WebviewPanel>();

/** Registers the DSH Companion editor and runtime commands. */
export function activate(context: vscode.ExtensionContext): void {
  const restoreLog = vscode.window.createOutputChannel('DSH Companion Restore', { log: true });
  const releaseRestoreLog = installRestoreTraceSink(line => restoreLog.info(line));
  context.subscriptions.push(restoreLog, { dispose: releaseRestoreLog });
  restoreTrace(undefined, 'diagnostics-started', { companionVersion: String(context.extension.packageJSON.version) });
  const runtimeProgress = new RuntimeProgress();
  const runtimeControl = connectRuntime(context, phase => runtimeProgress.report(phase));
  const sessionTree = new SessionSidebarProvider(
    context.extensionUri,
    onDidChange => connectSessionBrowser(context, runtimeControl, onDidChange),
    runtimeProgress,
  );
  void runtimeControl.then(() => sessionTree.runtimeReady(), () => sessionTree.runtimeReady(false));
  context.subscriptions.push({
    dispose: () => { void runtimeControl.then((control) => { control?.dispose(); }, () => {}); },
  }, sessionTree, vscode.window.registerWebviewViewProvider('dshCompanion.sessions', sessionTree));
  let stopHandoffs: (() => void) | undefined;
  let handoffsReady = false;
  const roots = () => vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
  void receiveSessionHandoffs(companionLifecycleRoot(), roots,
    sessionId => { openChatEditor(context, runtimeControl, sessionTree, runtimeProgress, sessionId); },
    error => { console.warn('DSH Companion Session handoff failed', error); },
  ).then(stop => {
    if (handoffsReady) stop();
    else stopHandoffs = stop;
  }, error => { console.warn('DSH Companion Session handoff unavailable', error); });
  context.subscriptions.push({ dispose: () => { handoffsReady = true; stopHandoffs?.(); } });
  context.subscriptions.push(
    vscode.commands.registerCommand('dshCompanion.openDevelopmentWebUi', async () => {
      try {
        await openWebUi(context, runtimeControl);
      } catch (error) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('dshCompanion.newChatEditor', () => {
      openChatEditor(context, runtimeControl, sessionTree, runtimeProgress);
    }),
    vscode.commands.registerCommand('dshCompanion.openSession', async (sessionId: unknown) => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        await vscode.window.showErrorMessage('DSH Companion received an invalid Session id.');
        return;
      }
      try {
        const browser = await connectSessionBrowser(context, runtimeControl, () => {});
        let entry: ReturnType<typeof browser.snapshot>['sessions'][number] | undefined;
        try {
          await browser.refresh();
          entry = browser.snapshot().sessions.find(item => item.sessionId === sessionId);
        } finally {
          await browser.dispose();
        }
        if (entry === undefined) {
          await vscode.window.showErrorMessage(`DSH Session ${sessionId} was not found.`);
          return;
        }
        const roots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
        const kind = sessionWorkspaceKind(entry.cwd, roots);
        if (kind === 'local') {
          openChatEditor(context, runtimeControl, sessionTree, runtimeProgress, sessionId);
          return;
        }
        if (kind === 'unknown') {
          const choice = await vscode.window.showWarningMessage(
            'The working directory of this Session is unknown. It cannot be matched to a VS Code workspace.',
            { modal: true }, 'Open Here',
          );
          if (choice === 'Open Here') openChatEditor(context, runtimeControl, sessionTree, runtimeProgress, sessionId);
          return;
        }
        const choice = await vscode.window.showInformationMessage(
          `This Session works in a different workspace or path.\nSession path: ${entry.cwd}\nCurrent roots: ${roots.join(', ') || '(none)'}\nOpen the Session in its VS Code workspace window?`,
          { modal: true }, 'Open',
        );
        if (choice !== 'Open' || entry.cwd === undefined) return;
        const cancelHandoff = await publishSessionHandoff(companionLifecycleRoot(), sessionId, entry.cwd);
        try {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(entry.cwd), { forceNewWindow: true });
        } catch (error) {
          await cancelHandoff();
          throw error;
        }
      } catch (error) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('dshCompanion.refreshSessions', async () => {
      try {
        await sessionTree.refresh();
      } catch (error) {
        await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand('dshCompanion.searchSessions', async () => {
      await vscode.commands.executeCommand('dshCompanion.sessions.focus');
      sessionTree.focusSearch();
    }),
    vscode.commands.registerCommand('dshCompanion.openProviderSettings', () => {
      const panel = activeCompanionPanel() ?? openChatEditor(context, runtimeControl, sessionTree, runtimeProgress);
      panel.reveal(panel.viewColumn, false);
      post(panel, { type: 'openProviderSettings' });
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
        configureChatEditor(
          context, runtimeControl, sessionTree, runtimeProgress, panel, isChatEditorState(state) ? state.sessionId : undefined,
        );
      },
    }),
  );
}

/** Releases resources owned by editor-panel subscriptions. */
export function deactivate(): void {}

async function openWebUi(
  context: vscode.ExtensionContext,
  runtimeControlPromise: Promise<RuntimeControl | undefined>,
): Promise<void> {
  let runtime = await runtimeControlPromise;
  if (runtime === undefined) {
    runtime = await connectRuntime(context);
    if (runtime !== undefined) context.subscriptions.push(runtime);
  }
  if (runtime === undefined) throw new Error('DSH Companion Runtime is unavailable');
  if (runtime.origin !== DSH_ORIGIN && runtime.origin !== PACKAGED_DSH_ORIGIN) {
    throw new Error(`DSH runtime origin ${runtime.origin} does not match a Companion runtime origin`);
  }
  await vscode.env.openExternal(vscode.Uri.parse(await runtime.bootstrapUrl()));
}

function openChatEditor(
  context: vscode.ExtensionContext,
  runtimeControl: Promise<RuntimeControl | undefined>,
  sessionTree: SessionSidebarProvider,
  runtimeProgress: RuntimeProgress,
  sessionId?: string,
): vscode.WebviewPanel {
  const existing = sessionId === undefined ? undefined : panelsBySessionId.get(sessionId);
  if (existing !== undefined) {
    existing.reveal(existing.viewColumn, false);
    return existing;
  }
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel(
    CHAT_EDITOR_VIEW_TYPE,
    'New DSH Chat',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaRoot],
    },
  );
  configureChatEditor(context, runtimeControl, sessionTree, runtimeProgress, panel, sessionId);
  return panel;
}

function activeCompanionPanel(): vscode.WebviewPanel | undefined {
  for (const panel of panelsBySessionId.values()) {
    if (panel.active) return panel;
  }
  return panelsBySessionId.values().next().value;
}

function configureChatEditor(
  context: vscode.ExtensionContext,
  runtimeControl: Promise<RuntimeControl | undefined>,
  sessionTree: SessionSidebarProvider,
  runtimeProgress: RuntimeProgress,
  panel: vscode.WebviewPanel,
  restoredSessionId?: string,
): void {
  if (restoredSessionId !== undefined) panelsBySessionId.set(restoredSessionId, panel);
  const panelTraceId = randomBytes(4).toString('hex');
  let traceSessionId = restoredSessionId;
  let scrollTraceLogged = false;
  restoreTrace(traceSessionId, 'panel-open', {
    panelTraceId, restored: restoredSessionId !== undefined,
    companionVersion: String(context.extension.packageJSON.version),
  });
  const seenKey = (sessionId: string) => `sessionSeenThrough:${sessionId}`;
  const seenThrough = restoredSessionId === undefined ? 0 : context.globalState.get<number>(seenKey(restoredSessionId), 0);
  const tabStatus = new TabStatusProjection(seenThrough);
  const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
  let disposed = false;
  const renderTab = () => {
    if (disposed) return;
    const icon = `tab-${tabStatus.status}.svg`;
    panel.iconPath = vscode.Uri.joinPath(mediaRoot, icon);
  };
  const acknowledge = () => {
    if (!panel.active || !panel.visible || disposed) return;
    const watermark = tabStatus.acknowledge();
    const sessionId = client?.sessionId ?? restoredSessionId;
    if (watermark !== undefined && sessionId !== undefined) {
      void context.globalState.update(seenKey(sessionId), watermark);
    }
    renderTab();
  };
  renderTab();
  panel.webview.options = {
    enableScripts: true,
    localResourceRoots: [mediaRoot],
  };
  panel.webview.html = editorHtml(
    panel.webview,
    vscode.Uri.joinPath(mediaRoot, 'transcript-state.js'),
    vscode.Uri.joinPath(mediaRoot, 'scroll-diagnostics.js'),
    vscode.Uri.joinPath(mediaRoot, 'main.js'),
    vscode.Uri.joinPath(mediaRoot, 'style.css'),
  );

  const messenger = new WebviewMessenger(panel.webview, (error) => {
    restoreTrace(traceSessionId, 'batch-delivery-error', {
      panelTraceId, errorKind: error instanceof Error ? error.name : 'unknown',
    });
  }, batch => {
    if (!batch.trace && batch.accepted) return;
    restoreTrace(traceSessionId, 'batch-posted', { panelTraceId, ...batch });
  });
  panelMessengers.set(panel, messenger);
  let client: DshClient | undefined;
  let runtimePending = true;
  const unsubscribeProgress = runtimeProgress.subscribe(phase => {
    if (!disposed && runtimePending) post(panel, { type: 'status', text: runtimePhaseText[phase] });
  });
  void runtimeControl.then(() => {
    runtimePending = false;
    unsubscribeProgress();
    if (!disposed) post(panel, { type: 'status', text: 'Connecting to DSH…' });
  }, () => { runtimePending = false; unsubscribeProgress(); });
  const ready = connect(
    context,
    runtimeControl,
    panel,
    restoredSessionId,
    () => { sessionTree.requestRefresh(); },
    (sessionId, backendVersion) => {
      traceSessionId = sessionId;
      restoreTrace(sessionId, 'session-bound', { panelTraceId, backendVersion });
      panelsBySessionId.set(sessionId, panel);
      if (restoredSessionId === undefined) panel.title = 'DSH Chat';
      sessionTree.requestRefresh();
      if (panel.active) sessionTree.setActiveSession(sessionId);
      post(panel, { type: 'session', sessionId });
      post(panel, {
        type: 'sessionInformation', sessionId,
        companionVersion: String(context.extension.packageJSON.version),
        backendVersion,
      });
    },
    (title) => {
      if (disposed) return;
      panel.title = title;
      post(panel, { type: 'sessionTitle', title });
    },
    (running) => { tabStatus.setRunning(running); renderTab(); if (!running) acknowledge(); },
    (time, reason) => { tabStatus.end(time, reason); renderTab(); acknowledge(); },
  ).then((connected) => {
    client = connected.client;
    acknowledge();
    post(panel, { type: 'connected' });
    void connected.client.providerSettings().then(
      snapshot => { post(panel, { type: 'providerSettings', snapshot }); },
      error => { console.warn('DSH provider settings are unavailable', error); },
    );
    return connected.client;
  });
  void ready.catch((error: unknown) => {
    restoreTrace(traceSessionId, 'connection-failed', { panelTraceId, errorKind: error instanceof Error ? error.name : 'unknown' });
    post(panel, {
      type: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
  });
  const receive = panel.webview.onDidReceiveMessage((message: unknown) => {
    if (isReadyMessage(message)) {
      restoreTrace(traceSessionId, 'webview-ready', { panelTraceId });
      messenger.markReady();
    }
    if (isDiagnosticBatchMessage(message)) {
      restoreTrace(traceSessionId, 'batch-applied', { panelTraceId, batchId: message.batchId, processed: message.processed, failed: message.failed });
    }
    if (!scrollTraceLogged && isDiagnosticScrollMessage(message)) {
      scrollTraceLogged = true;
      restoreTrace(traceSessionId, 'scroll-jump', {
        panelTraceId, reason: message.reason, startTop: message.startTop, samples: message.samples,
      });
    }
    if (isSubmitMessage(message)) void submit(panel, ready, message.requestId, message.text);
    if (isStopMessage(message)) void stop(panel, ready);
    if (isCopySessionIdMessage(message)) void copySessionId(panel, ready);
    if (isRefreshSessionTitleMessage(message)) void refreshSessionTitle(panel, ready);
    if (isLoadOlderMessage(message)) void loadOlder(panel, ready);
    if (isSelectModelMessage(message)) void selectModel(panel, ready, message);
    if (isSelectPermissionMessage(message)) void selectPermission(panel, ready, message.preset);
    if (isCompactMessage(message)) void compact(panel, ready);
    if (isRefreshProviderUsageMessage(message)) void refreshProviderUsage(panel, ready, message.provider);
    if (isLoadProviderSettingsMessage(message)) void loadProviderSettings(panel, ready, message.requestId);
    if (isSaveProviderSettingsMessage(message)) void saveProviderSettings(panel, ready, message);
    if (isCreateProviderInstanceMessage(message)) void createProviderInstance(panel, ready, message);
    if (isDeleteProviderInstanceMessage(message)) void deleteProviderInstance(panel, ready, message);
    if (isSetProviderModelEnabledMessage(message)) void setProviderModelEnabled(panel, ready, message);
    if (isSetProviderModelsEnabledMessage(message)) void setProviderModelsEnabled(panel, ready, message);
    if (isOpenLinkMessage(message)) void vscode.env.openExternal(vscode.Uri.parse(message.href));
  });
  const viewState = panel.onDidChangeViewState(({ webviewPanel }) => {
    acknowledge();
    sessionTree.setActiveSession(
      webviewPanel.active ? client?.sessionId ?? restoredSessionId : activeCompanionSessionId(),
    );
  });
  panel.onDidDispose(() => {
    restoreTrace(traceSessionId, 'panel-dispose', { panelTraceId });
    disposed = true;
    unsubscribeProgress();
    receive.dispose();
    viewState.dispose();
    messenger.dispose();
    panelMessengers.delete(panel);
    const sessionId = client?.sessionId ?? restoredSessionId;
    if (sessionId !== undefined && panelsBySessionId.get(sessionId) === panel) panelsBySessionId.delete(sessionId);
    sessionTree.setActiveSession(activeCompanionSessionId());
    client?.dispose();
  });
}

function activeCompanionSessionId(): string | undefined {
  for (const [sessionId, panel] of panelsBySessionId) {
    if (panel.active) return sessionId;
  }
  return undefined;
}

async function connect(
  context: vscode.ExtensionContext,
  runtimeControlPromise: Promise<RuntimeControl | undefined>,
  panel: vscode.WebviewPanel,
  restoredSessionId?: string,
  onSessionListChange?: () => void,
  onSessionCreated?: (sessionId: string, backendVersion: string) => void,
  onSummary?: (title: string) => void,
  onRunning?: (running: boolean) => void,
  onTurnEnd?: (time: number, reason: string) => void,
): Promise<ConnectedChat> {
  let cookie = await context.secrets.get(COOKIE_SECRET_KEY);
  let runtime = await runtimeControlPromise;
  if (runtime === undefined) {
    runtime = await connectRuntime(context);
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
  let renderPending = false;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelRender = () => {
    if (renderTimer !== undefined) clearTimeout(renderTimer);
    renderTimer = undefined;
    renderPending = false;
  };
  const flushRender = () => {
    if (!renderPending) return;
    cancelRender();
    post(panel, { type: 'assistantRender', html: renderMarkdown(streamingAssistant), text: streamingAssistant });
  };
  panel.onDidDispose(cancelRender);
  const sink = {
    sessionCreated: (sessionId: string) => { onSessionCreated?.(sessionId, backendVersion); },
    sessionSummary: (summary: import('./dshClient').DshSessionListEntry | undefined) => {
      if (summary !== undefined) onSummary?.(summary.title);
    },
    reset: () => {
      cancelRender();
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
    historyPrependStart: () => { flushRender(); post(panel, { type: 'historyPrependStart' }); },
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
    assistantStart: (turn: number, step: number) => {
      flushRender();
      streamingAssistant = '';
      post(panel, { type: 'assistantStart', turn, step });
    },
    assistantDelta: (text: string) => {
      streamingAssistant += text;
      renderPending = true;
      renderTimer ??= setTimeout(flushRender, 32);
    },
    assistantAbandoned: () => {
      cancelRender();
      streamingAssistant = '';
      post(panel, { type: 'assistantAbandoned' });
    },
    assistantTime: (time: number) => { flushRender(); post(panel, { type: 'assistantTime', time }); },
    process: (event: import('./dshClient').DshProcessEvent) => {
      flushRender();
      if (event.type === 'turn-end') onTurnEnd?.(event.time, event.reason);
      post(panel, { type: 'process', event });
    },
    queue: (items: readonly import('./dshClient').DshQueuedPrompt[]) => post(panel, { type: 'queue', items }),
    running: (value: boolean) => {
      if (!value) flushRender();
      onRunning?.(value);
      post(panel, { type: 'running', value });
      onSessionListChange?.();
    },
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

async function connectSessionBrowser(
  context: vscode.ExtensionContext,
  runtimeControlPromise: Promise<RuntimeControl | undefined>,
  onDidChange: () => void,
): Promise<DshSessionBrowser> {
  let cookie = await context.secrets.get(COOKIE_SECRET_KEY);
  let runtime = await runtimeControlPromise;
  if (runtime === undefined) {
    runtime = await connectRuntime(context);
    if (runtime !== undefined) context.subscriptions.push(runtime);
  }
  if (runtime === undefined) throw new Error('Managed DSH runtime is unavailable');
  if (runtime.origin !== DSH_ORIGIN && runtime.origin !== PACKAGED_DSH_ORIGIN) {
    throw new Error(`DSH runtime origin ${runtime.origin} does not match a Companion runtime origin`);
  }
  if (runtime.clientModule === undefined) throw new Error('Managed DSH runtime does not provide its Client module');
  try {
    if (cookie !== undefined) {
      return await DshSessionBrowser.connect(cookie, runtime.clientModule, onDidChange, runtime.origin);
    }
  } catch (error) {
    if (!(error instanceof DshHttpError) || error.status !== 401) throw error;
    await context.secrets.delete(COOKIE_SECRET_KEY);
    cookie = undefined;
  }
  const launchUrl = await runtime.bootstrapUrl();
  cookie = await exchangeLaunchUrl(launchUrl, runtime.origin);
  await context.secrets.store(COOKIE_SECRET_KEY, cookie);
  return DshSessionBrowser.connect(cookie, runtime.clientModule, onDidChange, runtime.origin);
}

async function copySessionId(panel: vscode.WebviewPanel, ready: Promise<DshClient>): Promise<void> {
  try {
    const sessionId = (await ready).sessionId;
    if (sessionId === undefined) throw new Error('Send the first prompt before copying a Session id');
    await vscode.env.clipboard.writeText(sessionId);
    post(panel, { type: 'sessionIdCopied' });
  } catch (error) {
    post(panel, {
      type: 'sessionIdCopyFailed',
      text: error instanceof Error ? error.message : String(error),
    });
  }
}

async function refreshSessionTitle(panel: vscode.WebviewPanel, ready: Promise<DshClient>): Promise<void> {
  try {
    const title = await (await ready).refreshTitle();
    post(panel, { type: 'sessionTitleRefreshResult', title });
  } catch (error) {
    post(panel, {
      type: 'sessionTitleRefreshResult',
      error: error instanceof Error ? error.message : String(error),
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

async function loadProviderSettings(
  panel: vscode.WebviewPanel,
  ready: Promise<DshClient>,
  requestId: number,
): Promise<void> {
  post(panel, { type: 'providerSettingsLoading', requestId, value: true });
  try {
    post(panel, { type: 'providerSettings', requestId, snapshot: await (await ready).providerSettings() });
  } catch (error) {
    post(panel, {
      type: 'providerSettingsFailed', requestId,
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'providerSettingsLoading', requestId, value: false });
  }
}

async function saveProviderSettings(
  panel: vscode.WebviewPanel,
  ready: Promise<DshClient>,
  message: SaveProviderSettingsMessage,
): Promise<void> {
  post(panel, { type: 'providerSettingsSaving', provider: message.provider, value: true });
  let snapshot: import('./dshClient').DshProviderSettingsSnapshot | undefined;
  try {
    const client = await ready;
    snapshot = await client.updateProviderSettings(message);
    if (message.test === true) {
      const tested = await client.testProviderConnection(message.provider);
      snapshot = tested.snapshot;
      post(panel, { type: 'providerSettingsTested', provider: message.provider, modelCount: tested.modelCount });
    }
    post(panel, { type: 'providerSettings', snapshot });
  } catch (error) {
    if (snapshot !== undefined) post(panel, { type: 'providerSettings', snapshot });
    post(panel, {
      type: 'providerSettingsSaveFailed', provider: message.provider,
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'providerSettingsSaving', provider: message.provider, value: false });
  }
}

async function createProviderInstance(
  panel: vscode.WebviewPanel,
  ready: Promise<DshClient>,
  message: CreateProviderInstanceMessage,
): Promise<void> {
  post(panel, { type: 'providerInstanceCreating', family: message.family, value: true });
  try {
    const snapshot = await (await ready).createProviderInstance(message.family, message);
    post(panel, { type: 'providerSettings', snapshot });
  } catch (error) {
    post(panel, {
      type: 'providerInstanceCreateFailed', family: message.family,
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'providerInstanceCreating', family: message.family, value: false });
  }
}

async function deleteProviderInstance(
  panel: vscode.WebviewPanel,
  ready: Promise<DshClient>,
  message: DeleteProviderInstanceMessage,
): Promise<void> {
  const accepted = await vscode.window.showWarningMessage(
    `Delete provider instance “${message.displayName}”? Existing Sessions retain its route reference, but the route becomes unavailable.`,
    { modal: true },
    'Delete',
  );
  if (accepted !== 'Delete') return;
  post(panel, { type: 'providerInstanceDeleting', provider: message.provider, value: true });
  try {
    const snapshot = await (await ready).deleteProviderInstance(
      message.family, message.instance, message.provider,
    );
    post(panel, { type: 'providerSettings', snapshot });
  } catch (error) {
    post(panel, {
      type: 'providerSettingsSaveFailed', provider: message.provider,
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'providerInstanceDeleting', provider: message.provider, value: false });
  }
}

async function setProviderModelEnabled(
  panel: vscode.WebviewPanel,
  ready: Promise<DshClient>,
  message: SetProviderModelEnabledMessage,
): Promise<void> {
  post(panel, { type: 'providerModelSaving', provider: message.provider, model: message.model, value: true });
  try {
    const snapshot = await (await ready).setProviderModelEnabled(
      message.provider, message.model, message.enabled, message.revision,
    );
    post(panel, { type: 'providerSettings', snapshot });
  } catch (error) {
    post(panel, {
      type: 'providerSettingsSaveFailed', provider: message.provider,
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'providerModelSaving', provider: message.provider, model: message.model, value: false });
  }
}

async function setProviderModelsEnabled(
  panel: vscode.WebviewPanel,
  ready: Promise<DshClient>,
  message: SetProviderModelsEnabledMessage,
): Promise<void> {
  post(panel, { type: 'providerModelsSaving', provider: message.provider, value: true });
  try {
    const snapshot = await (await ready).setProviderModelsEnabled(
      message.provider, message.models, message.enabled, message.revision,
    );
    post(panel, { type: 'providerSettings', snapshot });
  } catch (error) {
    post(panel, {
      type: 'providerSettingsSaveFailed', provider: message.provider,
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'providerModelsSaving', provider: message.provider, value: false });
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

function isRefreshSessionTitleMessage(value: unknown): value is RefreshSessionTitleMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 1 && Reflect.get(value, 'type') === 'refreshSessionTitle';
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

function isLoadProviderSettingsMessage(value: unknown): value is LoadProviderSettingsMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 2 && Reflect.get(value, 'type') === 'loadProviderSettings'
    && Number.isSafeInteger(Reflect.get(value, 'requestId')) && Number(Reflect.get(value, 'requestId')) > 0;
}

function isSaveProviderSettingsMessage(value: unknown): value is SaveProviderSettingsMessage {
  const provider = typeof value === 'object' && value !== null ? Reflect.get(value, 'provider') : undefined;
  const test = typeof value === 'object' && value !== null ? Reflect.get(value, 'test') : undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Reflect.get(value, 'type') !== 'saveProviderSettings'
    || typeof provider !== 'string' || provider.length === 0
    || (Reflect.get(value, 'displayName') !== undefined && typeof Reflect.get(value, 'displayName') !== 'string')
    || typeof Reflect.get(value, 'enabled') !== 'boolean'
    || !Number.isSafeInteger(Reflect.get(value, 'revision')) || Reflect.get(value, 'revision') < 0
    || (Reflect.get(value, 'baseURL') !== undefined && typeof Reflect.get(value, 'baseURL') !== 'string')
    || (Reflect.get(value, 'apiKey') !== undefined && typeof Reflect.get(value, 'apiKey') !== 'string')
    || (test !== undefined && typeof test !== 'boolean')) return false;
  return Object.keys(value).every(
    key => ['type', 'provider', 'displayName', 'enabled', 'baseURL', 'apiKey', 'test', 'revision'].includes(key),
  );
}

function isCreateProviderInstanceMessage(value: unknown): value is CreateProviderInstanceMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).every(key => ['type', 'family', 'displayName', 'enabled', 'baseURL', 'apiKey'].includes(key))
    && Reflect.get(value, 'type') === 'createProviderInstance'
    && typeof Reflect.get(value, 'family') === 'string' && Reflect.get(value, 'family').length > 0
    && typeof Reflect.get(value, 'displayName') === 'string' && Reflect.get(value, 'displayName').trim().length > 0
    && typeof Reflect.get(value, 'enabled') === 'boolean'
    && (Reflect.get(value, 'baseURL') === undefined || typeof Reflect.get(value, 'baseURL') === 'string')
    && (Reflect.get(value, 'apiKey') === undefined || typeof Reflect.get(value, 'apiKey') === 'string');
}

function isDeleteProviderInstanceMessage(value: unknown): value is DeleteProviderInstanceMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 5 && Reflect.get(value, 'type') === 'deleteProviderInstance'
    && ['family', 'instance', 'provider', 'displayName'].every(key => (
      typeof Reflect.get(value, key) === 'string' && Reflect.get(value, key).length > 0
    ));
}

function isSetProviderModelEnabledMessage(value: unknown): value is SetProviderModelEnabledMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).every(key => ['type', 'provider', 'model', 'enabled', 'revision'].includes(key))
    && Reflect.get(value, 'type') === 'setProviderModelEnabled'
    && typeof Reflect.get(value, 'provider') === 'string' && Reflect.get(value, 'provider').length > 0
    && typeof Reflect.get(value, 'model') === 'string' && Reflect.get(value, 'model').length > 0
    && typeof Reflect.get(value, 'enabled') === 'boolean'
    && Number.isSafeInteger(Reflect.get(value, 'revision')) && Reflect.get(value, 'revision') >= 0;
}

function isSetProviderModelsEnabledMessage(value: unknown): value is SetProviderModelsEnabledMessage {
  const models = typeof value === 'object' && value !== null ? Reflect.get(value, 'models') : undefined;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).every(key => ['type', 'provider', 'models', 'enabled', 'revision'].includes(key))
    && Reflect.get(value, 'type') === 'setProviderModelsEnabled'
    && typeof Reflect.get(value, 'provider') === 'string' && Reflect.get(value, 'provider').length > 0
    && Array.isArray(models) && models.length > 0 && models.length <= 1_000
    && new Set(models).size === models.length
    && models.every(model => typeof model === 'string' && model.length > 0)
    && typeof Reflect.get(value, 'enabled') === 'boolean'
    && Number.isSafeInteger(Reflect.get(value, 'revision')) && Reflect.get(value, 'revision') >= 0;
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
  scrollDiagnostics: vscode.Uri,
  script: vscode.Uri,
  style: vscode.Uri,
): string {
  const nonce = randomBytes(16).toString('base64');
  const transcriptStateUri = webview.asWebviewUri(transcriptState);
  const scrollDiagnosticsUri = webview.asWebviewUri(scrollDiagnostics);
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
          <div id="model-picker-header">
            <input id="model-search" type="search" aria-label="Search models" placeholder="Search models…">
            <button id="provider-settings-trigger" type="button" aria-label="Manage providers and models" title="Manage providers and models">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.7 1.5h2.6l.4 1.7 1.2.7 1.7-.5 1.3 2.2-1.3 1.2v1.4l1.3 1.2-1.3 2.2-1.7-.5-1.2.7-.4 1.7H6.7l-.4-1.7-1.2-.7-1.7.5-1.3-2.2 1.3-1.2V6.8L2.1 5.6l1.3-2.2 1.7.5 1.2-.7.4-1.7Z"/><circle cx="8" cy="8" r="2.1"/></svg>
            </button>
          </div>
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
          <div class="session-info-row session-info-title">
            <span>Title</span>
            <div class="session-info-value-with-action">
              <strong id="session-info-title">Loading…</strong>
              <button id="session-info-refresh-title" type="button" title="Generate a new title with AI">Refresh with AI</button>
            </div>
          </div>
          <div id="session-info-title-status" role="status" hidden></div>
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
  <div id="provider-settings-modal" role="dialog" aria-modal="true" aria-labelledby="provider-settings-title" hidden>
    <div id="provider-settings-backdrop"></div>
    <section id="provider-settings-surface">
      <header id="provider-settings-header">
        <div><h2 id="provider-settings-title">Providers &amp; Models</h2><p>Configure DSH routes and credentials.</p></div>
        <button id="provider-settings-close" type="button" aria-label="Close provider settings" title="Close">×</button>
      </header>
      <div id="provider-settings-toolbar">
        <input id="provider-settings-search" type="search" aria-label="Search providers and models" placeholder="Search providers and models…">
        <select id="provider-settings-filter" aria-label="Filter models">
          <option value="all">All models</option>
          <option value="enabled">Enabled models</option>
          <option value="disabled">Disabled models</option>
        </select>
      </div>
      <div id="provider-family-actions"></div>
      <div id="provider-settings-status" role="status"></div>
      <div id="provider-settings-list"></div>
    </section>
  </div>
  <script nonce="${nonce}" src="${transcriptStateUri}"></script>
  <script nonce="${nonce}" src="${scrollDiagnosticsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
