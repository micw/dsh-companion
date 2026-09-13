import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

/** Fixed development DSH Web origin. */
export const DSH_ORIGIN = 'http://127.0.0.1:3081';

export class DshHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'DshHttpError';
  }
}

export type DshProcessEvent =
  | { readonly type: 'turn-start'; readonly turn: number; readonly time: number }
  | {
    readonly type: 'turn-end'; readonly turn: number; readonly time: number;
    readonly reason: string; readonly replay: boolean;
  }
  | {
    readonly type: 'reasoning'; readonly id: string; readonly turn: number;
    readonly text: string; readonly append: boolean;
  }
  | {
    readonly type: 'tool-call';
    readonly turn: number;
    readonly callId: string;
    readonly name: string;
    readonly summary: string;
    readonly detail: string;
  }
  | {
    readonly type: 'tool-result';
    readonly turn: number;
    readonly callId: string;
    readonly detail: string;
    readonly isError: boolean;
  }
  | {
    readonly type: 'context'; readonly id: string; readonly turn: number;
    readonly label: string; readonly detail: string;
  }
  | { readonly type: 'turn-summary'; readonly summary: DshTurnSummary; readonly turn: number };

export interface DshTurnSummary {
  readonly completedAt: number;
  readonly runMs: number;
  readonly reason: string;
  readonly usage?: {
    readonly uncachedInputTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly outputTokens: number;
    readonly reasoningTokens?: number;
    readonly totalTokens: number;
    readonly routes?: readonly string[];
  };
  readonly ttftMs?: number;
  readonly tokensPerSecond?: number;
}

export interface DshQueuedPrompt {
  readonly id: string;
  readonly requestId?: string;
  readonly text: string;
  readonly placement: 'queued' | 'steering' | 'context';
}

export interface DshModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

export interface DshModelCatalog {
  readonly default: DshModelSelection;
  readonly routableProviders: readonly string[];
  readonly groups: readonly {
    readonly id: string;
    readonly name: string;
    readonly models: readonly {
      readonly id: string;
      readonly name: string;
      readonly description?: string;
      readonly reasoning?: {
        readonly efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[];
        readonly defaultEffort?: string;
      };
    }[];
  }[];
  readonly failures: readonly { readonly id: string; readonly name: string; readonly message: string }[];
}

export interface DshModelSelectionState {
  readonly watermark: number;
  readonly current: DshModelSelection;
}

export interface DshContextPressure {
  readonly pressureTokens?: number;
  readonly projectedTokens?: number;
  readonly contextWindow?: number;
}

export interface DshContextPressureState {
  readonly watermark: number;
  readonly current?: DshContextPressure;
}

export interface DshCompactResult {
  readonly kind: 'success' | 'error';
  readonly text?: string;
}

export type DshCompactionEvent =
  | { readonly type: 'start'; readonly id: string; readonly time: number }
  | { readonly type: 'summary'; readonly id: string; readonly itemCount: number; readonly tokenCount: number }
  | { readonly type: 'end'; readonly id: string; readonly time: number; readonly error?: string };

export interface DshOutputSink {
  history(role: 'user' | 'assistant' | 'error', text: string, time?: number): void;
  historyPrependStart(): void;
  historyPrependEnd(): void;
  historyState(hasMore: boolean): void;
  modelCatalog(catalog: DshModelCatalog): void;
  modelSelection(selection: DshModelSelection): void;
  contextPressure(pressure: DshContextPressure | undefined): void;
  compactAvailable(value: boolean): void;
  compaction(event: DshCompactionEvent): void;
  compacting(value: boolean): void;
  assistantStart(): void;
  assistantDelta(text: string): void;
  assistantTime(time: number): void;
  process(event: DshProcessEvent): void;
  queue(items: readonly DshQueuedPrompt[]): void;
  running(value: boolean): void;
  status(text: string): void;
  userCommitted(requestId: string | undefined, text: string, time: number, turn: number): void;
}

interface RpcSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

interface RpcFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

type RpcResult<T> = RpcSuccess<T> | RpcFailure;

interface UsageSample {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly route?: string;
  readonly decodeMs?: number;
}

interface DshHistoryPage {
  readonly records: readonly unknown[];
  readonly hasMore: boolean;
}

export interface PreviousPromptBatch {
  readonly records: readonly unknown[];
  readonly hasMore: boolean;
}

/** Validates one DSH model catalog and returns detached display data. */
export function parseModelCatalog(value: unknown): DshModelCatalog {
  if (!isRecord(value) || !Array.isArray(value.routableProviders)
    || !Array.isArray(value.groups) || !Array.isArray(value.failures)) {
    throw new Error('DSH returned an invalid model catalog');
  }
  const groups = value.groups.map((group) => {
    if (!isRecord(group) || typeof group.id !== 'string' || typeof group.name !== 'string'
      || !Array.isArray(group.models)) throw new Error('DSH returned an invalid model provider group');
    return { id: group.id, name: group.name, models: group.models.map(parseCatalogModel) };
  });
  const failures = value.failures.map((failure) => {
    if (!isRecord(failure) || typeof failure.id !== 'string' || typeof failure.name !== 'string'
      || typeof failure.message !== 'string') throw new Error('DSH returned an invalid model catalog failure');
    return { id: failure.id, name: failure.name, message: failure.message };
  });
  return {
    default: parseModelSelection(value.default),
    routableProviders: value.routableProviders.map(requireString),
    groups,
    failures,
  };
}

