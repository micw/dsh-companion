import assert from 'node:assert/strict'
import { zstdDecompressSync } from 'node:zlib'
import test from 'node:test'
import { CodexWireClient, normalizeServiceRoot } from '../lib/index.js'

const model = {
  id: 'gpt-5.6-sol',
  model: 'gpt-5.6-sol',
  display_name: 'GPT-5.6-Sol',
  description: null,
  hidden: false,
  input_modalities: ['text'],
  default_context_length: 272000,
  max_context_length: 872000,
  reasoning: { levels: ['low'], default: 'low', summary_supported: true },
}

test('normalizes service roots without accepting embedded authority or query data', () => {
  assert.equal(normalizeServiceRoot('https://wrapper.example/prefix///'), 'https://wrapper.example/prefix')
  for (const invalid of [
    'not a URL',
    'ftp://wrapper.example',
    'https://user:secret@wrapper.example',
    'https://wrapper.example?target=other',
    'https://wrapper.example#fragment',
  ]) {
    assert.throws(() => normalizeServiceRoot(invalid), error => error.code === 'INVALID_CONFIG')
  }
})

test('authenticates catalog requests and preserves a configured path prefix', async () => {
  const calls = []
  const client = new CodexWireClient({
    baseURL: 'https://wrapper.example/prefix/',
    apiKey: 'provider-secret',
  }, {
    fetch: async (url, init) => {
      calls.push({ url, init })
      return Response.json({ models: [model] })
    },
  })
  const catalog = await client.models()
  assert.equal(catalog.models[0].id, 'gpt-5.6-sol')
  assert.equal(calls[0].url, 'https://wrapper.example/prefix/wire/v1/models')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers.authorization, 'Bearer provider-secret')
  assert.equal(calls[0].init.headers.accept, 'application/json')
})

test('validates service identity and maps structured HTTP failures', async () => {
  const wrong = new CodexWireClient({ baseURL: 'https://wrapper.example', apiKey: 'key' }, {
    fetch: async () => Response.json({ service: 'other-service', version: '1.0.0' }),
  })
  await assert.rejects(wrong.info(), error => error.code === 'PROTOCOL')

  const refused = new CodexWireClient({ baseURL: 'https://wrapper.example', apiKey: 'key' }, {
    fetch: async () => new Response(JSON.stringify({ error: { message: 'quota exhausted' } }), {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '2',
        'x-request-id': 'request-1',
      },
    }),
  })
  await assert.rejects(refused.usage(), (error) => {
    assert.equal(error.code, 'RATE_LIMIT')
    assert.equal(error.message, 'quota exhausted')
    assert.equal(error.failure.status, 429)
    assert.equal(error.failure.providerRetryAfterMs, 2000)
    assert.equal(error.failure.requestId, 'request-1')
    return true
  })
})

test('classifies transient HTTP failures separately from buffer limits and permanent errors', async () => {
  for (const [status, code] of [[503, 'PROVIDER_UNAVAILABLE'], [502, 'PROVIDER_UNAVAILABLE'],
    [504, 'PROVIDER_UNAVAILABLE'], [507, 'UPSTREAM_BUFFER_LIMIT'], [501, 'HTTP_501'],
    [401, 'AUTH'], [403, 'AUTH'], [400, 'INVALID_REQUEST'], [413, 'REQUEST_TOO_LARGE']]) {
    const client = new CodexWireClient({ baseURL: 'https://wrapper.example', apiKey: 'key' }, {
      fetch: async () => new Response('upstream unavailable', { status }),
    })
    await assert.rejects(client.responses({ model: 'model', input: [], tools: [], parallel_tool_calls: false, store: false }),
      error => error.code === code && error.failure.status === status)
  }
})

test('opens and validates a complete SSE response', async () => {
  const encoder = new TextEncoder()
  const client = new CodexWireClient({ baseURL: 'https://wrapper.example', apiKey: 'key' }, {
    fetch: async (_url, init) => {
      assert.equal(init.method, 'POST')
      assert.equal(init.headers['content-encoding'], 'zstd')
      assert.equal(JSON.parse(zstdDecompressSync(init.body).toString('utf8')).model, 'gpt-5.6-sol')
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"text_delta","text":"ok"}\n\n'))
          controller.enqueue(encoder.encode('data: {"type":"done","response_id":null,"stop_reason":"end_turn","usage":null}\n\n'))
          controller.close()
        },
      }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
    },
  })
  const events = await client.responses({
    model: 'gpt-5.6-sol', input: [], tools: [], parallel_tool_calls: false, store: false,
  })
  assert.deepEqual(await Array.fromAsync(events), [
    { type: 'text_delta', text: 'ok' },
    { type: 'done', stopReason: 'end_turn' },
  ])
})

test('cancels SSE body consumption after response headers arrive', async () => {
  const encoder = new TextEncoder()
  let cancelled = false
  const controller = new AbortController()
  const client = new CodexWireClient({ baseURL: 'https://wrapper.example', apiKey: 'key' }, {
    fetch: async () => new Response(new ReadableStream({
      start(streamController) {
        streamController.enqueue(encoder.encode('data: {"type":"text_delta","text":"partial"}\n\n'))
      },
      cancel() { cancelled = true },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  })
  const events = await client.responses({
    model: 'gpt-5.6-sol', input: [], tools: [], parallel_tool_calls: false, store: false,
  }, controller.signal)
  const iterator = events[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { done: false, value: { type: 'text_delta', text: 'partial' } })
  const pending = iterator.next()
  controller.abort(new Error('cancel test'))
  await assert.rejects(pending, error => error.code === 'ABORTED')
  assert.equal(cancelled, true)
})

test('rejects wrong media types, oversized JSON, and aborted transport without exposing the key', async () => {
  const wrongType = new CodexWireClient({ baseURL: 'https://wrapper.example', apiKey: 'secret-key' }, {
    fetch: async () => new Response('not json', { headers: { 'content-type': 'text/plain' } }),
  })
  await assert.rejects(wrongType.models(), error => error.code === 'PROTOCOL')

  const oversized = new CodexWireClient({ baseURL: 'https://wrapper.example', apiKey: 'secret-key' }, {
    fetch: async () => new Response('{}', {
      headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) },
    }),
  })
  await assert.rejects(oversized.models(), error => error.code === 'RESPONSE_TOO_LARGE')

  const controller = new AbortController()
  controller.abort('test')
  const aborted = new CodexWireClient({ baseURL: 'https://wrapper.example', apiKey: 'secret-key' }, {
    fetch: async () => { throw new Error('transport includes secret-key') },
  })
  await assert.rejects(aborted.models(controller.signal), (error) => {
    assert.equal(error.code, 'ABORTED')
    assert.doesNotMatch(error.message, /secret-key/u)
    return true
  })
})
