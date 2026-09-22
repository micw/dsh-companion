/** Strict OpenRouter model-catalog decoding and immutable pi-ai generation projection. */

import type { Model } from '@earendil-works/pi-ai'
import type {
  CompanionProviderCatalogView,
  CompanionProviderModel,
  ModelPricing,
} from '@dsh-companion/provider-catalog'
import { CompanionProviderId } from '@dsh-companion/provider-catalog'

/** DSH route owned by the dedicated OpenRouter provider. */
export const OPENROUTER_PROVIDER = CompanionProviderId('openrouter')
/** OpenRouter's public API root. */
export const DEFAULT_OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1'

const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

type InputModality = 'text' | 'image'

/** Validated pricing strings reported by OpenRouter per unit. */
export interface OpenRouterPricing {
  readonly prompt: string
  readonly completion: string
  readonly input_cache_read?: string
  readonly input_cache_write?: string
}

/** Validated reasoning capabilities reported for one model. */
export interface OpenRouterReasoning {
  readonly mandatory?: boolean
  readonly default_enabled?: boolean
  readonly supported_efforts: readonly string[]
  readonly default_effort?: string
}

/** Validated OpenRouter model fields consumed by Companion and pi-ai. */
export interface OpenRouterModel {
  readonly id: string
  readonly canonical_slug: string
  readonly name: string
  readonly created: number
  readonly description: string
  readonly context_length: number
  readonly architecture: {
    readonly input_modalities: readonly string[]
    readonly output_modalities: readonly string[]
  }
  readonly pricing: OpenRouterPricing
  readonly top_provider: {
    readonly context_length: number
    readonly max_completion_tokens: number
  }
  readonly supported_parameters: readonly string[]
  readonly reasoning?: OpenRouterReasoning
}

/** Durable provider-owned payload returned by OpenRouter's Models API. */
export interface OpenRouterCatalog {
  readonly data: readonly OpenRouterModel[]
  readonly total_count: number
  readonly links: { readonly next: null }
}

/** Decode one complete unpaginated OpenRouter Models API response. */
export function decodeOpenRouterCatalog(value: unknown): OpenRouterCatalog {
  const root = record(value, 'OpenRouter catalog')
  exactKeys(root, ['data', 'total_count', 'links'], 'OpenRouter catalog')
  const rows = array(root.data, 'OpenRouter catalog data').map((item, index) => decodeModel(item, index))
  const totalCount = natural(root.total_count, 'OpenRouter catalog total_count')
  if (totalCount !== rows.length) {
    throw new Error(`OpenRouter catalog total_count ${String(totalCount)} does not match ${String(rows.length)} rows`)
  }
  const links = record(root.links, 'OpenRouter catalog links')
  exactKeys(links, ['next'], 'OpenRouter catalog links')
  if (links.next !== null) throw new Error('OpenRouter catalog must be fetched without pagination')
  const ids = new Set<string>()
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`OpenRouter catalog repeats model ${row.id}`)
    ids.add(row.id)
  }
  return { data: rows, total_count: totalCount, links: { next: null } }
}

/** One immutable catalog generation used by both metadata and the pi-ai data plane. */
export class OpenRouterCatalogGeneration {
  readonly models: readonly Model<'openai-completions'>[]

  constructor(readonly payload: OpenRouterCatalog, apiBaseURL = DEFAULT_OPENROUTER_API_BASE_URL) {
    this.models = Object.freeze(payload.data.map(model => toPiModel(model, apiBaseURL)))
  }

  /** Resolve one exact model from this generation. */
  model(id: string): Model<'openai-completions'> {
    const model = this.models.find(candidate => candidate.id === id)
    if (model === undefined) throw new Error(`OpenRouter catalog has no model ${id}`)
    return model
  }
}

/** Project the provider payload into Companion's client-safe catalog. */
export function projectOpenRouterCatalog(payload: OpenRouterCatalog): CompanionProviderCatalogView {
  return {
    provider: OPENROUTER_PROVIDER,
    models: payload.data.map(projectModel),
  }
}

