/** Validated Codex Wrapper Advanced `/wire/v1` values. */

/** Lossless JSON value retained from the wrapper protocol. */
export type CodexWireJson =
  | null
  | boolean
  | number
  | string
  | readonly CodexWireJson[]
  | { readonly [key: string]: CodexWireJson }

/** One model returned by `/wire/v1/models`. */
export interface CodexWireModel {
  /** Stable catalog identity selected by a DSH caller. */
  readonly id: string
  /** Model identifier sent to `/wire/v1/responses`. */
  readonly model: string
  /** Provider-supplied display name. */
  readonly displayName: string
  /** Provider-supplied description when available. */
  readonly description?: string
  /** Whether ordinary model selectors should omit this model. */
  readonly hidden: boolean
  /** Input modalities reported by the wrapper. */
  readonly inputModalities: readonly string[]
  /** Context budget used by the upstream Codex client. */
  readonly defaultContextLength?: number
  /** Largest context budget the wrapper reports as usable. */
  readonly maxContextLength?: number
  /** Model-specific reasoning controls. */
  readonly reasoning: {
    readonly levels: readonly string[]
    readonly default?: string
    readonly summarySupported: boolean
  }
}

/** Complete validated `/wire/v1/models` response. */
export interface CodexWireCatalog {
  readonly models: readonly CodexWireModel[]
}

/** Service identity returned by `/wire/v1/info`. */
export interface CodexWireServiceInfo {
  readonly service: 'codex-api-wrapper'
  readonly version: string
}

/** Optional token counters carried by a terminal wrapper event. */
export interface CodexWireUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cachedInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly reasoningOutputTokens?: number
  readonly totalTokens?: number
}

/** One quota window reported by the wrapper. */
export interface CodexWireLimitWindow {
  readonly usedPercent: number
  readonly windowSeconds?: number
  readonly resetsAt?: number
  readonly resetsInSeconds?: number
}

/** One quota group reported by the wrapper. */
export interface CodexWireLimitGroup {
  readonly id: string
  readonly name?: string
  readonly reached?: boolean
  readonly primary?: CodexWireLimitWindow
  readonly secondary?: CodexWireLimitWindow
}

/** Account facts shared by turn-limit and usage-report responses. */
export interface CodexWireAccount {
  readonly plan?: { readonly id: string; readonly name?: string }
  readonly credits?: {
    readonly hasCredits?: boolean
    readonly unlimited?: boolean
    readonly balance?: string
    readonly overageLimitReached?: boolean
    readonly approxCloudMessages?: CodexWireJson
    readonly approxLocalMessages?: CodexWireJson
  }
  readonly spendControl?: CodexWireJson
  readonly resetCredits?: CodexWireJson
}

/** Account and quota facts attached to a model response. */
export interface CodexWireTurnLimits {
  readonly account: CodexWireAccount
  readonly limits: {
    readonly activeGroup?: string
    readonly groups: readonly CodexWireLimitGroup[]
  }
}

/** Complete validated `/wire/v1/usage` response. */
export interface CodexWireUsageReport extends CodexWireTurnLimits {
  readonly promo?: CodexWireJson
}

/** Request body accepted by `POST /wire/v1/responses`. */
export interface CodexWireRequest {
  readonly model: string
  readonly input: readonly unknown[]
  readonly instructions?: string
  readonly tools: readonly unknown[]
  readonly effort?: string
  readonly parallel_tool_calls: boolean
  readonly store: false
  readonly session_id?: string
}

/** Validated event emitted by `/wire/v1/responses`. */
export type CodexWireEvent =
  | { readonly type: 'started'; readonly model?: string }
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'thinking_delta'; readonly text: string }
  | { readonly type: 'thinking_break' }
  | {
    readonly type: 'tool_call'
    readonly callId: string
    readonly name: string
    readonly arguments: string
  }
  | {
    readonly type: 'reasoning'
    readonly item: Readonly<Record<string, unknown>>
    readonly summary: readonly string[]
  }
  | { readonly type: 'rate_limits'; readonly value: CodexWireTurnLimits }
  | {
    readonly type: 'done'
    readonly responseId?: string
    readonly stopReason: string
    readonly usage?: CodexWireUsage
  }
  | { readonly type: 'failed'; readonly message: string; readonly retryable: boolean }
