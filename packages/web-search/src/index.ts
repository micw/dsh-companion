/** DSH-owned configuration and storage for Companion's Brave/Exa search router. */
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import { SearchFailure, searchProvider } from './adapters.js'
import { SearchRouter } from './router.js'
import { decodeSearchCommand, decodeSearchSnapshot, entrySchema, failureSchema } from './protocol.js'
import type { SearchCommand, SearchEntry, SearchSnapshot } from './protocol.js'

/** Live user intent persisted by DSH's config editor; keys are credential references only. */
export interface Config {
  entries: Volatile<SearchEntry[]>
  revision: Volatile<number>
  cooldownMs: Volatile<number>
  attemptTimeoutMs: Volatile<number>
}
const entryConfig = z.object({ id: z.string(), family: z.union(['brave', 'exa']), displayName: z.string(),
  enabled: z.boolean(), credentialRef: z.string().role('credential-ref') })
const schema = z.object({
  entries: z.array(entryConfig).default([{ id: 'legacy-brave', family: 'brave', displayName: 'Brave', enabled: true, credentialRef: 'BRAVE_SEARCH_API_KEY' }]).volatile(),
  revision: z.number().step(1).min(0).default(0).volatile(),
  cooldownMs: z.number().step(1).min(1000).max(30 * 24 * 3600_000).default(4 * 3600_000).volatile(),
  attemptTimeoutMs: z.number().step(1).min(1000).max(60_000).default(10_000).volatile(),
})
const domainSpec = defineDomain({ name: 'dsh_companion_web_search', version: 1, layout: 'per-record',
  invalidRecords: 'backup-and-skip', tables: { failures: domainTable<string, import('./protocol.js').SearchFailureState>(failureSchema) } })

declare module '@deepseek-ai/cordis' {
  interface Context { companionWebSearch: CompanionWebSearch }
}

/** Search management Remote; successful tool results keep DSH's existing web-search format. */
export class CompanionWebSearch extends TypertRemoteService {
  static inject = ['web', 'credentials', 'configEditor', 'storageDomain']
  static Config = schema
  declare readonly ctx: Context
  private router!: SearchRouter
  private queue: Promise<void> = Promise.resolve()
  private clearFailure!: (id: string) => Promise<void>

