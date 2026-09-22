/** Cordis plugin wiring OpenRouter provider instances, credentials, catalogs, accounts, and routes. */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  assertUsableApiKey,
  LlmError,
  LlmProviderFamilyId,
  LlmProviderInstanceId,
  resolveRetryPolicy,
  RetryPolicySchema,
} from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  LlmProviderFamilyController,
  LlmProviderInstance,
  LlmProviderInstanceSave,
  RetryPolicyConfig,
} from '@deepseek-ai/dsh-llm'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type {} from '@dsh-companion/model-policy'
import type {
  CompanionProviderAccountRegistration,
  CompanionProviderAccountSource,
} from '@dsh-companion/provider-account'
import type {
  CompanionProviderCatalogRegistration,
  CompanionProviderCatalogSource,
  CompanionProviderId as CompanionProviderRouteId,
} from '@dsh-companion/provider-catalog'
import { CompanionProviderId } from '@dsh-companion/provider-catalog'
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

/** DSH Settings namespace owned by this provider family. */
export const OPENROUTER_SETTINGS_NAMESPACE = 'dsh-companion-openrouter'
/** Legacy credential reference retained only for explicit manual migration. */
export const DEFAULT_OPENROUTER_API_KEY_REF = 'OPENROUTER_API_KEY'
/** Installed OpenRouter family identity. */
export const OPENROUTER_FAMILY_ID = LlmProviderFamilyId(OPENROUTER_PROVIDER)

