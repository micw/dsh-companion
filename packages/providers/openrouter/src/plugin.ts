/** Cordis plugin wiring OpenRouter settings, credentials, catalog LKG, account state, and PiAiAdapter. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { COMPANION_MODEL_POLICY_SETTINGS_NAMESPACE } from '@dsh-companion/model-policy'
import type {} from '@dsh-companion/model-policy'
import type {
  CompanionProviderAccountRegistration,
  CompanionProviderAccountSource,
} from '@dsh-companion/provider-account'
import type {
  CompanionProviderCatalogRegistration,
  CompanionProviderCatalogSource,
} from '@dsh-companion/provider-catalog'
import { projectOpenRouterAccount } from './account.js'
import { OpenRouterAdapter } from './adapter.js'
import {
  DEFAULT_OPENROUTER_API_BASE_URL,
  OPENROUTER_PROVIDER,
  OpenRouterCatalogGeneration,
  decodeOpenRouterCatalog,
  projectOpenRouterCatalog,
} from './catalog.js'
import type { OpenRouterCatalog } from './catalog.js'
import { OpenRouterClient } from './client.js'

/** DSH Settings namespace owned by this provider. */
export const OPENROUTER_SETTINGS_NAMESPACE = 'dsh-companion-openrouter'
/** Conventional DSH credential reference for the OpenRouter API key. */
export const DEFAULT_OPENROUTER_API_KEY_REF = 'OPENROUTER_API_KEY'

/** User-configurable OpenRouter connection and request policy. */
export interface Config {
  /** Whether the OpenRouter DSH route is registered. */
  enabled?: boolean
  /** OpenRouter-compatible API root. */
  baseURL?: string
  /** DSH credential reference holding the API key. */
  apiKeyEnv?: string
  /** Provider-owned retry policy captured with route registration. */
  retryPolicy?: RetryPolicyConfig
  /** Maximum idle interval while one streamed read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Aggregate base64 image payload bound passed to PiAiAdapter. */
  maxRequestImageBytes?: number
  /** Per-image pixel budget passed to PiAiAdapter. */
  requestImagePixelBudget?: number
  /** Per-image encoded-byte target passed to PiAiAdapter. */
  requestImageMaxBytes?: number
}

/** Runtime schema for OpenRouter settings. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  baseURL: z.string().default(DEFAULT_OPENROUTER_API_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_OPENROUTER_API_KEY_REF),
  retryPolicy: RetryPolicySchema,
  streamIdleTimeoutMs: z.number().step(1).min(1).default(300_000),
  maxRequestImageBytes: z.number().step(1).min(1).default(20 * 1024 * 1024),
  requestImagePixelBudget: z.number().step(1).min(1).default(2048 * 2048),
  requestImageMaxBytes: z.number().step(1).min(1).default(1024 * 1024),
})

/** Cordis plugin identity. */
export const name = 'dsh-companion/provider-openrouter'
/** Required canonical DSH and Companion services. */
export const inject = [
  'llm', 'credentials', 'companionProviderCatalog', 'companionProviderAccounts', 'companionModelPolicy',
]

interface ResolvedConfig {
  readonly enabled: boolean
  readonly baseURL: string
  readonly apiKeyEnv: CredentialRef
  readonly retryPolicy: ReturnType<typeof resolveRetryPolicy>
  readonly streamIdleTimeoutMs: number
  readonly maxRequestImageBytes: number
  readonly requestImagePixelBudget: number
  readonly requestImageMaxBytes: number
}