/** Applies a durable model-selection projection unless its watermark is stale. */
export function advanceModelSelection(
  state: DshModelSelectionState,
  projection: unknown,
  watermark: number,
  fallback: DshModelSelection,
): DshModelSelectionState {
  if (!Number.isSafeInteger(watermark) || watermark < -1) {
    throw new Error('DSH returned an invalid model-selection watermark');
  }
  if (watermark < state.watermark) return state;
  if (projection === undefined) return { watermark, current: { ...fallback } };
  if (!isRecord(projection) || !Object.hasOwn(projection, 'lastUsed') || !Object.hasOwn(projection, 'next')) {
    throw new Error('DSH returned an invalid model-selection projection');
  }
  const lastUsed = projection.lastUsed === null ? null : parseModelSelection(projection.lastUsed);
  const next = projection.next === null ? null : parseModelSelection(projection.next);
  return { watermark, current: { ...(next ?? lastUsed ?? fallback) } };
}

/** Applies a validated context-pressure projection unless its watermark is stale. */
export function advanceContextPressure(
  state: DshContextPressureState,
  projection: unknown,
  watermark: number,
): DshContextPressureState {
  if (!Number.isSafeInteger(watermark) || watermark < -1) {
    throw new Error('DSH returned an invalid context-pressure watermark');
  }
  if (watermark < state.watermark) return state;
  if (projection === undefined) return { watermark };
  if (!isRecord(projection)) throw new Error('DSH returned an invalid context-pressure projection');
  const pressureTokens = optionalCount(projection.pressureTokens, 'pressureTokens');
  const projectedTokens = optionalCount(projection.projectedTokens, 'projectedTokens');
  const contextWindow = optionalCount(projection.contextWindow, 'contextWindow', true);
  return {
    watermark,
    current: {
      ...(pressureTokens === undefined ? {} : { pressureTokens }),
      ...(projectedTokens === undefined ? {} : { projectedTokens }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
    },
  };
}

/** Projects one durable DSH compaction lifecycle event for transcript presentation. */
export function parseCompactionEvent(value: unknown): DshCompactionEvent | undefined {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.compactionId !== 'string') return undefined;
  if (value.type === 'compaction/start' && typeof value.time === 'number') {
    return { type: 'start', id: value.data.compactionId, time: value.time };
  }
  if (value.type === 'compaction/summary' && Array.isArray(value.data.shadowedSeqs)
    && isCount(value.data.shadowedTokenCount)) {
    return {
      type: 'summary',
      id: value.data.compactionId,
      itemCount: value.data.shadowedSeqs.length,
      tokenCount: value.data.shadowedTokenCount,
    };
  }
  if (value.type === 'compaction/end' && typeof value.time === 'number'
    && (value.data.error === undefined || typeof value.data.error === 'string')) {
    return {
      type: 'end',
      id: value.data.compactionId,
      time: value.time,
      ...(value.data.error === undefined ? {} : { error: value.data.error }),
    };
  }
  return undefined;
}

/** Reads a contiguous older batch that starts at the nearest available human-prompt Turn. */
export async function collectPreviousPromptBatch(
  beforeSeq: number,
  throughSeq: number,
  readPage: (beforeSeq: number, throughSeq: number) => Promise<DshHistoryPage>,
): Promise<PreviousPromptBatch> {
  let cursor = beforeSeq;
  let hasMore = true;
  let records: readonly unknown[] = [];
  while (hasMore) {
    const page = await readPage(cursor, throughSeq);
    const pageRecords = validHistoryRecords(page.records);
    if (pageRecords.length === 0) return { records, hasMore: false };
    records = [...pageRecords, ...records];
    hasMore = page.hasMore;
    const nextCursor = historyRecordSeq(pageRecords[0]);
    if (nextCursor >= cursor) throw new Error('DSH Session history paging made no backwards progress');
    cursor = nextCursor;
    const promptIndex = findLastRecordIndex(records, isHumanPromptRecord);
    if (promptIndex < 0) continue;
    const turnStartIndex = findLastRecordIndex(records, (record, index) => (
      index <= promptIndex && isTurnStartRecord(record)
    ));
    if (turnStartIndex < 0 && hasMore) continue;
    const start = turnStartIndex < 0 ? 0 : turnStartIndex;
    return { records: records.slice(start), hasMore: hasMore || start > 0 };
  }
  return { records, hasMore: false };
}

export class TurnStats {
  private readonly stepStarts = new Map<number, number>();
  private readonly firstTokens = new Map<number, number>();
  private readonly attempts: UsageSample[] = [];
  private route: string | undefined;

  constructor(readonly startedAt: number) {}

  startStep(step: number, time: number): void {
    this.stepStarts.set(step, time);
  }

  selectRoute(provider: unknown, model: unknown): void {
    this.route = typeof provider === 'string' && typeof model === 'string'
      ? `${provider}/${model}`
      : undefined;
  }

  firstToken(step: number, time: unknown): void {
    if (typeof time === 'number' && !this.firstTokens.has(step)) this.firstTokens.set(step, time);
  }

  addAttempt(step: number, completedAt: unknown, usage: unknown, route = this.route): void {
    const normalized = normalizeUsage(usage, route);
    if (normalized === undefined) return;
    const firstToken = this.firstTokens.get(step);
    const decodeMs = firstToken === undefined || typeof completedAt !== 'number'
      ? undefined
      : Math.max(0, completedAt - firstToken);
    this.attempts.push({ ...normalized, ...(decodeMs === undefined ? {} : { decodeMs }) });
  }

