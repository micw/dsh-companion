import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { BraveSearchProvider, mapBraveResponse } from '../lib/provider.js'

const key = 'test-secret-never-report'
const payload = { web: { results: [{ url: 'https://example.org', title: 'Example', description: 'Excerpt', age: '2 days ago', page_age: '2024-01-01T12:30:00Z' }] } }
const response = (body = payload, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const provider = (resolveApiKey = async () => key) => new BraveSearchProvider({ resolveApiKey })
const search = (instance, signal, maxResults = 4) => instance.search({ query: 'a & b', maxResults }, signal)
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code && !error.message.includes(key))

test('maps only web sources without generated content', () => {
  assert.deepEqual(mapBraveResponse(payload), { sources: [{ url: 'https://example.org', title: 'Example', snippet: 'Excerpt', publishedAt: '2024-01-01T12:30:00Z' }], truncated: false })
  assert.deepEqual(mapBraveResponse({ web: { results: [{ url: 'javascript:bad' }, { url: 'https://safe.example', page_age: '1 day' }] } }, 1), { sources: [], truncated: true })
  assert.deepEqual(mapBraveResponse({ web: { results: [{ url: 'https://example.org', age: '1 day', page_age: 'yesterday' }] } }).sources, [{ url: 'https://example.org' }])
  assert.deepEqual(mapBraveResponse({ web: { results: [{ url: 'https://example.org', page_age: '2024-99-01T00:00:00Z' }] } }).sources, [{ url: 'https://example.org' }])
  assert.throws(() => mapBraveResponse({ web: {} }), { code: 'WEB_PROVIDER_ERROR' })
})

test('uses official URL, bounded result count and required headers', async () => {
  const original = globalThis.fetch
  globalThis.fetch = mock.fn(async (url, init) => {
    const parsed = new URL(url)
    assert.equal(parsed.origin, 'https://api.search.brave.com')
    assert.equal(parsed.pathname, '/res/v1/web/search')
    assert.equal(parsed.searchParams.get('q'), 'a & b')
    assert.equal(parsed.searchParams.get('count'), '4')
    assert.equal(parsed.searchParams.get('result_filter'), 'web')
    assert.equal(parsed.searchParams.get('safesearch'), 'moderate')
    assert.equal(init.headers['X-Subscription-Token'], key)
    assert.equal(init.headers.Accept, 'application/json')
    assert.equal(init.redirect, 'error')
    return response()
  })
  try { assert.equal((await search(provider())).sources.length, 1) } finally { globalThis.fetch = original }
})

test('missing key and invalid bounds prevent dispatch', async () => {
  const original = globalThis.fetch
  globalThis.fetch = mock.fn(() => { throw new Error('unexpected dispatch') })
  try {
    await rejectsCode(search(provider(async () => undefined)), 'WEB_PROVIDER_CREDENTIAL_MISSING')
    await rejectsCode(search(provider(), undefined, 21), 'WEB_PROVIDER_ERROR')
    await rejectsCode(search(provider(), undefined, 0), 'WEB_PROVIDER_ERROR')
    assert.equal(globalThis.fetch.mock.callCount(), 0)
  } finally { globalThis.fetch = original }
})

test('rotates credential for every search and translates HTTP and malformed responses', async () => {
  let current = 'first'
  const seen = []
  const original = globalThis.fetch
  globalThis.fetch = mock.fn(async (_url, init) => { seen.push(init.headers['X-Subscription-Token']); return seen.length === 3 ? response({}, 429) : seen.length === 4 ? response({ invalid: true }) : response() })
  try {
    const instance = provider(async () => current)
    await search(instance)
    current = 'second'
    await search(instance)
    await rejectsCode(search(instance), 'WEB_PROVIDER_ERROR')
    await rejectsCode(search(instance), 'WEB_PROVIDER_ERROR')
    assert.deepEqual(seen, ['first', 'second', 'second', 'second'])
  } finally { globalThis.fetch = original }
})

test('aborts before dispatch and during body read', async () => {
  const controller = new AbortController()
  controller.abort()
  await rejectsCode(search(provider(), controller.signal), 'WEB_ABORTED')
  const original = globalThis.fetch
  const running = new AbortController()
  globalThis.fetch = mock.fn(async () => new Response(new ReadableStream({ start() { running.abort() } })))
  try { await rejectsCode(search(provider(), running.signal), 'WEB_ABORTED') } finally { globalThis.fetch = original }
})

test('redirect response is never followed to its target', async () => {
  const original = globalThis.fetch
  let targetContacted = false
  globalThis.fetch = mock.fn(async (url, init) => {
    if (new URL(url).hostname === 'untrusted.example') targetContacted = true
    if (init.redirect !== 'error') return globalThis.fetch('https://untrusted.example/steal', init)
    return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/steal' } })
  })
  try { await rejectsCode(search(provider()), 'WEB_PROVIDER_ERROR'); assert.equal(targetContacted, false); assert.equal(globalThis.fetch.mock.callCount(), 1) } finally { globalThis.fetch = original }
})

test('rejects oversized and invalid UTF-8 response bodies', async () => {
  const original = globalThis.fetch
  let cancelled = false
  globalThis.fetch = mock.fn(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  })))
  try { await rejectsCode(search(provider()), 'WEB_PROVIDER_ERROR'); assert.equal(cancelled, true) } finally { globalThis.fetch = original }
  globalThis.fetch = mock.fn(async () => new Response(new Uint8Array([255])))
  try { await rejectsCode(search(provider()), 'WEB_PROVIDER_ERROR') } finally { globalThis.fetch = original }
})
