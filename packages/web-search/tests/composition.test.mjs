import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const signal = () => new AbortController().signal

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'companion-search-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { id: 'web', name: require.resolve('@deepseek-ai/dsh-web'), config: { searchProvider: 'dsh-companion-search' } },
    { id: 'search', name: new URL('../lib/index.js', import.meta.url).pathname },
  ]))
  const keys = new Map([['BRAVE_SEARCH_API_KEY', 'legacy-key']])
  const records = new Map()
  let rejectWrite = false
  let opens = 0
  async function start() {
    const ctx = await boot('companion-search-test', file, [], ctx => {
      ctx.provide('credentials', {
        resolve: async ref => keys.has(ref) ? { value: keys.get(ref) } : undefined,
        describe: async ref => ({ configured: keys.has(ref), writable: true }),
        set: async (ref, value) => { keys.set(ref, value); ctx.emit('credentials/reference-updated', ref) },
        unset: async ref => { keys.delete(ref); ctx.emit('credentials/reference-updated', ref) },
      })
      ctx.provide('storageDomain', { open: async () => {
        opens++
        return { close: async () => {}, table: () => ({
          get: id => records.get(id), delete: async id => records.delete(id),
          put: async (id, state) => { records.set(id, structuredClone(state)) },
        }) }
      } })
      ctx.provide('configEditor', { edit: async (entry, change) => {
        const next = change(structuredClone(entry.options.config ?? {}), {})
        if (rejectWrite) throw new Error('Configuration disk write failed')
        await entry.update({ config: next })
        await writeFile(file, JSON.stringify([...ctx.loader.entries()].filter(e => ['web', 'search'].includes(e.options.id)).map(e => e.options)))
      } })
    })
    t.after(() => ctx.fiber.dispose())
    return ctx
  }
  return { start, keys, records, file, rejectWrites: value => { rejectWrite = value }, opens: () => opens }
}

test('Loader composition edits live intent without restarting, stages credentials and rolls them back on failure', async t => {
  const f = await fixture(t); const ctx = await f.start(); const service = ctx.companionWebSearch
  const searchEntry = [...ctx.loader.entries()].find(e => e.options.id === 'search')
  const fiber = searchEntry.fiber
  const initial = await service.manage({ kind: 'list' }, signal())
  assert.equal(initial.entries[0].configured, true)
  assert.equal(initial.entries[0].id, 'legacy-brave')
  const created = await service.manage({ kind: 'save', revision: 0, family: 'exa', displayName: 'Research', enabled: true, apiKey: 'exa-secret' }, signal())
  assert.equal(created.entries.length, 2)
  assert.equal(searchEntry.fiber === fiber, true); assert.equal(f.opens(), 1)
  assert.doesNotMatch(JSON.stringify(created), /exa-secret|credentialRef/u)
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /exa-secret/u)
  await assert.rejects(service.manage({ kind: 'cooldown', revision: 0, cooldownMs: 1000 }, signal()), /changed/u)
  const before = [...f.keys]
  f.rejectWrites(true)
  await assert.rejects(service.manage({ kind: 'save', revision: 1, id: created.entries[1].id, family: 'exa', displayName: 'Research', enabled: true, apiKey: 'replacement-secret' }, signal()), /disk write/u)
  assert.deepEqual([...f.keys], before)
  f.rejectWrites(false)
  const moved = await service.manage({ kind: 'move', revision: 1, id: created.entries[1].id, direction: 'up' }, signal())
  assert.equal(moved.entries[0].family, 'exa')
  const removed = await service.manage({ kind: 'remove', revision: 2, id: created.entries[1].id }, signal())
  assert.equal(removed.entries.length, 1)
  assert.deepEqual([...f.keys], [['BRAVE_SEARCH_API_KEY', 'legacy-key']])
  await searchEntry.update({ disabled: true })
  await assert.rejects(ctx.web.search({ query: 'query' }), /not registered/u)
})

test('real web seam silently fails over, restores failures and Retry has no fallback or Session work', async t => {
  const f = await fixture(t); let ctx = await f.start()
  const added = await ctx.companionWebSearch.manage({ kind: 'save', revision: 0, family: 'exa', displayName: 'Research', enabled: true, apiKey: 'exa-secret' }, signal())
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ host: url.host, query: url.searchParams.get('q') ?? JSON.parse(init.body).query })
    if (url.host === 'api.search.brave.com') return Response.json({ error: { code: 'QUOTA_LIMITED', message: 'legacy-key secret query' } }, { status: 429 })
    return Response.json({ results: [] })
  }
  assert.deepEqual(await ctx.web.search({ query: 'secret query' }), { sources: [], truncated: false })
  const state = await ctx.companionWebSearch.manage({ kind: 'list' }, signal())
  assert.equal(state.entries[0].failure.reason, 'quota')
  assert.doesNotMatch(JSON.stringify([...f.records]), /legacy-key|secret query/u)
  await ctx.fiber.dispose(); ctx = await f.start()
  const restored = await ctx.companionWebSearch.manage({ kind: 'list' }, signal())
  assert.deepEqual(restored.entries[0].failure, state.entries[0].failure)
  calls.length = 0
  await ctx.web.search({ query: 'another query' }); assert.equal(calls.length, 1); assert.equal(calls[0].host, 'api.exa.ai')
  calls.length = 0
  await ctx.companionWebSearch.manage({ kind: 'retry', id: 'legacy-brave' }, signal())
  assert.deepEqual(calls, [{ host: 'api.search.brave.com', query: 'example domain' }])
  globalThis.fetch = async () => Response.json({ web: { results: [] } })
  const retried = await ctx.companionWebSearch.manage({ kind: 'retry', id: 'legacy-brave' }, signal())
  assert.equal(retried.entries[0].failure, null)
  assert.equal(f.records.has('legacy-brave'), false)
  assert.equal(retried.entries[1].id, added.entries[1].id)
})