  finish(completedAt: number, reason: string): DshTurnSummary {
    const usage = aggregateUsage(this.attempts);
    const firstStep = [...this.stepStarts.keys()].sort((left, right) => left - right)[0];
    const stepStart = firstStep === undefined ? undefined : this.stepStarts.get(firstStep);
    const firstToken = firstStep === undefined ? undefined : this.firstTokens.get(firstStep);
    const ttftMs = stepStart === undefined || firstToken === undefined
      ? undefined
      : Math.max(0, firstToken - stepStart);
    const decoded = this.attempts.filter(
      (attempt): attempt is UsageSample & { decodeMs: number } => attempt.decodeMs !== undefined,
    );
    const decodeMs = decoded.reduce((sum, attempt) => sum + attempt.decodeMs, 0);
    const decodeTokens = decoded.reduce((sum, attempt) => sum + attempt.outputTokens, 0);
    const tokensPerSecond = decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : undefined;
    return {
      completedAt,
      runMs: Math.max(0, completedAt - this.startedAt),
      reason,
      ...(usage === undefined ? {} : { usage }),
      ...(ttftMs === undefined ? {} : { ttftMs }),
      ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
    };
  }
}

/** Minimal client for one Session on the fixed development DSH instance. */
export class DshClient {
  private readonly socket: WebSocket;
  private readonly streamId = randomUUID();
  private readonly controlStreamId = randomUUID();
  readonly sessionId: string;
  private disposed = false;
  private hasLiveAssistantText = false;
  private lastReportedError: string | undefined;
  private currentTurn = 0;
  private currentStep = 0;
  private turnStats: TurnStats | undefined;
  private historyThroughSeq = -1;
  private historyBaseSeq = 0;
  private historyHasMore = false;
  private loadingOlder: Promise<void> | undefined;
  private receiveQueue = Promise.resolve();
  private readonly modelLabels: ReadonlyMap<string, string>;
  private modelSelectionState: DshModelSelectionState;
  private contextPressureState: DshContextPressureState = { watermark: -1 };
  private readonly activeCompactions = new Set<string>();
  private readonly activeCompactionCommands = new Set<string>();
  private streamReadyResolve: (() => void) | undefined;
  private streamReadyReject: ((error: Error) => void) | undefined;

