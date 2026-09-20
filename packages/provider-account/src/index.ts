/** Generic live account and allowance registry for Companion providers. */

import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CompanionProviderId } from '@dsh-companion/provider-catalog/types'
import { CompanionProviderId as providerId } from '@dsh-companion/provider-catalog'
import type {
  CompanionProviderAccountRegistration,
  CompanionProviderAccountRemoteSnapshot,
  CompanionProviderAccountSnapshot,
  CompanionProviderAccountSource,
  CompanionProviderAccountView,
} from './types.js'

export type {
  CompanionAllowanceGroup,
  CompanionAllowanceWindow,
  CompanionJsonValue,
  CompanionProviderAccountRegistration,
  CompanionProviderAccountRemoteSnapshot,
  CompanionProviderAccountSnapshot,
  CompanionProviderAccountSource,
  CompanionProviderAccountView,
  CompanionProviderCredits,
} from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    companionProviderAccounts: CompanionProviderAccounts
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'dsh-companion/provider-account-refresh-failed': { readonly provider: string }
  }
}

interface AccountEntry {
  source: CompanionProviderAccountSource
  epoch: number
  controller: AbortController | undefined
  active: Promise<CompanionProviderAccountSnapshot> | undefined
  snapshot: CompanionProviderAccountSnapshot
}

