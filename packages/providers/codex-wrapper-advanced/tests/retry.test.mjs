import assert from 'node:assert/strict'
import test from 'node:test'
import { zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, expandAssistantStream, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '../../../../../deepseek-harness/packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../../../deepseek-harness/packages/session/session-projection/lib/index.js'
import SystemPrompt from '../../../../../deepseek-harness/packages/core/system-prompt/lib/index.js'
import ToolRuntime, { defineContentToolFixture } from '../../../../../deepseek-harness/packages/core/tools/lib/index.js'
import AgentRegistry from '../../../../../deepseek-harness/packages/core/agent/lib/index.js'
import AgentLoop from '../../../../../deepseek-harness/packages/core/agent-loop/lib/index.js'
import * as retry from '../../../../../deepseek-harness/packages/llm/llm-retry/lib/index.js'
import {
  CODEX_WRAPPER_ADVANCED_PROVIDER, CodexCatalogGeneration, CodexWireClient,
  CodexWrapperAdvancedAdapter, parseCodexWireCatalog,
} from '../lib/index.js'

const done = { type: 'done', stop_reason: 'end_turn' }
const failure = { type: 'failed', message: 'upstream temporarily unavailable', retryable: true }
const tool = (callId, name) => ({ type: 'tool_call', call_id: callId, name, arguments: '{}' })

function response(events) {
  if (events instanceof Response) return events
  if (events instanceof Error) {
    return new Response(new ReadableStream({
      pull(controller) { controller.error(events) },
    }), { headers: { 'content-type': 'text/event-stream' } })
  }
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function harness(t, script, { maxRetries = 3, delayMs = 1 } = {}) {
  const requests = []
  const client = new CodexWireClient({ baseURL: 'https://wrapper.example', apiKey: 'test-key' }, {
    fetch: async (_url, init) => {
      requests.push(JSON.parse(zstdDecompressSync(init.body).toString('utf8')))
      const events = script.shift()
      assert.ok(events, 'unexpected additional wrapper request')
      return response(events)
    },
  })
  const catalog = new CodexCatalogGeneration(parseCodexWireCatalog({ models: [{
    id: 'model', model: 'model', display_name: 'Model', description: null, hidden: false,
    input_modalities: ['text'], default_context_length: 10000, max_context_length: 10000,
    reasoning: { levels: ['low'], default: 'low', summary_supported: true },
  }] }))
  const policy = resolveRetryPolicy({ mode: 'normal', maxRetries,
    retryableCodes: ['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'PROVIDER_UNAVAILABLE', 'STREAM_CLOSED'],
    backoff: { initialDelayMs: delayMs, maxDelayMs: delayMs, jitterRatio: 0 },
  })
  const adapter = new CodexWrapperAdvancedAdapter({
    generation: async () => ({ client, catalog }), retryPolicy: () => policy,
    imageUrl: async () => { throw new Error('unexpected image') },
  })
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose() })
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry, retry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter([CODEX_WRAPPER_ADVANCED_PROVIDER], adapter)
  const agent = await ctx.agentLoop.create(SessionId(t.name), {
    provider: CODEX_WRAPPER_ADVANCED_PROVIDER, model: 'model',
  })
  return { ctx, agent, requests }
}

function start(agent) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
}

function retryEvents(agent) {
  return agent.session.snapshotEvents().filter(event => event.type === 'llm/retry')
}

test('retries only the failed Codex step, retaining prior tool results and discarding partial text and complete tool calls', { timeout: 10000 }, async t => {
  const { ctx, agent, requests } = await harness(t, [
    [tool('prior-call', 'prior'), done],
    [{ type: 'text_delta', text: 'discarded partial output' }, tool('discarded-call', 'danger'), failure],
    [{ type: 'text_delta', text: 'recovered' }, done],
  ])
  const executions = { prior: 0, danger: 0 }
  for (const name of Object.keys(executions)) {
    ctx.tools.register(defineContentToolFixture({ name, description: name, parameters: {},
      async execute() {
        executions[name] += 1
        return [{ type: 'text', text: 'retained prior result' }]
      },
    }))
  }
  start(agent)
  await agent.whenIdle()
  assert.equal(requests.length, 3)
  assert.deepEqual(executions, { prior: 1, danger: 0 })
  assert.deepEqual(requests[2].input, requests[1].input)
  const retryInput = JSON.stringify(requests[2].input)
  assert.ok(retryInput.includes('retained prior result'))
  assert.ok(retryInput.includes('prior-call'))
  assert.ok(!retryInput.includes('discarded partial output'))
  assert.ok(!retryInput.includes('discarded-call'))
  assert.equal(retryEvents(agent).length, 1)
  assert.equal(retryEvents(agent)[0].data.step, 2)
  const attempts = agent.session.snapshotEvents().filter(event => event.type === 'assistant/attempt')
  const discarded = attempts.flatMap(event => expandAssistantStream(event.data.stream)).map(record => record.chunk)
  assert.ok(discarded.some(chunk => chunk.type === 'text-delta' && chunk.text === 'discarded partial output'))
  assert.ok(discarded.some(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.id === 'discarded-call'))
  assert.deepEqual(agent.session.deriveMessages().at(-1).content, [{ type: 'text', text: 'recovered' }])
  assert.deepEqual(agent.session.snapshotEvents().filter(event => event.type === 'step/start').map(event => event.data.step), [1, 2])
})