  private constructor(
    private readonly cookie: string,
    sessionId: string,
    private readonly sink: DshOutputSink,
    private readonly modelCatalogValue: DshModelCatalog,
  ) {
    this.sessionId = sessionId;
    this.modelLabels = modelLabelMap(modelCatalogValue);
    this.modelSelectionState = { watermark: -1, current: { ...modelCatalogValue.default } };
    const websocketUrl = new URL('/api/remote.mux', DSH_ORIGIN);
    websocketUrl.protocol = 'ws:';
    this.socket = new WebSocket(websocketUrl, {
      headers: { cookie },
      origin: DSH_ORIGIN,
    });
    this.socket.on('message', (data) => {
      this.receiveQueue = this.receiveQueue
        .then(() => this.receive(String(data)))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.rejectStreamReady(error instanceof Error ? error : new Error(message));
          this.sink.status(message);
        });
    });
    this.socket.on('close', () => {
      this.rejectStreamReady(new Error('DSH closed the Session stream before it became ready'));
      if (!this.disposed) this.sink.status('Disconnected');
    });
    this.socket.on('error', (error) => {
      this.rejectStreamReady(error);
      if (!this.disposed) this.sink.status(`Connection error: ${error.message}`);
    });
  }

  /** Creates or restores a Session and opens its live event stream. */
  static async connect(
    cookie: string,
    cwd: string | undefined,
    sink: DshOutputSink,
    restoredSessionId?: string,
  ): Promise<DshClient> {
    sink.status('Connecting to DSH…');
    await rpc(cookie, 'session/list', { _request: {} });
    const modelCatalog = parseModelCatalog(await rpc(cookie, 'session/modelCatalog', {}));
    const sessionId = restoredSessionId ?? (await rpc<{ sessionId: string }>(cookie, 'session/create', {
        request: cwd === undefined ? {} : { cwd },
      })).sessionId;
    const commands: unknown = await rpc(cookie, 'commands/list', { agentId: sessionId });
    if (!Array.isArray(commands) || !commands.every((command) => (
      isRecord(command) && typeof command.name === 'string'
    ))) throw new Error('DSH returned an invalid command catalog');
    const client = new DshClient(cookie, sessionId, sink, modelCatalog);
    sink.modelCatalog(modelCatalog);
    sink.modelSelection(modelCatalog.default);
    sink.compactAvailable(commands.some((command) => command.name === 'compact'));
    await client.open();
    sink.status('Connected');
    return client;
  }

  /** Sends one text prompt to this editor's Session. */
  async prompt(text: string, requestId: string): Promise<void> {
    this.lastReportedError = undefined;
    await rpc(this.cookie, 'session/prompt', {
      request: {
        requestId,
        sessionId: this.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  }

  /** Cancels the active turn while retaining pending DSH inbox work. */
  async cancel(): Promise<void> {
    await rpc(this.cookie, 'session/cancel', { request: { sessionId: this.sessionId } });
  }

  /** Selects one DSH provider, model, and optional reasoning effort for this Session. */
  async selectModel(selection: DshModelSelection): Promise<void> {
    const value: unknown = await rpc(this.cookie, 'session/selectModel', {
      request: { sessionId: this.sessionId, ...selection },
    });
    if (!isRecord(value) || !isRecord(value.selected)) {
      throw new Error('DSH returned an invalid model-selection response');
    }
    parseModelSelection(value.selected);
  }

  /** Runs DSH's canonical argument-free `/compact` command for this Session. */
  async compact(): Promise<DshCompactResult> {
    const value: unknown = await rpc(this.cookie, 'commands/execute', {
      agentId: this.sessionId,
      line: '/compact',
      submittedAttachments: [],
    });
    if (!isRecord(value) || typeof value.commandId !== 'string' || !isRecord(value.result)
      || !['success', 'error'].includes(String(value.result.kind))
      || (value.result.text !== undefined && typeof value.result.text !== 'string')) {
      throw new Error('DSH returned an invalid compact command response');
    }
    return {
      kind: value.result.kind as DshCompactResult['kind'],
      ...(value.result.text === undefined ? {} : { text: value.result.text }),
    };
  }

  /** Loads enough older DSH history to expose the next human prompt above the current window. */
  loadOlder(): Promise<void> {
    if (!this.historyHasMore) return Promise.resolve();
    if (this.loadingOlder !== undefined) return this.loadingOlder;
    const loading = this.loadOlderBatch().finally(() => {
      if (this.loadingOlder === loading) this.loadingOlder = undefined;
    });
    this.loadingOlder = loading;
    return loading;
  }

  dispose(): void {
    this.disposed = true;
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'cancel', streamId: this.streamId }));
      this.socket.send(JSON.stringify({ type: 'cancel', streamId: this.controlStreamId }));
    }
    this.socket.close();
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.streamReadyResolve = resolve;
      this.streamReadyReject = reject;
      this.socket.once('open', () => {
        this.socket.send(JSON.stringify({
          type: 'open',
          streamId: this.streamId,
          endpoint: 'session/follow',
          payload: {
            args: {
              request: {
                address: { kind: 'session', sessionId: this.sessionId },
                maxMessages: 50,
                assistantStream: true,
              },
            },
          },
        }));
        this.socket.send(JSON.stringify({
          type: 'open',
          streamId: this.controlStreamId,
          endpoint: 'session/control',
          payload: { args: {} },
        }));
      });
    });
  }

  private async receive(text: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.sink.status('DSH sent an invalid stream frame');
      return;
    }
    if (!isRecord(message)) return;
    if (message.streamId === this.controlStreamId) {
      if (message.type === 'item' && isRecord(message.value)) this.receiveControlFrame(message.value);
      return;
    }
    if (message.streamId !== this.streamId) return;
    if (message.type === 'error' && isRecord(message.error)) {
      const error = new Error(`DSH stream error: ${String(message.error.message ?? 'unknown error')}`);
      this.rejectStreamReady(error);
      this.sink.status(error.message);
      return;
    }
    if (message.type !== 'item' || !isRecord(message.value)) return;
    await this.receiveFollowFrame(message.value);
    this.resolveStreamReady();
  }

  private receiveControlFrame(frame: Record<string, unknown>): void {
    if (frame.type === 'baseline' && isRecord(frame.value) && isRecord(frame.value.queues)
      && isRecord(frame.value.projections)) {
      this.sink.queue(parseQueueItems(frame.value.queues[this.sessionId]));
      const projection = frame.value.projections[this.sessionId];
      if (projection !== undefined) this.receiveProjectionBlock(projection);
      return;
    }
    if (frame.type === 'queue' && frame.sessionId === this.sessionId) {
      this.sink.queue(parseQueueItems(frame.items));
      return;
    }
    if (frame.type === 'projection' && frame.sessionId === this.sessionId && typeof frame.seq === 'number') {
      if (frame.key === 'modelSelection') this.acceptModelSelection(frame.value, frame.seq);
      if (frame.key === 'contextPressure') this.acceptContextPressure(frame.value, frame.seq);
    }
  }

  private receiveProjectionBlock(value: unknown): void {
    if (!isRecord(value) || !Number.isSafeInteger(value.asOfSeq) || !isRecord(value.values)) {
      throw new Error('DSH returned an invalid Session projection baseline');
    }
    this.acceptModelSelection(value.values.modelSelection, value.asOfSeq as number);
    this.acceptContextPressure(value.values.contextPressure, value.asOfSeq as number);
  }

  private acceptModelSelection(projection: unknown, watermark: number): void {
    const next = advanceModelSelection(
      this.modelSelectionState,
      projection,
      watermark,
      this.modelCatalogValue.default,
    );
    if (next === this.modelSelectionState) return;
    this.modelSelectionState = next;
    this.sink.modelSelection(next.current);
  }

  private acceptContextPressure(projection: unknown, watermark: number): void {
    const next = advanceContextPressure(this.contextPressureState, projection, watermark);
    if (next === this.contextPressureState) return;
    this.contextPressureState = next;
    this.sink.contextPressure(next.current);
  }

  private resolveStreamReady(): void {
    const resolve = this.streamReadyResolve;
    this.streamReadyResolve = undefined;
    this.streamReadyReject = undefined;
    resolve?.();
  }

  private rejectStreamReady(error: Error): void {
    const reject = this.streamReadyReject;
    this.streamReadyResolve = undefined;
    this.streamReadyReject = undefined;
    reject?.(error);
  }

  private async receiveFollowFrame(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === 'snapshot' && Array.isArray(frame.records)) {
      if (!Number.isSafeInteger(frame.cursor) || (frame.cursor as number) < -1
        || typeof frame.hasMore !== 'boolean' || !isRecord(frame.projections)) {
        throw new Error('DSH returned an invalid Session history snapshot');
      }
      this.receiveProjectionBlock(frame.projections);
      const records = validHistoryRecords(frame.records);
      const lastRecord = records.at(-1);
      this.historyThroughSeq = typeof frame.cursor === 'number'
        ? frame.cursor
        : lastRecord === undefined ? -1 : historyRecordSeq(lastRecord);
      this.historyBaseSeq = records[0] === undefined ? 0 : historyRecordSeq(records[0]);
      this.historyHasMore = frame.hasMore === true;
      let openingRecords: readonly unknown[] = records;
      if (this.historyHasMore) {
        const older = await this.readPreviousPromptBatch(this.historyBaseSeq);
        openingRecords = [...older.records, ...openingRecords];
        this.historyHasMore = older.hasMore;
        if (older.records[0] !== undefined) this.historyBaseSeq = historyRecordSeq(older.records[0]);
      }
      for (const record of openingRecords) this.receiveHistoryRecord(record, true);
      this.sink.compacting(this.compactionActive());
      if (isRecord(frame.assistantStream) && isRecord(frame.assistantStream.activeAttempt)
        && Array.isArray(frame.assistantStream.activeAttempt.stream)) {
        if (typeof frame.assistantStream.activeAttempt.turn === 'number') {
          this.currentTurn = frame.assistantStream.activeAttempt.turn;
        }
        if (typeof frame.assistantStream.activeAttempt.step === 'number') {
          this.currentStep = frame.assistantStream.activeAttempt.step;
        }
        this.sink.assistantStart();
        for (const item of frame.assistantStream.activeAttempt.stream) {
          if (isRecord(item) && item.type === 'chunk' && isRecord(item.chunk)) {
            this.receiveAssistantChunk(item.chunk, item.time);
          }
        }
      }
      this.sink.historyState(this.historyHasMore);
      return;
    }
    if (frame.type === 'assistant-stream' && isRecord(frame.frame)) {
      if (frame.frame.type === 'start') {
        if (typeof frame.frame.turn === 'number') this.currentTurn = frame.frame.turn;
        if (typeof frame.frame.step === 'number') this.currentStep = frame.frame.step;
        this.sink.assistantStart();
        return;
      }
      if (frame.frame.type === 'chunk' && isRecord(frame.frame.chunk)) {
        this.receiveAssistantChunk(frame.frame.chunk, frame.frame.time);
      }
    }
    if (frame.type === 'event') this.receiveHistoryRecord(frame, false);
  }

  private async loadOlderBatch(): Promise<void> {
    const batch = await this.readPreviousPromptBatch(this.historyBaseSeq);
    if (batch.records.length > 0) {
      const saved = {
        currentTurn: this.currentTurn,
        currentStep: this.currentStep,
        turnStats: this.turnStats,
        hasLiveAssistantText: this.hasLiveAssistantText,
      };
      this.sink.historyPrependStart();
      try {
        for (const record of batch.records) this.receiveHistoryRecord(record, true, true);
      } finally {
        this.currentTurn = saved.currentTurn;
        this.currentStep = saved.currentStep;
        this.turnStats = saved.turnStats;
        this.hasLiveAssistantText = saved.hasLiveAssistantText;
        this.sink.historyPrependEnd();
      }
      this.historyBaseSeq = historyRecordSeq(batch.records[0]);
    }
    this.historyHasMore = batch.hasMore;
    this.sink.historyState(this.historyHasMore);
  }

  private readPreviousPromptBatch(beforeSeq: number): Promise<PreviousPromptBatch> {
    return collectPreviousPromptBatch(beforeSeq, this.historyThroughSeq, async (pageBeforeSeq, throughSeq) => {
      const page: unknown = await rpc(this.cookie, 'session/page', {
        request: {
          address: { kind: 'session', sessionId: this.sessionId },
          throughSeq,
          beforeSeq: pageBeforeSeq,
          maxMessages: 50,
        },
      });
      if (!isRecord(page) || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') {
        throw new Error('DSH returned an invalid Session history page');
      }
      return { records: validHistoryRecords(page.records), hasMore: page.hasMore };
    });
  }

  private receiveAssistantChunk(chunk: Record<string, unknown>, time: unknown): void {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      if (chunk.text.trim() !== '') this.turnStats?.firstToken(this.currentStep, time);
      this.hasLiveAssistantText = true;
      this.sink.assistantDelta(chunk.text);
      return;
    }
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      if (chunk.text.trim() !== '') this.turnStats?.firstToken(this.currentStep, time);
      this.sink.process({
        type: 'reasoning',
        id: reasoningDisclosureId(this.currentTurn, this.currentStep, chunk.index),
        turn: this.currentTurn,
        text: chunk.text,
        append: true,
      });
      return;
    }
    this.receiveFinish(chunk);
  }

  private receiveHistoryRecord(record: unknown, fromSnapshot: boolean, older = false): void {
    if (!isRecord(record) || record.type !== 'event' || !isRecord(record.event)) return;
    const event = record.event;
    if (!isRecord(event.data)) return;

    if (event.type === 'turn/start' && typeof event.data.turn === 'number') {
      this.currentTurn = event.data.turn;
      const startedAt = typeof event.time === 'number' ? event.time : Date.now();
      this.turnStats = new TurnStats(startedAt);
      this.sink.process({
        type: 'turn-start',
        turn: this.currentTurn,
        time: startedAt,
      });
      if (!older) this.sink.running(true);
      return;
    }

    if (event.type === 'step/start' && typeof event.data.step === 'number') {
      this.currentStep = event.data.step;
      if (typeof event.time === 'number') this.turnStats?.startStep(this.currentStep, event.time);
      return;
    }

    if (event.type === 'request/header' && isRecord(event.data.header)
      && isRecord(event.data.header.config)) {
      const { provider, model } = event.data.header.config;
      this.turnStats?.selectRoute(provider, model);
      if (!older && typeof provider === 'string' && typeof model === 'string') {
        this.sink.status(`${this.modelLabels.get(`${provider}\0${model}`) ?? `${provider}/${model}`} responding…`);
      }
      return;
    }

    if (event.type === 'turn/end' && typeof event.data.turn === 'number') {
      if (isRecord(event.data.reason) && event.data.reason.kind === 'error'
        && isRecord(event.data.reason.error) && typeof event.data.reason.error.message === 'string') {
        this.reportError(event.data.reason.error.message);
      }
      const completedAt = typeof event.time === 'number' ? event.time : Date.now();
      const reason = isRecord(event.data.reason) && typeof event.data.reason.kind === 'string'
        ? event.data.reason.kind
        : 'completed';
      if (this.turnStats !== undefined) {
        this.sink.process({
          type: 'turn-summary',
          turn: event.data.turn,
          summary: this.turnStats.finish(completedAt, reason),
        });
      }
      this.sink.process({
        type: 'turn-end',
        turn: event.data.turn,
        time: completedAt,
        reason,
        replay: fromSnapshot,
      });
      this.turnStats = undefined;
      if (!older) this.sink.running(false);
      return;
    }

    const compaction = parseCompactionEvent(event);
    if (compaction !== undefined) {
      if (!older && compaction.type === 'start') {
        this.activeCompactions.add(compaction.id);
        if (typeof event.data.sourceCommandId === 'string') {
          this.activeCompactionCommands.add(event.data.sourceCommandId);
        }
      }
      if (!older && compaction.type === 'end') this.activeCompactions.delete(compaction.id);
      this.sink.compaction(compaction);
      if (!older && !fromSnapshot && compaction.type !== 'summary') {
        this.sink.compacting(this.compactionActive());
      }
      return;
    }

    if (event.type === 'command/done' && typeof event.data.commandId === 'string'
      && !older && this.activeCompactionCommands.delete(event.data.commandId)) {
      if (!fromSnapshot) this.sink.compacting(this.compactionActive());
      return;
    }

    if (event.type === 'user/message') {
      if (isRecord(event.data.source) && event.data.source.kind !== 'user') {
        if (event.data.source.kind === 'plugin' && event.data.source.plugin === 'compact') return;
        this.sink.process({
          type: 'context',
          id: `turn:${String(this.currentTurn)}:context:${String(event.seq)}`,
          turn: this.currentTurn,
          label: typeof event.data.source.plugin === 'string'
            ? event.data.source.plugin
            : 'Context injection',
          detail: contentText(event.data.content),
        });
      } else if (fromSnapshot) {
        emitContent(this.sink, 'user', event.data.content, event.time);
      } else {
        const requestId = isRecord(event.data.source) && typeof event.data.source.rpcId === 'string'
          ? event.data.source.rpcId
          : undefined;
        this.sink.userCommitted(
          requestId,
          contentText(event.data.content),
          typeof event.time === 'number' ? event.time : Date.now(),
          this.currentTurn,
        );
      }
      return;
    }

    if (event.type === 'assistant/message' && isRecord(event.data.message)) {
      const step = typeof event.data.step === 'number' ? event.data.step : this.currentStep;
      this.turnStats?.firstToken(step, firstVisibleStreamTime(event.data.stream));
      const source = isRecord(event.data.message.source) ? event.data.message.source : undefined;
      const route = typeof source?.provider === 'string' && typeof source.model === 'string'
        ? `${source.provider}/${source.model}`
        : undefined;
      this.turnStats?.addAttempt(
        step,
        event.time,
        event.data.usage ?? usageFromStream(event.data.stream),
        route,
      );
      if (fromSnapshot && Array.isArray(event.data.message.content)) {
        for (const [index, block] of event.data.message.content.entries()) {
          if (isRecord(block) && block.type === 'reasoning' && typeof block.text === 'string') {
            this.sink.process({
              type: 'reasoning',
              id: reasoningDisclosureId(
                this.currentTurn,
                typeof event.data.step === 'number' ? event.data.step : this.currentStep,
                index,
              ),
              turn: this.currentTurn,
              text: block.text,
              append: false,
            });
          }
        }
      }
      if (this.hasLiveAssistantText) {
        this.hasLiveAssistantText = false;
        if (typeof event.time === 'number') this.sink.assistantTime(event.time);
        return;
      }
      emitContent(this.sink, 'assistant', event.data.message.content, event.time);
      return;
    }

    if (event.type === 'tool/call'
      && typeof event.data.turn === 'number'
      && typeof event.data.callId === 'string'
      && typeof event.data.name === 'string') {
      const detail = typeof event.data.arguments === 'string'
        ? event.data.arguments
        : JSON.stringify(event.data.arguments, null, 2);
      this.sink.process({
        type: 'tool-call',
        turn: event.data.turn,
        callId: event.data.callId,
        name: event.data.name,
        summary: toolSummary(event.data.name, detail),
        detail,
      });
      return;
    }

    if (event.type === 'tool/result' && isRecord(event.data.message)
      && isRecord(event.data.message.source) && typeof event.data.message.source.callId === 'string') {
      const first = Array.isArray(event.data.message.content) ? event.data.message.content[0] : undefined;
      this.sink.process({
        type: 'tool-result',
        turn: this.currentTurn,
        callId: event.data.message.source.callId,
        detail: isRecord(first) ? contentText(first.content) : '',
        isError: isRecord(first) && first.isError === true,
      });
      return;
    }

    if (event.type === 'assistant/attempt' && Array.isArray(event.data.stream)) {
      const step = typeof event.data.step === 'number' ? event.data.step : this.currentStep;
      this.turnStats?.firstToken(step, firstVisibleStreamTime(event.data.stream));
      this.turnStats?.addAttempt(step, event.time, usageFromStream(event.data.stream));
      for (const item of event.data.stream) {
        if (isRecord(item) && item.type === 'chunk' && isRecord(item.chunk)) {
          this.receiveFinish(item.chunk);
        }
      }
    }
  }

  private compactionActive(): boolean {
    return this.activeCompactions.size > 0 || this.activeCompactionCommands.size > 0;
  }

  private receiveFinish(chunk: Record<string, unknown>): void {
    if (chunk.type !== 'finish' || !isRecord(chunk.reason) || !isRecord(chunk.reason.failure)
      || typeof chunk.reason.failure.message !== 'string') return;
    this.reportError(chunk.reason.failure.message);
  }

  private reportError(message: string): void {
    if (message === this.lastReportedError) return;
    this.lastReportedError = message;
    this.sink.history('error', message);
    this.sink.status('Request failed');
  }
}