/** One stored OpenRouter provider instance. */
export interface OpenRouterInstanceConfig {
  /** Editable display name; route and instance identities remain unchanged. */
  displayName?: string
  /** Whether this instance publishes its DSH route. */
  enabled?: boolean
  /** Stable route identity; written once and retained across edits. */
  provider?: string
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

/** User-configurable OpenRouter family state. */
export interface Config {
  /** Configured instances by opaque DSH-owned identity. */
  instances?: Record<string, OpenRouterInstanceConfig>
  /** Retired identities that may never be rebound to another route. */
  retiredInstanceIds?: string[]
}

const InstanceConfig: z<OpenRouterInstanceConfig> = z.object({
  displayName: z.string().default('OpenRouter'),
  enabled: z.boolean().default(false),
  provider: z.string(),
  baseURL: z.string().default(DEFAULT_OPENROUTER_API_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref'),
  retryPolicy: RetryPolicySchema,
  streamIdleTimeoutMs: z.number().step(1).min(1).default(300_000),
  maxRequestImageBytes: z.number().step(1).min(1).default(20 * 1024 * 1024),
  requestImagePixelBudget: z.number().step(1).min(1).default(2048 * 2048),
  requestImageMaxBytes: z.number().step(1).min(1).default(1024 * 1024),
})

/** Runtime schema for OpenRouter family settings. */
export const Config: z<Config> = z.object({
  instances: z.dict(InstanceConfig).default({}),
  retiredInstanceIds: z.array(z.string()).default([]),
})

/** Cordis plugin identity. */
export const name = 'dsh-companion/provider-openrouter'
/** Required canonical DSH and Companion services. */
export const inject = [
  'llm', 'credentials', 'settings', 'companionProviderCatalog', 'companionProviderAccounts', 'companionModelPolicy',
]

interface ResolvedInstanceConfig {
  readonly displayName: string
  readonly enabled: boolean
  readonly provider: CompanionProviderRouteId
  readonly baseURL: string
  readonly apiKeyEnv: CredentialRef
  readonly retryPolicy: ReturnType<typeof resolveRetryPolicy>
  readonly streamIdleTimeoutMs: number
  readonly maxRequestImageBytes: number
  readonly requestImagePixelBudget: number
  readonly requestImageMaxBytes: number
}

/** Register the settings-driven OpenRouter provider family. */
export function apply(ctx: Context, config: Config): () => Promise<void> {
  const scope = ctx.settings.register(OPENROUTER_SETTINGS_NAMESPACE, Config, {
    base: config,
    validate: validateConfig,
  })
  const runtimes = new Map<string, OpenRouterInstanceRuntime>()

  const reconcile = (): void => {
    const configured = scope.get().instances ?? {}
    for (const [id, runtime] of runtimes) {
      if (configured[id] !== undefined) continue
      runtime.dispose()
      runtimes.delete(id)
    }
    for (const [id, value] of Object.entries(configured)) {
      const resolved = resolveInstance(id, value)
      const runtime = runtimes.get(id)
      if (runtime === undefined) runtimes.set(id, new OpenRouterInstanceRuntime(ctx, resolved))
      else runtime.update(resolved)
    }
  }

  const controller: LlmProviderFamilyController = {
    listInstances: async () => Promise.all(Object.entries(scope.get().instances ?? {}).map(async ([id, value]) => {
      const resolved = resolveInstance(id, value)
      const credential = await ctx.credentials.describe(resolved.apiKeyEnv)
      const active = ctx.llm.listProviders().some(provider => provider.id === resolved.provider)
      return projectInstance(id, resolved, credential.configured, active)
    })),
    saveAndTest: (save, signal) => saveAndTest(ctx, scope, save, signal),
    deleteInstance: (instanceId, signal) => deleteInstance(ctx, scope, instanceId, signal),
  }
  const family = ctx.llm.registerProviderFamily({
    id: OPENROUTER_FAMILY_ID,
    displayName: 'OpenRouter',
    maxInstances: null,
    settingsNs: OPENROUTER_SETTINGS_NAMESPACE,
    instancesPath: ['instances'],
  }, controller)

  reconcile()
  const unwatch = scope.watch(() => {
    reconcile()
    family.changed()
  })
  ctx.on('credentials/reference-updated', (ref) => {
    for (const runtime of runtimes.values()) runtime.credentialUpdated(ref)
  })

  return async () => {
    unwatch()
    family()
    const disposing = [...runtimes.values()].map(runtime => runtime.dispose())
    runtimes.clear()
    await Promise.all(disposing)
  }
}

class OpenRouterInstanceRuntime {
  private config: ResolvedInstanceConfig
  private adapterRegistration: AdapterRegistrationHandle | undefined
  private catalogRegistration: CompanionProviderCatalogRegistration<OpenRouterCatalog> | undefined
  private accountRegistration: CompanionProviderAccountRegistration | undefined
  private sourceIdentityValue: string | undefined
  private generationQueue: Promise<void> = Promise.resolve()
  private epoch = 0
  private disposed = false
  private readonly adapter: OpenRouterAdapter

  constructor(private readonly ctx: Context, config: ResolvedInstanceConfig) {
    this.config = config
    this.adapter = new OpenRouterAdapter({
      provider: config.provider,
      displayName: () => this.config.displayName,
      generation: signal => this.queueGeneration(signal),
      apiKey: async () => (await this.resolveClient()).apiKey,
      retryPolicy: () => this.config.retryPolicy,
      limits: () => this.config,
      resolveAttachments: () => this.ctx.get('attachments'),
      modelEnabled: (provider, model) => this.ctx.companionModelPolicy.isEnabled(provider, model, OPENROUTER_PROVIDER),
    })
    this.warm()
  }

  update(config: ResolvedInstanceConfig): void {
    if (config.provider !== this.config.provider) {
      throw new LlmError('OpenRouter instance route identity cannot change', 'INVALID_CONFIG')
    }
    this.epoch += 1
    this.config = config
    this.disposeSources()
    this.syncRoute(false)
    this.warm()
  }

  credentialUpdated(ref: CredentialRef): void {
    if (ref !== this.config.apiKeyEnv) return
    this.epoch += 1
    this.disposeSources()
    this.syncRoute(false)
    this.warm()
  }

  private syncRoute(active: boolean): void {
    const routes = active && this.config.enabled ? [this.config.provider] : []
    if (this.adapterRegistration === undefined) {
      if (routes.length > 0) this.adapterRegistration = this.ctx.llm.registerAdapter(routes, this.adapter)
    } else {
      this.adapterRegistration.replace(routes)
    }
    if (routes.length === 0) this.disposeSources()
  }

  private warm(): void {
    if (!this.config.enabled) { this.syncRoute(false); return }
    const epoch = this.epoch
    void this.queueGeneration(undefined).then(
      () => { if (epoch === this.epoch) this.syncRoute(true) },
      (error: unknown) => {
        if (epoch !== this.epoch) return
        this.syncRoute(false)
        this.ctx.logger.warn(`OpenRouter provider refresh failed: ${safeMessage(error)}`)
      },
    )
  }

  private queueGeneration<T extends AbortSignal | undefined>(signal: T): Promise<OpenRouterCatalogGeneration> {
    let result: OpenRouterCatalogGeneration | undefined
    const operation = this.generationQueue.then(async () => {
      if (this.disposed) throw new LlmError('OpenRouter provider was disposed', 'NO_ADAPTER')
      result = await this.resolveGeneration(signal)
    })
    this.generationQueue = operation.then(() => undefined, () => undefined)
    return operation.then(() => {
      if (result === undefined) throw new Error('OpenRouter generation did not resolve')
      return result
    })
  }

  private async resolveClient(): Promise<{ readonly apiKey: string; readonly client: OpenRouterClient; readonly identity: string }> {
    if (!this.config.enabled) throw new LlmError('OpenRouter provider is disabled', 'NO_ADAPTER')
    const credential = await this.ctx.credentials.resolve(this.config.apiKeyEnv)
    if (credential === undefined) {
      throw new LlmError(`OpenRouter has no credential for ${this.config.apiKeyEnv}`, 'MISSING_CREDENTIAL')
    }
    const apiKey = assertUsableApiKey(credential.value, 'provider-openrouter', this.config.apiKeyEnv)
    return {
      apiKey,
      client: new OpenRouterClient({ baseURL: this.config.baseURL, apiKey }),
      identity: sourceIdentity(this.config.baseURL, apiKey),
    }
  }

  private async resolveGeneration(signal?: AbortSignal): Promise<OpenRouterCatalogGeneration> {
    signal?.throwIfAborted()
    const { client, identity } = await this.resolveClient()
    signal?.throwIfAborted()
    this.ensureSources(identity, client)
    let catalog = this.catalogRegistration?.current()
    if (catalog === undefined) {
      await this.ctx.companionProviderCatalog.refresh(this.config.provider)
      catalog = this.catalogRegistration?.current()
    }
    if (catalog === undefined) throw new LlmError('OpenRouter catalog refresh produced no generation', 'INVALID_CATALOG')
    return new OpenRouterCatalogGeneration(catalog.payload, this.config.baseURL)
  }

  private ensureSources(identity: string, client: OpenRouterClient): void {
    if (this.sourceIdentityValue === identity) return
    const catalog = catalogSource(this.config.provider, identity, client)
    const account = accountSource(this.config.provider, identity, client)
    if (this.catalogRegistration === undefined) this.catalogRegistration = this.ctx.companionProviderCatalog.register(catalog)
    else this.catalogRegistration.replace(catalog)
    if (this.accountRegistration === undefined) this.accountRegistration = this.ctx.companionProviderAccounts.register(account)
    else this.accountRegistration.replace(account)
    this.sourceIdentityValue = identity
  }

  private disposeSources(): void {
    this.catalogRegistration?.cancelRefresh()
    this.accountRegistration?.cancelRefresh()
    this.catalogRegistration?.()
    this.accountRegistration?.()
    this.catalogRegistration = undefined
    this.accountRegistration = undefined
    this.sourceIdentityValue = undefined
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.epoch += 1
    this.adapterRegistration?.()
    this.adapterRegistration = undefined
    this.disposeSources()
    await this.generationQueue
  }
}

async function saveAndTest(
  ctx: Context,
  scope: SettingsScope<Config>,
  save: LlmProviderInstanceSave,
  signal?: AbortSignal,
): Promise<LlmProviderInstance> {
  signal?.throwIfAborted()
  const state = scope.get()
  const instances = state.instances ?? {}
  const retired = new Set(state.retiredInstanceIds ?? [])
  const id = String(save.instanceId)
  if (save.create && retired.has(id)) throw new LlmError('OpenRouter instance identity was retired', 'INVALID_CONFIG')
  const previous = instances[id]
  const input = decodeDraft(save.draft.config)
  const previousResolved = previous === undefined ? undefined : resolveInstance(id, previous)
  const provider = previousResolved?.provider ?? routeId(id)
  const displayName = save.draft.displayName
  let nextRef = previousResolved?.apiKeyEnv
  let stagedRef: CredentialRef | undefined
  let apiKey: string
  if (save.draft.credential?.kind === 'replace') {
    apiKey = assertUsableApiKey(save.draft.credential.value, 'provider-openrouter', 'submitted credential')
    const generation = randomUUID().replaceAll('-', '_')
    stagedRef = credentialRef(`DSH_COMPANION_OPENROUTER_${id.replace(/[^A-Za-z0-9]/gu, '_')}_${generation}`)
    nextRef = stagedRef
  } else {
    if (save.draft.credential?.kind === 'remove') {
      throw new LlmError('OpenRouter requires a credential; replace it instead of removing it', 'MISSING_CREDENTIAL')
    }
    if (nextRef === undefined) throw new LlmError('A new OpenRouter instance requires a credential', 'MISSING_CREDENTIAL')
    const resolved = await ctx.credentials.resolve(nextRef)
    if (resolved === undefined) throw new LlmError('The OpenRouter credential is not configured', 'MISSING_CREDENTIAL')
    apiKey = assertUsableApiKey(resolved.value, 'provider-openrouter', nextRef)
  }
  const candidate = resolveInstance(id, {
    ...input,
    displayName,
    enabled: save.draft.enabled,
    provider,
    apiKeyEnv: nextRef,
  })
  const client = new OpenRouterClient({ baseURL: candidate.baseURL, apiKey })
  const catalog = decodeOpenRouterCatalog(await client.models(signal))
  if (catalog.data.length === 0) throw new LlmError('OpenRouter returned an empty model catalog', 'INVALID_CATALOG')
  await client.keyStatus(signal)
  if (stagedRef !== undefined) await ctx.credentials.set(stagedRef, apiKey)
  try {
    await scope.replace({
      instances: { ...instances, [id]: storedInstance(candidate) },
      retiredInstanceIds: [...retired],
    })
  } catch (error) {
    if (stagedRef !== undefined) await ctx.credentials.unset(stagedRef)
    throw error
  }
  if (stagedRef !== undefined && previousResolved?.apiKeyEnv !== undefined
    && previousResolved.apiKeyEnv !== stagedRef && ownsCredential(previousResolved.apiKeyEnv)) {
    await ctx.credentials.unset(previousResolved.apiKeyEnv)
  }
  const active = ctx.llm.listProviders().some(registered => registered.id === candidate.provider)
  return projectInstance(id, candidate, true, active)
}

async function deleteInstance(
  ctx: Context,
  scope: SettingsScope<Config>,
  instanceId: LlmProviderInstanceId,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const state = scope.get()
  const instances = { ...state.instances }
  const previous = instances[instanceId]
  if (previous === undefined) throw new LlmError('OpenRouter instance does not exist', 'NO_PROVIDER_INSTANCE')
  const resolved = resolveInstance(instanceId, previous)
  delete instances[instanceId]
  const retired = new Set(state.retiredInstanceIds ?? [])
  retired.add(instanceId)
  await scope.replace({ instances, retiredInstanceIds: [...retired] })
  if (ownsCredential(resolved.apiKeyEnv)) await ctx.credentials.unset(resolved.apiKeyEnv)
}

function decodeDraft(value: Readonly<Record<string, unknown>>): OpenRouterInstanceConfig {
  const allowed = new Set([
    'baseURL', 'retryPolicy', 'streamIdleTimeoutMs', 'maxRequestImageBytes',
    'requestImagePixelBudget', 'requestImageMaxBytes',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new LlmError(`OpenRouter config field "${key}" is not editable`, 'INVALID_CONFIG')
  }
  return value as OpenRouterInstanceConfig
}

function storedInstance(config: ResolvedInstanceConfig): OpenRouterInstanceConfig {
  return {
    displayName: config.displayName,
    enabled: config.enabled,
    provider: config.provider,
    baseURL: config.baseURL,
    apiKeyEnv: config.apiKeyEnv,
    retryPolicy: config.retryPolicy.mode === 'normal'
      ? {
          mode: 'normal',
          maxRetries: config.retryPolicy.maxRetries,
          retryableCodes: [...config.retryPolicy.retryableCodes],
          backoff: {
            initialDelayMs: config.retryPolicy.initialDelayMs,
            maxDelayMs: config.retryPolicy.maxDelayMs,
            jitterRatio: config.retryPolicy.jitterRatio,
          },
        }
      : {
          mode: 'always',
          backoff: {
            initialDelayMs: config.retryPolicy.initialDelayMs,
            maxDelayMs: config.retryPolicy.maxDelayMs,
            jitterRatio: config.retryPolicy.jitterRatio,
          },
        },
    streamIdleTimeoutMs: config.streamIdleTimeoutMs,
    maxRequestImageBytes: config.maxRequestImageBytes,
    requestImagePixelBudget: config.requestImagePixelBudget,
    requestImageMaxBytes: config.requestImageMaxBytes,
  }
}

function projectInstance(
  id: string,
  config: ResolvedInstanceConfig,
  configured: boolean,
  active: boolean,
): LlmProviderInstance {
  return {
    id: LlmProviderInstanceId(id),
    familyId: OPENROUTER_FAMILY_ID,
    provider: config.provider,
    displayName: config.displayName,
    enabled: config.enabled,
    active,
    settingsNs: OPENROUTER_SETTINGS_NAMESPACE,
    settingsPath: ['instances', id],
    credential: configured ? 'configured' : 'missing',
  }
}

function catalogSource(
  provider: CompanionProviderRouteId,
  identity: string,
  client: OpenRouterClient,
): CompanionProviderCatalogSource<OpenRouterCatalog> {
  return {
    provider,
    identity,
    load: signal => client.models(signal),
    decode: decodeOpenRouterCatalog,
    project: (catalog) => {
      const projected = projectOpenRouterCatalog(catalog)
      return { ...projected, provider: CompanionProviderId(provider) }
    },
  }
}

function accountSource(
  provider: CompanionProviderRouteId,
  identity: string,
  client: OpenRouterClient,
): CompanionProviderAccountSource {
  return {
    provider,
    identity,
    refresh: async signal => ({
      ...projectOpenRouterAccount(await client.keyStatus(signal)),
      provider,
    }),
  }
}

function validateConfig(config: Config): void {
  const retired = new Set(config.retiredInstanceIds ?? [])
  if (retired.size !== (config.retiredInstanceIds ?? []).length) {
    throw new LlmError('OpenRouter retired instance ids must be unique', 'INVALID_CONFIG')
  }
  const routes = new Set<string>()
  for (const [id, value] of Object.entries(config.instances ?? {})) {
    if (retired.has(id)) throw new LlmError(`OpenRouter instance ${id} is retired`, 'INVALID_CONFIG')
    const resolved = resolveInstance(id, value)
    if (routes.has(resolved.provider)) throw new LlmError(`OpenRouter route ${resolved.provider} is duplicated`, 'INVALID_CONFIG')
    routes.add(resolved.provider)
  }
}

function resolveInstance(id: string, config: OpenRouterInstanceConfig): ResolvedInstanceConfig {
  if (id.length === 0) throw new LlmError('OpenRouter instance id must be non-empty', 'INVALID_CONFIG')
  const positive = (value: number | undefined, fallback: number, field: string): number => {
    const result = value ?? fallback
    if (!Number.isSafeInteger(result) || result <= 0) throw new LlmError(`OpenRouter ${field} must be a positive safe integer`, 'INVALID_CONFIG')
    return result
  }
  const provider = CompanionProviderId(config.provider ?? routeId(id))
  const apiKeyEnv = config.apiKeyEnv
  if (provider.length === 0 || apiKeyEnv === undefined || apiKeyEnv.length === 0) {
    throw new LlmError(`OpenRouter instance ${id} needs stable provider and credential references`, 'INVALID_CONFIG')
  }
  const displayName = config.displayName?.trim() ?? 'OpenRouter'
  if (displayName.length === 0) throw new LlmError(`OpenRouter instance ${id} needs a display name`, 'INVALID_CONFIG')
  return {
    displayName,
    enabled: config.enabled ?? false,
    provider,
    baseURL: normalizeApiRoot(config.baseURL ?? DEFAULT_OPENROUTER_API_BASE_URL),
    apiKeyEnv: credentialRef(apiKeyEnv),
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `provider-openrouter ${id} retryPolicy`),
    streamIdleTimeoutMs: positive(config.streamIdleTimeoutMs, 300_000, 'streamIdleTimeoutMs'),
    maxRequestImageBytes: positive(config.maxRequestImageBytes, 20 * 1024 * 1024, 'maxRequestImageBytes'),
    requestImagePixelBudget: positive(config.requestImagePixelBudget, 2048 * 2048, 'requestImagePixelBudget'),
    requestImageMaxBytes: positive(config.requestImageMaxBytes, 1024 * 1024, 'requestImageMaxBytes'),
  }
}

function ownsCredential(ref: CredentialRef): boolean {
  return ref.startsWith('DSH_COMPANION_OPENROUTER_')
}

function routeId(instanceId: string): string {
  return CompanionProviderId(`openrouter-${instanceId}`)
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
