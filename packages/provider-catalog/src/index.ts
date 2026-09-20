/** Generic durable last-known-good catalog lifecycle for external Companion providers. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { providerCatalogDomainSpec } from './spec.js'
import type { ProviderCatalogRecord } from './spec.js'
import type {
  CompanionProviderCatalogRegistration,
  CompanionProviderCatalogRemoteSnapshot,
  CompanionProviderCatalogSnapshot,
  CompanionProviderCatalogSource,
  CompanionProviderCatalogValue,
  CompanionProviderCatalogView,
  CompanionProviderId,
} from './types.js'
import { CompanionProviderId as providerId } from './types.js'

export { CompanionProviderId } from './types.js'
export type {
  CompanionProviderCatalogRegistration,
  CompanionProviderCatalogRemoteSnapshot,
  CompanionProviderCatalogSnapshot,
  CompanionProviderCatalogSource,
  CompanionProviderCatalogValue,
  CompanionProviderCatalogView,
  CompanionProviderModel,
  ModelPricing,
  ModelPricingKind,
} from './types.js'
export { providerCatalogDomainSpec, providerCatalogRecord } from './spec.js'
export type { ProviderCatalogRecord } from './spec.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    companionProviderCatalog: CompanionProviderCatalog
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'dsh-companion/provider-catalog-refresh-failed': { readonly provider: string }
  }
}

interface ErasedSource {
  readonly provider: CompanionProviderId
  readonly identity: string
  load(signal: AbortSignal): Promise<unknown>
  decode(value: unknown): unknown
  project(payload: unknown): CompanionProviderCatalogView
}

interface SourceEntry {
  source: ErasedSource
  epoch: number
  controller: AbortController | undefined
  active: Promise<CompanionProviderCatalogSnapshot> | undefined
  payload: unknown | undefined
  snapshot: CompanionProviderCatalogSnapshot
}

/** Catalog registry, refresh coordinator, and durable LKG owner. */
export class CompanionProviderCatalog extends TypertRemoteService {
  static inject = ['storageDomain']

  private table?: KvTable<CompanionProviderId, ProviderCatalogRecord>
  private readonly sources = new Map<CompanionProviderId, SourceEntry>()
  private readonly listeners = new Set<(provider: CompanionProviderId) => void>()

  constructor(ctx: Context) {
    super(ctx, 'companionProviderCatalog')
  }

  /** Open the disposable derived-data domain before accepting sources. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(providerCatalogDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'companionProviderCatalog.domainClose')
    this.table = domain.table('providers')
  }

  /**
   * Register one provider-owned source. The matching durable generation is
   * published as stale immediately, then an asynchronous refresh begins.
   */
  register<P>(source: CompanionProviderCatalogSource<P>): CompanionProviderCatalogRegistration<P> {
    const erased = eraseSource(source)
    this.validateSource(erased)
    if (this.sources.has(source.provider)) {
      throw new Error(`Companion provider catalog source ${JSON.stringify(source.provider)} is already registered`)
    }
    let released = false
    const entry: SourceEntry = {
      source: erased,
      epoch: 0,
      controller: undefined,
      active: undefined,
      payload: undefined,
      snapshot: unavailableSnapshot(source.provider),
    }
    const dispose = this.ctx.effect(() => {
      this.sources.set(source.provider, entry)
      this.restore(entry)
      this.notify(source.provider)
      void this.refreshEntry(entry).catch((error: unknown) => {
        this.ctx.logger.warn(`Companion provider catalog initial refresh failed for ${source.provider}: ${safeMessage(error)}`)
      })
      return () => {
        released = true
        entry.epoch += 1
        entry.controller?.abort('provider catalog source disposed')
        this.sources.delete(source.provider)
        this.notify(source.provider)
      }
    }, 'companionProviderCatalog.register()')
    const registration = (() => { void dispose() }) as CompanionProviderCatalogRegistration<P>
    registration.replace = (next: CompanionProviderCatalogSource<P>): void => {
      if (released) throw new Error('A disposed Companion provider catalog source cannot be replaced')
      const nextErased = eraseSource(next)
      this.validateSource(nextErased)
      if (next.provider !== source.provider) {
        throw new Error('A Companion provider catalog source replacement must preserve its provider id')
      }
      entry.epoch += 1
      entry.controller?.abort('provider catalog source replaced')
      entry.controller = undefined
      entry.active = undefined
      entry.source = nextErased
      entry.payload = undefined
      entry.snapshot = unavailableSnapshot(next.provider)
      this.restore(entry)
      this.notify(next.provider)
      void this.refreshEntry(entry).catch((error: unknown) => {
        this.ctx.logger.warn(`Companion provider catalog replacement refresh failed for ${next.provider}: ${safeMessage(error)}`)
      })
    }
    registration.current = (): CompanionProviderCatalogValue<P> | undefined => released || entry.payload === undefined
      ? undefined
      : { generation: entry.snapshot.generation, payload: entry.payload as P }
    registration.cancelRefresh = (): void => {
      if (released) return
      this.cancelRefresh(entry, 'provider catalog source changed')
    }
    return registration
  }