/** Exchanges a DSH launch URL for the authority-bound browser cookie. */
export async function exchangeLaunchUrl(launchUrl: string): Promise<string> {
  const url = new URL(launchUrl);
  if (url.origin !== DSH_ORIGIN || url.pathname !== '/' || !url.searchParams.has('token')) {
    throw new Error(`Expected the launch URL printed by DSH for ${DSH_ORIGIN}`);
  }
  const response = await fetch(url, { method: 'GET', redirect: 'manual' });
  if (response.status !== 303) {
    throw new DshHttpError(response.status, `DSH authentication failed with HTTP ${response.status}`);
  }
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie?.split(';', 1)[0];
  if (cookie === undefined || cookie.length === 0) {
    throw new Error('DSH authentication did not return a session cookie');
  }
  return cookie;
}

async function rpc<T = unknown>(cookie: string, endpoint: string, args: object): Promise<T> {
  const rpcId = randomUUID();
  const response = await fetch(new URL(`/api/${endpoint}`, DSH_ORIGIN), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { args },
    }),
  });
  if (!response.ok) {
    throw new DshHttpError(response.status, `DSH request ${endpoint} failed with HTTP ${response.status}`);
  }
  const envelope: unknown = await response.json();
  if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
    || !isRecord(envelope.result)) {
    throw new Error(`DSH returned an invalid response for ${endpoint}`);
  }
  const result = envelope.result as unknown as RpcResult<T>;
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function parseModelSelection(value: unknown): DshModelSelection {
  if (!isRecord(value) || typeof value.provider !== 'string' || value.provider.length === 0
    || typeof value.model !== 'string' || value.model.length === 0
    || (value.reasoningEffort !== undefined
      && (typeof value.reasoningEffort !== 'string' || value.reasoningEffort.length === 0))) {
    throw new Error('DSH returned an invalid model selection');
  }
  return {
    provider: value.provider,
    model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
  };
}

