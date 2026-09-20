import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

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
  reset(): void;
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
  submissionObserved(requestId: string): void;
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

interface ObservableValue {
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
}

interface CanonicalSession extends ObservableValue {
  readonly sessionId: string;
  readonly projections: { faceOf(key: string): ObservableValue };
  beginSubmission(input: {
    mode: 'queue' | 'steer';
    text: string;
    attachments: readonly unknown[];
    onRetire?: (retirement: { readonly reason: 'observed' | 'failed' }) => void;
  }): { requestId: string; abandon(): void };
  prompt(
    content: readonly { readonly type: 'text'; readonly text: string }[],
    mode: 'queue' | 'steer',
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<unknown>;
  cancel(): Promise<unknown>;
  loadOlder(): Promise<void>;
}

interface CanonicalBinding {
  readonly session: CanonicalSession;
  readonly eventSource: ObservableValue;
}

interface CanonicalClientGraph {
  readonly sessions: {
    readonly list: ObservableValue;
    create(options?: { cwd?: string }): Promise<string>;
    open(sessionId: string): void;
    binding(sessionId: string): CanonicalBinding | undefined;
    subagentAddress(sessionId: string): unknown;
  };
  readonly remote: Record<string, unknown>;
  readonly connection: { readonly state: ObservableValue };
  dispose(): Promise<void>;
}

interface CanonicalState {
  readonly graph: CanonicalClientGraph;
  readonly binding: CanonicalBinding;
  readonly disposers: (() => void)[];
  readonly requestAliases: Map<string, string>;
  assistantAttemptId?: string;
}

let canonicalAssemblyQueue: Promise<void> = Promise.resolve();

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

/** Projects one canonical DSH Client Session supplied by the managed Runtime. */
export class DshClient {
  readonly sessionId: string;
  private hasLiveAssistantText = false;
  private lastReportedError: string | undefined;
  private currentTurn = 0;
  private currentStep = 0;
  private turnStats: TurnStats | undefined;
  private readonly modelLabels: ReadonlyMap<string, string>;
  private modelSelectionState: DshModelSelectionState;
  private contextPressureState: DshContextPressureState = { watermark: -1 };
  private readonly activeCompactions = new Set<string>();
  private readonly activeCompactionCommands = new Set<string>();
  private canonical: CanonicalState | undefined;

  private constructor(
    sessionId: string,
    private readonly sink: DshOutputSink,
    private readonly modelCatalogValue: DshModelCatalog,
    canonical: CanonicalState,
  ) {
    this.sessionId = sessionId;
    this.modelLabels = modelLabelMap(modelCatalogValue);
    this.modelSelectionState = { watermark: -1, current: { ...modelCatalogValue.default } };
    this.canonical = canonical;
  }

  /** Creates or restores a Session and opens its live event stream. */
  static async connect(
    cookie: string,
    cwd: string | undefined,
    sink: DshOutputSink,
    restoredSessionId: string | undefined,
    clientModule: string,
  ): Promise<DshClient> {
    sink.status('Connecting to DSH…');
    await rpc(cookie, 'session/list', { _request: {} });
    return DshClient.connectCanonical(cookie, cwd, sink, restoredSessionId, clientModule);
  }