/** Registry for process-local provider account and allowance observations. */
export class CompanionProviderAccounts extends TypertRemoteService {
  private readonly sources = new Map<CompanionProviderId, AccountEntry>()
  private readonly listeners = new Set<(provider: CompanionProviderId) => void | Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'companionProviderAccounts')
  }

  /** Register one provider account source and begin its initial refresh. */
  register(source: CompanionProviderAccountSource): CompanionProviderAccountRegistration {
    this.validateSource(source)
    if (this.sources.has(source.provider)) {
      throw new Error(`Companion provider account source ${JSON.stringify(source.provider)} is already registered`)
    }
    let released = false
    const entry: AccountEntry = {
      source,
      epoch: 0,
      controller: undefined,
      active: undefined,
      snapshot: unavailable(source.provider),
    }
    const dispose = this.ctx.effect(() => {
      this.sources.set(source.provider, entry)
      this.notify(source.provider)
      void this.refreshEntry(entry).catch((error: unknown) => {
        this.ctx.logger.warn(`Companion provider account initial refresh failed for ${source.provider}: ${safeMessage(error)}`)
      })
      return () => {
        released = true
        this.cancel(entry, 'provider account source disposed')
        this.sources.delete(source.provider)
        this.notify(source.provider)
      }
    }, 'companionProviderAccounts.register()')
    const registration = (() => { void dispose() }) as CompanionProviderAccountRegistration
    registration.replace = (next): void => {
      if (released) throw new Error('A disposed Companion provider account source cannot be replaced')
      this.validateSource(next)
      if (next.provider !== source.provider) {
        throw new Error('A Companion provider account source replacement must preserve its provider id')
      }
      this.cancel(entry, 'provider account source replaced')
      entry.source = next
      entry.snapshot = unavailable(next.provider)
      this.notify(next.provider)
      void this.refreshEntry(entry).catch((error: unknown) => {
        this.ctx.logger.warn(`Companion provider account replacement refresh failed for ${next.provider}: ${safeMessage(error)}`)
      })
    }
    registration.publish = view => {
      if (released) throw new Error('A disposed Companion provider account source cannot publish')
      if (view.provider !== entry.source.provider) {
        throw new Error('A Companion provider account publication must preserve its provider id')
      }
      entry.snapshot = ready(view, entry.snapshot.refreshing)
      this.notify(view.provider)
      return entry.snapshot
    }
    registration.current = () => released ? undefined : entry.snapshot
    registration.cancelRefresh = () => {
      if (!released) this.cancel(entry, 'provider account source changed')
    }
    return registration
  }

  /** Current snapshot for one registered provider. */
  snapshot(provider: CompanionProviderId): CompanionProviderAccountSnapshot | undefined {
    return this.sources.get(provider)?.snapshot
  }

  /** Current snapshots in source registration order. */
  list(): readonly CompanionProviderAccountSnapshot[] {
    return Object.freeze([...this.sources.values()].map(entry => entry.snapshot))
  }

  /** Client-safe account snapshots for every registered provider. */
  @Remote('list')
  remoteList(): readonly CompanionProviderAccountRemoteSnapshot[] {
    return this.list()
  }

  /** Refresh one source, sharing an already-running operation. */
  refresh(provider: CompanionProviderId): Promise<CompanionProviderAccountSnapshot> {
    const entry = this.sources.get(provider)
    if (entry === undefined) {
      return Promise.reject(new Error(`No Companion provider account source is registered for ${JSON.stringify(provider)}`))
    }
    return this.refreshEntry(entry)
  }

  /** Refresh one provider account through the shared Gateway transport. */
  @Remote('refresh')
  async remoteRefresh(provider: string, signal: AbortSignal): Promise<CompanionProviderAccountRemoteSnapshot> {
    try {
      return await waitWithSignal(this.refresh(providerId(provider)), signal)
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason
      throw new RemoteError(
        'dsh-companion/provider-account-refresh-failed',
        safeMessage(error),
        { provider },
        { cause: error },
      )
    }
  }

  /** Subscribe to account snapshot changes. */
  subscribe(listener: (provider: CompanionProviderId) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private refreshEntry(entry: AccountEntry): Promise<CompanionProviderAccountSnapshot> {
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
      // The caller and initial-refresh observer own the failure; this branch observes finally's mirror.
    })
    return operation
  }

  private async runRefresh(
    entry: AccountEntry,
    epoch: number,
    controller: AbortController,
  ): Promise<CompanionProviderAccountSnapshot> {
    try {
      const view = await entry.source.refresh(controller.signal)
      controller.signal.throwIfAborted()
      if (entry.epoch !== epoch || this.sources.get(entry.source.provider) !== entry) {
        throw new Error('Companion provider account refresh was superseded')
      }
      if (view.provider !== entry.source.provider) {
        throw new Error('Companion provider account refresh changed its provider id')
      }
      entry.snapshot = ready(view, false)
      this.notify(entry.source.provider)
      return entry.snapshot
    } catch (error: unknown) {
      if (entry.epoch === epoch && this.sources.get(entry.source.provider) === entry) {
        entry.snapshot = freezeSnapshot({
          ...entry.snapshot,
          status: entry.snapshot.value === undefined ? 'unavailable' : 'stale',
          refreshing: false,
          error: safeMessage(error),
        })
        this.notify(entry.source.provider)
      }
      throw error
    }
  }

  private cancel(entry: AccountEntry, reason: string): void {
    entry.epoch += 1
    entry.controller?.abort(reason)
    entry.controller = undefined
    entry.active = undefined
    if (entry.snapshot.refreshing) {
      entry.snapshot = freezeSnapshot({ ...entry.snapshot, refreshing: false })
      this.notify(entry.source.provider)
    }
  }

  private validateSource(source: CompanionProviderAccountSource): void {
    if (source.identity.length === 0) throw new Error('Companion provider account source identity must not be empty')
  }

  private notify(provider: CompanionProviderId): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(provider)
        if (result != null && typeof (result as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).catch((error: unknown) => {
            this.ctx.logger.warn(`Companion provider account listener failed: ${safeMessage(error)}`)
          })
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`Companion provider account listener failed: ${safeMessage(error)}`)
      }
    }
  }
}

function unavailable(provider: CompanionProviderId): CompanionProviderAccountSnapshot {
  return freezeSnapshot({ provider, status: 'unavailable', refreshing: false })
}

function ready(view: CompanionProviderAccountView, refreshing: boolean): CompanionProviderAccountSnapshot {
  return freezeSnapshot({
    provider: view.provider,
    status: 'ready',
    value: view,
    observedAt: Date.now(),
    refreshing,
  })
}

function freezeSnapshot(value: CompanionProviderAccountSnapshot): CompanionProviderAccountSnapshot {
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

export default CompanionProviderAccounts