function parseCatalogModel(value: unknown): DshModelCatalog['groups'][number]['models'][number] {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string'
    || (value.description !== undefined && typeof value.description !== 'string')) {
    throw new Error('DSH returned an invalid model catalog entry');
  }
  let reasoning: DshModelCatalog['groups'][number]['models'][number]['reasoning'];
  if (value.reasoning !== undefined) {
    if (!isRecord(value.reasoning) || !Array.isArray(value.reasoning.efforts)
      || (value.reasoning.defaultEffort !== undefined && typeof value.reasoning.defaultEffort !== 'string')) {
      throw new Error('DSH returned invalid model reasoning metadata');
    }
    reasoning = {
      efforts: value.reasoning.efforts.map((effort) => {
        if (!isRecord(effort) || typeof effort.id !== 'string' || typeof effort.name !== 'string'
          || (effort.description !== undefined && typeof effort.description !== 'string')) {
          throw new Error('DSH returned an invalid model reasoning effort');
        }
        return {
          id: effort.id,
          name: effort.name,
          ...(effort.description === undefined ? {} : { description: effort.description }),
        };
      }),
      ...(value.reasoning.defaultEffort === undefined
        ? {}
        : { defaultEffort: value.reasoning.defaultEffort }),
    };
  }
  return {
    id: value.id,
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    ...(reasoning === undefined ? {} : { reasoning }),
  };
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('DSH returned an invalid string');
  return value;
}