  /** Current immutable snapshot for one registered provider. */
  snapshot(provider: CompanionProviderId): CompanionProviderCatalogSnapshot | undefined {
    return this.sources.get(provider)?.snapshot
  }

  /** Current immutable snapshots in source registration order. */
  list(): readonly CompanionProviderCatalogSnapshot[] {
    return Object.freeze([...this.sources.values()].map(entry => entry.snapshot))
  }

  /** Client-safe catalog snapshots for every registered provider. */
  @Remote('list')
  remoteList(): readonly CompanionProviderCatalogRemoteSnapshot[] {
    return this.list()
  }

  /** Refresh one source, sharing an already-running operation. */
  refresh(provider: CompanionProviderId): Promise<CompanionProviderCatalogSnapshot> {
    const entry = this.sources.get(provider)
    if (entry === undefined) {
      return Promise.reject(new Error(`No Companion provider catalog source is registered for ${JSON.stringify(provider)}`))
    }
    return this.refreshEntry(entry)
  }

  /** Refresh one provider through the shared Gateway transport. */
  @Remote('refresh')
  async remoteRefresh(provider: string, signal: AbortSignal): Promise<CompanionProviderCatalogRemoteSnapshot> {
    try {
      return await waitWithSignal(this.refresh(providerId(provider)), signal)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      throw new RemoteError(
        'dsh-companion/provider-catalog-refresh-failed',
        safeMessage(error),
        { provider },
        { cause: error },
      )
    }
  }

  /** Abort an obsolete refresh and start a new source generation. */
  invalidate(provider: CompanionProviderId): Promise<CompanionProviderCatalogSnapshot> {
    const entry = this.sources.get(provider)
    if (entry === undefined) {
      return Promise.reject(new Error(`No Companion provider catalog source is registered for ${JSON.stringify(provider)}`))
    }
    this.cancelRefresh(entry, 'provider catalog invalidated')
    return this.refreshEntry(entry)
  }