function decodeModel(value: unknown, index: number): OpenRouterModel {
  const label = `OpenRouter model ${String(index)}`
  const source = record(value, label)
  const required = [
    'id', 'canonical_slug', 'name', 'created', 'description', 'context_length', 'architecture',
    'pricing', 'top_provider', 'supported_parameters',
  ]
  for (const key of required) if (!(key in source)) throw new Error(`${label} is missing ${key}`)
  const architecture = record(source.architecture, `${label} architecture`)
  const pricing = record(source.pricing, `${label} pricing`)
  const topProvider = record(source.top_provider, `${label} top_provider`)
  const reasoning = source.reasoning === undefined || source.reasoning === null
    ? undefined
    : decodeReasoning(source.reasoning, label)
  const decoded: OpenRouterModel = {
    id: nonEmpty(source.id, `${label} id`),
    canonical_slug: nonEmpty(source.canonical_slug, `${label} canonical_slug`),
    name: nonEmpty(source.name, `${label} name`),
    created: natural(source.created, `${label} created`),
    description: string(source.description, `${label} description`),
    context_length: positive(source.context_length, `${label} context_length`),
    architecture: {
      input_modalities: strings(architecture.input_modalities, `${label} input_modalities`),
      output_modalities: strings(architecture.output_modalities, `${label} output_modalities`),
    },
    pricing: {
      prompt: decimal(pricing.prompt, `${label} pricing.prompt`),
      completion: decimal(pricing.completion, `${label} pricing.completion`),
      ...optionalDecimal(pricing, 'input_cache_read', label),
      ...optionalDecimal(pricing, 'input_cache_write', label),
    },
    top_provider: {
      context_length: positive(topProvider.context_length, `${label} top_provider.context_length`),
      max_completion_tokens: positive(
        topProvider.max_completion_tokens,
        `${label} top_provider.max_completion_tokens`,
      ),
    },
    supported_parameters: strings(source.supported_parameters, `${label} supported_parameters`),
    ...reasoning === undefined ? {} : { reasoning },
  }
  if (!decoded.architecture.output_modalities.includes('text')) {
    throw new Error(`${label} does not produce text`)
  }
  return decoded
}

function decodeReasoning(value: unknown, label: string): OpenRouterReasoning {
  const source = record(value, `${label} reasoning`)
  const efforts = strings(source.supported_efforts, `${label} reasoning.supported_efforts`)
  for (const effort of efforts) {
    if (!THINKING_LEVELS.has(effort)) throw new Error(`${label} has unsupported reasoning effort ${effort}`)
  }
  const defaultEffort = source.default_effort === undefined || source.default_effort === null
    ? undefined
    : nonEmpty(source.default_effort, `${label} reasoning.default_effort`)
  if (defaultEffort !== undefined && !efforts.includes(defaultEffort)) {
    throw new Error(`${label} reasoning default is not supported`)
  }
  return {
    ...optionalBoolean(source.mandatory, `${label} reasoning.mandatory`, 'mandatory'),
    ...optionalBoolean(source.default_enabled, `${label} reasoning.default_enabled`, 'default_enabled'),
    supported_efforts: efforts,
    ...defaultEffort === undefined ? {} : { default_effort: defaultEffort },
  }
}

function toPiModel(source: OpenRouterModel, apiBaseURL: string): Model<'openai-completions'> {
  const efforts = source.reasoning?.supported_efforts
  const thinkingLevelMap = efforts === undefined
    ? undefined
    : Object.fromEntries([...THINKING_LEVELS].map(level => [level, efforts.includes(level) ? level : null]))
  return {
    id: source.id,
    name: source.name,
    api: 'openai-completions',
    provider: OPENROUTER_PROVIDER,
    baseUrl: apiBaseURL,
    reasoning: source.reasoning !== undefined || source.supported_parameters.includes('reasoning'),
    ...thinkingLevelMap === undefined ? {} : { thinkingLevelMap },
    input: inputModalities(source.architecture.input_modalities),
    cost: {
      input: perMillionNumber(source.pricing.prompt),
      output: perMillionNumber(source.pricing.completion),
      cacheRead: perMillionNumber(source.pricing.input_cache_read ?? '0'),
      cacheWrite: perMillionNumber(source.pricing.input_cache_write ?? '0'),
    },
    contextWindow: source.top_provider.context_length,
    maxTokens: source.top_provider.max_completion_tokens,
    compat: { supportsDeveloperRole: false, thinkingFormat: 'openrouter' },
  }
}

