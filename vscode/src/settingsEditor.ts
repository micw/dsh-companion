/** Session-independent settings editor with native unsaved-change protection. */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import * as vscode from 'vscode';
import { DSH_ORIGIN, PACKAGED_DSH_ORIGIN, DshClient, DshHttpError, exchangeLaunchUrl } from './dshClient';
import type { DshOutputSink } from './dshClient';
import type { RuntimeControl } from './runtimeControl';
import { connectRuntime } from './runtimeInstaller';
import { parseSettingsRequest } from './settingsProtocol';
import { executeSettingsOperation } from './settingsOperations';
import { parseVersionRequest } from './versionProtocol';
import { createVersionController } from './versionHost';

const VIEW_TYPE = 'dshCompanion.settingsEditor';
const RESOURCE = vscode.Uri.parse('dsh-companion-settings:/dsh-companion-settings');
const COOKIE_KEY = 'dshCompanion.developmentCookie';
const ignore = () => {};
const quietSink: DshOutputSink = {
  sessionCreated: ignore, sessionSummary: ignore, reset: ignore, history: ignore, historyPrependStart: ignore,
  historyPrependEnd: ignore, historyState: ignore, modelCatalog: ignore, modelSelection: ignore,
  contextPressure: ignore, sessionCost: ignore, providerAccounts: ignore, permissionSelection: ignore,
  compactAvailable: ignore, compaction: ignore, compacting: ignore, assistantStart: ignore,
  assistantDelta: ignore, assistantAbandoned: ignore, assistantTime: ignore, process: ignore,
  queue: ignore, running: ignore, status: ignore, submissionObserved: ignore, userCommitted: ignore,
};
class SettingsDocument implements vscode.CustomDocument {
  readonly uri = RESOURCE;
  dirty = false;
  save: (() => Promise<void>) | undefined;
  reset: (() => void) | undefined;
  dispose(): void {}
}

/** One reusable editor per Extension Host; DSH owns every committed value. */
export class SettingsEditor implements vscode.CustomEditorProvider<SettingsDocument> {
  private readonly changes = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<SettingsDocument>>();
  readonly onDidChangeCustomDocument = this.changes.event;
  private panel: vscode.WebviewPanel | undefined;
  private opening: Promise<void> | undefined;
  constructor(private readonly context: vscode.ExtensionContext, private readonly runtime: Promise<RuntimeControl | undefined>, private readonly onProvidersChanged: () => void) {
    context.subscriptions.push(this.changes, vscode.window.registerCustomEditorProvider(VIEW_TYPE, this, {
      supportsMultipleEditorsPerDocument: false, webviewOptions: { retainContextWhenHidden: true },
    }));
  }
  /** Focus the existing editor; never create a chat or a DSH Session. */
  async open(): Promise<void> {
    if (this.panel) { this.panel.reveal(this.panel.viewColumn, false); return; }
    this.opening ??= Promise.resolve(vscode.commands.executeCommand<void>('vscode.openWith', RESOURCE, VIEW_TYPE, { preview: false }));
    try { await this.opening; } finally { this.opening = undefined; }
  }
  async openCustomDocument(uri: vscode.Uri): Promise<SettingsDocument> {
    if (uri.toString() !== RESOURCE.toString()) throw new Error('DSH Companion Settings does not open files');
    return new SettingsDocument();
  }
  async saveCustomDocument(document: SettingsDocument): Promise<void> {
    if (!document.dirty) return;
    // The Custom Editor API supplies no SaveReason. Never let file autosave submit credentials.
    if (vscode.workspace.getConfiguration('files', RESOURCE).get('autoSave', 'off') !== 'off') {
      throw new Error('Apply changes with Save in the Settings editor. Automatic file saving does not apply to DSH settings.');
    }
    await document.save?.();
  }
  async saveCustomDocumentAs(): Promise<void> { throw new Error('DSH settings cannot be saved as a file'); }
  async revertCustomDocument(document: SettingsDocument): Promise<void> { document.dirty = false; document.reset?.(); }
  /** Restore only the editor identity; credentials and all unsaved drafts are deliberately excluded. */
  async backupCustomDocument(): Promise<vscode.CustomDocumentBackup> { return { id: RESOURCE.toString(), delete: ignore }; }