function optionalCount(value: unknown, name: string, positive = false): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (positive ? Number(value) <= 0 : Number(value) < 0)) {
    throw new Error(`DSH returned an invalid context-pressure ${name}`);
  }
  return value as number;
}

function modelLabelMap(value: DshModelCatalog): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const group of value.groups) {
    const providerName = group.name.replace(/ Wrapper \(OpenAI API\)$/u, '');
    for (const model of group.models) {
      labels.set(`${group.id}\0${model.id}`, `${providerName}/${model.name}`);
    }
  }
  return labels;
}

function normalizeUsage(value: unknown, route?: string): UsageSample | undefined {
  if (!isRecord(value) || !isCount(value.inputTokens) || !isCount(value.outputTokens)) return undefined;
  const cacheReadTokens = isCount(value.cacheReadTokens) ? value.cacheReadTokens : undefined;
  const cacheWriteTokens = isCount(value.cacheWriteTokens) ? value.cacheWriteTokens : undefined;
  const reasoningTokens = isCount(value.reasoningTokens) && value.reasoningTokens <= value.outputTokens
    ? value.reasoningTokens
    : undefined;
  const derivedTotal = cacheReadTokens === undefined || cacheWriteTokens === undefined
    ? undefined
    : safeSum([value.inputTokens, cacheReadTokens, cacheWriteTokens, value.outputTokens]);
  const totalTokens = isCount(value.totalTokens) ? value.totalTokens : derivedTotal;
  if (totalTokens === undefined) return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    totalTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(route === undefined ? {} : { route }),
  };
}

