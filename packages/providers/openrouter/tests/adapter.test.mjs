import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  OpenRouterAdapter,
  OpenRouterCatalogGeneration,
  decodeOpenRouterCatalog,
} from '../lib/index.js'
import { catalogPayload } from './fixture.mjs'

const LIMITS = {
  streamIdleTimeoutMs: 5_000,
  maxRequestImageBytes: 20 * 1024 * 1024,
  requestImagePixelBudget: 2048 * 2048,
  requestImageMaxBytes: 1024 * 1024,
}
const TEXT = [{
  role: 'user',
  content: [{ type: 'text', text: 'Hello' }],
}]

function adapter(generation, provider = 'openrouter') {
  return new OpenRouterAdapter({
    provider,
    generation: async signal => {
      signal?.throwIfAborted()
      return generation
    },
    apiKey: async () => 'test-key',
    limits: () => LIMITS,
  })
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

async function mockServer(behaviors) {
  const requests = []
  const headers = []
  let responseClosedResolve
  const responseClosed = new Promise(resolve => { responseClosedResolve = resolve })
  const server = createServer((request, response) => {
    response.on('close', responseClosedResolve)
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push(JSON.parse(body))
      headers.push(request.headers)
      const behavior = behaviors.shift()
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      let index = 0
      const write = () => {
        if (response.destroyed) return
        const event = behavior?.events[index++]
        if (event === undefined) { response.end(); return }
        response.write(`data: ${event}\n\n`)
        if (behavior.delayMs === undefined) write()
        else setTimeout(write, behavior.delayMs)
      }
      write()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    headers,
    responseClosed,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

const textEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"cost":0.000125}}',
  '[DONE]',
]

const reasoningToolEvents = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"reasoning":"checking"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"weather","arguments":"{\\"city\\":\\"B\\"}"}}]},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"cost":0.0003}}',
  '[DONE]',
]

test('reuses PiAiAdapter for a complete text stream', async (t) => {
  const server = await mockServer([{ events: textEvents }])
  t.after(() => server.close())
  const generation = new OpenRouterCatalogGeneration(decodeOpenRouterCatalog(catalogPayload()), 'openrouter', server.url)
  const chunks = await collect(adapter(generation).stream({
    provider: 'openrouter', model: 'acme/reasoner', messages: TEXT,
  }))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hello'))
  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.deepEqual(usage.accounting, {
    scope: 'call',
    costs: [{
      kind: 'reported',
      amount: { currency: 'USD', nanos: 125_000 },
      source: 'openrouter-response',
    }],
  })
  assert.ok(chunks.findIndex(chunk => chunk.type === 'usage') < chunks.findIndex(chunk => chunk.type === 'finish'))
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(server.headers[0]?.authorization, 'Bearer test-key')
})

test('streams through the exact configured instance route', async (t) => {
  const server = await mockServer([{ events: textEvents }])
  t.after(() => server.close())
  const provider = 'openrouter-instance-1'
  const generation = new OpenRouterCatalogGeneration(decodeOpenRouterCatalog(catalogPayload()), provider, server.url)
  const chunks = await collect(adapter(generation, provider).stream({
    provider, model: 'acme/reasoner', messages: TEXT,
  }))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'hello'))
  assert.equal(generation.model('acme/reasoner').provider, provider)
  assert.equal(server.requests.length, 1)
})

test('one model without reasoning efforts does not hide other OpenRouter models', async () => {
  const source = catalogPayload()
  const incomplete = structuredClone(source.data[0])
  incomplete.id = 'apodex/apodex-1.1-mini:free'
  incomplete.reasoning.supported_efforts = []
  delete incomplete.reasoning.default_effort
  source.data.push(incomplete)
  source.total_count = 2
  const generation = new OpenRouterCatalogGeneration(decodeOpenRouterCatalog(source), 'openrouter')
  const route = adapter(generation)
  assert.deepEqual((await route.listModels('openrouter')).map(model => model.id), [
    'acme/reasoner', 'apodex/apodex-1.1-mini:free',
  ])
  assert.equal((await route.resolveModel('openrouter', incomplete.id)).reasoning, undefined)
  assert.ok((await route.resolveModel('openrouter', 'acme/reasoner')).reasoning)
})

test('reuses PiAiAdapter for reasoning and a tool call', async (t) => {
  const server = await mockServer([{ events: reasoningToolEvents }])
  t.after(() => server.close())
  const generation = new OpenRouterCatalogGeneration(decodeOpenRouterCatalog(catalogPayload()), 'openrouter', server.url)
  const chunks = await collect(adapter(generation).stream({
    provider: 'openrouter',
    model: 'acme/reasoner',
    reasoningEffort: 'high',
    messages: TEXT,
    tools: [{
      name: 'weather',
      description: 'Read weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }],
  }))
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'checking'))
  assert.ok(chunks.some(chunk => chunk.type === 'tool-call-delta' && chunk.name === 'weather'))
  assert.deepEqual(server.requests[0].reasoning, { effort: 'high' })
  assert.equal(server.requests[0].tools[0].function.name, 'weather')
})

test('forwards cancellation through PiAiAdapter to the active request', async (t) => {
  const server = await mockServer([{ events: textEvents, delayMs: 100 }])
  t.after(() => server.close())
  const generation = new OpenRouterCatalogGeneration(decodeOpenRouterCatalog(catalogPayload()), 'openrouter', server.url)
  const controller = new AbortController()
  const operation = collect(adapter(generation).stream({
    provider: 'openrouter', model: 'acme/reasoner', messages: TEXT, signal: controller.signal,
  }))
  setTimeout(() => controller.abort('test cancellation'), 20)
  const chunks = await operation
  assert.equal(chunks.at(-1)?.type, 'finish')
  assert.equal(chunks.at(-1)?.reason.kind, 'aborted')
  await server.responseClosed
})