test('recovers from a truncated Codex SSE stream through the actual retry plugin', { timeout: 10000 }, async t => {
  const { agent, requests } = await harness(t, [
    [{ type: 'text_delta', text: 'truncated partial output' }],
    [{ type: 'text_delta', text: 'recovered' }, done],
  ])
  start(agent)
  await agent.whenIdle()
  assert.equal(requests.length, 2)
  assert.equal(retryEvents(agent)[0].data.failure.code, 'STREAM_CLOSED')
  assert.deepEqual(requests[1].input, requests[0].input)
  assert.deepEqual(agent.session.deriveMessages().at(-1).content, [{ type: 'text', text: 'recovered' }])
})

test('recovers from a thrown Codex SSE body transport error', { timeout: 10000 }, async t => {
  const { agent, requests } = await harness(t, [
    new TypeError('network body interrupted'),
    [{ type: 'text_delta', text: 'recovered' }, done],
  ])
  start(agent)
  await agent.whenIdle()
  assert.equal(requests.length, 2)
  assert.equal(retryEvents(agent)[0].data.failure.code, 'TRANSPORT')
  assert.deepEqual(requests[1].input, requests[0].input)
  assert.deepEqual(agent.session.deriveMessages().at(-1).content, [{ type: 'text', text: 'recovered' }])
})

for (const [label, failedResponse, code] of [
  ['legacy transport failure', [{ type: 'failed', retryable: false,
    message: 'stream error: Transport error: network error: error decoding response body' }], 'TRANSPORT'],
  ['HTTP 503', new Response('temporarily unavailable', { status: 503 }), 'PROVIDER_UNAVAILABLE'],
]) {
  test(`recovers from Codex ${label}`, { timeout: 10000 }, async t => {
    const { agent, requests } = await harness(t, [failedResponse, [{ type: 'text_delta', text: 'recovered' }, done]])
    start(agent)
    await agent.whenIdle()
    assert.equal(requests.length, 2)
    assert.equal(retryEvents(agent)[0].data.failure.code, code)
    assert.deepEqual(requests[1].input, requests[0].input)
    assert.deepEqual(agent.session.deriveMessages().at(-1).content, [{ type: 'text', text: 'recovered' }])
  })
}

for (const [label, failedResponse] of [
  ['authentication', new Response('unauthorized', { status: 401 })],
  ['upstream retry buffer limit', new Response('buffer limit', { status: 507 })],
  ['invalid SSE protocol', new Response('data: invalid-json\n\n', { headers: { 'content-type': 'text/event-stream' } })],
  ['permanent provider failure', [{ type: 'failed', message: 'invalid model', retryable: false }]],
]) {
  test(`does not retry Codex ${label}`, { timeout: 10000 }, async t => {
    const { agent, requests } = await harness(t, [failedResponse])
    start(agent)
    await agent.whenIdle()
    assert.equal(requests.length, 1)
    assert.equal(retryEvents(agent).length, 0)
    assert.equal(agent.session.snapshotEvents().at(-1).data.reason.kind, 'error')
  })
}

test('stops retrying Codex after the configured retry budget', { timeout: 10000 }, async t => {
  const { agent, requests } = await harness(t, [[failure], [failure], [failure]], { maxRetries: 2 })
  start(agent)
  await agent.whenIdle()
  assert.equal(requests.length, 3)
  assert.deepEqual(retryEvents(agent).map(event => event.data.retry), [1, 2])
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'error'))
})

test('cancels Codex retry backoff without making another wrapper request', { timeout: 10000 }, async t => {
  const { ctx, agent, requests } = await harness(t, [[failure]], { delayMs: 1000 })
  const scheduled = new Promise(resolve => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/retry') {
        dispose()
        resolve(event)
      }
    })
  })
  start(agent)
  await scheduled
  agent.cancel({ kind: 'user' })
  await agent.whenIdle()
  assert.equal(requests.length, 1)
  assert.equal(retryEvents(agent).length, 1)
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'aborted'))
})