function aggregateUsage(attempts: readonly UsageSample[]): DshTurnSummary['usage'] | undefined {
  if (attempts.length === 0) return undefined;
  const uncachedInputTokens = safeSum(attempts.map((attempt) => attempt.inputTokens));
  const outputTokens = safeSum(attempts.map((attempt) => attempt.outputTokens));
  const totalTokens = safeSum(attempts.map((attempt) => attempt.totalTokens));
  if (uncachedInputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined;
  const cacheReadTokens = optionalSum(attempts.map((attempt) => attempt.cacheReadTokens));
  const cacheWriteTokens = optionalSum(attempts.map((attempt) => attempt.cacheWriteTokens));
  const reasoningTokens = optionalSum(attempts.map((attempt) => attempt.reasoningTokens));
  const routes = attempts.every((attempt) => attempt.route !== undefined)
    ? [...new Set(attempts.map((attempt) => attempt.route as string))]
    : undefined;
  return {
    uncachedInputTokens,
    outputTokens,
    totalTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(routes === undefined ? {} : { routes }),
  };
}

function optionalSum(values: readonly (number | undefined)[]): number | undefined {
  return values.every(isCount) ? safeSum(values) : undefined;
}

function safeSum(values: readonly number[]): number | undefined {
  let sum = 0;
  for (const value of values) {
    sum += value;
    if (!Number.isSafeInteger(sum)) return undefined;
  }
  return sum;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function usageFromStream(stream: unknown): unknown {
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index--) {
    const item = stream[index];
    if (isRecord(item) && item.type === 'chunk' && isRecord(item.chunk)
      && item.chunk.type === 'usage') return item.chunk.usage;
  }
  return undefined;
}

function firstVisibleStreamTime(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined;
  for (const item of stream) {
    if (!isRecord(item)) continue;
    if ((item.type === 'text-chunks' || item.type === 'reasoning-chunks')
      && typeof item.time0 === 'number' && Array.isArray(item.texts)
      && item.texts.some((text) => typeof text === 'string' && text.trim() !== '')) return item.time0;
    if (item.type === 'chunk' && typeof item.time === 'number' && isRecord(item.chunk)
      && ((item.chunk.type === 'text-delta' || item.chunk.type === 'reasoning-delta')
        && typeof item.chunk.text === 'string' && item.chunk.text.trim() !== '')) return item.time;
  }
  return undefined;
}

function emitContent(
  sink: DshOutputSink,
  role: 'user' | 'assistant',
  content: unknown,
  time: unknown,
): void {
  const text = contentText(content);
  if (text.length > 0) sink.history(role, text, typeof time === 'number' ? time : undefined);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part): part is { type: 'text'; text: string } => (
      isRecord(part) && part.type === 'text' && typeof part.text === 'string'
    ))
    .map((part) => part.text)
    .join('\n');
}

export function parseQueueItems(value: unknown): readonly DshQueuedPrompt[] {
  if (!Array.isArray(value)) return [];
  const items: DshQueuedPrompt[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.message)
      || !['queued', 'steering', 'context'].includes(String(item.placement))) continue;
    items.push({
      id: item.id,
      ...(typeof item.rpcId === 'string' ? { requestId: item.rpcId } : {}),
      text: contentText(item.message.content),
      placement: item.placement as DshQueuedPrompt['placement'],
    });
  }
  return items;
}

function toolSummary(name: string, detail: string): string {
  try {
    const value: unknown = JSON.parse(detail);
    if (!isRecord(value)) return detail;
    for (const key of ['file_path', 'path', 'query', 'command', 'name']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
  } catch {
    // Tool arguments may be an incomplete provider string while streaming.
  }
  return name;
}

function reasoningDisclosureId(turn: number, step: number, blockIndex: unknown): string {
  const index = typeof blockIndex === 'number' ? blockIndex : 0;
  return `turn:${String(turn)}:reasoning:${String(step)}:${String(index)}`;
}

function validHistoryRecords(value: readonly unknown[]): readonly unknown[] {
  for (const record of value) {
    if (!isRecord(record) || record.type !== 'event' || !isRecord(record.event)
      || !Number.isSafeInteger(record.event.seq) || !isRecord(record.event.data)) {
      throw new Error('DSH returned an invalid Session history record');
    }
  }
  return value;
}

function historyRecordSeq(record: unknown): number {
  if (!isRecord(record) || !isRecord(record.event) || !Number.isSafeInteger(record.event.seq)) {
    throw new Error('DSH returned a Session history record without a sequence');
  }
  return record.event.seq as number;
}

function isHumanPromptRecord(record: unknown): boolean {
  return isRecord(record) && isRecord(record.event) && record.event.type === 'user/message'
    && isRecord(record.event.data) && isRecord(record.event.data.source)
    && record.event.data.source.kind === 'user';
}

function isTurnStartRecord(record: unknown): boolean {
  return isRecord(record) && isRecord(record.event) && record.event.type === 'turn/start';
}

function findLastRecordIndex(
  records: readonly unknown[],
  predicate: (record: unknown, index: number) => boolean,
): number {
  for (let index = records.length - 1; index >= 0; index--) {
    if (predicate(records[index], index)) return index;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