/** Register the settings-driven OpenRouter provider. */
export function apply(ctx: Context, config: Config): () => Promise<void> {
  let current: () => Config = () => config
  let adapterRegistration: AdapterRegistrationHandle | undefined
  let catalogRegistration: CompanionProviderCatalogRegistration<OpenRouterCatalog> | undefined
  let accountRegistration: CompanionProviderAccountRegistration | undefined
  let sourceIdentityValue: string | undefined
  let generationQueue: Promise<void> = Promise.resolve()
  let disposed = false

  const resolved = (): ResolvedConfig => resolveConfig(current())
  const adapter = new OpenRouterAdapter({
    generation: signal => queueGeneration(signal),
    apiKey: async () => (await resolveClient()).apiKey,
    retryPolicy: () => resolved().retryPolicy,
    limits: () => resolved(),
    resolveAttachments: () => ctx.get('attachments'),
    modelEnabled: (provider, model) => ctx.companionModelPolicy.isEnabled(provider, model),
  })
  const directory: DirectoryRegistrationHandle = ctx.llm.registerConfigurableProviders([{
    provider: OPENROUTER_PROVIDER,
    displayName: 'OpenRouter',
    settingsNs: OPENROUTER_SETTINGS_NAMESPACE,
    settingsPath: [],
  }])
  void directory

  const syncRoute = (): void => {
    const routes = resolved().enabled ? [OPENROUTER_PROVIDER] : []
    if (adapterRegistration === undefined) {
      if (routes.length > 0) adapterRegistration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      adapterRegistration.replace(routes)
    }
    if (routes.length === 0) disposeSources()
  }

  const warm = (): void => {
    if (!resolved().enabled) return
    void queueGeneration(undefined).catch((error: unknown) => {
      ctx.logger.warn(`OpenRouter provider refresh failed: ${safeMessage(error)}`)
    })
  }

  const queueGeneration = <T extends AbortSignal | undefined>(signal: T): Promise<OpenRouterCatalogGeneration> => {
    let result: OpenRouterCatalogGeneration | undefined
    const operation = generationQueue.then(async () => {
      if (disposed) throw new LlmError('OpenRouter provider was disposed', 'NO_ADAPTER')
      result = await resolveGeneration(signal)
    })
    generationQueue = operation.then(() => undefined, () => undefined)
    return operation.then(() => {
      if (result === undefined) throw new Error('OpenRouter generation did not resolve')
      return result
    })
  }

  const resolveClient = async (): Promise<{ readonly apiKey: string; readonly client: OpenRouterClient; readonly identity: string }> => {
    const next = resolved()
    if (!next.enabled) throw new LlmError('OpenRouter provider is disabled', 'NO_ADAPTER')
    const credential = await ctx.credentials.resolve(next.apiKeyEnv)
    if (credential === undefined) {
      throw new LlmError(`OpenRouter has no credential for ${next.apiKeyEnv}`, 'MISSING_CREDENTIAL')
    }
    const apiKey = assertUsableApiKey(credential.value, 'provider-openrouter', next.apiKeyEnv)
    return {
      apiKey,
      client: new OpenRouterClient({ baseURL: next.baseURL, apiKey }),
      identity: sourceIdentity(next.baseURL, apiKey),
    }
  }

  const resolveGeneration = async (signal?: AbortSignal): Promise<OpenRouterCatalogGeneration> => {
    signal?.throwIfAborted()
    const { client, identity } = await resolveClient()
    signal?.throwIfAborted()
    ensureSources(identity, client)
    let catalog = catalogRegistration?.current()
    if (catalog === undefined) {
      await ctx.companionProviderCatalog.refresh(OPENROUTER_PROVIDER)
      catalog = catalogRegistration?.current()
    }
    if (catalog === undefined) throw new LlmError('OpenRouter catalog refresh produced no generation', 'INVALID_CATALOG')
    return new OpenRouterCatalogGeneration(catalog.payload, resolved().baseURL)
  }

  const ensureSources = (identity: string, client: OpenRouterClient): void => {
    if (sourceIdentityValue === identity) return
    const catalog = catalogSource(identity, client)
    const account = accountSource(identity, client)
    if (catalogRegistration === undefined) catalogRegistration = ctx.companionProviderCatalog.register(catalog)
    else catalogRegistration.replace(catalog)
    if (accountRegistration === undefined) accountRegistration = ctx.companionProviderAccounts.register(account)
    else accountRegistration.replace(account)
    sourceIdentityValue = identity
  }

  const disposeSources = (): void => {
    catalogRegistration?.cancelRefresh()
    accountRegistration?.cancelRefresh()
    catalogRegistration?.()
    accountRegistration?.()
    catalogRegistration = undefined
    accountRegistration = undefined
    sourceIdentityValue = undefined
  }

  syncRoute()
  warm()
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, OPENROUTER_SETTINGS_NAMESPACE, Config, config, {
      validate: value => { resolveConfig(value) },
      setSource: source => { current = source },
      onChange: () => {
        disposeSources()
        syncRoute()
        warm()
      },
    })
  })
  ctx.on('credentials/reference-updated', ref => {
    if (ref !== resolved().apiKeyEnv) return
    disposeSources()
    warm()
  })
  ctx.on('settings/updated', namespace => {
    if (namespace === COMPANION_MODEL_POLICY_SETTINGS_NAMESPACE) syncRoute()
  })

  return async () => {
    disposed = true
    disposeSources()
    await generationQueue
  }
}

function catalogSource(
  identity: string,
  client: OpenRouterClient,
): CompanionProviderCatalogSource<OpenRouterCatalog> {
  return {
    provider: OPENROUTER_PROVIDER,
    identity,
    load: signal => client.models(signal),
    decode: decodeOpenRouterCatalog,
    project: projectOpenRouterCatalog,
  }
}

function accountSource(identity: string, client: OpenRouterClient): CompanionProviderAccountSource {
  return {
    provider: OPENROUTER_PROVIDER,
    identity,
    refresh: async signal => projectOpenRouterAccount(await client.keyStatus(signal)),
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const baseURL = normalizeApiRoot(config.baseURL ?? DEFAULT_OPENROUTER_API_BASE_URL)
  const positive = (value: number | undefined, fallback: number, field: string): number => {
    const result = value ?? fallback
    if (!Number.isSafeInteger(result) || result <= 0) throw new LlmError(`OpenRouter ${field} must be a positive safe integer`, 'INVALID_CONFIG')
    return result
  }
  return {
    enabled: config.enabled ?? false,
    baseURL,
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_OPENROUTER_API_KEY_REF),
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'provider-openrouter retryPolicy'),
    streamIdleTimeoutMs: positive(config.streamIdleTimeoutMs, 300_000, 'streamIdleTimeoutMs'),
    maxRequestImageBytes: positive(config.maxRequestImageBytes, 20 * 1024 * 1024, 'maxRequestImageBytes'),
    requestImagePixelBudget: positive(config.requestImagePixelBudget, 2048 * 2048, 'requestImagePixelBudget'),
    requestImageMaxBytes: positive(config.requestImageMaxBytes, 1024 * 1024, 'requestImageMaxBytes'),
  }
}

function normalizeApiRoot(value: string): string {
  let url: URL
  try { url = new URL(value) } catch (error) {
    throw new LlmError('OpenRouter baseURL must be an absolute HTTP or HTTPS URL', 'INVALID_CONFIG', { cause: error })
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '') {
    throw new LlmError('OpenRouter baseURL must be an HTTP or HTTPS origin/path without credentials, query, or fragment', 'INVALID_CONFIG')
  }
  return url.toString().replace(/\/$/u, '')
}

function sourceIdentity(baseURL: string, apiKey: string): string {
  return createHash('sha256').update('openrouter-source-v1\0').update(baseURL).update('\0').update(apiKey).digest('hex')
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
