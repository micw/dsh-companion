/** Priority routing with durable cooldowns and one in-flight operation per access. */
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import { SearchFailure } from './adapters.js'
import type { SearchEntry, SearchFailureState } from './protocol.js'

interface Access {
  entry: SearchEntry
  identity: string
  failure: SearchFailureState | undefined
  active: Promise<void> | undefined
}
/** Dependencies supplied by the DSH plugin; secrets never leave the credential resolver. */
export interface RouterOptions {
  resolveKey(entry: SearchEntry): Promise<string | undefined>
  run(family: SearchEntry['family'], key: string, request: WebSearchRequest, signal: AbortSignal): Promise<WebSearchResult>
  persist(id: string, failure: SearchFailureState | undefined, identity: string): Promise<void>
  cooldownMs(): number
  attemptTimeoutMs(): number
  now(): number
}

/** Model-facing results contain no routing chatter, access names, or secret values. */
export class SearchRouter {
  readonly id = 'dsh-companion-search'
  private accesses = new Map<string, Access>()
  private readonly operations = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  constructor(private readonly options: RouterOptions) {}

  configure(entries: readonly SearchEntry[], restored = new Map<string, SearchFailureState>()): void {
    const next = new Map<string, Access>()
    for (const entry of entries) {
      const identity = `${entry.family}:${entry.credentialRef}`
      const previous = this.accesses.get(entry.id)
      const saved = restored.get(entry.id)
      const access = previous?.identity === identity ? previous : {
        entry, identity, failure: saved?.identity === identity ? saved : undefined, active: undefined,
      }
      access.entry = entry
      next.set(entry.id, access)
    }
    this.accesses = next
  }
  available(): boolean { return [...this.accesses.values()].some(access => access.entry.enabled) }
  state(id: string): { checking: boolean; failure: SearchFailureState | undefined } {
    const access = this.accesses.get(id)
    return { checking: access?.active !== undefined, failure: access?.failure }
  }
  /** Drop a failure only after the caller has durably committed a credential replacement. */
  async credentialChanged(ref: string): Promise<void> {
    for (const access of this.accesses.values()) {
      if (access.entry.credentialRef !== ref) continue
      // Replacing the runtime object prevents an old in-flight request publishing into the new key generation.
      this.accesses.set(access.entry.id, { ...access, failure: undefined, active: undefined })
      await this.options.persist(access.entry.id, undefined, access.identity)
    }
  }
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const outer = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    outer.throwIfAborted()
    if (!request.query.trim() || (request.maxResults !== undefined && (!Number.isSafeInteger(request.maxResults) || request.maxResults < 1))) {
      throw new WebError('Invalid web search request', 'WEB_INVALID_QUERY')
    }
    for (const access of this.accesses.values()) {
      if (!access.entry.enabled || this.blocked(access)) continue
      // An expired cooldown has one probing request; peers use the next access rather than queueing more probes.
      if (access.active !== undefined && access.failure !== undefined) continue
      while (access.active !== undefined && access.failure === undefined) await wait(access.active, outer)
      outer.throwIfAborted()
      if (this.accesses.get(access.entry.id) !== access || !access.entry.enabled || this.blocked(access) || access.active !== undefined) continue
      try { return await this.attempt(access, request, outer) } catch (error) {
        outer.throwIfAborted()
        if (!(error instanceof SearchFailure)) throw error
      }
    }
    throw new WebError('All configured web search accesses are unavailable; review Web Search settings or retry an access', 'WEB_PROVIDER_UNAVAILABLE')
  }
  /** One explicit probe of the named access, including disabled or indefinitely blocked entries; never fails over. */
  async retry(id: string, signal: AbortSignal): Promise<void> {
    const access = this.accesses.get(id)
    if (access === undefined) throw new Error('Search access no longer exists')
    if (access.active !== undefined) throw new Error('Search access is already being checked')
    await this.attempt(access, { query: 'example domain', maxResults: 1 }, AbortSignal.any([signal, this.lifetime.signal]))
  }
  /** Cancel operations and await storage settlement before the domain is closed. */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('Search router disposed'))
    await Promise.all(this.operations)
  }
  private blocked(access: Access): boolean {
    return access.failure !== undefined && (access.failure.blockedUntil === null || access.failure.blockedUntil > this.options.now())
  }
  private async attempt(access: Access, request: WebSearchRequest, outer: AbortSignal): Promise<WebSearchResult> {
    // Reserve synchronously before credential resolution or network awaits.
    let release!: () => void
    const active = new Promise<void>(resolve => { release = resolve })
    access.active = active
    this.operations.add(active)
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new Error('Search attempt timed out')), this.options.attemptTimeoutMs())
    const signal = AbortSignal.any([outer, timeout.signal])
    try {
      let result: WebSearchResult | undefined
      let failure: SearchFailure | undefined
      try {
        const key = await wait(this.options.resolveKey(access.entry), signal)
        signal.throwIfAborted()
        if (!key) throw new SearchFailure('credentials', 'Search access has no configured API key', null)
        result = await this.options.run(access.entry.family, key, request, signal)
        signal.throwIfAborted()
      } catch (error) {
        outer.throwIfAborted()
        if (timeout.signal.aborted) failure = new SearchFailure('timeout', 'Search access timed out')
        else if (error instanceof SearchFailure) failure = error
        else throw error
      }
      outer.throwIfAborted()
      if (this.accesses.get(access.entry.id) !== access) throw new Error('Search access changed during the request')
      const now = this.options.now()
      const state: SearchFailureState | undefined = failure === undefined ? undefined : {
        identity: access.identity, reason: failure.reason, message: failure.message, failedAt: now,
        blockedUntil: failure.retryAt === null ? null : failure.retryAt ?? now + this.options.cooldownMs(),
        retrySource: failure.retryAt === null ? 'manual' : failure.retryAt === undefined ? 'default' : 'provider',
      }
      await this.options.persist(access.entry.id, state, access.identity)
      if (this.accesses.get(access.entry.id) === access) access.failure = state
      if (failure !== undefined) throw failure
      if (result === undefined) throw new Error('Search completed without a result')
      return result
    } finally {
      clearTimeout(timer)
      if (access.active === active) access.active = undefined
      this.operations.delete(active)
      release()
    }
  }
}

/** Observe late settlement while allowing cooperative cancellation of credential resolution. */
async function wait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason) })
  signal.addEventListener('abort', abort, { once: true })
  try { return await Promise.race([operation, cancelled]) } finally { signal.removeEventListener('abort', abort) }
}