  private static async connectCanonical(
    cookie: string,
    cwd: string | undefined,
    sink: DshOutputSink,
    restoredSessionId: string | undefined,
    clientModule: string,
  ): Promise<DshClient> {
    const module = await importExternalModule(pathToFileURL(clientModule).href);
    const Client = isRecord(module)
      ? module.DshWebClient ?? (isRecord(module.default) ? module.default.DshWebClient : undefined)
      : undefined;
    const connect = (typeof Client === 'function' || isRecord(Client))
      ? Reflect.get(Client, 'connect')
      : undefined;
    if (typeof connect !== 'function') {
      throw new Error('Managed DSH Client module has an invalid API');
    }
    const graphValue: unknown = await assembleCanonicalClient(connect, Client, { origin: DSH_ORIGIN, cookie });
    if (!isCanonicalClientGraph(graphValue)) throw new Error('Managed DSH Client returned an invalid object graph');
    const graph = graphValue;
    try {
      const catalogResult = await callCanonicalRemote(graph, 'session', 'modelCatalog');
      const modelCatalog = parseModelCatalog(unwrapCanonicalResult(catalogResult, 'session.modelCatalog'));
      const sessionId = restoredSessionId ?? await graph.sessions.create(cwd === undefined ? {} : { cwd });
      if (restoredSessionId !== undefined && !canonicalSessionIds(graph.sessions.list.getSnapshot()).has(sessionId)) {
        throw new Error(`DSH Session ${sessionId} is not available`);
      }
      graph.sessions.open(sessionId);
      const binding: unknown = graph.sessions.binding(sessionId);
      if (!isCanonicalBinding(binding)) {
        throw new Error(`DSH did not create a valid Client binding for Session ${sessionId}`);
      }
      const commands = graph.sessions.subagentAddress(sessionId) === undefined
        ? unwrapCommandCatalog(await callCanonicalRemote(graph, 'commands', 'list', sessionId))
        : [];
      if (!Array.isArray(commands) || !commands.every((command) => (
        isRecord(command) && typeof command.name === 'string'
      ))) throw new Error('DSH returned an invalid command catalog');
      const client = new DshClient(sessionId, sink, modelCatalog, {
        graph,
        binding,
        disposers: [],
        requestAliases: new Map(),
      });
      sink.modelCatalog(modelCatalog);
      sink.modelSelection(modelCatalog.default);
      sink.compactAvailable(commands.some((command) => command.name === 'compact'));
      await client.openCanonical();
      sink.status('Connected');
      return client;
    } catch (error) {
      await graph.dispose();
      throw error;
    }
  }

  /** Sends one text prompt to this editor's Session. */
  async prompt(text: string, requestId: string): Promise<void> {
    this.lastReportedError = undefined;
    const canonical = this.requireCanonical();
    const submission = canonical.binding.session.beginSubmission({
      mode: 'queue',
      text,
      attachments: [],
      onRetire: (retirement) => {
        if (retirement.reason === 'observed') this.sink.submissionObserved(requestId);
      },
    });
    canonical.requestAliases.set(submission.requestId, requestId);
    const result = await canonical.binding.session.prompt(
      [{ type: 'text', text }], 'queue', undefined, submission.requestId,
    );
    try {
      unwrapCanonicalResult(result, 'session.prompt');
    } catch (error) {
      canonical.requestAliases.delete(submission.requestId);
      throw error;
    }
  }

  /** Cancels the active turn while retaining pending DSH inbox work. */
  async cancel(): Promise<void> {
    unwrapCanonicalResult(await this.requireCanonical().binding.session.cancel(), 'session.cancel');
  }

  /** Selects one DSH provider, model, and optional reasoning effort for this Session. */
  async selectModel(selection: DshModelSelection): Promise<void> {
    const result = await callCanonicalRemote(this.requireCanonical().graph, 'session', 'selectModel', {
      sessionId: this.sessionId,
      ...selection,
    });
    const value = unwrapCanonicalResult(result, 'session.selectModel');
    if (!isRecord(value) || !isRecord(value.selected)) {
      throw new Error('DSH returned an invalid model-selection response');
    }
    parseModelSelection(value.selected);
  }

  /** Runs DSH's canonical argument-free `/compact` command for this Session. */
  async compact(): Promise<DshCompactResult> {
    const result = await callCanonicalRemote(
      this.requireCanonical().graph, 'commands', 'execute', this.sessionId, '/compact', [],
    );
    return parseCompactResult(unwrapCanonicalResult(result, 'commands.execute'));
  }

  /** Loads enough older DSH history to expose the next human prompt above the current window. */
  loadOlder(): Promise<void> {
    return this.requireCanonical().binding.session.loadOlder();
  }

