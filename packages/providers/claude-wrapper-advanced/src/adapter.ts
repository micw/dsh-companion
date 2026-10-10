/** Native DSH adapter over Claude Wrapper Advanced `/wire/v1`. */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, PreparedAdapterCall, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CLAUDE_WRAPPER_ADVANCED_PROVIDER, ClaudeCatalogGeneration } from './catalog.js'
import { translateClaudeWireStream } from './translate.js'
import type { ClaudeWireUsageReport } from './wire/types.js'
import { ClaudeWireClient } from './wire/client.js'
import { serializeClaudeWireRequest } from './wire/request.js'

export interface ClaudeAdapterGeneration { readonly client: ClaudeWireClient; readonly catalog: ClaudeCatalogGeneration }
export interface ClaudeAdapterOptions {
  readonly generation: (signal?: AbortSignal) => Promise<ClaudeAdapterGeneration>
  readonly imageUrl: (image: ImageAttachmentRef, signal?: AbortSignal) => Promise<string>
  readonly retryPolicy?: () => ResolvedRetryPolicy
  readonly modelEnabled?: (provider: string, model: string) => boolean
  readonly onQuota?: (usage: ClaudeWireUsageReport, limitGroups: readonly string[]) => void
  readonly onLimitStatus?: () => void
}
export class ClaudeWrapperAdvancedAdapter extends LlmAdapter {
  constructor(private readonly options: ClaudeAdapterOptions) { super() }
  override providerInfo(provider: string): LlmProviderInfo { this.owned(provider); return { id: provider, name: 'Claude' } }
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined { this.owned(provider); return this.options.retryPolicy?.() }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> { this.owned(provider); return (await this.options.generation()).catalog.listModels().filter(model => this.enabled(provider, model.id)) }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> { this.owned(provider); this.allowed(provider, model); return (await this.options.generation(signal)).catalog.resolveModel(model) }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> { this.owned(provider); this.allowed(provider, model); const generation = await this.options.generation(signal); return { model: generation.catalog.resolveModel(model), stream: request => this.withGeneration(request, generation) } }
  override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> { this.owned(request.provider); this.allowed(request.provider, request.model); yield* this.withGeneration(request, await this.options.generation(request.signal)) }
  private async * withGeneration(request: GenerateOptions, generation: ClaudeAdapterGeneration): AsyncIterable<StreamChunk> {
    const body = await serializeClaudeWireRequest(request, { wireModel: generation.catalog.wireModel(request.model), imageUrl: this.options.imageUrl })
    const events = await generation.client.responses(body, request.signal)
    yield* translateClaudeWireStream(events, {
      quota: usage => { try { this.options.onQuota?.(usage, generation.catalog.limitGroups(request.model)) } catch { /* presentation observer */ } },
      limitStatus: () => { try { this.options.onLimitStatus?.() } catch { /* presentation observer */ } },
    })
  }
  private owned(provider: string): void { if (provider !== CLAUDE_WRAPPER_ADVANCED_PROVIDER) throw new LlmError(`Claude adapter does not own ${provider}`, 'NO_ADAPTER') }
  private enabled(provider: string, model: string): boolean { return this.options.modelEnabled?.(provider, model) ?? true }
  private allowed(provider: string, model: string): void { if (!this.enabled(provider, model)) throw new LlmError(`Provider ${provider} model ${model} is disabled`, 'MODEL_DISABLED') }
}
