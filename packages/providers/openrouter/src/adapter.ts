/** OpenRouter adapter that delegates request conversion and streaming to DSH's public PiAiAdapter. */

import type { AuthContext, CredentialStore, Provider } from '@earendil-works/pi-ai'
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { OPENROUTER_PROVIDER, OpenRouterCatalogGeneration } from './catalog.js'

/** Adapter-owned request bounds required by PiAiAdapter's resolved profile. */
export interface OpenRouterPiAiLimits {
  readonly streamIdleTimeoutMs: number
  readonly maxRequestImageBytes: number
  readonly requestImagePixelBudget: number
  readonly requestImageMaxBytes: number
}

/** Dependencies for the OpenRouter-to-PiAiAdapter bridge. */
export interface OpenRouterAdapterOptions {
  /** Resolve and freeze one immutable catalog generation for an operation. */
  readonly generation: (signal?: AbortSignal) => Promise<OpenRouterCatalogGeneration>
  /** Resolve the OpenRouter API key without exposing it to catalog or UI state. */
  readonly apiKey: () => Promise<string>
  /** Provider-owned retry policy captured by the DSH route registration. */
  readonly retryPolicy?: () => ResolvedRetryPolicy
  /** Request/image bounds passed unchanged to PiAiAdapter. */
  readonly limits: () => OpenRouterPiAiLimits
  /** Resolve DSH's durable attachment store for image-capable requests. */
  readonly resolveAttachments?: () => AttachmentStore | undefined
  /** Model-policy decision made before model resolution or provider I/O. */
  readonly modelEnabled?: (provider: string, model: string) => boolean
}

/** Dedicated OpenRouter route over DSH's canonical pi-ai data plane. */
export class OpenRouterAdapter extends LlmAdapter {
  private readonly adapters = new WeakMap<OpenRouterCatalogGeneration, PiAiAdapter>()

  constructor(private readonly options: OpenRouterAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    this.owned(provider)
    return { id: provider, name: 'OpenRouter' }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    this.owned(provider)
    return this.options.retryPolicy?.()
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.owned(provider)
    const generation = await this.options.generation()
    const models = await this.adapter(generation).listModels(provider)
    return models.filter(model => this.enabled(provider, model.id))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    this.owned(provider)
    this.allowed(provider, model)
    const generation = await this.options.generation(signal)
    return this.adapter(generation).resolveModel(provider, model, signal)
  }

  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    this.owned(provider)
    this.allowed(provider, model)
    const generation = await this.options.generation(signal)
    return this.adapter(generation).prepareCall(provider, model, signal)
  }

  override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.owned(request.provider)
    this.allowed(request.provider, request.model)
    const generation = await this.options.generation(request.signal)
    yield* this.adapter(generation).stream(request)
  }

  private adapter(generation: OpenRouterCatalogGeneration): PiAiAdapter {
    const current = this.adapters.get(generation)
    if (current !== undefined) return current
    const base = openrouterProvider()
    const limits = this.options.limits()
    const provider: Provider<'openai-completions'> = {
      id: OPENROUTER_PROVIDER,
      name: 'OpenRouter',
      ...base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl },
      auth: base.auth,
      getModels: () => generation.models,
      stream: (model, context, options) => base.stream(model, context, options),
      streamSimple: (model, context, options) => base.streamSimple(model, context, options),
    }
    const profile: ResolvedPiAiProviderProfile = {
      provider: OPENROUTER_PROVIDER,
      displayName: 'OpenRouter',
      streamIdleTimeoutMs: limits.streamIdleTimeoutMs,
      maxRequestImageBytes: limits.maxRequestImageBytes,
      requestImagePixelBudget: limits.requestImagePixelBudget,
      requestImageMaxBytes: limits.requestImageMaxBytes,
      retryPolicy: this.options.retryPolicy?.() ?? resolveRetryPolicy(undefined, 'OpenRouter retry policy'),
      configuredMaxTokens: new Map(),
      modelErrors: new Map(),
      piProvider: provider,
    }
    const profiles = new Map([[OPENROUTER_PROVIDER, profile]])
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: () => this.options.apiKey(),
      auth: EMPTY_AUTH,
      ...this.options.resolveAttachments === undefined ? {} : {
        resolveAttachments: this.options.resolveAttachments,
      },
    })
    this.adapters.set(generation, adapter)
    return adapter
  }

  private owned(provider: string): void {
    if (provider !== OPENROUTER_PROVIDER) {
      throw new LlmError(`OpenRouter adapter does not own ${provider}`, 'NO_ADAPTER')
    }
  }

  private enabled(provider: string, model: string): boolean {
    return this.options.modelEnabled?.(provider, model) ?? true
  }

  private allowed(provider: string, model: string): void {
    if (!this.enabled(provider, model)) {
      throw new LlmError(`Provider ${provider} model ${model} is disabled`, 'MODEL_DISABLED')
    }
  }
}

const EMPTY_CREDENTIALS: CredentialStore = {
  read: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  modify: (_provider, operation) => operation(undefined),
  delete: () => Promise.resolve(),
}
const EMPTY_CONTEXT: AuthContext = {
  env: () => Promise.resolve(undefined),
  fileExists: () => Promise.resolve(false),
}
const EMPTY_AUTH = { credentials: EMPTY_CREDENTIALS, authContext: EMPTY_CONTEXT }
