/** Cordis plugin wiring settings, credentials, catalog LKG, and the native DSH adapter. */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { assertUsableApiKey, LlmError, RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  DirectoryRegistrationHandle,
  RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@dsh-companion/model-policy'
import { COMPANION_MODEL_POLICY_SETTINGS_NAMESPACE } from '@dsh-companion/model-policy'
import type { CompanionProviderAccountRegistration, CompanionProviderAccountSource } from '@dsh-companion/provider-account'
import type { CompanionProviderCatalogRegistration, CompanionProviderCatalogSource } from '@dsh-companion/provider-catalog'
import { ClaudeAccountProjection } from './account.js'
import {
  CLAUDE_WRAPPER_ADVANCED_PROVIDER,
  ClaudeCatalogGeneration,
  decodeClaudeCatalogPayload,
  projectCompanionCatalog,
} from './catalog.js'
import { ClaudeWrapperAdvancedAdapter } from './adapter.js'
import type { ClaudeAdapterGeneration } from './adapter.js'
import { ClaudeWireClient, normalizeServiceRoot } from './wire/client.js'
import type { ClaudeWireCatalog } from './wire/types.js'

/** DSH Settings namespace owned by this provider integration. */
export const CLAUDE_WRAPPER_ADVANCED_SETTINGS_NAMESPACE = 'dsh-companion-claude-wrapper-advanced'
/** Conventional DSH credential reference for the external service API key. */
export const DEFAULT_CLAUDE_WRAPPER_ADVANCED_API_KEY_REF = 'CLAUDE_WRAPPER_ADVANCED_API_KEY'

/** User-configurable provider connection and routing policy. */
export interface Config {
  /** Whether a configured endpoint registers the DSH provider route. */
  enabled?: boolean
  /** Root URL of the independently operated wrapper service. */
  baseURL?: string
  /** DSH credential reference holding the wrapper API key. */
  apiKeyEnv?: string
  /** Provider-owned retry policy captured with the DSH route registration. */
  retryPolicy?: RetryPolicyConfig
}

/** Runtime schema for provider settings and composition config. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  baseURL: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_CLAUDE_WRAPPER_ADVANCED_API_KEY_REF),
  retryPolicy: RetryPolicySchema,
})

/** Cordis plugin identity. */
export const name = 'dsh-companion/provider-claude-wrapper-advanced'
/** Required DSH services; the independently operated wrapper is reached over HTTP. */
export const inject = [
  'llm', 'credentials', 'companionProviderCatalog', 'companionProviderAccounts', 'companionModelPolicy',
]

interface ResolvedConfig {
  readonly enabled: boolean
  readonly baseURL?: string
  readonly apiKeyEnv: CredentialRef
  readonly retryPolicy: ReturnType<typeof resolveRetryPolicy>
}

/** Register the configurable provider and its settings-driven native adapter. */
export function apply(ctx: Context, config: Config): () => Promise<void> {
  let current: () => Config = () => config
  let adapterRegistration: AdapterRegistrationHandle | undefined
  let catalogRegistration: CompanionProviderCatalogRegistration<ClaudeWireCatalog> | undefined
  let accountRegistration: CompanionProviderAccountRegistration | undefined
  let accountProjection: ClaudeAccountProjection | undefined
  let catalogIdentity: string | undefined
  let accountIdentity: string | undefined
  let generationQueue: Promise<void> = Promise.resolve()
  let disposed = false

  const resolved = (): ResolvedConfig => resolveConfig(current())
  const adapter = new ClaudeWrapperAdvancedAdapter({
    generation: signal => queueGeneration(signal),
    imageUrl: async (ref, signal) => {
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new LlmError('Claude Wrapper Advanced image input requires the DSH attachment service', 'UNSUPPORTED_CONTENT')
      }
      const image = await attachments.readImage(ref, signal)
      return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
    },
    retryPolicy: () => resolved().retryPolicy,
    modelEnabled: (provider, model) => ctx.companionModelPolicy.isEnabled(provider, model),
    onQuota: (usage, limitGroups) => {
      if (accountRegistration === undefined || accountProjection === undefined) return
      accountRegistration.publish(accountProjection.acceptTurn(usage, limitGroups))
    },
    onLimitStatus: () => {
      if (accountRegistration === undefined) return
      void ctx.companionProviderAccounts.refresh(CLAUDE_WRAPPER_ADVANCED_PROVIDER).catch((error: unknown) => {
        ctx.logger.warn(`Claude Wrapper Advanced usage refresh failed: ${safeMessage(error)}`)
      })
    },
  })

  const directory: DirectoryRegistrationHandle = ctx.llm.registerConfigurableProviders([{
    provider: CLAUDE_WRAPPER_ADVANCED_PROVIDER,
    displayName: 'Claude Wrapper Advanced',
    settingsNs: CLAUDE_WRAPPER_ADVANCED_SETTINGS_NAMESPACE,
    settingsPath: [],
  }])
  void directory

  const syncRoute = (): void => {
    const next = resolved()
    const routes = next.enabled && next.baseURL !== undefined ? [CLAUDE_WRAPPER_ADVANCED_PROVIDER] : []
    if (adapterRegistration === undefined) {
      if (routes.length > 0) adapterRegistration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      adapterRegistration.replace(routes)
    }
    if (routes.length === 0 && catalogRegistration !== undefined) {
      catalogRegistration()
      catalogRegistration = undefined
      catalogIdentity = undefined
    }
    if (routes.length === 0 && accountRegistration !== undefined) {
      accountRegistration()
      accountRegistration = undefined
      accountProjection = undefined
      accountIdentity = undefined
    }
  }

  const warmConfiguredGeneration = (): void => {
    const next = resolved()
    if (!next.enabled || next.baseURL === undefined) return
    void queueGeneration(undefined).catch((error: unknown) => {
      ctx.logger.warn(`Claude Wrapper Advanced provider refresh failed: ${safeMessage(error)}`)
    })
  }

  const queueGeneration = <T extends AbortSignal | undefined>(signal: T): Promise<ClaudeAdapterGeneration> => {
    let result: ClaudeAdapterGeneration | undefined
    const operation = generationQueue.then(async () => {
      if (disposed) throw new LlmError('Claude Wrapper Advanced provider was disposed', 'NO_ADAPTER')
      result = await resolveGeneration(signal)
    })
    generationQueue = operation.then(() => undefined, () => undefined)
    return operation.then(() => {
      if (result === undefined) throw new Error('Claude Wrapper Advanced generation did not resolve')
      return result
    })
  }

  const resolveGeneration = async (signal?: AbortSignal): Promise<ClaudeAdapterGeneration> => {
    signal?.throwIfAborted()
    const next = resolved()
    if (!next.enabled || next.baseURL === undefined) {
      throw new LlmError('Claude Wrapper Advanced provider is disabled or has no baseURL', 'NO_ADAPTER')
    }
    const credential = await ctx.credentials.resolve(next.apiKeyEnv)
    signal?.throwIfAborted()
    if (credential === undefined) {
      throw new LlmError(
        `Claude Wrapper Advanced has no credential for ${next.apiKeyEnv}`,
        'MISSING_CREDENTIAL',
      )
    }
    const apiKey = assertUsableApiKey(credential.value, 'provider-claude-wrapper-advanced', next.apiKeyEnv)
    const client = new ClaudeWireClient({ baseURL: next.baseURL, apiKey })
    const identity = sourceIdentity(next.baseURL, apiKey)
    if (catalogRegistration === undefined || catalogIdentity !== identity) {
      const source = catalogSource(identity, client)
      if (catalogRegistration === undefined) {
        catalogRegistration = ctx.companionProviderCatalog.register(source)
      } else {
        catalogRegistration.replace(source)
      }
      catalogIdentity = identity
    }
    if (accountRegistration === undefined || accountIdentity !== identity) {
      const projection = new ClaudeAccountProjection()
      const source = accountSource(identity, client, projection)
      accountProjection = projection
      if (accountRegistration === undefined) {
        accountRegistration = ctx.companionProviderAccounts.register(source)
      } else {
        accountRegistration.replace(source)
      }
      accountIdentity = identity
    }
    let catalog = catalogRegistration.current()
    if (catalog === undefined) {
      await ctx.companionProviderCatalog.refresh(CLAUDE_WRAPPER_ADVANCED_PROVIDER)
      catalog = catalogRegistration.current()
    }
    if (catalog === undefined) {
      throw new LlmError('Claude Wrapper Advanced catalog refresh produced no generation', 'INVALID_CATALOG')
    }
    return { client, catalog: new ClaudeCatalogGeneration(catalog.payload) }
  }

  syncRoute()
  warmConfiguredGeneration()
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, CLAUDE_WRAPPER_ADVANCED_SETTINGS_NAMESPACE, Config, config, {
      validate: value => { resolveConfig(value) },
      setSource: source => { current = source },
      onChange: () => {
        catalogRegistration?.cancelRefresh()
        accountRegistration?.cancelRefresh()
        syncRoute()
        warmConfiguredGeneration()
      },
    })
  })

  ctx.on('credentials/reference-updated', (ref) => {
    if (ref !== resolved().apiKeyEnv) return
    catalogRegistration?.cancelRefresh()
    accountRegistration?.cancelRefresh()
    warmConfiguredGeneration()
  })
  ctx.on('settings/updated', (namespace) => {
    if (namespace === COMPANION_MODEL_POLICY_SETTINGS_NAMESPACE) syncRoute()
  })
  return async () => {
    disposed = true
    catalogRegistration?.cancelRefresh()
    accountRegistration?.cancelRefresh()
    await generationQueue
    catalogRegistration?.()
    accountRegistration?.()
    catalogRegistration = undefined
    accountRegistration = undefined
    accountProjection = undefined
  }
}