function projectModel(source: OpenRouterModel): CompanionProviderModel {
  const reasoning = source.reasoning
  return {
    id: source.id,
    name: source.name,
    description: source.description,
    hidden: false,
    inputModalities: source.architecture.input_modalities,
    context: { default: source.context_length, maximum: source.top_provider.context_length },
    ...reasoning === undefined ? {} : {
      reasoning: {
        efforts: reasoning.supported_efforts,
        ...reasoning.default_effort === undefined ? {} : { defaultEffort: reasoning.default_effort },
      },
    },
    pricing: pricing(source),
  }
}

function pricing(source: OpenRouterModel): ModelPricing {
  return {
    kind: 'reported',
    currency: 'USD',
    unit: 'million-tokens',
    input: perMillionDecimal(source.pricing.prompt),
    output: perMillionDecimal(source.pricing.completion),
    ...source.pricing.input_cache_read === undefined
      ? {}
      : { cacheRead: perMillionDecimal(source.pricing.input_cache_read) },
    ...source.pricing.input_cache_write === undefined
      ? {}
      : { cacheWrite: perMillionDecimal(source.pricing.input_cache_write) },
    source: 'openrouter-models-api',
    tariffVersion: `${source.canonical_slug}@${String(source.created)}`,
  }
}

function inputModalities(values: readonly string[]): InputModality[] {
  const result: InputModality[] = ['text']
  if (values.includes('image')) result.push('image')
  return result
}

function perMillionNumber(value: string): number {
  const result = Number(perMillionDecimal(value))
  if (!Number.isFinite(result) || result < 0) throw new Error(`OpenRouter price ${value} is not finite`)
  return result
}

function perMillionDecimal(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.')
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, '')
  const places = fraction.length - 6
  if (places <= 0) return `${digits}${'0'.repeat(-places)}`.replace(/^0+(?=\d)/u, '')
  const padded = digits.padStart(places + 1, '0')
  const split = padded.length - places
  return `${padded.slice(0, split)}.${padded.slice(split)}`.replace(/^0+(?=\d)/u, '').replace(/\.?0+$/u, '') || '0'
}

function optionalDecimal(source: Record<string, unknown>, key: 'input_cache_read' | 'input_cache_write', label: string): Partial<OpenRouterPricing> {
  const value = source[key]
  return value === undefined || value === null ? {} : { [key]: decimal(value, `${label} pricing.${key}`) }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}
function nonEmpty(value: unknown, label: string): string {
  const result = string(value, label)
  if (result.length === 0) throw new Error(`${label} must not be empty`)
  return result
}
function strings(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => string(item, `${label}[${String(index)}]`))
}
function natural(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a natural safe integer`)
  return Number(value)
}
function positive(value: unknown, label: string): number {
  const result = natural(value, label)
  if (result === 0) throw new Error(`${label} must be positive`)
  return result
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
  return value
}
function optionalBoolean(
  value: unknown,
  label: string,
  key: 'mandatory' | 'default_enabled',
): Partial<OpenRouterReasoning> {
  return value === undefined || value === null ? {} : { [key]: boolean(value, label) }
}
function decimal(value: unknown, label: string): string {
  const result = string(value, label)
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(result)) throw new Error(`${label} must be a non-negative decimal`)
  return result
}
function exactKeys(source: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`${label} has unknown field ${key}`)
  for (const key of keys) if (!(key in source)) throw new Error(`${label} is missing ${key}`)
}
