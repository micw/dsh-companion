import assert from 'node:assert/strict'
import test from 'node:test'
import { SearchRouter } from '../lib/router.js'
import { SearchFailure } from '../lib/adapters.js'

const empty = { sources: [], truncated: false }
const entries = [
  { id: 'private', family: 'brave', displayName: 'Private', enabled: true, credentialRef: 'PRIVATE_KEY' },
  { id: 'business', family: 'brave', displayName: 'Business', enabled: true, credentialRef: 'BUSINESS_KEY' },
  { id: 'exa', family: 'exa', displayName: 'Exa', enabled: true, credentialRef: 'EXA_KEY' },
]
function setup(run, records = new Map(), overrides = {}) {
  let now = 10000
  const calls = []
  const router = new SearchRouter({
    resolveKey: async entry => entry.credentialRef,
    run: async (...args) => { calls.push(args[1]); return run(...args) },
    persist: async (id, state) => { if (state === undefined) records.delete(id); else records.set(id, state) },
    cooldownMs: () => 4 * 3600_000, attemptTimeoutMs: () => 10000, now: () => now, ...overrides,
  })
  router.configure(entries, records)
  return { router, records, calls, time: value => { now = value } }
}

test('silently crosses accounts and providers, persists cooldown, restores and fails back', async () => {
  let working = false
  const run = async (_family, key) => {
    if (key === 'PRIVATE_KEY' && !working) throw new SearchFailure('quota', 'Brave budget exhausted', 20000)
    if (key === 'BUSINESS_KEY') throw new SearchFailure('transport', 'Brave unavailable')
    return empty
  }
  const h = setup(run)
  assert.deepEqual(await h.router.search({ query: 'query' }), empty)
  assert.deepEqual(h.calls, ['PRIVATE_KEY', 'BUSINESS_KEY', 'EXA_KEY'])
  assert.equal(h.records.get('private').retrySource, 'provider')
  const restored = setup(run, h.records)
  assert.deepEqual(await restored.router.search({ query: 'query' }), empty)
  assert.deepEqual(restored.calls, ['EXA_KEY'])
  working = true
  restored.time(20000)
  await restored.router.search({ query: 'query' })
  assert.equal(restored.calls.at(-1), 'PRIVATE_KEY')
  assert.equal(h.records.has('private'), false)
  await h.router.dispose(); await restored.router.dispose()
})

test('manual retry sends exactly one neutral search to the named blocked access, no failover', async () => {
  let working = false
  const seen = []
  const h = setup(async (_family, key, request) => {
    seen.push({ key, request })
    if (!working) throw new SearchFailure('credentials', 'Invalid key', null)
    return empty
  })
  await assert.rejects(h.router.retry('private', new AbortController().signal), /Invalid key/u)
  assert.deepEqual(seen, [{ key: 'PRIVATE_KEY', request: { query: 'example domain', maxResults: 1 } }])
  assert.equal(h.router.state('private').failure.blockedUntil, null)
  working = true
  await h.router.retry('private', new AbortController().signal)
  assert.equal(h.router.state('private').failure, undefined)
  assert.equal(h.records.has('private'), false)
  await h.router.dispose()
})

test('one expired access is probed while concurrent searches use the healthy alternative', async () => {
  const gate = Promise.withResolvers()
  const failed = { identity: 'brave:PRIVATE_KEY', reason: 'quota', message: 'Quota reached', failedAt: 1, blockedUntil: 2, retrySource: 'provider' }
  const h = setup(async (_family, key) => key === 'PRIVATE_KEY' ? gate.promise : empty, new Map([['private', failed]]))
  const probe = h.router.search({ query: 'first' })
  await new Promise(resolve => setImmediate(resolve))
  const parallel = await h.router.search({ query: 'second' })
  assert.deepEqual(parallel, empty)
  assert.deepEqual(h.calls, ['PRIVATE_KEY', 'BUSINESS_KEY'])
  await assert.rejects(h.router.retry('private', new AbortController().signal), /already being checked/u)
  gate.resolve(empty); await probe
  assert.equal(h.router.state('private').failure, undefined)
  await h.router.dispose()
})

test('serializes healthy concurrent requests without multiplying requests after a failure', async () => {
  const gate = Promise.withResolvers()
  const h = setup(async (_family, key) => key === 'PRIVATE_KEY' ? gate.promise : empty)
  const first = h.router.search({ query: 'one' })
  const second = h.router.search({ query: 'two' })
  const third = h.router.search({ query: 'three' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls, ['PRIVATE_KEY'])
  gate.reject(new SearchFailure('quota', 'Quota reached'))
  await Promise.all([first, second, third])
  assert.deepEqual(h.calls, ['PRIVATE_KEY', 'BUSINESS_KEY', 'BUSINESS_KEY', 'BUSINESS_KEY'])
  await h.router.dispose()
})

test('cancellation, invalid query and storage failure do not trigger failover or block an access', async () => {
  const cancelled = new AbortController()
  const h = setup(async (_family, _key, _request, signal) => {
    cancelled.abort(new Error('User cancelled')); signal.throwIfAborted()
  })
  await assert.rejects(h.router.search({ query: 'query' }, cancelled.signal), /User cancelled/u)
  assert.deepEqual(h.calls, ['PRIVATE_KEY']); assert.equal(h.records.size, 0)
  await assert.rejects(h.router.search({ query: '' }), /Invalid web search/u)
  const disk = setup(async () => empty, new Map(), { persist: async () => { throw new Error('disk unavailable') } })
  await assert.rejects(disk.router.search({ query: 'query' }), /disk unavailable/u)
  assert.deepEqual(disk.calls, ['PRIVATE_KEY'])
  await h.router.dispose(); await disk.router.dispose()
})

test('replacing a key prevents stale publication and ignores restored state for the previous reference', async () => {
  const gate = Promise.withResolvers()
  const h = setup(async () => gate.promise)
  const request = h.router.search({ query: 'query' })
  await new Promise(resolve => setImmediate(resolve))
  h.router.configure([{ ...entries[0], credentialRef: 'NEW_KEY' }])
  gate.reject(new SearchFailure('quota', 'Old key exhausted'))
  await assert.rejects(request, /changed during the request/u)
  assert.equal(h.records.size, 0)
  const stale = new Map([['private', { identity: 'brave:PRIVATE_KEY', reason: 'quota', message: 'Old quota', failedAt: 1, blockedUntil: 99999999, retrySource: 'default' }]])
  h.router.configure([{ ...entries[0], credentialRef: 'NEW_KEY' }], stale)
  assert.equal(h.router.state('private').failure, undefined)
  await h.router.dispose()
})

test('attempt timeout fails over while caller deadline cancels all further attempts', async () => {
  const h = setup(async (_family, key, _request, signal) => {
    if (key !== 'PRIVATE_KEY') return empty
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return empty
  }, new Map(), { attemptTimeoutMs: () => 5 })
  assert.deepEqual(await h.router.search({ query: 'query' }), empty)
  assert.equal(h.router.state('private').failure.reason, 'timeout')
  await h.router.dispose()
})