  dispose(): void {
    const canonical = this.canonical;
    if (canonical === undefined) return;
    for (const dispose of canonical.disposers.splice(0)) dispose();
    void canonical.graph.dispose().catch(() => {
      console.warn('DSH Client disposal did not settle cleanly');
    });
    this.canonical = undefined;
  }

  private requireCanonical(): CanonicalState {
    if (this.canonical === undefined) throw new Error('Managed DSH Client is disposed');
    return this.canonical;
  }

  private async openCanonical(): Promise<void> {
    const canonical = this.requireCanonical();
    const session = canonical.binding.session;
    const projectSession = (): void => {
      const snapshot = session.getSnapshot();
      if (!isRecord(snapshot) || !Array.isArray(snapshot.queue) || typeof snapshot.running !== 'boolean'
        || typeof snapshot.hasMore !== 'boolean' || typeof snapshot.openState !== 'string') {
        throw new Error('DSH Client returned an invalid Session snapshot');
      }
      this.sink.queue(snapshot.queue.map((item) => canonicalQueueItem(item, canonical.requestAliases)));
      this.sink.running(snapshot.running);
      this.sink.historyState(snapshot.hasMore);
    };
    const projectEvents = (): void => { this.receiveCanonicalWindow(canonical.binding.eventSource.getSnapshot()); };
    const modelProjection = session.projections.faceOf('modelSelection');
    const contextProjection = session.projections.faceOf('contextPressure');
    const projectModel = (): void => {
      this.acceptModelSelection(modelProjection.getSnapshot(), this.modelSelectionState.watermark + 1);
    };
    const projectContext = (): void => {
      this.acceptContextPressure(contextProjection.getSnapshot(), this.contextPressureState.watermark + 1);
    };
    const projectConnection = (): void => {
      const state = canonical.graph.connection.state.getSnapshot();
      if (state === 'connecting') this.sink.status('Reconnecting to DSH…');
      if (state === 'disconnected') this.sink.status('Disconnected; retrying…');
      if (state === 'connected') this.sink.status('Connected');
    };
    canonical.disposers.push(
      session.subscribe(projectSession),
      canonical.binding.eventSource.subscribe(projectEvents),
      modelProjection.subscribe(projectModel),
      contextProjection.subscribe(projectContext),
      canonical.graph.connection.state.subscribe(projectConnection),
    );
    projectSession();
    projectEvents();
    projectModel();
    projectContext();
    projectConnection();
    await waitForCanonicalSession(session);
  }

  private receiveCanonicalWindow(value: unknown): void {
    if (!isRecord(value) || !Array.isArray(value.entries) || !isRecord(value.change)
      || typeof value.hasMore !== 'boolean') {
      throw new Error('DSH Client returned an invalid event window');
    }
    const change = value.change;
    if (change.kind === 'append' && Array.isArray(change.entries)) {
      for (const entry of change.entries) this.receiveCanonicalEntry(entry, false);
      return;
    }
    if (change.kind === 'prepend' && Array.isArray(change.entries)) {
      const saved = this.saveParserPosition();
      this.sink.historyPrependStart();
      try {
        for (const entry of change.entries) this.receiveCanonicalEntry(entry, true, true);
      } finally {
        this.restoreParserPosition(saved);
        this.sink.historyPrependEnd();
      }
      return;
    }
    if (change.kind === 'settle-assistant' && isRecord(change.entry)) {
      if (this.canonical !== undefined) this.canonical.assistantAttemptId = undefined;
      this.receiveCanonicalEntry(change.entry, false);
      return;
    }
    if (change.kind !== 'replace' && change.kind !== 'settle-assistant') {
      throw new Error('DSH Client returned an invalid event-window change');
    }
    this.retireCanonicalSubmissions(value.entries);
    this.resetParser();
    this.sink.reset();
    for (const entry of value.entries) this.receiveCanonicalEntry(entry, true);
    this.sink.compacting(this.compactionActive());
    this.sink.historyState(value.hasMore);
  }

