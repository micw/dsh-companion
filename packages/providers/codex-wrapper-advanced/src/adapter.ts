/** Native DSH adapter over the complete Codex Wrapper Advanced wire API. */

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CODEX_WRAPPER_ADVANCED_PROVIDER, CodexCatalogGeneration } from './catalog.js'
import { translateCodexWireStream } from './translate.js'
import type { CodexWireTurnLimits } from './wire/types.js'
import { CodexWireClient } from './wire/client.js'
import { serializeCodexWireRequest } from './wire/request.js'

/** One immutable endpoint, credential, and catalog generation. */
export interface CodexAdapterGeneration {
  readonly client: CodexWireClient
  readonly catalog: CodexCatalogGeneration
}

/** Dependencies supplied by the provider plugin around the wire adapter. */
export interface CodexAdapterOptions {
  /** Resolve the complete generation used by the next operation. */
  readonly generation: (signal?: AbortSignal) => Promise<CodexAdapterGeneration>
  /** Resolve one durable DSH image to a wrapper-accepted URL. */
  readonly imageUrl: (image: ImageAttachmentRef, signal?: AbortSignal) => Promise<string>
  /** Retry policy captured when the provider route registers. */
  readonly retryPolicy?: () => ResolvedRetryPolicy
  /** Host policy decision for one exact route. */
  readonly modelEnabled?: (provider: string, model: string) => boolean
  /** Publish non-model account state observed on a completed provider response. */
  readonly onLimits?: (limits: CodexWireTurnLimits) => void
}

/** DSH LLM adapter for the single `codex-wrapper-advanced` route. */
export class CodexWrapperAdvancedAdapter extends LlmAdapter {
  constructor(private readonly options: CodexAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    this.assertProvider(provider)
    return { id: provider, name: 'Codex' }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    this.assertProvider(provider)
    return this.options.retryPolicy?.()
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertProvider(provider)
    return (await this.options.generation()).catalog.listModels()
      .filter(model => this.enabled(provider, model.id))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    this.assertProvider(provider)
    this.assertModelEnabled(provider, model)
    return (await this.options.generation(signal)).catalog.resolveModel(model)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    this.assertProvider(provider)
    this.assertModelEnabled(provider, model)
    const generation = await this.options.generation(signal)
    return {
      model: generation.catalog.resolveModel(model),
      stream: request => this.streamWithGeneration(request, generation),
    }
  }

  override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.assertProvider(request.provider)
    this.assertModelEnabled(request.provider, request.model)
    const generation = await this.options.generation(request.signal)
    yield* this.streamWithGeneration(request, generation)
  }

  private async * streamWithGeneration(
    request: GenerateOptions,
    generation: CodexAdapterGeneration,
  ): AsyncIterable<StreamChunk> {
    this.assertProvider(request.provider)
    const wireRequest = await serializeCodexWireRequest(request, {
      wireModel: generation.catalog.wireModel(request.model),
      imageUrl: this.options.imageUrl,
    })
    const events = await generation.client.responses(wireRequest, request.signal)
    yield* translateCodexWireStream(events, {
      limits: (limits) => {
        try {
          this.options.onLimits?.(limits)
        } catch {
          // Account presentation must not turn a completed model response into a failed attempt.
        }
      },
    })
  }

  private assertProvider(provider: string): void {
    if (provider !== CODEX_WRAPPER_ADVANCED_PROVIDER) {
      throw new LlmError(
        `Codex Wrapper Advanced adapter does not own provider ${JSON.stringify(provider)}`,
        'NO_ADAPTER',
      )
    }
  }

  private enabled(provider: string, model: string): boolean {
    return this.options.modelEnabled?.(provider, model) ?? true
  }

  private assertModelEnabled(provider: string, model: string): void {
    if (this.enabled(provider, model)) return
    throw new LlmError(
      `Provider ${JSON.stringify(provider)} model ${JSON.stringify(model)} is disabled by DSH Companion model policy`,
      'MODEL_DISABLED',
    )
  }
}
