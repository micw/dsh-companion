/** Immutable projection of one validated wrapper catalog into DSH model metadata. */

import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, ModelModality } from '@deepseek-ai/dsh-llm'
import { CompanionProviderId } from '@dsh-companion/provider-catalog'
import type { CompanionProviderCatalogView, CompanionProviderModel } from '@dsh-companion/provider-catalog'
import type { CodexWireCatalog, CodexWireModel } from './wire/types.js'
import { parseCodexWireCatalog } from './wire/validation.js'

/** Stable DSH provider route owned by this integration. */
export const CODEX_WRAPPER_ADVANCED_PROVIDER = CompanionProviderId('codex-wrapper-advanced')

/** Models whose independently measured maximum is exposed as a second DSH budget choice. */
const LONG_CONTEXT_MODELS: ReadonlySet<string> = new Set(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'])

/** One exact DSH model projection and the model identifier sent on the wire. */
interface ProjectedModel {
  readonly info: LlmResolvedModelInfo
  readonly wireModel: string
  readonly hidden: boolean
}

/**
 * One immutable wrapper catalog generation. Catalog refresh publishes a new
 * instance instead of mutating one a prepared DSH call may still hold.
 */
export class CodexCatalogGeneration {
  private readonly models: ReadonlyMap<string, ProjectedModel>
  private readonly advertised: readonly LlmModelInfo[]

  /** Build one complete generation from an already validated wrapper response. */
  constructor(catalog: CodexWireCatalog) {
    const models = new Map<string, ProjectedModel>()
    for (const model of catalog.models) {
      this.add(models, model.id, model, model.defaultContextLength, model.hidden)
      if (LONG_CONTEXT_MODELS.has(model.id)
        && model.maxContextLength !== undefined
        && model.defaultContextLength !== undefined
        && model.maxContextLength > model.defaultContextLength) {
        this.add(models, `${model.id}:long`, model, model.maxContextLength, model.hidden, true)
      }
    }
    this.models = models
    this.advertised = Object.freeze([...models.values()]
      .filter(model => !model.hidden)
      .map(model => Object.freeze({
        provider: model.info.provider,
        id: model.info.id,
        name: model.info.name,
        ...model.info.description === undefined ? {} : { description: model.info.description },
        ...model.info.inputModalities === undefined ? {} : { inputModalities: model.info.inputModalities },
      })))
    Object.freeze(this)
  }

  /** Models shown by ordinary DSH selectors, in wrapper order. */
  listModels(): readonly LlmModelInfo[] {
    return this.advertised
  }

  /** Resolve complete DSH metadata for an exact base, hidden, or long-budget model id. */
  resolveModel(model: string): LlmResolvedModelInfo {
    const projected = this.models.get(model)
    if (projected === undefined) {
      throw new LlmError(
        `Codex Wrapper Advanced catalog has no model ${JSON.stringify(model)}`,
        'UNKNOWN_MODEL',
      )
    }
    return projected.info
  }

  /** Resolve the wrapper-facing model identifier for an exact DSH model id. */
  wireModel(model: string): string {
    const projected = this.models.get(model)
    if (projected === undefined) {
      throw new LlmError(
        `Codex Wrapper Advanced catalog has no model ${JSON.stringify(model)}`,
        'UNKNOWN_MODEL',
      )
    }
    return projected.wireModel
  }

  private add(
    models: Map<string, ProjectedModel>,
    id: string,
    source: CodexWireModel,
    contextWindow: number | undefined,
    hidden: boolean,
    long = false,
  ): void {
    if (models.has(id)) {
      throw new LlmError(
        `Codex Wrapper Advanced catalog projection produced duplicate model id ${JSON.stringify(id)}`,
        'INVALID_CATALOG',
      )
    }
    const inputModalities = projectModalities(source)
    const levels = selectableReasoningLevels(source)
    const efforts = levels.map(level => ({
      id: ReasoningEffortId(level),
      name: effortName(level),
    }))
    const defaultEffort = source.reasoning.default !== undefined
      && levels.includes(source.reasoning.default)
      ? ReasoningEffortId(source.reasoning.default)
      : undefined
    const info: LlmResolvedModelInfo = Object.freeze({
      provider: CODEX_WRAPPER_ADVANCED_PROVIDER,
      id,
      name: long ? `${source.displayName} (Long context)` : source.displayName,
      ...source.description === undefined ? {} : { description: source.description },
      inputModalities: Object.freeze(inputModalities),
      ...contextWindow === undefined ? {} : { context: Object.freeze({ contextWindow }) },
      ...efforts.length === 0
        ? {}
        : {
          reasoning: Object.freeze({
            efforts: Object.freeze(efforts.map(effort => Object.freeze(effort))),
            ...defaultEffort === undefined ? {} : { defaultEffort },
          }),
        },
    })
    models.set(id, Object.freeze({ info, wireModel: source.model, hidden }))
  }
}

/** Project one validated wrapper payload for generic Companion settings clients. */
export function projectCompanionCatalog(catalog: CodexWireCatalog): CompanionProviderCatalogView {
  const models: CompanionProviderModel[] = []
  for (const model of catalog.models) {
    models.push(companionModel(model.id, model, model.defaultContextLength, model.hidden))
    if (LONG_CONTEXT_MODELS.has(model.id)
      && model.maxContextLength !== undefined
      && model.defaultContextLength !== undefined
      && model.maxContextLength > model.defaultContextLength) {
      models.push(companionModel(`${model.id}:long`, model, model.maxContextLength, model.hidden, true))
    }
  }
  return { provider: CODEX_WRAPPER_ADVANCED_PROVIDER, models }
}

/** Validate a normalized catalog payload restored from the generic LKG domain. */
export function decodeCodexCatalogPayload(value: unknown): CodexWireCatalog {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new LlmError('Stored Codex Wrapper Advanced catalog must contain a models array', 'INVALID_CATALOG')
  }
  return parseCodexWireCatalog({
    models: value.models.map((candidate) => {
      if (!isRecord(candidate) || !isRecord(candidate.reasoning)) return candidate
      return {
        id: candidate.id,
        model: candidate.model,
        display_name: candidate.displayName,
        description: candidate.description ?? null,
        hidden: candidate.hidden,
        input_modalities: candidate.inputModalities,
        default_context_length: candidate.defaultContextLength ?? null,
        max_context_length: candidate.maxContextLength ?? null,
        reasoning: {
          levels: candidate.reasoning.levels,
          default: candidate.reasoning.default ?? null,
          summary_supported: candidate.reasoning.summarySupported,
        },
      }
    }),
  })
}