  private receiveCanonicalEntry(entry: unknown, fromSnapshot: boolean, older = false): void {
    if (!isRecord(entry) || !isRecord(entry.event)) return;
    if (entry.type === 'event') {
      this.receiveHistoryRecord(entry, fromSnapshot, older);
      return;
    }
    const event = entry.event;
    if (entry.type !== 'transient' || event.type !== 'assistant/live-chunk' || !isRecord(event.data)
      || typeof event.data.attemptId !== 'string' || typeof event.data.turn !== 'number'
      || typeof event.data.step !== 'number' || !isRecord(event.data.chunk)) return;
    const canonical = this.canonical;
    if (canonical === undefined) return;
    this.currentTurn = event.data.turn;
    this.currentStep = event.data.step;
    if (canonical.assistantAttemptId !== event.data.attemptId) {
      canonical.assistantAttemptId = event.data.attemptId;
      this.sink.assistantStart();
    }
    this.receiveAssistantChunk(event.data.chunk, event.time);
  }

  private retireCanonicalSubmissions(entries: readonly unknown[]): void {
    const canonical = this.canonical;
    if (canonical === undefined || canonical.requestAliases.size === 0) return;
    let turn = 0;
    for (const entry of entries) {
      if (!isRecord(entry) || entry.type !== 'event' || !isRecord(entry.event)) continue;
      const event = entry.event;
      if (!isRecord(event.data)) continue;
      const data = event.data;
      if (event.type === 'turn/start' && typeof data.turn === 'number') turn = data.turn;
      if (event.type !== 'user/message' || !isRecord(data.source)
        || typeof data.source.rpcId !== 'string') continue;
      const alias = canonical.requestAliases.get(data.source.rpcId);
      if (alias === undefined) continue;
      canonical.requestAliases.delete(data.source.rpcId);
      this.sink.userCommitted(
        alias,
        contentText(data.content),
        typeof event.time === 'number' ? event.time : Date.now(),
        turn,
      );
    }
  }

  private saveParserPosition() {
    return {
      currentTurn: this.currentTurn,
      currentStep: this.currentStep,
      turnStats: this.turnStats,
      hasLiveAssistantText: this.hasLiveAssistantText,
    };
  }

  private restoreParserPosition(saved: ReturnType<DshClient['saveParserPosition']>): void {
    this.currentTurn = saved.currentTurn;
    this.currentStep = saved.currentStep;
    this.turnStats = saved.turnStats;
    this.hasLiveAssistantText = saved.hasLiveAssistantText;
  }

