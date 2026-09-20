/** Runtime validation at the external Codex Wrapper Advanced wire boundary. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  CodexWireAccount,
  CodexWireCatalog,
  CodexWireEvent,
  CodexWireLimitGroup,
  CodexWireLimitWindow,
  CodexWireJson,
  CodexWireModel,
  CodexWireServiceInfo,
  CodexWireTurnLimits,
  CodexWireUsage,
  CodexWireUsageReport,
} from './types.js'

/** Parse and validate a `/wire/v1/info` response. */
export function parseCodexWireServiceInfo(value: unknown): CodexWireServiceInfo {
  const root = record(value, 'service info')
  if (root.service !== 'codex-api-wrapper') {
    fail('service info does not identify codex-api-wrapper')
  }
  return { service: root.service, version: nonEmptyString(root.version, 'service info version') }
}

/** Parse and validate a `/wire/v1/models` response. */
export function parseCodexWireCatalog(value: unknown): CodexWireCatalog {
  const root = record(value, 'model catalog')
  if (!Array.isArray(root.models)) fail('model catalog models must be an array')
  const seen = new Set<string>()
  const models = root.models.map((candidate, index) => {
    const model = parseModel(candidate, index)
    if (seen.has(model.id)) fail(`model catalog contains duplicate id ${JSON.stringify(model.id)}`)
    seen.add(model.id)
    return model
  })
  return { models }
}

/** Parse and validate a `/wire/v1/usage` response. */
export function parseCodexWireUsageReport(value: unknown): CodexWireUsageReport {
  const root = record(value, 'usage report')
  const promo = optionalJson(root.promo)
  return {
    ...parseTurnLimits(root),
    ...promo === undefined ? {} : { promo },
  }
}

/** Parse and validate one `/wire/v1/responses` SSE data payload. */
export function parseCodexWireEvent(value: unknown): CodexWireEvent {
  const event = record(value, 'stream event')
  const type = nonEmptyString(event.type, 'stream event type')
  switch (type) {
    case 'started': {
      const model = optionalString(event.model, 'started model')
      return {
        type,
        ...model === undefined ? {} : { model },
      }
    }
    case 'text_delta':
    case 'thinking_delta':
      return { type, text: string(event.text, `${type} text`) }
    case 'thinking_break':
      return { type }
    case 'tool_call':
      return {
        type,
        callId: nonEmptyString(event.call_id, 'tool_call call_id'),
        name: nonEmptyString(event.name, 'tool_call name'),
        arguments: string(event.arguments, 'tool_call arguments'),
      }
    case 'reasoning': {
      const item = record(event.item, 'reasoning item')
      if (!Array.isArray(event.summary)
        || event.summary.some(part => typeof part !== 'string')) {
        fail('reasoning summary must be an array of strings')
      }
      return { type, item, summary: [...event.summary] as string[] }
    }
    case 'rate_limits':
      return { type, value: parseTurnLimits(event) }
    case 'done': {
      const usage = event.usage === null || event.usage === undefined
        ? undefined
        : parseUsage(event.usage)
      const responseId = optionalString(event.response_id, 'done response_id')
      return {
        type,
        stopReason: nonEmptyString(event.stop_reason, 'done stop_reason'),
        ...responseId === undefined ? {} : { responseId },
        ...usage === undefined ? {} : { usage },
      }
    }
    case 'failed':
      return {
        type,
        message: nonEmptyString(event.message, 'failed message'),
        retryable: boolean(event.retryable, 'failed retryable'),
      }
    default:
      fail(`unsupported stream event type ${JSON.stringify(type)}`)
  }
}

