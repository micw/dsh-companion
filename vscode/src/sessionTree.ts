import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  DshSessionBrowser, type DshSessionListEntry, type DshSessionSearchResult,
} from './dshClient';
import { basename } from 'node:path';
import { sessionWorkspaceKind } from './sessionWorkspace';

interface SidebarMessage {
  readonly type: 'ready' | 'newChat' | 'refresh' | 'openSession' | 'search';
  readonly sessionId?: string;
  readonly query?: string;
}

/** Supplies the DSH-backed Session list and full-text search inside a sidebar Webview. */
export class SessionSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private browserPromise: Promise<DshSessionBrowser> | undefined;
  private browser: DshSessionBrowser | undefined;
  private view: vscode.WebviewView | undefined;
  private receive: vscode.Disposable | undefined;
  private activeSessionId: string | undefined;
  private searchRequest = 0;
  private searchController: AbortController | undefined;
  private refreshQueued = false;
  private disposed = false;
  private readonly workspaceChange = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    this.post({ type: 'workspaceChanged' });
    void this.publish();
  });

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly connect: (onDidChange: () => void) => Promise<DshSessionBrowser>,
  ) {}

  /** Configures the sidebar surface and starts its list-only canonical Client graph. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = sidebarHtml(
      view.webview,
      vscode.Uri.joinPath(mediaRoot, 'sessions.js'),
      vscode.Uri.joinPath(mediaRoot, 'sessions.css'),
    );
    this.receive?.dispose();
    this.receive = view.webview.onDidReceiveMessage((value: unknown) => {
      const message = parseSidebarMessage(value);
      if (message === undefined) return;
      if (message.type === 'ready') void this.publish();
      if (message.type === 'newChat') void vscode.commands.executeCommand('dshCompanion.newChatEditor');
      if (message.type === 'refresh') void this.refresh().catch(() => {});
      if (message.type === 'openSession' && message.sessionId !== undefined) {
        void vscode.commands.executeCommand('dshCompanion.openSession', message.sessionId);
      }
      if (message.type === 'search' && message.query !== undefined) void this.search(message.query);
    });
    view.onDidDispose(() => {
      this.receive?.dispose();
      this.receive = undefined;
      this.view = undefined;
      this.searchController?.abort();
    });
    void this.publish();
  }

  /** Re-pulls the Host-authoritative Session list and reports failures inside the view. */
  async refresh(): Promise<void> {
    this.post({ type: 'status', phase: 'refreshing', text: 'Refreshing sessions…' });
    try {
      await this.withViewProgress(async () => (await this.ensureBrowser()).refresh());
      await this.publish();
    } catch (error) {
      this.postError(error);
      throw error;
    }
  }

  /** Coalesces editor-originated list refreshes, including changes during initial connection. */
  requestRefresh(): void {
    if ((this.browser === undefined && this.browserPromise === undefined) || this.refreshQueued || this.disposed) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.disposed) return;
      const target = this.browser ?? this.browserPromise;
      if (target === undefined) return;
      void Promise.resolve(target).then(browser => browser.refresh()).then(
        () => this.publish(),
        error => { console.warn('DSH Session sidebar refresh failed', error); },
      );
    });
  }

  /** Marks the Session shown by the active Companion editor. */
  setActiveSession(sessionId: string | undefined): void {
    if (sessionId === this.activeSessionId) return;
    this.activeSessionId = sessionId;
    void this.publish();
  }

  /** Focuses the persistent sidebar search field. */
  focusSearch(): void {
    this.post({ type: 'focusSearch' });
  }

  /** Releases the list-only canonical Client graph and Webview subscription. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.searchController?.abort();
    this.receive?.dispose();
    this.workspaceChange.dispose();
    const browser = this.browser;
    if (browser !== undefined) void browser.dispose();
    else void this.browserPromise?.then(value => value.dispose(), () => {});
  }

  private async publish(): Promise<void> {
    if (this.view === undefined || this.disposed) return;
    if (this.browser === undefined && this.browserPromise === undefined) {
      this.post({ type: 'status', phase: 'connecting', text: 'Connecting to DSH…' });
    }
    try {
      const browser = this.browser ?? await this.withViewProgress(() => this.ensureBrowser());
      const snapshot = browser.snapshot();
      this.post({
        type: 'sessions',
        phase: snapshot.phase,
        activeSessionId: this.activeSessionId,
        sessions: snapshot.sessions.map(session => this.withWorkspace(session)),
      });
    } catch (error) {
      this.postError(error);
    }
  }

  private async search(value: string): Promise<void> {
    const query = value.trim();
    const request = ++this.searchRequest;
    this.searchController?.abort();
    if (query.length === 0) {
      this.post({ type: 'searchResults', query, items: [], hasMore: false });
      return;
    }
    const controller = new AbortController();
    this.searchController = controller;
    this.post({ type: 'searching', query });
    let titleMatches: DshSessionSearchResult | undefined;
    try {
      const browser = await this.ensureBrowser();
      if (request !== this.searchRequest || controller.signal.aborted) return;
      titleMatches = mergeTitleMatches(browser.snapshot().sessions, { items: [], hasMore: false }, query);
      this.post({ type: 'searchResults', query, ...titleMatches, items: titleMatches.items.map(item => this.withWorkspace(item)) });
      const result = await this.withViewProgress(() => browser.search(query, controller.signal));
      if (request !== this.searchRequest || controller.signal.aborted) return;
      const merged = mergeTitleMatches(browser.snapshot().sessions, result, query);
      this.post({ type: 'searchResults', query, ...merged, items: merged.items.map(item => this.withWorkspace(item)) });
    } catch (error) {
      if (request !== this.searchRequest || controller.signal.aborted) return;
      if (titleMatches !== undefined && titleMatches.items.length > 0) return;
      this.post({
        type: 'searchFailed', query,
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private withWorkspace<T extends DshSessionListEntry>(session: T): T & { workspaceKind: 'local' | 'foreign' | 'unknown'; workspaceLabel?: string } {
    const roots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    return {
      ...session,
      workspaceKind: sessionWorkspaceKind(session.cwd, roots),
      ...(session.cwd === undefined ? {} : { workspaceLabel: basename(session.cwd) || session.cwd }),
    };
  }

  private async ensureBrowser(): Promise<DshSessionBrowser> {
    if (this.disposed) throw new Error('The DSH Session browser is closed');
    if (this.browser !== undefined) return this.browser;
    if (this.browserPromise === undefined) {
      const pending = this.connect(() => { void this.publish(); });
      this.browserPromise = pending;
      void pending.catch(() => {
        if (this.browserPromise === pending) this.browserPromise = undefined;
      });
    }
    const browser = await this.browserPromise;
    if (this.disposed) {
      await browser.dispose();
      throw new Error('The DSH Session browser is closed');
    }
    this.browser = browser;
    return browser;
  }

  private post(message: object): void {
    void this.view?.webview.postMessage(message);
  }

  private withViewProgress<T>(task: () => Promise<T>): Promise<T> {
    return Promise.resolve(vscode.window.withProgress({ location: { viewId: 'dshCompanion.sessions' } }, task));
  }

  private postError(error: unknown): void {
    this.post({
      type: 'status', phase: 'error',
      text: error instanceof Error ? error.message : String(error),
    });
  }
}

function mergeTitleMatches(
  sessions: readonly DshSessionListEntry[],
  search: DshSessionSearchResult,
  query: string,
): DshSessionSearchResult {
  const normalized = query.toLocaleLowerCase();
  const content = new Map(search.items.map(item => [item.sessionId, item]));
  const items: (DshSessionListEntry & { snippet: string })[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    if (!session.title.toLocaleLowerCase().includes(normalized)) continue;
    const match = content.get(session.sessionId);
    items.push({ ...session, snippet: match?.snippet ?? 'Session title match' });
    seen.add(session.sessionId);
  }
  for (const item of search.items) {
    if (!seen.has(item.sessionId)) items.push(item);
  }
  return { items, hasMore: search.hasMore };
}

function parseSidebarMessage(value: unknown): SidebarMessage | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const type = Reflect.get(value, 'type');
  if (!['ready', 'newChat', 'refresh', 'openSession', 'search'].includes(String(type))) return undefined;
  const keys = Object.keys(value);
  if (type === 'openSession') {
    const sessionId = Reflect.get(value, 'sessionId');
    return keys.length === 2 && typeof sessionId === 'string' && sessionId.length > 0
      ? { type, sessionId }
      : undefined;
  }
  if (type === 'search') {
    const query = Reflect.get(value, 'query');
    return keys.length === 2 && typeof query === 'string' && query.length <= 1_000
      ? { type, query }
      : undefined;
  }
  return keys.length === 1 ? { type: type as 'ready' | 'newChat' | 'refresh' } : undefined;
}

function sidebarHtml(webview: vscode.Webview, script: vscode.Uri, style: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${webview.asWebviewUri(style)}">
  <title>DSH Sessions</title>
</head>
<body>
  <div id="search-wrap"><input id="search" type="search" aria-label="Search session questions and answers" placeholder="Search questions and answers…"><label id="all-workspaces-label"><input id="all-workspaces" type="checkbox"> Search all workspaces</label></div>
  <div id="status" role="status">Connecting to DSH…</div>
  <main id="sessions" aria-label="DSH Sessions"></main>
  <script nonce="${nonce}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
}
