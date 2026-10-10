/** Tab-local intent to fork a completed DSH Turn on the first submission. */
export interface ForkDraft {
  readonly draftId: string;
  readonly sourceSessionId: string;
  readonly atSeq: number;
  readonly sourceTitle: string;
}

/** Session binding or deferred fork identity stored by the Webview serializer. */
export interface ChatEditorState {
  readonly version: 1 | 2 | 3;
  readonly sessionId?: string;
  readonly forkDraft?: ForkDraft;
}

/** Presentation title shown until the child records its own title. */
export interface ProvisionalForkTitle {
  readonly title: string;
  readonly atSeq: number;
}

/** DSH's minted ordinary fork identity returned by the pinned Session Remote. */
export function isForkChildId(value: unknown): value is string {
  return typeof value === 'string'
    && /^session-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

/** Validates local presentation state before restoring a child tab. */
export function isProvisionalForkTitle(value: unknown): value is ProvisionalForkTitle {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const title = value as Record<string, unknown>;
  return Object.keys(title).length === 2 && typeof title.title === 'string'
    && title.title.startsWith('(forked) ') && title.title.length > '(forked) '.length
    && title.title.length <= 521 && Number.isSafeInteger(title.atSeq) && Number(title.atSeq) >= 0;
}

/** Validates a persisted fork intent without trusting Webview state. */
export function isForkDraft(value: unknown): value is ForkDraft {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return Object.keys(draft).every(key => ['draftId', 'sourceSessionId', 'atSeq', 'sourceTitle'].includes(key))
    && typeof draft.draftId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(draft.draftId)
    && typeof draft.sourceSessionId === 'string' && draft.sourceSessionId.length > 0 && draft.sourceSessionId.length <= 256
    && Number.isSafeInteger(draft.atSeq) && Number(draft.atSeq) >= 0
    && typeof draft.sourceTitle === 'string' && draft.sourceTitle.length > 0 && draft.sourceTitle.length <= 512;
}

/** Accepts an existing tab binding or a versioned, unactivated fork intent. */
export function isChatEditorState(value: unknown): value is ChatEditorState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return (state.version === 1 || state.version === 2 || state.version === 3)
    && (state.sessionId === undefined || typeof state.sessionId === 'string'
      && state.sessionId.length > 0 && state.sessionId.length <= 256)
    && (state.forkDraft === undefined || (state.version === 3 && state.sessionId === undefined
      && isForkDraft(state.forkDraft)));
}

/** Validates the only Webview input needed to select a fork boundary. */
export function isForkAtMessage(value: unknown): value is { readonly type: 'forkAt'; readonly atSeq: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return Object.keys(message).length === 2 && message.type === 'forkAt'
    && Number.isSafeInteger(message.atSeq) && Number(message.atSeq) >= 0;
}

/** Checks the visible canonical window for the exact durable Turn end selected by the UI. */
export function hasCompletedTurnAt(entries: readonly unknown[], atSeq: number): boolean {
  return Number.isSafeInteger(atSeq) && atSeq >= 0 && entries.some(entry => {
    if (typeof entry !== 'object' || entry === null) return false;
    const row = entry as Record<string, unknown>;
    if (row.type !== 'event' || typeof row.event !== 'object' || row.event === null) return false;
    const event = row.event as Record<string, unknown>;
    return event.seq === atSeq && event.type === 'turn/end';
  });
}

/** A preview may replay only committed source events at or before its fixed cut. */
export function includesForkPreviewEvent(entry: unknown, atSeq: number): boolean {
  if (typeof entry !== 'object' || entry === null || !Number.isSafeInteger(atSeq) || atSeq < 0) return false;
  const row = entry as Record<string, unknown>;
  if (row.type !== 'event' || typeof row.event !== 'object' || row.event === null) return false;
  const event = row.event as Record<string, unknown>;
  return Number.isSafeInteger(event.seq) && Number(event.seq) >= 0 && Number(event.seq) <= atSeq;
}

/** Reads a durable title revision eligible to replace the provisional tab label after the fork cut. */
export function branchTitleRevision(value: unknown): { readonly seq: number; readonly title: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const event = value as Record<string, unknown>;
  if (event.type !== 'session/title' || !Number.isSafeInteger(event.seq) || Number(event.seq) < 0
    || typeof event.data !== 'object' || event.data === null) return undefined;
  const data = event.data as Record<string, unknown>;
  if (typeof data.title !== 'string' || data.title.length === 0
    || typeof data.source !== 'object' || data.source === null) return undefined;
  const source = data.source as Record<string, unknown>;
  if (source.kind !== 'user' && !(source.kind === 'provider'
    && source.provider === 'dsh-companion/agent-title-tool')) return undefined;
  return { seq: Number(event.seq), title: data.title };
}