  constructor(private readonly ownerContext: Context, readonly config: Config) { super(ownerContext, 'companionWebSearch') }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(domainSpec)
    const table = domain.table('failures')
    this.clearFailure = async id => { await table.delete(id) }
    this.router = new SearchRouter({
      resolveKey: async entry => (await this.ctx.credentials.resolve(credentialRef(entry.credentialRef)))?.value,
      run: searchProvider,
      persist: (id, failure, identity) => this.serial(async () => {
        const entry = this.entries().find(candidate => candidate.id === id)
        if (entry === undefined || `${entry.family}:${entry.credentialRef}` !== identity) return
        if (failure === undefined) await table.delete(id)
        else await table.put(id, failure)
      }),
      cooldownMs: () => this.config.cooldownMs.get(),
      attemptTimeoutMs: () => this.config.attemptTimeoutMs.get(),
      now: Date.now,
    })
    const entries = this.entries()
    const restored = new Map(entries.flatMap(entry => {
      const state = table.get(entry.id)
      return state === undefined ? [] : [[entry.id, state] as const]
    }))
    this.router.configure(entries, restored)
    this.ctx.effect(() => async () => { await this.router.dispose(); await this.queue; await domain.close() })
    this.ctx.web.registerSearchProvider(this.router)
    this.ctx.on('loader/volatile-update', () => this.router.configure(this.entries()))
    this.ctx.on('credentials/reference-updated', ref => {
      void this.router.credentialChanged(ref).catch(() => { this.ctx.logger.warn('Search access state could not be reset') })
    })
    this.ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, this.ctx.fiber)) })
  }

  /** Read secret-free status or execute one bounded configuration/probe operation. */
  @Remote('manage')
  async manage(input: SearchCommand, signal: AbortSignal): Promise<SearchSnapshot> {
    const command = decodeSearchCommand(input)
    signal.throwIfAborted()
    if (command.kind === 'retry') {
      try { await this.router.retry(command.id, signal) } catch (error) {
        signal.throwIfAborted()
        if (!(error instanceof SearchFailure)) throw error
      }
    } else if (command.kind !== 'list') await this.serial(() => this.mutate(command, signal))
    return this.snapshot()
  }

  private entries(): SearchEntry[] {
    const parsed = entrySchema.array().max(32).safeParse(this.config.entries.get())
    if (!parsed.success || new Set(parsed.data.map(entry => entry.id)).size !== parsed.data.length) {
      throw new Error('Invalid or duplicate web search access configuration')
    }
    return parsed.data
  }
  private async snapshot(): Promise<SearchSnapshot> {
    const revision = this.config.revision.get()
    const cooldownMs = this.config.cooldownMs.get()
    const entries = await Promise.all(this.entries().map(async entry => {
      const credential = await this.ctx.credentials.describe(credentialRef(entry.credentialRef))
      const { failure, checking } = this.router.state(entry.id)
      return { id: entry.id, family: entry.family, displayName: entry.displayName, enabled: entry.enabled,
        configured: credential.configured, writable: credential.writable, checking,
        failure: failure === undefined ? null : { reason: failure.reason, message: failure.message, failedAt: failure.failedAt,
          blockedUntil: failure.blockedUntil, retrySource: failure.retrySource } }
    }))
    if (revision !== this.config.revision.get()) throw new Error('Search settings changed while loading; refresh')
    return decodeSearchSnapshot({ revision, cooldownMs, entries })
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
  private async mutate(command: Exclude<SearchCommand, { kind: 'list' | 'retry' }>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (command.revision !== this.config.revision.get()) throw new Error('Search settings changed; refresh before saving')
    const entries = this.entries()
    const index = 'id' in command ? entries.findIndex(entry => entry.id === command.id) : -1
    const previous = entries[index]
    let stagedRef: string | undefined
    let cooldownMs = this.config.cooldownMs.get()
    if (command.kind === 'save') {
      if (command.id !== undefined && previous === undefined) throw new Error('Search access no longer exists')
      if (previous !== undefined && previous.family !== command.family) throw new Error('Create a new access to change its provider')
      if (previous === undefined && entries.length >= 32) throw new Error('At most 32 search accesses are supported')
      if (previous === undefined && command.apiKey === undefined) throw new Error('A new search access requires an API key')
      if (command.apiKey !== undefined) {
        if (previous !== undefined && !(await this.ctx.credentials.describe(credentialRef(previous.credentialRef))).writable) {
          throw new Error('This key is supplied by the Runtime environment and cannot be replaced here')
        }
        stagedRef = `DSH_COMPANION_SEARCH_${randomUUID().replaceAll('-', '_').toUpperCase()}`
        await this.ctx.credentials.set(credentialRef(stagedRef), command.apiKey)
      }
      const entry: SearchEntry = { id: previous?.id ?? randomUUID(), family: command.family,
        displayName: command.displayName, enabled: command.enabled, credentialRef: stagedRef ?? previous!.credentialRef }
      if (previous === undefined) entries.push(entry)
      else entries[index] = entry
    } else if (command.kind === 'remove') {
      if (previous === undefined) throw new Error('Search access no longer exists')
      entries.splice(index, 1)
    } else if (command.kind === 'move') {
      if (previous === undefined) throw new Error('Search access no longer exists')
      const target = index + (command.direction === 'up' ? -1 : 1)
      if (target < 0 || target >= entries.length) throw new Error('Search access cannot move further')
      entries[index] = entries[target]!
      entries[target] = previous
    } else cooldownMs = command.cooldownMs
    try {
      signal.throwIfAborted()
      const entry = this.ownerContext.fiber.entry
      if (entry === undefined) throw new Error('Search configuration entry is unavailable')
      await this.ownerContext.configEditor.edit(entry, current => {
        if ((current.revision ?? 0) !== command.revision) throw new Error('Search settings changed; refresh before saving')
        return { ...current, entries, cooldownMs, revision: command.revision + 1 }
      })
    } catch (error) {
      if (stagedRef !== undefined) await this.ctx.credentials.unset(credentialRef(stagedRef))
      throw error
    }
    if (previous !== undefined && (command.kind === 'remove' || stagedRef !== undefined)) await this.clearFailure(previous.id)
    if (previous !== undefined && (command.kind === 'remove' || stagedRef !== undefined)
      && previous.credentialRef.startsWith('DSH_COMPANION_SEARCH_')
      && !entries.some(entry => entry.credentialRef === previous.credentialRef)) {
      await this.ctx.credentials.unset(credentialRef(previous.credentialRef))
    }
  }
}
export default CompanionWebSearch
