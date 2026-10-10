/** Minimal OpenRouter control-plane client for catalog and account probes. */

import { decodeOpenRouterCatalog } from './catalog.js'
import type { OpenRouterCatalog } from './catalog.js'

/** Validated status of the configured OpenRouter API key. */
export interface OpenRouterKeyStatus {
  readonly label: string
  readonly limit: number | null
  readonly limit_reset: 'daily' | 'weekly' | 'monthly' | null
  readonly limit_remaining: number | null
  readonly include_byok_in_limit: boolean
  readonly usage: number
  readonly usage_daily: number
  readonly usage_weekly: number
  readonly usage_monthly: number
  readonly byok_usage: number
  readonly byok_usage_daily: number
  readonly byok_usage_weekly: number
  readonly byok_usage_monthly: number
  readonly is_free_tier: boolean
  readonly free_model_daily_requests: {
    readonly used: number
    readonly limit: number
    readonly remaining: number
  }
}

/** Fetch dependencies for testable OpenRouter control-plane calls. */
export interface OpenRouterClientOptions {
  readonly apiKey: string
  readonly baseURL: string
  readonly fetch?: typeof globalThis.fetch
}

/** Strict OpenRouter HTTP client; secrets remain request-only. */
export class OpenRouterClient {
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(private readonly options: OpenRouterClientOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  /** Fetch the complete default text-output model catalog without pagination. */
  async models(signal?: AbortSignal): Promise<OpenRouterCatalog> {
    return decodeOpenRouterCatalog(await this.json('/models', signal))
  }

  /** Fetch non-secret usage and limits for the configured API key. */
  async keyStatus(signal?: AbortSignal): Promise<OpenRouterKeyStatus> {
    return decodeOpenRouterKeyStatus(await this.json('/key', signal))
  }

  private async json(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path.replace(/^\//u, ''), withSlash(this.options.baseURL)), {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) throw new Error(`OpenRouter ${path} failed with HTTP ${String(response.status)}`)
    return response.json()
  }
}

/** Decode the documented `GET /key` response without retaining deprecated rate-limit fields. */
export function decodeOpenRouterKeyStatus(value: unknown): OpenRouterKeyStatus {
  const root = asRecord(value, 'OpenRouter key response')
  const data = asRecord(root.data, 'OpenRouter key response data')
  const free = asRecord(data.free_model_daily_requests, 'OpenRouter free-model daily requests')
  const limit = nullableNumber(data.limit, 'OpenRouter key limit')
  const limitRemaining = nullableNumber(data.limit_remaining, 'OpenRouter key limit_remaining')
  if (limit !== null && limitRemaining !== null && limitRemaining > limit) {
    throw new Error('OpenRouter key limit_remaining must not exceed limit')
  }
  return {
    label: asString(data.label, 'OpenRouter key label'),
    limit,
    limit_reset: limitReset(data.limit_reset),
    limit_remaining: limitRemaining,
    include_byok_in_limit: asBoolean(data.include_byok_in_limit, 'OpenRouter include_byok_in_limit'),
    usage: nonNegative(data.usage, 'OpenRouter key usage'),
    usage_daily: nonNegative(data.usage_daily, 'OpenRouter daily usage'),
    usage_weekly: nonNegative(data.usage_weekly, 'OpenRouter weekly usage'),
    usage_monthly: nonNegative(data.usage_monthly, 'OpenRouter monthly usage'),
    byok_usage: nonNegative(data.byok_usage, 'OpenRouter BYOK usage'),
    byok_usage_daily: nonNegative(data.byok_usage_daily, 'OpenRouter daily BYOK usage'),
    byok_usage_weekly: nonNegative(data.byok_usage_weekly, 'OpenRouter weekly BYOK usage'),
    byok_usage_monthly: nonNegative(data.byok_usage_monthly, 'OpenRouter monthly BYOK usage'),
    is_free_tier: asBoolean(data.is_free_tier, 'OpenRouter free-tier status'),
    free_model_daily_requests: {
      used: natural(free.used, 'OpenRouter free-model daily used'),
      limit: natural(free.limit, 'OpenRouter free-model daily limit'),
      remaining: natural(free.remaining, 'OpenRouter free-model daily remaining'),
    },
  }
}

function withSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}
function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function asString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}
function limitReset(value: unknown): OpenRouterKeyStatus['limit_reset'] {
  if (value === null || value === 'daily' || value === 'weekly' || value === 'monthly') return value
  throw new Error('OpenRouter key limit_reset must be daily, weekly, monthly, or null')
}
function asBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}
function nonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative and finite`)
  return value
}
function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : nonNegative(value, label)
}
function natural(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a natural safe integer`)
  return Number(value)
}