function companionModel(
  id: string,
  source: CodexWireModel,
  selectedContext: number | undefined,
  hidden: boolean,
  long = false,
): CompanionProviderModel {
  const levels = selectableReasoningLevels(source)
  return {
    id,
    name: long ? `${source.displayName} (Long context)` : source.displayName,
    ...source.description === undefined ? {} : { description: source.description },
    hidden,
    inputModalities: [...source.inputModalities],
    context: {
      ...selectedContext === undefined ? {} : { default: selectedContext },
      ...source.maxContextLength === undefined ? {} : { maximum: source.maxContextLength },
    },
    reasoning: {
      efforts: levels,
      ...source.reasoning.default === undefined
        || !levels.includes(source.reasoning.default)
        ? {}
        : { defaultEffort: source.reasoning.default },
      summarySupported: source.reasoning.summarySupported,
    },
  }
}

function selectableReasoningLevels(model: CodexWireModel): string[] {
  // Older wrapper releases advertise `none` for GPT-6.1 Sol, but its backend rejects it.
  return model.id === 'gpt-6.1-sol'
    ? model.reasoning.levels.filter(level => level !== 'none')
    : [...model.reasoning.levels]
}

function projectModalities(model: CodexWireModel): ModelModality[] {
  return model.inputModalities.map((modality) => {
    if (modality === 'text' || modality === 'image') return modality
    throw new LlmError(
      `Codex Wrapper Advanced model ${JSON.stringify(model.id)} reports unsupported input modality ${JSON.stringify(modality)}`,
      'INVALID_CATALOG',
    )
  })
}

function effortName(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