  private resetParser(): void {
    this.currentTurn = 0;
    this.currentStep = 0;
    this.turnStats = undefined;
    this.hasLiveAssistantText = false;
    this.lastReportedError = undefined;
    this.activeCompactions.clear();
    this.activeCompactionCommands.clear();
    if (this.canonical !== undefined) this.canonical.assistantAttemptId = undefined;
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
      if (!older && !fromSnapshot && typeof provider === 'string' && typeof model === 'string') {
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
        const canonicalRequestId = isRecord(event.data.source) && typeof event.data.source.rpcId === 'string'
          ? event.data.source.rpcId
          : undefined;
        const requestId = canonicalRequestId === undefined
          ? undefined
          : this.canonical?.requestAliases.get(canonicalRequestId) ?? canonicalRequestId;
        if (canonicalRequestId !== undefined) this.canonical?.requestAliases.delete(canonicalRequestId);
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

const importExternalModule = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

function assembleCanonicalClient(
  connect: (...args: unknown[]) => unknown,
  receiver: unknown,
  options: { readonly origin: string; readonly cookie: string },
): Promise<unknown> {
  const assembly = canonicalAssemblyQueue.then(() => Reflect.apply(connect, receiver, [options]));
  canonicalAssemblyQueue = assembly.then(() => undefined, () => undefined);
  return assembly;
}

function isCanonicalClientGraph(value: unknown): value is CanonicalClientGraph {
  return isRecord(value) && isRecord(value.sessions) && isObservable(value.sessions.list)
    && typeof value.sessions.create === 'function' && typeof value.sessions.open === 'function'
    && typeof value.sessions.binding === 'function' && typeof value.sessions.subagentAddress === 'function'
    && isRecord(value.remote)
    && isRecord(value.connection) && isObservable(value.connection.state)
    && typeof value.dispose === 'function';
}

function isObservable(value: unknown): value is ObservableValue {
  return isRecord(value) && typeof value.getSnapshot === 'function' && typeof value.subscribe === 'function';
}

function isCanonicalBinding(value: unknown): value is CanonicalBinding {
  return isRecord(value) && isObservable(value.eventSource) && isRecord(value.session)
    && typeof value.session.sessionId === 'string' && isObservable(value.session)
    && isRecord(value.session.projections) && typeof value.session.projections.faceOf === 'function'
    && typeof value.session.beginSubmission === 'function' && typeof value.session.prompt === 'function'
    && typeof value.session.cancel === 'function' && typeof value.session.loadOlder === 'function';
}

async function callCanonicalRemote(
  graph: CanonicalClientGraph,
  namespaceName: string,
  methodName: string,
  ...args: unknown[]
): Promise<unknown> {
  const namespace = graph.remote[namespaceName];
  if (!isRecord(namespace) || typeof namespace[methodName] !== 'function') {
    throw new Error(`Managed DSH Client omits ${namespaceName}.${methodName}`);
  }
  return Reflect.apply(namespace[methodName], namespace, args);
}

function unwrapCanonicalResult(value: unknown, operation: string): unknown {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new Error(`DSH returned an invalid ${operation} result`);
  }
  if (value.ok) return value.value;
  if (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
    throw new Error(`DSH returned an invalid ${operation} failure`);
  }
  throw new Error(`${value.error.code}: ${value.error.message}`);
}

function unwrapCommandCatalog(value: unknown): unknown {
  if (isRecord(value) && value.ok === false && isRecord(value.error)
    && value.error.code === 'session/agent-busy') return [];
  return unwrapCanonicalResult(value, 'commands.list');
}

function canonicalSessionIds(value: unknown): ReadonlySet<string> {
  if (!isRecord(value) || !Array.isArray(value.ids)
    || value.ids.some((item) => typeof item !== 'string')) {
    throw new Error('DSH Client returned an invalid Session list');
  }
  return new Set(value.ids);
}

function canonicalQueueItem(value: unknown, aliases: ReadonlyMap<string, string>): DshQueuedPrompt {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.preview !== 'string'
    || !['queued', 'steering', 'context'].includes(String(value.placement))
    || (value.rpcId !== undefined && typeof value.rpcId !== 'string')) {
    throw new Error('DSH Client returned an invalid queue item');
  }
  return {
    id: value.id,
    text: typeof value.text === 'string' ? value.text : value.preview,
    placement: value.placement as DshQueuedPrompt['placement'],
    ...(value.rpcId === undefined ? {} : { requestId: aliases.get(value.rpcId) ?? value.rpcId }),
  };
}

async function waitForCanonicalSession(session: CanonicalSession): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      dispose();
      rejectReady(new Error('Timed out opening the DSH Client Session'));
    }, 30_000);
    const inspect = (): void => {
      const snapshot = session.getSnapshot();
      if (!isRecord(snapshot)) return;
      if (snapshot.openState === 'open') {
        clearTimeout(timeout);
        dispose();
        resolveReady();
      } else if (snapshot.openState === 'error') {
        clearTimeout(timeout);
        dispose();
        rejectReady(new Error('DSH Client could not open the Session'));
      }
    };
    const dispose = session.subscribe(inspect);
    inspect();
  });
}

function parseCompactResult(value: unknown): DshCompactResult {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