function parseModel(value: unknown, index: number): CodexWireModel {
  const raw = record(value, `model catalog entry ${String(index)}`)
  if (!Array.isArray(raw.input_modalities)) {
    fail(`model catalog entry ${String(index)} input_modalities must be an array`)
  }
  const inputModalities = raw.input_modalities.map((item, modalityIndex) =>
    nonEmptyString(item, `model catalog entry ${String(index)} input modality ${String(modalityIndex)}`))
  if (new Set(inputModalities).size !== inputModalities.length) {
    fail(`model catalog entry ${String(index)} contains duplicate input modalities`)
  }
  const reasoning = record(raw.reasoning, `model catalog entry ${String(index)} reasoning`)
  if (!Array.isArray(reasoning.levels)) {
    fail(`model catalog entry ${String(index)} reasoning levels must be an array`)
  }
  const levels = reasoning.levels.map((item, levelIndex) =>
    nonEmptyString(item, `model catalog entry ${String(index)} reasoning level ${String(levelIndex)}`))
  if (new Set(levels).size !== levels.length) {
    fail(`model catalog entry ${String(index)} contains duplicate reasoning levels`)
  }
  const defaultContextLength = optionalPositiveInteger(
    raw.default_context_length,
    `model catalog entry ${String(index)} default_context_length`,
  )
  const maxContextLength = optionalPositiveInteger(
    raw.max_context_length,
    `model catalog entry ${String(index)} max_context_length`,
  )
  if (defaultContextLength !== undefined && maxContextLength !== undefined
    && maxContextLength < defaultContextLength) {
    fail(`model catalog entry ${String(index)} max_context_length is below default_context_length`)
  }
  const description = optionalString(raw.description, `model catalog entry ${String(index)} description`)
  const defaultEffort = optionalString(reasoning.default, `model catalog entry ${String(index)} reasoning default`)
  return {
    id: nonEmptyString(raw.id, `model catalog entry ${String(index)} id`),
    model: nonEmptyString(raw.model, `model catalog entry ${String(index)} model`),
    displayName: nonEmptyString(raw.display_name, `model catalog entry ${String(index)} display_name`),
    ...description === undefined ? {} : { description },
    hidden: boolean(raw.hidden, `model catalog entry ${String(index)} hidden`),
    inputModalities,
    ...defaultContextLength === undefined ? {} : { defaultContextLength },
    ...maxContextLength === undefined ? {} : { maxContextLength },
    reasoning: {
      levels,
      ...defaultEffort === undefined ? {} : { default: defaultEffort },
      summarySupported: boolean(
        reasoning.summary_supported,
        `model catalog entry ${String(index)} reasoning summary_supported`,
      ),
    },
  }
}

function parseUsage(value: unknown): CodexWireUsage {
  const raw = record(value, 'done usage')
  const inputTokens = optionalCount(raw.input_tokens, 'usage input_tokens')
  const outputTokens = optionalCount(raw.output_tokens, 'usage output_tokens')
  const cachedInputTokens = optionalCount(raw.cached_input_tokens, 'usage cached_input_tokens')
  const cacheWriteInputTokens = optionalCount(raw.cache_write_input_tokens, 'usage cache_write_input_tokens')
  const reasoningOutputTokens = optionalCount(raw.reasoning_output_tokens, 'usage reasoning_output_tokens')
  const totalTokens = optionalCount(raw.total_tokens, 'usage total_tokens')
  return {
    ...inputTokens === undefined ? {} : { inputTokens },
    ...outputTokens === undefined ? {} : { outputTokens },
    ...cachedInputTokens === undefined ? {} : { cachedInputTokens },
    ...cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens },
    ...reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens },
    ...totalTokens === undefined ? {} : { totalTokens },
  }
}

function parseTurnLimits(value: unknown): CodexWireTurnLimits {
  const raw = record(value, 'rate limits')
  const account = parseAccount(raw.account)
  const limits = record(raw.limits, 'rate limits limits')
  if (!Array.isArray(limits.groups)) fail('rate limits groups must be an array')
  const groups = limits.groups.map((group, index) => parseGroup(group, index))
  const ids = groups.map(group => group.id)
  if (new Set(ids).size !== ids.length) fail('rate limits contain duplicate group ids')
  const activeGroup = optionalString(limits.active_group, 'rate limits active_group')
  return {
    account,
    limits: {
      ...activeGroup === undefined ? {} : { activeGroup },
      groups,
    },
  }
}