  /** Subscribe to provider snapshot changes. */
  subscribe(listener: (provider: CompanionProviderId) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private restore(entry: SourceEntry): void {
    const record = this.requireTable().get(entry.source.provider)
    if (record === undefined || record.identity !== entry.source.identity) return
    try {
      const payload = freezePayload(entry.source.decode(record.payload))
      const view = this.project(entry.source, payload)
      entry.payload = payload
      entry.snapshot = freezeSnapshot({
        ...view,
        status: 'stale',
        generation: record.generation,
        refreshedAt: record.refreshedAt,
        refreshing: false,
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `Companion provider catalog ignored an unusable cached generation for ${entry.source.provider}: ${safeMessage(error)}`,
      )
    }
  }

  private cancelRefresh(entry: SourceEntry, reason: string): void {
    entry.epoch += 1
    entry.controller?.abort(reason)
    entry.controller = undefined
    entry.active = undefined
    if (entry.snapshot.refreshing) {
      entry.snapshot = freezeSnapshot({ ...entry.snapshot, refreshing: false })
      this.notify(entry.source.provider)
    }
  }

  private refreshEntry(entry: SourceEntry): Promise<CompanionProviderCatalogSnapshot> {
    if (entry.active !== undefined) return entry.active
    const epoch = entry.epoch
    const controller = new AbortController()
    entry.controller = controller
    entry.snapshot = freezeSnapshot({ ...entry.snapshot, refreshing: true })
    this.notify(entry.source.provider)
    const operation = this.runRefresh(entry, epoch, controller)
    entry.active = operation
    void operation.finally(() => {
      if (entry.active === operation) {
        entry.active = undefined
        entry.controller = undefined
      }
    }).catch(() => {
      // The caller and initial-refresh observer own the operation failure; this branch observes finally's mirror.
    })
    return operation
  }

  private async runRefresh(
    entry: SourceEntry,
    epoch: number,
    controller: AbortController,
  ): Promise<CompanionProviderCatalogSnapshot> {
    try {
      const loaded = await entry.source.load(controller.signal)
      controller.signal.throwIfAborted()
      if (entry.epoch !== epoch || this.sources.get(entry.source.provider) !== entry) {
        throw new Error('Companion provider catalog refresh was superseded')
      }
      const durablePayload = z.json().parse(loaded)
      const payload = freezePayload(entry.source.decode(durablePayload))
      const projected = this.project(entry.source, payload)
      const previous = this.requireTable().get(entry.source.provider)
      const generation = Math.max(entry.snapshot.generation, previous?.generation ?? 0) + 1
      const refreshedAt = Date.now()
      await this.requireTable().put(entry.source.provider, {
        identity: entry.source.identity,
        generation,
        refreshedAt,
        payload: durablePayload,
      })
      controller.signal.throwIfAborted()
      if (entry.epoch !== epoch) throw new Error('Companion provider catalog refresh was superseded')
      entry.payload = payload
      entry.snapshot = freezeSnapshot({
        ...projected,
        status: 'ready',
        generation,
        refreshedAt,
        refreshing: false,
      })
      this.notify(entry.source.provider)
      return entry.snapshot
    } catch (error: unknown) {
      if (entry.epoch === epoch && this.sources.get(entry.source.provider) === entry) {
        entry.snapshot = freezeSnapshot({
          ...entry.snapshot,
          status: entry.snapshot.refreshedAt === undefined ? 'unavailable' : 'stale',
          refreshing: false,
          error: safeMessage(error),
        })
        this.notify(entry.source.provider)
      }
      throw error
    }
  }

  private project(source: ErasedSource, payload: unknown): CompanionProviderCatalogView {
    const view = source.project(payload)
    if (view.provider !== source.provider) {
      throw new Error(`Companion provider catalog projection for ${source.provider} changed its provider id`)
    }
    return view
  }

  private validateSource(source: ErasedSource): void {
    if (source.identity.length === 0) throw new Error('Companion provider catalog source identity must not be empty')
    this.requireTable()
  }

  private requireTable(): KvTable<CompanionProviderId, ProviderCatalogRecord> {
    if (this.table === undefined) throw new Error('Companion provider catalog is not initialized')
    return this.table
  }

  private notify(provider: CompanionProviderId): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(provider)
        if (result != null && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result as unknown as PromiseLike<unknown>).catch((error: unknown) => {
            this.ctx.logger.warn(`Companion provider catalog listener failed: ${safeMessage(error)}`)
          })
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`Companion provider catalog listener failed: ${safeMessage(error)}`)
      }
    }
  }
}

function eraseSource<P>(source: CompanionProviderCatalogSource<P>): ErasedSource {
  return {
    provider: source.provider,
    identity: source.identity,
    load: signal => source.load(signal),
    decode: value => source.decode(value),
    project: payload => source.project(payload as P),
  }
}

function unavailableSnapshot(provider: CompanionProviderId): CompanionProviderCatalogSnapshot {
  return freezeSnapshot({ provider, models: [], status: 'unavailable', generation: 0, refreshing: false })
}

function freezeSnapshot(value: CompanionProviderCatalogSnapshot): CompanionProviderCatalogSnapshot {
  return deepFreeze(structuredClone(value))
}

function freezePayload<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort?.(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export default CompanionProviderCatalog
