/** Immutable Claude wrapper catalog projection. */
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo, ModelModality } from '@deepseek-ai/dsh-llm'
import { CompanionProviderId } from '@dsh-companion/provider-catalog'
import type { CompanionProviderCatalogView, CompanionProviderModel } from '@dsh-companion/provider-catalog'
import type { ClaudeWireCatalog, ClaudeWireModel } from './wire/types.js'
import { parseClaudeWireCatalog } from './wire/validation.js'

export const CLAUDE_WRAPPER_ADVANCED_PROVIDER = CompanionProviderId('claude-wrapper-advanced')
interface Projected { readonly info: LlmResolvedModelInfo; readonly wireModel: string; readonly limitGroups: readonly string[] }
export class ClaudeCatalogGeneration {
  private readonly models: ReadonlyMap<string, Projected>
  constructor(catalog: ClaudeWireCatalog) {
    this.models = new Map(catalog.models.map(model => [model.id, { info: projectInfo(model), wireModel: model.id, limitGroups: model.limitGroups }]))
  }
  listModels(): readonly LlmModelInfo[] { return [...this.models.values()].map(value => value.info) }
  resolveModel(id: string): LlmResolvedModelInfo { const found = this.models.get(id); if (found === undefined) throw unknown(id); return found.info }
  wireModel(id: string): string { const found = this.models.get(id); if (found === undefined) throw unknown(id); return found.wireModel }
  limitGroups(id: string): readonly string[] { const found = this.models.get(id); if (found === undefined) throw unknown(id); return found.limitGroups }
}
function projectInfo(model: ClaudeWireModel): LlmResolvedModelInfo {
  const modalities = model.inputModalities.map((value): ModelModality => { if (value === 'text' || value === 'image') return value; throw new LlmError(`Unsupported modality ${value}`, 'INVALID_CATALOG') })
  const efforts = model.efforts.supported.map(value => ({ id: ReasoningEffortId(value), name: value[0]?.toUpperCase() + value.slice(1) }))
  return { provider: CLAUDE_WRAPPER_ADVANCED_PROVIDER, id: model.id, name: model.name, inputModalities: modalities, context: { contextWindow: model.contextLength }, ...efforts.length === 0 ? {} : { reasoning: { efforts, ...model.efforts.default === undefined ? {} : { defaultEffort: ReasoningEffortId(model.efforts.default) } } } }
}
export function projectCompanionCatalog(catalog: ClaudeWireCatalog): CompanionProviderCatalogView {
  const models: CompanionProviderModel[] = catalog.models.map(model => ({ id: model.id, name: model.name, hidden: false, inputModalities: [...model.inputModalities], context: { default: model.contextLength, maximum: model.contextLength }, reasoning: { efforts: [...model.efforts.supported], ...model.efforts.default === undefined ? {} : { defaultEffort: model.efforts.default }, summarySupported: false } }))
  return { provider: CLAUDE_WRAPPER_ADVANCED_PROVIDER, models }
}
export function decodeClaudeCatalogPayload(value: unknown): ClaudeWireCatalog {
  if (!record(value) || !Array.isArray(value.models)) throw new LlmError('Stored Claude catalog must contain models', 'INVALID_CATALOG')
  return parseClaudeWireCatalog({ models: value.models.map(item => {
    if (!record(item) || !record(item.efforts)) return item
    return { id: item.id, backend_model: item.backendModel, name: item.name, context_length: item.contextLength, input_modalities: item.inputModalities, efforts: { supported: item.efforts.supported, default: item.efforts.default ?? null }, knowledge_cutoff: item.knowledgeCutoff ?? null, aliases: item.aliases, limit_groups: item.limitGroups }
  }) })
}
function unknown(id: string): LlmError { return new LlmError(`Claude Wrapper Advanced catalog has no model ${JSON.stringify(id)}`, 'UNKNOWN_MODEL') }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