function parseAccount(value: unknown): CodexWireAccount {
  const raw = record(value, 'rate limits account')
  const planRaw = optionalRecord(raw.plan, 'rate limits account plan')
  let plan: CodexWireAccount['plan']
  if (planRaw !== undefined) {
    const name = optionalString(planRaw.name, 'rate limits account plan name')
    plan = {
      id: nonEmptyString(planRaw.id, 'rate limits account plan id'),
      ...name === undefined ? {} : { name },
    }
  }
  const creditsRaw = optionalRecord(raw.credits, 'rate limits account credits')
  let credits: CodexWireAccount['credits']
  if (creditsRaw !== undefined) {
    const hasCredits = optionalBoolean(creditsRaw.has_credits, 'credits has_credits')
    const unlimited = optionalBoolean(creditsRaw.unlimited, 'credits unlimited')
    const balance = optionalString(creditsRaw.balance, 'credits balance')
    const overageLimitReached = optionalBoolean(creditsRaw.overage_limit_reached, 'credits overage_limit_reached')
    const approxCloudMessages = optionalJson(creditsRaw.approx_cloud_messages)
    const approxLocalMessages = optionalJson(creditsRaw.approx_local_messages)
    credits = {
      ...hasCredits === undefined ? {} : { hasCredits },
      ...unlimited === undefined ? {} : { unlimited },
      ...balance === undefined ? {} : { balance },
      ...overageLimitReached === undefined ? {} : { overageLimitReached },
      ...approxCloudMessages === undefined ? {} : { approxCloudMessages },
      ...approxLocalMessages === undefined ? {} : { approxLocalMessages },
    }
  }
  const spendControl = optionalJson(raw.spend_control)
  const resetCredits = optionalJson(raw.reset_credits)
  return {
    ...plan === undefined ? {} : { plan },
    ...credits === undefined ? {} : { credits },
    ...spendControl === undefined ? {} : { spendControl },
    ...resetCredits === undefined ? {} : { resetCredits },
  }
}

function parseGroup(value: unknown, index: number): CodexWireLimitGroup {
  const raw = record(value, `rate limit group ${String(index)}`)
  const name = optionalString(raw.name, `rate limit group ${String(index)} name`)
  const reached = optionalBoolean(raw.reached, `rate limit group ${String(index)} reached`)
  const primary = optionalWindow(raw.primary, `rate limit group ${String(index)} primary`)
  const secondary = optionalWindow(raw.secondary, `rate limit group ${String(index)} secondary`)
  return {
    id: nonEmptyString(raw.id, `rate limit group ${String(index)} id`),
    ...name === undefined ? {} : { name },
    ...reached === undefined ? {} : { reached },
    ...primary === undefined ? {} : { primary },
    ...secondary === undefined ? {} : { secondary },
  }
}

function optionalWindow(value: unknown, label: string): CodexWireLimitWindow | undefined {
  if (value === undefined || value === null) return undefined
  const raw = record(value, label)
  const windowSeconds = optionalPositiveInteger(raw.window_seconds, `${label} window_seconds`)
  const resetsAt = optionalInteger(raw.resets_at, `${label} resets_at`)
  const resetsInSeconds = optionalInteger(raw.resets_in_seconds, `${label} resets_in_seconds`)
  return {
    usedPercent: finiteNonNegative(raw.used_percent, `${label} used_percent`),
    ...windowSeconds === undefined ? {} : { windowSeconds },
    ...resetsAt === undefined ? {} : { resetsAt },
    ...resetsInSeconds === undefined ? {} : { resetsInSeconds },
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined || value === null ? undefined : record(value, label)
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be a string`)
  return value
}

function nonEmptyString(value: unknown, label: string): string {
  const parsed = string(value, label)
  if (parsed.length === 0) fail(`${label} must not be empty`)
  return parsed
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : nonEmptyString(value, label)
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`)
  return value
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  return value === undefined || value === null ? undefined : boolean(value, label)
}

function optionalCount(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(`${label} must be a non-negative safe integer`)
  return value as number
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  const parsed = optionalInteger(value, label)
  if (parsed !== undefined && parsed <= 0) fail(`${label} must be positive`)
  return parsed
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value)) fail(`${label} must be a safe integer`)
  return value as number
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a finite non-negative number`)
  }
  return value
}

function optionalJson(value: unknown): CodexWireJson | undefined {
  return value === undefined || value === null ? undefined : jsonValue(value, '$')
}

function jsonValue(value: unknown, path: string): CodexWireJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${String(index)}]`))
  if (typeof value === 'object') {
    const output: Record<string, CodexWireJson> = {}
    for (const [key, item] of Object.entries(value)) output[key] = jsonValue(item, `${path}.${key}`)
    return output
  }
  fail(`${path} must contain lossless JSON data`)
}

function fail(message: string): never {
  throw new LlmError(`Codex Wrapper Advanced protocol error: ${message}`, 'PROTOCOL')
}
