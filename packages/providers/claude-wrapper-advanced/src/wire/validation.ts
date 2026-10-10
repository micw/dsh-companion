/** Strict validation at the external Claude Wrapper Advanced wire boundary. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ClaudeWireCatalog, ClaudeWireCost, ClaudeWireEvent, ClaudeWireJson, ClaudeWireLimitGroup, ClaudeWireModel, ClaudeWireServiceInfo, ClaudeWireUsage, ClaudeWireUsageReport } from './types.js'

export function parseClaudeWireServiceInfo(value: unknown): ClaudeWireServiceInfo {
  const root = exact(value, ['service', 'version'], 'service info')
  if (root.service !== 'claude-wrapper-advanced') fail('service info does not identify claude-wrapper-advanced')
  return { service: root.service, version: text(root.version, 'service info version') }
}

export function parseClaudeWireCatalog(value: unknown): ClaudeWireCatalog {
  const root = exact(value, ['models'], 'model catalog')
  if (!Array.isArray(root.models)) fail('model catalog models must be an array')
  const seen = new Set<string>()
  const models = root.models.map((item, index) => {
    const model = parseModel(item, index)
    if (seen.has(model.id)) fail(`duplicate model ${JSON.stringify(model.id)}`)
    seen.add(model.id)
    return model
  })
  return { models }
}

export function parseClaudeWireUsageReport(value: unknown): ClaudeWireUsageReport {
  const root = exact(value, ['groups'], 'usage report')
  if (!Array.isArray(root.groups)) fail('usage report groups must be an array')
  const groups = root.groups.map(parseGroup)
  if (new Set(groups.map(group => group.id)).size !== groups.length) fail('usage report contains duplicate groups')
  return { groups }
}

export function parseClaudeWireEvent(value: unknown): ClaudeWireEvent {
  const event = record(value, 'stream event')
  const type = text(event.type, 'stream event type')
  switch (type) {
    case 'started': {
      exactKeys(event, ['type', 'model', 'reused'], type)
      return { type, model: text(event.model, 'started model'), reused: bool(event.reused, 'started reused') }
    }
    case 'text_delta':
      exactKeys(event, ['type', 'text'], type)
      return { type, text: stringValue(event.text, 'text_delta text') }
    case 'thinking_progress':
      exactKeys(event, ['type', 'tokens'], type)
      return { type, tokens: count(event.tokens, 'thinking_progress tokens') }
    case 'tool_call':
      exactKeys(event, ['type', 'id', 'name', 'arguments'], type)
      return { type, callId: text(event.id, 'tool_call id'), name: text(event.name, 'tool_call name'), arguments: stringValue(event.arguments, 'tool_call arguments') }
    case 'quota':
      exactKeys(event, ['type', 'usage'], type)
      return { type, usage: parseClaudeWireUsageReport(event.usage) }
    case 'limit_status': {
      exactKeys(event, [
        'type', 'window', 'claim', 'status', 'resets_at', 'surpassed_threshold', 'overage', 'usage_stale',
      ], type)
      json(event.surpassed_threshold, 'limit_status surpassed_threshold')
      json(event.overage, 'limit_status overage')
      return {
        type,
        ...(event.status == null ? {} : { status: text(event.status, 'limit_status status') }),
        usageStale: bool(event.usage_stale, 'limit_status usage_stale'),
        ...(event.window == null ? {} : { window: json(event.window, 'limit_status window') }),
        ...(event.claim == null ? {} : { claim: json(event.claim, 'limit_status claim') }),
        ...(event.resets_at == null ? {} : { resetsAt: count(event.resets_at, 'limit_status resets_at') }),
      }
    }
    case 'done': {
      exactKeys(event, ['type', 'stop_reason', 'text', 'usage', 'cost', 'timing'], type)
      json(event.timing, 'done.timing')
      return {
        type,
        stopReason: text(event.stop_reason, 'done stop_reason'),
        text: stringValue(event.text, 'done text'),
        usage: parseUsage(event.usage),
        cost: parseCost(event.cost),
      }
    }
    case 'failed': {
      const allowed = ['type', 'error_type', 'message', 'upstream_status', 'retryable', 'cost']
      exactKeys(event, allowed.filter(key => key !== 'upstream_status' || Object.hasOwn(event, key)), type)
      const upstreamStatus = event.upstream_status === null || event.upstream_status === undefined ? undefined : count(event.upstream_status, 'failed upstream_status')
      return {
        type,
        errorType: text(event.error_type, 'failed error_type'),
        message: text(event.message, 'failed message'),
        ...upstreamStatus === undefined ? {} : { upstreamStatus },
        retryable: bool(event.retryable, 'failed retryable'),
        cost: parseCost(event.cost),
      }
    }
    default: fail(`unsupported stream event type ${JSON.stringify(type)}`)
  }
}

function parseModel(value: unknown, index: number): ClaudeWireModel {
  const raw = exact(value, ['id', 'name', 'backend_model', 'context_length', 'input_modalities', 'efforts', 'knowledge_cutoff', 'aliases', 'limit_groups'], `model ${String(index)}`)
  const efforts = exact(raw.efforts, ['supported', 'default'], `model ${String(index)} efforts`, true)
  const supported = strings(efforts.supported, `model ${String(index)} efforts supported`)
  const defaultEffort = efforts.default === null || efforts.default === undefined ? undefined : text(efforts.default, 'efforts default')
  if (defaultEffort !== undefined && !supported.includes(defaultEffort)) fail('efforts default is not supported')
  return {
    id: text(raw.id, 'model id'), backendModel: text(raw.backend_model, 'backend_model'), name: text(raw.name, 'model name'),
    contextLength: positive(raw.context_length, 'context_length'), inputModalities: strings(raw.input_modalities, 'input_modalities'),
    efforts: { supported, ...defaultEffort === undefined ? {} : { default: defaultEffort } },
    ...raw.knowledge_cutoff === null || raw.knowledge_cutoff === undefined ? {} : { knowledgeCutoff: text(raw.knowledge_cutoff, 'knowledge_cutoff') },
    aliases: strings(raw.aliases, 'aliases'), limitGroups: strings(raw.limit_groups, 'limit_groups'),
  }
}

function parseUsage(value: unknown): ClaudeWireUsage {
  const raw = exact(value, ['input_new', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h', 'input_total', 'output', 'thinking', 'thinking_basis', 'service_tier'], 'done usage', true)
  const usage: ClaudeWireUsage = {
    inputNew: count(raw.input_new, 'input_new'), cacheRead: count(raw.cache_read, 'cache_read'), cacheWrite: count(raw.cache_write, 'cache_write'),
    inputTotal: count(raw.input_total, 'input_total'), output: count(raw.output, 'output'),
    ...raw.cache_write_5m === null || raw.cache_write_5m === undefined ? {} : { cacheWrite5m: count(raw.cache_write_5m, 'cache_write_5m') },
    ...raw.cache_write_1h === null || raw.cache_write_1h === undefined ? {} : { cacheWrite1h: count(raw.cache_write_1h, 'cache_write_1h') },
    ...raw.thinking === null || raw.thinking === undefined ? {} : { thinking: count(raw.thinking, 'thinking') },
    ...raw.thinking_basis === null || raw.thinking_basis === undefined ? {} : {
      thinkingBasis: raw.thinking_basis === 'reported' || raw.thinking_basis === 'estimated'
        ? raw.thinking_basis
        : fail('thinking_basis must be reported, estimated, or null'),
    },
    ...raw.service_tier === null || raw.service_tier === undefined ? {} : { serviceTier: text(raw.service_tier, 'service_tier') },
  }
  if (usage.inputTotal !== usage.inputNew + usage.cacheRead + usage.cacheWrite) fail('input_total is inconsistent')
  if ((usage.thinking === undefined) !== (usage.thinkingBasis === undefined)) fail('thinking and thinking_basis must be present together')
  return usage
}

function parseCost(value: unknown): ClaudeWireCost {
  const raw = exact(value, ['total_usd', 'by_model', 'scope', 'covered_requests', 'epoch'], 'done cost')
  const totalUsd = raw.total_usd === null ? undefined : finite(raw.total_usd, 'cost total_usd')
  const scope = raw.scope === null ? undefined : raw.scope === 'call' || raw.scope === 'turn' ? raw.scope : fail('cost scope must be call, turn, or null')
  const byModelRaw = record(raw.by_model, 'cost by_model')
  const byModel: Record<string, ClaudeWireJson> = {}
  for (const [key, item] of Object.entries(byModelRaw)) byModel[key] = json(item, `by_model.${key}`)
  const coveredRequests = raw.covered_requests === null ? undefined : positive(raw.covered_requests, 'cost covered_requests')
  const epoch = uuid(raw.epoch, 'cost epoch')
  if (totalUsd === undefined && scope !== undefined) fail('cost without total_usd must not have scope')
  if (scope === 'call' && coveredRequests !== 1) fail('call cost must cover exactly one request')
  if (scope === 'turn' && (coveredRequests === undefined || coveredRequests < 2)) fail('turn cost must cover at least two requests')
  if (scope === undefined && coveredRequests !== undefined) fail('unscoped cost must not claim covered requests')
  return { ...totalUsd === undefined ? {} : { totalUsd }, ...scope === undefined ? {} : { scope }, ...coveredRequests === undefined ? {} : { coveredRequests }, epoch, byModel }
}

function parseGroup(value: unknown, index: number): ClaudeWireLimitGroup {
  const raw = exact(value, ['id', 'upstream_id', 'scope', 'observed_at', 'age_seconds', 'windows'], `usage group ${String(index)}`)
  if (!Array.isArray(raw.windows)) fail('usage group windows must be an array')
  json(raw.upstream_id, `usage group ${String(index)} upstream_id`)
  json(raw.scope, `usage group ${String(index)} scope`)
  const windows = raw.windows.flatMap((item, wi) => {
    const win = exact(item, ['id', 'upstream_id', 'used_percent', 'window_seconds', 'resets_at'], `window ${String(wi)}`)
    json(win.upstream_id, `window ${String(wi)} upstream_id`)
    const id = text(win.id, 'window id')
    const windowSeconds = win.window_seconds == null ? undefined : positive(win.window_seconds, 'window_seconds')
    if (win.used_percent == null) {
      if (win.resets_at != null) fail(`window ${String(wi)} must not report resets_at without used_percent`)
      return []
    }
    return [{ id, usedPercent: finite(win.used_percent, 'used_percent'), ...windowSeconds === undefined ? {} : { windowSeconds }, ...win.resets_at == null ? {} : { resetsAt: count(win.resets_at, 'resets_at') } }]
  })
  return { id: text(raw.id, 'group id'), ...raw.observed_at == null ? {} : { observedAt: count(raw.observed_at, 'observed_at') }, ...raw.age_seconds == null ? {} : { ageSeconds: count(raw.age_seconds, 'age_seconds') }, windows }
}

function exact(value: unknown, keys: readonly string[], label: string, _nullable = false): Record<string, unknown> { const out = record(value, label); exactKeys(out, keys, label); return out }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void { const a = Object.keys(value).sort(); const b = [...keys].sort(); if (a.length !== b.length || a.some((key, i) => key !== b[i])) fail(`${label} fields must be exactly ${b.join(', ')}`) }
function record(value: unknown, label: string): Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`); return value as Record<string, unknown> }
function stringValue(value: unknown, label: string): string { if (typeof value !== 'string') fail(`${label} must be a string`); return value }
function text(value: unknown, label: string): string { const out = stringValue(value, label); if (out.length === 0) fail(`${label} must not be empty`); return out }
function uuid(value: unknown, label: string): string { const out = text(value, label); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(out)) fail(`${label} must be a UUID`); return out }
function bool(value: unknown, label: string): boolean { if (typeof value !== 'boolean') fail(`${label} must be boolean`); return value }
function count(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || Number(value) < 0 || Object.is(value, -0)) fail(`${label} must be a non-negative safe integer`); return value as number }
function positive(value: unknown, label: string): number { const out = count(value, label); if (out === 0) fail(`${label} must be positive`); return out }
function finite(value: unknown, label: string): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${label} must be finite non-negative`); return value }
function strings(value: unknown, label: string): string[] { if (!Array.isArray(value)) fail(`${label} must be an array`); const out = value.map((item, i) => text(item, `${label}[${String(i)}]`)); if (new Set(out).size !== out.length) fail(`${label} contains duplicates`); return out }
function json(value: unknown, path: string): ClaudeWireJson { if (value === null || typeof value === 'string' || typeof value === 'boolean') return value; if (typeof value === 'number' && Number.isFinite(value)) return value; if (Array.isArray(value)) return value.map((item, i) => json(item, `${path}[${String(i)}]`)); if (typeof value === 'object') { const out: Record<string, ClaudeWireJson> = {}; for (const [key, item] of Object.entries(value)) out[key] = json(item, `${path}.${key}`); return out } fail(`${path} must be JSON`) }
function fail(message: string): never { throw new LlmError(`Claude Wrapper Advanced protocol error: ${message}`, 'PROTOCOL') }
