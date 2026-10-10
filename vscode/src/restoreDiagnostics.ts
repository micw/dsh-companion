/** Temporary, content-free instrumentation for Session restore and Webview delivery. */

type DiagnosticChange = 'append' | 'prepend' | 'replace' | 'settle-assistant' | 'invalid';

export interface DiagnosticBatchMessage {
  readonly type: 'diagnosticBatch';
  readonly batchId: number;
  readonly processed: number;
  readonly failed: boolean;
}

const SCROLL_KINDS = new Set([
  'wheel-up', 'wheel-armed', 'native-scroll', 'frame-one', 'frame-two',
  'host-assistant-before', 'host-assistant-after', 'host-process-before', 'host-process-after',
  'host-message-before', 'host-message-after', 'host-reset-before', 'host-reset-after',
  'host-prepend-before', 'host-prepend-after', 'render-before', 'render-after',
  'render-write-before', 'render-write-after', 'bounds-before', 'bounds-after',
  'follow-write-before', 'follow-write-after', 'prepend-write-before', 'prepend-write-after',
  'mode-follow', 'mode-sticky', 'resize', 'reset-before', 'reset-after', 'prepend-start', 'prepend-end',
]);

export interface DiagnosticScrollSample {
  readonly kind: string;
  readonly ms: number;
  readonly top: number;
  readonly height: number;
  readonly viewport: number;
  readonly mode: 'follow' | 'sticky';
  readonly intent: boolean;
  readonly pointer: boolean;
  readonly batchId: number;
  readonly target: number | null;
}

export interface DiagnosticScrollMessage {
  readonly type: 'diagnosticScroll';
  readonly reason: string;
  readonly startTop: number;
  readonly samples: readonly DiagnosticScrollSample[];
}

/** Accepts only bounded scroll coordinates and fixed event names, never DOM or model content. */
export function isDiagnosticScrollMessage(value: unknown): value is DiagnosticScrollMessage {
  if (!record(value) || Object.keys(value).length !== 4 || value.type !== 'diagnosticScroll'
    || typeof value.reason !== 'string' || !SCROLL_KINDS.has(value.reason)
    || !count(value.startTop, 1_000_000_000)
    || !Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > 48) return false;
  return value.samples.every((sample: unknown) => record(sample) && Object.keys(sample).length === 10
    && typeof sample.kind === 'string' && SCROLL_KINDS.has(sample.kind)
    && count(sample.ms, 120_000) && count(sample.top, 1_000_000_000)
    && count(sample.height, 1_000_000_000) && count(sample.viewport, 1_000_000)
    && (sample.mode === 'follow' || sample.mode === 'sticky')
    && typeof sample.intent === 'boolean' && typeof sample.pointer === 'boolean'
    && count(sample.batchId, 1_000_000_000)
    && (sample.target === null || count(sample.target, 1_000_000_000)));
}

/** Validate a Webview-only delivery acknowledgment without accepting payloads. */
export function isDiagnosticBatchMessage(value: unknown): value is DiagnosticBatchMessage {
  if (!record(value) || Object.keys(value).length !== 4) return false;
  return value.type === 'diagnosticBatch'
    && typeof value.batchId === 'number' && Number.isSafeInteger(value.batchId) && value.batchId > 0
    && typeof value.processed === 'number' && Number.isSafeInteger(value.processed)
    && value.processed >= 0 && value.processed <= 64 && typeof value.failed === 'boolean';
}

interface SequenceRange {
  readonly count: number;
  readonly firstSeq?: number;
  readonly lastSeq?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown, maximum: number): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** Count committed events without examining their contents or transient chunks. */
export function sequenceRange(entries: readonly unknown[]): SequenceRange {
  let firstSeq: number | undefined;
  let lastSeq: number | undefined;
  let count = 0;
  for (const entry of entries) {
    if (!record(entry) || entry.type !== 'event' || !record(entry.event)) continue;
    const seq = entry.event.seq;
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) continue;
    if (firstSeq === undefined) firstSeq = seq;
    lastSeq = seq;
    count += 1;
  }
  return { count, ...(firstSeq === undefined ? {} : { firstSeq, lastSeq }) };
}

/** Describe an event-window update using only allowlisted structural facts. */
export function eventWindowTrace(entries: readonly unknown[], change: Record<string, unknown>, hasMore: boolean): object {
  const kind: DiagnosticChange = change.kind === 'append' || change.kind === 'prepend'
    || change.kind === 'replace' || change.kind === 'settle-assistant' ? change.kind : 'invalid';
  const changedEntries = (kind === 'append' || kind === 'prepend') && Array.isArray(change.entries)
    ? change.entries : kind === 'settle-assistant' && change.entry !== undefined ? [change.entry] : [];
  return {
    kind, hasMore, window: sequenceRange(entries),
    changed: sequenceRange(changedEntries),
  };
}

let traceSink: ((line: string) => void) | undefined;

/** Route diagnostic lines into a persistent VS Code log channel owned by activation. */
export function installRestoreTraceSink(sink: (line: string) => void): () => void {
  traceSink = sink;
  return () => { if (traceSink === sink) traceSink = undefined; };
}

/** Emit one machine-readable redacted diagnostic; never accept model or provider text here. */
export function restoreTrace(sessionId: string | undefined, event: string, facts: object): void {
  traceSink?.(`[DSH Companion restore trace] ${JSON.stringify({ sessionId: sessionId ?? null, event, ...facts })}`);
}