function accountSource(
  identity: string,
  client: ClaudeWireClient,
  projection: ClaudeAccountProjection,
): CompanionProviderAccountSource {
  return {
    provider: CLAUDE_WRAPPER_ADVANCED_PROVIDER,
    identity,
    refresh: async signal => projection.acceptUsage(await client.usage(signal)),
  }
}

function catalogSource(
  identity: string,
  client: ClaudeWireClient,
): CompanionProviderCatalogSource<ClaudeWireCatalog> {
  return {
    provider: CLAUDE_WRAPPER_ADVANCED_PROVIDER,
    identity,
    load: async (signal) => {
      await client.info(signal)
      return client.models(signal)
    },
    decode: decodeClaudeCatalogPayload,
    project: projectCompanionCatalog,
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  if (config.baseURL === '') throw new LlmError('Claude Wrapper Advanced baseURL must not be empty', 'INVALID_CONFIG')
  const baseURL = config.baseURL === undefined ? undefined : normalizeServiceRoot(config.baseURL)
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_CLAUDE_WRAPPER_ADVANCED_API_KEY_REF)
  return {
    enabled: config.enabled ?? false,
    ...baseURL === undefined ? {} : { baseURL },
    apiKeyEnv,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'provider-claude-wrapper-advanced retryPolicy'),
  }
}

function sourceIdentity(baseURL: string, apiKey: string): string {
  return createHash('sha256')
    .update('claude-wrapper-advanced-catalog-v1\0')
    .update(baseURL)
    .update('\0')
    .update(apiKey)
    .digest('hex')
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
