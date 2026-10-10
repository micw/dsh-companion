/** Validated Claude Wrapper Advanced `/wire/v1` values. */

export type ClaudeWireJson = null | boolean | number | string | readonly ClaudeWireJson[]
  | { readonly [key: string]: ClaudeWireJson }

export interface ClaudeWireServiceInfo {
  readonly service: 'claude-wrapper-advanced'
  readonly version: string
}

export interface ClaudeWireModel {
  readonly id: string
  readonly backendModel: string
  readonly name: string
  readonly contextLength: number
  readonly inputModalities: readonly string[]
  readonly efforts: { readonly supported: readonly string[]; readonly default?: string }
  readonly knowledgeCutoff?: string
  readonly aliases: readonly string[]
  readonly limitGroups: readonly string[]
}

export interface ClaudeWireCatalog { readonly models: readonly ClaudeWireModel[] }

export interface ClaudeWireUsage {
  readonly inputNew: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly cacheWrite5m?: number
  readonly cacheWrite1h?: number
  readonly inputTotal: number
  readonly output: number
  readonly thinking?: number
  readonly thinkingBasis?: 'reported' | 'estimated'
  readonly serviceTier?: string
}

export interface ClaudeWireCost {
  readonly totalUsd?: number
  readonly scope?: 'call' | 'turn'
  readonly coveredRequests?: number
  readonly epoch: string
  /** Validated provider diagnostics; never projected into DSH accounting yet. */
  readonly byModel: Readonly<Record<string, ClaudeWireJson>>
}

export interface ClaudeWireWindow {
  readonly id: string
  readonly usedPercent: number
  readonly windowSeconds?: number
  readonly resetsAt?: number
}

export interface ClaudeWireLimitGroup {
  readonly id: string
  readonly observedAt?: number
  readonly ageSeconds?: number
  readonly windows: readonly ClaudeWireWindow[]
}

export interface ClaudeWireUsageReport { readonly groups: readonly ClaudeWireLimitGroup[] }

export interface ClaudeWireRequest {
  readonly model: string
  readonly messages: readonly unknown[]
  readonly tools: readonly unknown[]
  readonly reasoning_effort?: string
  readonly session_id?: string
  readonly cost_scope_id?: string
}

export type ClaudeWireEvent =
  | { readonly type: 'started'; readonly model: string; readonly reused: boolean }
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'thinking_progress'; readonly tokens: number }
  | { readonly type: 'tool_call'; readonly callId: string; readonly name: string; readonly arguments: string }
  | { readonly type: 'quota'; readonly usage: ClaudeWireUsageReport }
  | {
    readonly type: 'limit_status'
    readonly status?: string
    readonly usageStale: boolean
    readonly window?: ClaudeWireJson
    readonly claim?: ClaudeWireJson
    readonly resetsAt?: number
  }
  | { readonly type: 'done'; readonly stopReason: string; readonly text: string; readonly usage: ClaudeWireUsage; readonly cost: ClaudeWireCost }
  | { readonly type: 'failed'; readonly errorType: string; readonly message: string; readonly upstreamStatus?: number; readonly retryable: boolean; readonly cost: ClaudeWireCost }
