import { randomBytes, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  DSH_ORIGIN, DshClient, DshHttpError, DshSessionBrowser, PACKAGED_DSH_ORIGIN, exchangeLaunchUrl,
} from './dshClient';
import { renderMarkdown, renderPortableMarkdown } from './markdown';
import { isOpenFileMessage, resolveLocalFilePath, uriForLocalFile } from './fileLinks';
import type { OpenFileMessage } from './fileLinks';
import { isCopyTextMessage } from './clipboardMessages';
import { isLoadImageMessage, isQueueActionMessage, isStopMessage, isSubmitMessage } from './queueMessages';
import type { LoadImageMessage, QueueActionMessage, SubmitMessage } from './queueMessages';
import { isAnswerApprovalMessage } from './approvalMessages';
import type { AnswerApprovalMessage } from './approvalMessages';
import { isChatEditorState, isForkAtMessage, isForkChildId, isProvisionalForkTitle } from './forkDraft';
import type { ForkDraft } from './forkDraft';
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

interface ConnectedChat {
  readonly client: DshClient;
  readonly backendVersion: string;
  readonly cancelRender: () => void;
}

const panelMessengers = new WeakMap<vscode.WebviewPanel, WebviewMessenger>();
const panelsBySessionId = new Map<string, vscode.WebviewPanel>();
const panelFileLinks = new Map<vscode.WebviewPanel, (message: OpenFileMessage) => void>();

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
    vscode.commands.registerCommand('dshCompanion.openWebviewLink', (link: unknown) => {
      handleWebviewLink(link, 'open');
    }),
    vscode.commands.registerCommand('dshCompanion.openWebviewLinkBeside', (link: unknown) => {
      handleWebviewLink(link, 'openBeside');
    }),
    vscode.commands.registerCommand('dshCompanion.copyWebviewLink', (link: unknown) => {
      handleWebviewLink(link, 'copyLink');
    }),
    vscode.commands.registerCommand('dshCompanion.copyWebviewAbsolutePath', (link: unknown) => {
      handleWebviewLink(link, 'copyPath');
    }),
    vscode.window.registerWebviewPanelSerializer(CHAT_EDITOR_VIEW_TYPE, {
      async deserializeWebviewPanel(panel, state: unknown): Promise<void> {
        const editorState = isChatEditorState(state) ? state : undefined;
        const draft = editorState?.forkDraft;
        const candidate = draft === undefined ? undefined
          : context.workspaceState.get<unknown>(`forkDraftChild:${draft.draftId}`);
        const activatedId = isForkChildId(candidate) ? candidate : undefined;
        const boundId = activatedId ?? editorState?.sessionId;
        const storedTitle = boundId === undefined ? undefined
          : context.workspaceState.get<unknown>(`provisionalForkTitle:${boundId}`);
        const provisional = isProvisionalForkTitle(storedTitle) ? storedTitle
          : activatedId !== undefined && draft !== undefined
            ? { title: `(forked) ${draft.sourceTitle}`, atSeq: draft.atSeq } : undefined;
        if (activatedId !== undefined) {
          await context.workspaceState.update(`forkTitlePending:${activatedId}`, true);
          if (provisional !== undefined) {
            await context.workspaceState.update(`provisionalForkTitle:${activatedId}`, provisional);
          }
        }
        configureChatEditor(
          context, runtimeControl, sessionTree, runtimeProgress, panel, boundId,
          activatedId === undefined ? draft : undefined, undefined,
          provisional?.title,
          activatedId === undefined ? undefined : draft?.draftId,
          provisional?.atSeq,
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
  forkDraft?: ForkDraft,
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
  configureChatEditor(context, runtimeControl, sessionTree, runtimeProgress, panel, sessionId, forkDraft);
  return panel;
}

function activeCompanionPanel(): vscode.WebviewPanel | undefined {
  for (const panel of panelsBySessionId.values()) {
    if (panel.active) return panel;
  }
  return panelsBySessionId.values().next().value;
}

function handleWebviewLink(value: unknown, action: 'open' | 'openBeside' | 'copyLink' | 'copyPath'): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Reflect.get(value, 'webviewSection') !== 'dshCompanionLink') return;
  const kind = Reflect.get(value, 'dshCompanionLinkKind');
  const target = Reflect.get(value, 'dshCompanionLinkTarget');
  if (typeof target !== 'string' || target.length === 0 || target.length > 4096) return;
  if (kind === 'external') {
    if (action === 'openBeside' || action === 'copyPath' || !isOpenLinkMessage({ type: 'openLink', href: target })) return;
    if (action === 'copyLink') void vscode.env.clipboard.writeText(target);
    else void vscode.env.openExternal(vscode.Uri.parse(target));
    return;
  }
  if (kind !== 'file') return;
  const line = Reflect.get(value, 'dshCompanionLinkLine');
  const endLine = Reflect.get(value, 'dshCompanionLinkEndLine');
  const message = { type: 'openFile', path: target,
    ...(line === undefined ? {} : { line }), ...(endLine === undefined ? {} : { endLine }),
    action: action === 'copyLink' ? 'open' : action };
  if (!isOpenFileMessage(message)) return;
  if (action === 'copyLink') {
    const suffix = message.line === undefined ? '' : message.endLine === undefined
      ? `:${String(message.line)}` : `#L${String(message.line)}-L${String(message.endLine)}`;
    void vscode.env.clipboard.writeText(`${message.path}${suffix}`);
    return;
  }
  for (const [panel, open] of panelFileLinks) {
    if (panel.active) { open(message); return; }
  }
}

function configureChatEditor(
  context: vscode.ExtensionContext,
  runtimeControl: Promise<RuntimeControl | undefined>,
  sessionTree: SessionSidebarProvider,
  runtimeProgress: RuntimeProgress,
  panel: vscode.WebviewPanel,
  restoredSessionId?: string,
  initialForkDraft?: ForkDraft,
  initialSubmission?: SubmitMessage,
  forkTitlePlaceholder?: string,
  activationDraftId?: string,
  forkBoundarySeq?: number,
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
  let sessionCwd: string | undefined;
  let currentTitle: string | undefined;
  let pendingPlaceholder = forkTitlePlaceholder;
  if (initialForkDraft !== undefined) panel.title = `(forked) ${initialForkDraft.sourceTitle}`;
  else if (pendingPlaceholder !== undefined) panel.title = pendingPlaceholder;
  const renderTab = () => {
    if (disposed) return;
    const icon = `tab-${tabStatus.status}.svg`;
    panel.iconPath = vscode.Uri.joinPath(mediaRoot, icon);
  };
  const acknowledge = () => {
    if (initialForkDraft !== undefined) return;
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
    vscode.Uri.joinPath(mediaRoot, 'mermaid-bundle.js'),
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
  if (initialForkDraft !== undefined) post(panel, { type: 'forkDraft', draft: initialForkDraft });
  let client: DshClient | undefined;
  let cancelCurrentRender = () => {};
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
    initialForkDraft?.sourceSessionId ?? restoredSessionId,
    () => { sessionTree.requestRefresh(); },
    (sessionId, backendVersion) => {
      if (initialForkDraft !== undefined) return;
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
    (summary) => {
      if (disposed) return;
      if (summary === undefined) return;
      if (summary.cwd !== undefined) sessionCwd = summary.cwd;
      currentTitle = summary.title;
      const title = initialForkDraft !== undefined ? `(forked) ${initialForkDraft.sourceTitle}`
        : pendingPlaceholder ?? summary.title;
      panel.title = title;
      post(panel, { type: 'sessionTitle', title });
    },
    (running) => {
      if (initialForkDraft !== undefined) return;
      tabStatus.setRunning(running);
      renderTab();
      if (!running) acknowledge();
    },
    (time, reason) => {
      if (initialForkDraft !== undefined) return;
      tabStatus.end(time, reason);
      renderTab();
      acknowledge();
    },
    (seq, title) => {
      if (forkBoundarySeq === undefined || seq <= forkBoundarySeq || disposed) return;
      pendingPlaceholder = undefined;
      panel.title = title;
      post(panel, { type: 'sessionTitle', title });
      if (restoredSessionId !== undefined) {
        void context.workspaceState.update(`provisionalForkTitle:${restoredSessionId}`, undefined);
      }
    },
    initialForkDraft?.atSeq,
  ).then((connected) => {
    client = connected.client;
    cancelCurrentRender = connected.cancelRender;
    acknowledge();
    post(panel, { type: 'connected' });
    void connected.client.providerSettings().then(
      snapshot => { if (!disposed) post(panel, { type: 'providerSettings', snapshot }); },
      error => { console.warn('DSH provider settings are unavailable', error); },
    );
    if (initialSubmission !== undefined) void submitCurrent(initialSubmission).then(accepted => {
      if (!accepted) post(panel, { type: 'restoreSubmission', text: initialSubmission.text,
        images: initialSubmission.images ?? [] });
    });
    return connected.client;
  });
  const submitCurrent = async (message: SubmitMessage): Promise<boolean> => {
    const key = restoredSessionId === undefined ? undefined : `forkTitlePending:${restoredSessionId}`;
    const pending = key !== undefined && context.workspaceState.get<boolean>(key) === true;
    const prepared = pending ? ready.then(async bound => { await bound.prepareForkTitle(); return bound; }) : ready;
    const accepted = await submit(panel, prepared, message);
    if (accepted && pending && key !== undefined) {
      await context.workspaceState.update(key, undefined);
    }
    return accepted;
  };
  panelFileLinks.set(panel, message => { void openSessionFile(ready, () => sessionCwd, message); });
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
    if (isForkAtMessage(message) && initialForkDraft === undefined) {
      void ready.then(source => {
        if (!source.canForkAt(message.atSeq) || currentTitle === undefined || source.sessionId === undefined) {
          throw new Error('This completed Turn is no longer available for Fork');
        }
        const draft: ForkDraft = {
          draftId: randomUUID(), sourceSessionId: source.sessionId, atSeq: message.atSeq, sourceTitle: currentTitle,
        };
        openChatEditor(context, runtimeControl, sessionTree, runtimeProgress, undefined, draft);
      }).catch(error => vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)));
    }
    if (isSubmitMessage(message)) {
      if (initialForkDraft === undefined) void submitCurrent(message);
      else void activateForkDraft(message);
    }
    if (activationDraftId !== undefined && isSessionBoundMessage(message)
      && message.sessionId === restoredSessionId) {
      void context.workspaceState.update(`forkDraftChild:${activationDraftId}`, undefined);
    }
    if (initialForkDraft !== undefined && !isLoadOlderMessage(message) && !isLoadImageMessage(message)
      && !isOpenLinkMessage(message) && !isOpenFileMessage(message) && !isCopyTextMessage(message)) return;
    if (isStopMessage(message)) void stop(panel, ready);
    if (isQueueActionMessage(message)) void queueAction(panel, ready, message);
    if (isLoadImageMessage(message)) void loadImage(panel, ready, message);
    if (isCopySessionIdMessage(message)) void copySessionId(panel, ready);
    if (isRefreshSessionTitleMessage(message)) void refreshSessionTitle(panel, ready);
    if (isLoadOlderMessage(message)) void loadOlder(panel, ready);
    if (isSelectModelMessage(message)) void selectModel(panel, ready, message);
    if (isSelectPermissionMessage(message)) void selectPermission(panel, ready, message.preset);
    if (isAnswerApprovalMessage(message)) void answerApproval(panel, ready, message);
    if (isCompactMessage(message)) void compact(panel, ready);
    if (isRefreshProviderUsageMessage(message)) void refreshProviderUsage(panel, ready, message.provider);
    if (isLoadProviderSettingsMessage(message)) void loadProviderSettings(panel, ready, message.requestId);
    if (isSaveProviderSettingsMessage(message)) void saveProviderSettings(panel, ready, message);
    if (isCreateProviderInstanceMessage(message)) void createProviderInstance(panel, ready, message);
    if (isDeleteProviderInstanceMessage(message)) void deleteProviderInstance(panel, ready, message);
    if (isSetProviderModelEnabledMessage(message)) void setProviderModelEnabled(panel, ready, message);
    if (isSetProviderModelsEnabledMessage(message)) void setProviderModelsEnabled(panel, ready, message);
    if (isOpenLinkMessage(message)) void vscode.env.openExternal(vscode.Uri.parse(message.href));
    if (isOpenFileMessage(message)) void openSessionFile(ready, () => sessionCwd, message);
    if (isCopyTextMessage(message)) {
      const text = message.format === 'html' ? renderPortableMarkdown(message.text) : message.text;
      if (Buffer.byteLength(text, 'utf8') <= 4 * 1024 * 1024) void vscode.env.clipboard.writeText(text);
    }
  });
  let activating = false;
  let activationChildId: string | undefined;
  const activateForkDraft = async (message: SubmitMessage): Promise<void> => {
    if (initialForkDraft === undefined) return;
    if (activating) {
      post(panel, { type: 'submissionFailed', requestId: message.requestId });
      return;
    }
    activating = true;
    post(panel, { type: 'sending', value: true });
    try {
      const source = await ready;
      const key = `forkDraftChild:${initialForkDraft.draftId}`;
      const storedChild = context.workspaceState.get<unknown>(key);
      let childId = activationChildId ?? (isForkChildId(storedChild) ? storedChild : undefined);
      if (childId === undefined) {
        childId = await source.forkAt(initialForkDraft.atSeq);
        activationChildId = childId;
      }
      await context.workspaceState.update(key, childId);
      await context.workspaceState.update(`provisionalForkTitle:${childId}`, {
        title: `(forked) ${initialForkDraft.sourceTitle}`, atSeq: initialForkDraft.atSeq,
      });
      await context.workspaceState.update(`forkTitlePending:${childId}`, true);
      if (disposed) return;
      disposed = true;
      unsubscribeProgress();
      receive.dispose();
      viewState.dispose();
      messenger.dispose();
      panelMessengers.delete(panel);
      panelFileLinks.delete(panel);
      cancelCurrentRender();
      source.dispose();
      const firstMessage: SubmitMessage = { ...message, mode: 'queue' };
      configureChatEditor(context, runtimeControl, sessionTree, runtimeProgress, panel, childId, undefined,
        firstMessage, `(forked) ${initialForkDraft.sourceTitle}`, initialForkDraft.draftId, initialForkDraft.atSeq);
    } catch (error) {
      post(panel, { type: 'submissionFailed', requestId: message.requestId });
      post(panel, { type: 'error', text: error instanceof Error ? error.message : String(error) });
      post(panel, { type: 'sending', value: false });
    } finally {
      activating = false;
    }
  };
  const viewState = panel.onDidChangeViewState(({ webviewPanel }) => {
    acknowledge();
    sessionTree.setActiveSession(
      webviewPanel.active && initialForkDraft === undefined
        ? client?.sessionId ?? restoredSessionId : activeCompanionSessionId(),
    );
  });
  panel.onDidDispose(() => {
    if (disposed) return;
    restoreTrace(traceSessionId, 'panel-dispose', { panelTraceId });
    disposed = true;
    unsubscribeProgress();
    receive.dispose();
    viewState.dispose();
    messenger.dispose();
    panelMessengers.delete(panel);
    panelFileLinks.delete(panel);
    cancelCurrentRender();
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
  onSummary?: (summary: import('./dshClient').DshSessionListEntry | undefined) => void,
  onRunning?: (running: boolean) => void,
  onTurnEnd?: (time: number, reason: string) => void,
  onBranchTitle?: (seq: number, title: string) => void,
  previewAtSeq?: number,
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
      onSummary?.(summary);
    },
    branchTitle: (seq: number, title: string) => { onBranchTitle?.(seq, title); },
    reset: () => {
      cancelRender();
      streamingAssistant = '';
      post(panel, { type: 'resetTranscript' });
    },
    history: (role: 'user' | 'assistant' | 'error', text: string, time?: number, turn?: number, step?: number,
      images?: readonly import('./dshClient').DshImageAttachment[]) => post(panel, {
      type: 'message',
      role,
      text,
      ...(role === 'assistant' ? { html: renderMarkdown(text) } : {}),
      ...(time === undefined ? {} : { time }),
      ...(turn === undefined ? {} : { turn, step }),
      ...(images === undefined ? {} : { images }),
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
    userCommitted: (requestId: string | undefined, text: string, time: number, turn: number, step: number,
      images?: readonly import('./dshClient').DshImageAttachment[]) => post(panel, {
      type: 'userCommitted', requestId, text, time, turn, step, images,
    }),
  };
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  try {
    if (cookie !== undefined) {
      const client = await DshClient.connect(cookie, cwd, sink, restoredSessionId, runtime.clientModule, runtime.origin,
        previewAtSeq);
      return { client, backendVersion, cancelRender };
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
    client: await DshClient.connect(cookie, cwd, sink, restoredSessionId, runtime.clientModule, runtime.origin,
      previewAtSeq),
    backendVersion,
    cancelRender,
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

async function openSessionFile(
  ready: Promise<DshClient>,
  sessionCwd: () => string | undefined,
  message: OpenFileMessage,
): Promise<void> {
  try {
    await ready;
    const file = resolveLocalFilePath(message.path, sessionCwd());
    if (file === undefined) throw new Error('The Session working directory is unavailable for this relative file link.');
    if (message.action === 'copyPath') {
      await vscode.env.clipboard.writeText(file);
      return;
    }
    const uri = uriForLocalFile(file, vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? [],
      (root, relative) => vscode.Uri.joinPath(root, relative), absolute => vscode.Uri.file(absolute));
    const document = await vscode.workspace.openTextDocument(uri);
    const start = message.line === undefined ? undefined
      : document.validatePosition(new vscode.Position(message.line - 1, 0));
    const endLine = message.endLine === undefined ? undefined
      : Math.min(message.endLine - 1, document.lineCount - 1);
    const end = endLine === undefined ? start
      : new vscode.Position(endLine, document.lineAt(endLine).text.length);
    const selection = start === undefined || end === undefined ? undefined : new vscode.Range(start, end);
    const editor = await vscode.window.showTextDocument(document, {
      preview: true, selection,
      ...(message.action === 'openBeside' ? { viewColumn: vscode.ViewColumn.Beside } : {}),
    });
    if (selection !== undefined) editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (error) {
    await vscode.window.showErrorMessage(`DSH Companion could not open the file: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  message: SubmitMessage,
): Promise<boolean> {
  post(panel, { type: 'sending', value: true });
  try {
    const client = await ready;
    await client.prompt(message.text, message.requestId, message.mode, message.images ?? []);
    post(panel, { type: 'submissionAccepted', requestId: message.requestId });
    return true;
  } catch (error) {
    post(panel, { type: 'submissionFailed', requestId: message.requestId });
    post(panel, {
      type: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    post(panel, { type: 'sending', value: false });
  }
}

async function stop(panel: vscode.WebviewPanel, ready: Promise<DshClient>): Promise<void> {
  post(panel, { type: 'stopping', value: true });
  try {
    const result = await (await ready).stopAndClearQueue();
    for (const item of result.removed) {
      post(panel, { type: 'queueItemRemoved', itemId: item.id, requestId: item.requestId, action: 'remove' });
    }
    post(panel, { type: 'queueStopResult', failed: result.failed, cancelFailed: result.cancelFailed });
  } catch (error) {
    post(panel, {
      type: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
  } finally {
    post(panel, { type: 'stopping', value: false });
  }
}

async function answerApproval(
  panel: vscode.WebviewPanel, ready: Promise<DshClient>, message: AnswerApprovalMessage,
): Promise<void> {
  try {
    const accepted = (await ready).answerApproval(message.token, message.outcome);
    if (!accepted) post(panel, { type: 'approvalAnswerUnavailable', token: message.token });
  } catch (_error) {
    post(panel, { type: 'approvalAnswerUnavailable', token: message.token });
  }
}

async function queueAction(panel: vscode.WebviewPanel, ready: Promise<DshClient>, message: QueueActionMessage): Promise<void> {
  try {
    const client = await ready;
    if (message.action === 'steer') {
      await client.steerQueued(message.itemId);
      post(panel, { type: 'queueItemSteered', itemId: message.itemId });
      return;
    }
    const item = await client.removeQueued(message.itemId, message.action === 'takeBack');
    post(panel, {
      type: 'queueItemRemoved', itemId: item.id, requestId: item.requestId, action: message.action,
      ...(message.action === 'takeBack' ? { text: item.text, images: item.restoredImages ?? [] } : {}),
    });
  } catch (error) {
    post(panel, {
      type: 'queueActionFailed', itemId: message.itemId,
      text: error instanceof Error ? error.message : String(error),
    });
  }
}

async function loadImage(panel: vscode.WebviewPanel, ready: Promise<DshClient>, message: LoadImageMessage): Promise<void> {
  try {
    const image = await (await ready).readImage(message.attachmentId);
    post(panel, { type: 'imageLoaded', attachmentId: message.attachmentId, image });
  } catch (_error) {
    post(panel, { type: 'imageLoadFailed', attachmentId: message.attachmentId });
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

function isSessionBoundMessage(value: unknown): value is { readonly type: 'sessionBound'; readonly sessionId: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 2 && Reflect.get(value, 'type') === 'sessionBound'
    && typeof Reflect.get(value, 'sessionId') === 'string' && Reflect.get(value, 'sessionId').length > 0;
}

function editorHtml(
  webview: vscode.Webview,
  transcriptState: vscode.Uri,
  scrollDiagnostics: vscode.Uri,
  mermaidBundle: vscode.Uri,
  script: vscode.Uri,
  style: vscode.Uri,
): string {
  const nonce = randomBytes(16).toString('base64');
  const transcriptStateUri = webview.asWebviewUri(transcriptState);
  const scrollDiagnosticsUri = webview.asWebviewUri(scrollDiagnostics);
  const mermaidUri = webview.asWebviewUri(mermaidBundle);
  const scriptUri = webview.asWebviewUri(script);
  const styleUri = webview.asWebviewUri(style);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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
  <div id="fork-draft-banner" hidden>Fork draft · Source history ends at the selected turn. Your first message creates a new Session.</div>
  <div id="status" role="status">Connecting…</div>
  <form id="composer">
    <div id="image-tray" aria-label="Attached images" hidden></div>
    <div id="image-error" role="alert" hidden></div>
    <textarea id="prompt" rows="1" aria-label="Message" aria-keyshortcuts="Enter Control+Enter" title="Enter queues; Ctrl+Enter steers while a Turn is running; Shift+Enter inserts a newline" placeholder="Ask DSH Companion… (Enter sends, Ctrl+Enter = steer, Shift+Enter = newline)"></textarea>
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
        <button id="stop" type="button" aria-label="Stop and clear waiting messages" title="Stop active work and clear waiting messages">
          <span aria-hidden="true"></span>
        </button>
        <button id="send" type="submit" data-mode="send" aria-label="Send message (Enter or click)" title="Send message (Enter or click)">
          <svg class="send-icon send-icon-send" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17 17 4M8 4h9v9"/></svg>
          <svg class="send-icon send-icon-queue" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h12M4 9h12M4 13h7m0 4h6m-3-3 3 3-3 3"/></svg>
          <svg class="send-icon send-icon-steer" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17h7a5 5 0 0 0 5-5V4m-4 4 4-4 4 4"/></svg>
          <span id="send-label">Send</span>
        </button>
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
  <script nonce="${nonce}" src="${mermaidUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
