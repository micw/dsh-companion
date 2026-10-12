import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { httpFailure, mapResponse, searchProvider } from '../lib/adapters.js'
import { decodeSearchCommand, decodeSearchSnapshot } from '../lib/protocol.js'

const signal = () => new AbortController().signal
const empty = { sources: [], truncated: false }

test('Brave quota reset uses the exhausted long window, never an unlimited or per-second window', () => {
  const response = new Response('{}', { status: 429, headers: {
    'x-ratelimit-limit': '50, 1000', 'x-ratelimit-policy': '50;w=1, 1000;w=2678400',
    'x-ratelimit-remaining': '49, 0', 'x-ratelimit-reset': '1, 900000',
  } })
  const quota = httpFailure('brave', response, { error: { code: 'QUOTA_LIMITED' } }, 1000)
  assert.equal(quota.retryAt, 900001000)
  const unlimited = new Response('{}', { status: 429, headers: {
    'x-ratelimit-limit': '50, 0', 'x-ratelimit-policy': '50;w=1, 0;w=2678400',
    'x-ratelimit-remaining': '0, 0', 'x-ratelimit-reset': '1, 900000',
  } })
  assert.equal(httpFailure('brave', unlimited, { error: { code: 'QUOTA_LIMITED' } }, 1000).retryAt, undefined)
  assert.equal(httpFailure('brave', unlimited, { error: { code: 'RATE_LIMITED' } }, 1000).retryAt, 2000)
})

test('Retry-After seconds and HTTP dates override cooldown; authentication requires manual intervention', () => {
  for (const family of ['brave', 'exa']) {
    assert.equal(httpFailure(family, new Response('', { status: 429, headers: { 'retry-after': '120' } }), {}, 1000).retryAt, 121000)
    assert.equal(httpFailure(family, new Response('', { status: 503, headers: { 'retry-after': 'Thu, 01 Jan 1970 00:02:00 GMT' } }), {}, 1000).retryAt, 120000)
    assert.equal(httpFailure(family, new Response('', { status: 401 }), {}, 1000).retryAt, null)
  }
  const exhausted = httpFailure('exa', new Response('', { status: 402 }), { tag: 'NO_MORE_CREDITS', error: 'secret QUERY' }, 1000)
  assert.equal(exhausted.reason, 'quota')
  assert.doesNotMatch(exhausted.message, /secret|QUERY/u)
})

test('normalizes Brave and Exa results, including empty searches and Exa URLs without highlights', () => {
  assert.deepEqual(mapResponse('brave', { web: { results: [] } }, 8), empty)
  assert.deepEqual(mapResponse('exa', { results: [{ url: 'https://example.org', title: 'Example', highlights: ['Excerpt'] }, { url: 'https://example.net' }] }, 8), {
    sources: [{ url: 'https://example.org', title: 'Example', snippet: 'Excerpt' }, { url: 'https://example.net' }], truncated: false,
  })
  assert.throws(() => mapResponse('exa', { results: [{ url: 'javascript:alert(1)' }] }, 8), /unsupported/u)
  assert.throws(() => mapResponse('brave', { web: { results: [{ url: 'https://example.org', description: {} }] } }, 8), /invalid/u)
})

test('fixed credentialed endpoints reject redirects without contacting their targets for both adapters', async t => {
  let contacted = 0
  const target = createServer((_req, res) => { contacted++; res.end('{}') })
  target.listen(0, '127.0.0.1'); await once(target, 'listening')
  t.after(() => target.close())
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (url, init) => {
    assert.equal(init.redirect, 'error')
    assert.ok(['https://api.search.brave.com', 'https://api.exa.ai'].includes(url.origin))
    // Exercise real fetch redirect policy against a local source, not a hand-made redirect response.
    const redirect = createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/` }); res.end() })
    redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening')
    try { return await original(`http://127.0.0.1:${redirect.address().port}/`, { ...init, headers: {} }) }
    finally { redirect.close() }
  }
  for (const family of ['brave', 'exa']) await assert.rejects(searchProvider(family, 'credential', { query: 'query', maxResults: 8 }, signal()), /connection failed/u)
  assert.equal(contacted, 0)
})

test('Exa sends current highlights syntax without generated answers; provider responses and secrets stay out of errors', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { query: 'query', type: 'auto', numResults: 8, contents: { highlights: true } })
    return Response.json({ results: [] })
  }
  assert.deepEqual(await searchProvider('exa', 'credential', { query: 'query', maxResults: 8 }, signal()), empty)
  globalThis.fetch = async () => Response.json({ error: 'credential QUERY', tag: 'NO_MORE_CREDITS' }, { status: 402 })
  await assert.rejects(searchProvider('exa', 'credential', { query: 'QUERY' }, signal()), error => !/credential|QUERY/u.test(error.message) && error.reason === 'quota')
  globalThis.fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1))
  await assert.rejects(searchProvider('brave', 'credential', { query: 'query' }, signal()), /exceeds 2 MiB/u)
})

test('management and response validation reject oversized, extra, and secret-bearing fields', () => {
  assert.throws(() => decodeSearchCommand({ kind: 'save', revision: 0, family: 'exa', displayName: 'Exa', enabled: true, apiKey: 'SECRET\n' }), /Invalid/u)
  assert.throws(() => decodeSearchCommand({ kind: 'retry', id: 'one', query: 'private query' }), /Invalid/u)
  assert.throws(() => decodeSearchSnapshot({ revision: 0, cooldownMs: 14400000, entries: [], apiKey: 'SECRET' }), /Invalid/u)
})