  async resolveCustomEditor(document: SettingsDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.panel = panel; panel.title = 'DSH Companion Settings';
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [root] };
    panel.webview.html = settingsHtml(panel.webview, root);
    let disposed = false;
    let client: DshClient | undefined;
    let stopConnection: (() => void) | undefined;
    let phase: 'connected' | 'connecting' | 'disconnected' = 'connecting';
    let generation = 0;
    let busy = false;
    let savePending: { resolve: () => void; reject: (error: Error) => void } | undefined;
    const post = (message: object) => { if (!disposed) void panel.webview.postMessage(message); };
    const version = createVersionController(this.context, snapshot => post({ type: 'versionState', snapshot }), () => document.dirty);
    const announce = () => post({ type: 'settingsConnection', phase, generation,
      authority: `${vscode.env.remoteName ? 'SSH / Remote' : 'Local'} · ${hostname()}` });
    document.reset = () => post({ type: 'settingsDiscarded' });
    document.save = () => new Promise<void>((resolve, reject) => {
      if (savePending) { reject(new Error('Settings are already being saved')); return; }
      savePending = { resolve, reject }; post({ type: 'settingsSaveDraft' });
    });
    const connect = async () => {
      if (busy || disposed) return;
      if (client && phase === 'connected') { announce(); return; }
      busy = true; phase = 'connecting'; announce();
      try {
        stopConnection?.(); stopConnection = undefined;
        await client?.dispose(); client = undefined;
        const connected = await this.connectClient();
        if (disposed) { await connected.dispose(); return; }
        client = connected;
        stopConnection = connected.watchConnection(value => {
          if (value === 'connected' && phase !== 'connected') generation++;
          phase = value; announce();
        });
      } catch {
        phase = 'disconnected'; announce();
      } finally { busy = false; }
    };
    panel.webview.onDidReceiveMessage(async (value: unknown) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
      if (Reflect.get(value, 'type') === 'settingsReady' && Object.keys(value).length === 1) {
        post({ type: 'versionState', snapshot: version.snapshot() });
        announce(); await connect(); return;
      }
      if (Reflect.get(value, 'type') === 'settingsDirty' && Object.keys(value).length === 2 && typeof Reflect.get(value, 'dirty') === 'boolean') {
        const dirty = Reflect.get(value, 'dirty') === true;
        if (dirty && !document.dirty) { document.dirty = true; this.changes.fire({ document }); }
        if (!dirty && document.dirty) {
          document.dirty = false;
          savePending?.resolve(); savePending = undefined;
          // Clear VS Code's dirty marker only for this active editor after explicit save/discard.
          if (panel.active) await vscode.commands.executeCommand('workbench.action.files.save');
        }
        return;
      }
      if (Reflect.get(value, 'type') === 'settingsSaveRejected' && Object.keys(value).length === 1) {
        savePending?.reject(new Error('Settings could not be saved')); savePending = undefined; return;
      }
      if (Reflect.get(value, 'type') === 'settingsDiscardRequest' && Object.keys(value).length === 2 && Number.isSafeInteger(Reflect.get(value, 'requestId'))) {
        const accepted = await vscode.window.showWarningMessage('Discard unsaved settings changes?', { modal: true }, 'Discard');
        post({ type: 'settingsDiscardResult', requestId: Reflect.get(value, 'requestId'), accepted: accepted === 'Discard' }); return;
      }
      if (Reflect.get(value, 'type') === 'settingsReconnect' && Object.keys(value).length === 1) { await connect(); return; }
      const update = parseVersionRequest(value);
      if (update) {
        try {
          if (update.action === 'load') await version.load(update.channel);
          else if (update.action === 'check') await version.check(update.channel);
          else await version.install(update.channel);
        } catch {
          post({ type: 'versionState', snapshot: { ...version.snapshot(), phase: 'error', canInstall: false,
            message: 'Version settings could not be updated. Close and reopen Settings, then try again.' } });
        }
        return;
      }
      const request = parseSettingsRequest(value);
      if (!request || !client || phase !== 'connected') return;
      const currentGeneration = generation;
      try {
        const result = await executeSettingsOperation(client, request.operation, async name =>
          await vscode.window.showWarningMessage(`Remove “${name}”?`, { modal: true }, 'Remove') === 'Remove');
        if (currentGeneration !== generation || phase !== 'connected') throw new Error('Connection changed');
        if ('models' in result && request.operation.kind !== 'load') this.onProvidersChanged();
        post({ type: 'settingsResult', requestId: request.requestId, generation, ...result });
      } catch {
        post({ type: 'settingsFailed', requestId: request.requestId, generation,
          text: 'The operation failed. Refresh and retry; the configuration may have changed in another window.' });
        savePending?.reject(new Error('Settings could not be saved')); savePending = undefined;
      }
    }, undefined, this.context.subscriptions);
    panel.onDidDispose(() => {
      disposed = true; version.dispose(); stopConnection?.();
      try { client?.dispose(); } catch { /* The panel is closed; contain transport teardown failure. */ }
      savePending?.reject(new Error('Settings editor closed')); savePending = undefined;
      document.save = undefined; document.reset = undefined;
      if (this.panel === panel) this.panel = undefined;
    });
  }
  private async connectClient(): Promise<DshClient> {
    let runtime = await this.runtime;
    if (!runtime) { runtime = await connectRuntime(this.context); if (runtime) this.context.subscriptions.push(runtime); }
    if (!runtime?.clientModule || ![DSH_ORIGIN, PACKAGED_DSH_ORIGIN].includes(runtime.origin)) throw new Error('DSH Runtime unavailable');
    const connect = (cookie: string) => DshClient.connect(cookie, undefined, quietSink, undefined, runtime!.clientModule!, runtime!.origin);
    const saved = await this.context.secrets.get(COOKIE_KEY);
    if (saved) {
      try { return await connect(saved); } catch (error) { if (!(error instanceof DshHttpError) || error.status !== 401) throw error; }
    }
    const cookie = await exchangeLaunchUrl(await runtime.bootstrapUrl(), runtime.origin);
    await this.context.secrets.store(COOKIE_KEY, cookie);
    return connect(cookie);
  }
}

function settingsHtml(webview: vscode.Webview, root: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const uri = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, name));
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${uri('settings-editor.css')}">
<title>DSH Companion Settings</title></head><body>
<header><h1>DSH Companion Settings</h1><span id="connection" role="status">Connecting to DSH…</span></header>
<div id="layout"><nav aria-label="Settings categories"><button data-category="models" aria-current="page">Models</button><button data-category="search">Web Search</button><button data-category="version">Version</button></nav>
<main id="content"><p>Connecting to DSH…</p></main></div>
<script nonce="${nonce}" src="${uri('settings-state.js')}"></script><script nonce="${nonce}" src="${uri('settings-editor.js')}"></script></body></html>`;
}
