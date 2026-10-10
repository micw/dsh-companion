import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseCodexWireCatalog,
  parseCodexWireEvent,
  parseCodexWireSse,
  parseCodexWireUsageReport,
} from '../lib/index.js'

const model = {
  id: 'gpt-5.6-sol:long',
  model: 'gpt-5.6-sol',
  display_name: 'GPT-5.6-Sol Long',
  description: 'Long-context budget.',
  hidden: false,
  input_modalities: ['text', 'image'],
  default_context_length: 272000,
  max_context_length: 872000,
  reasoning: {
    levels: ['none', 'low', 'high'],
    default: 'provider-default-not-in-levels',
    summary_supported: true,
  },
}

test('validates the complete model identity without conflating picker and wire ids', () => {
  const catalog = parseCodexWireCatalog({ models: [model] })
  assert.deepEqual(catalog.models[0], {
    id: 'gpt-5.6-sol:long',
    model: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol Long',
    description: 'Long-context budget.',
    hidden: false,
    inputModalities: ['text', 'image'],
    defaultContextLength: 272000,
    maxContextLength: 872000,
    reasoning: {
      levels: ['none', 'low', 'high'],
      default: 'provider-default-not-in-levels',
      summarySupported: true,
    },
  })
})

test('rejects catalog duplicates and inconsistent context capacities', () => {
  assert.throws(
    () => parseCodexWireCatalog({ models: [model, model] }),
    error => error.code === 'PROTOCOL' && /duplicate id/u.test(error.message),
  )
  assert.throws(
    () => parseCodexWireCatalog({
      models: [{ ...model, default_context_length: 100, max_context_length: 99 }],
    }),
    error => error.code === 'PROTOCOL' && /below default_context_length/u.test(error.message),
  )
})

test('retains optional usage and account values without inventing nulls', () => {
  const event = parseCodexWireEvent({
    type: 'done',
    response_id: null,
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 120,
      output_tokens: 20,
      cached_input_tokens: 100,
      cache_write_input_tokens: null,
      reasoning_output_tokens: 7,
      total_tokens: 140,
    },
  })
  assert.deepEqual(event, {
    type: 'done',
    stopReason: 'end_turn',
    usage: {
      inputTokens: 120,
      outputTokens: 20,
      cachedInputTokens: 100,
      reasoningOutputTokens: 7,
      totalTokens: 140,
    },
  })

  assert.deepEqual(parseCodexWireUsageReport({
    account: {
      plan: { id: 'prolite', name: 'Pro Lite' },
      credits: {
        has_credits: false,
        unlimited: false,
        balance: '0',
        overage_limit_reached: null,
        approx_cloud_messages: { remaining: 3 },
        approx_local_messages: null,
      },
      spend_control: null,
      reset_credits: { available: false },
    },
    limits: {
      active_group: null,
      groups: [{
        id: 'global',
        name: null,
        reached: false,
        primary: {
          used_percent: 1,
          window_seconds: 604800,
          resets_at: 1788457743,
          resets_in_seconds: 591075,
        },
        secondary: null,
      }],
    },
    promo: null,
  }), {
    account: {
      plan: { id: 'prolite', name: 'Pro Lite' },
      credits: {
        hasCredits: false,
        unlimited: false,
        balance: '0',
        approxCloudMessages: { remaining: 3 },
      },
      resetCredits: { available: false },
    },
    limits: {
      groups: [{
        id: 'global',
        reached: false,
        primary: {
          usedPercent: 1,
          windowSeconds: 604800,
          resetsAt: 1788457743,
          resetsInSeconds: 591075,
        },
      }],
    },
  })
})

test('preserves opaque reasoning replay and raw tool arguments', () => {
  const item = { type: 'reasoning', encrypted_content: 'opaque', nested: [1, true] }
  assert.deepEqual(parseCodexWireEvent({ type: 'reasoning', item, summary: ['first', 'second'] }), {
    type: 'reasoning', item, summary: ['first', 'second'],
  })
  assert.deepEqual(parseCodexWireEvent({
    type: 'tool_call', call_id: 'call-1', name: 'broken_json', arguments: '{',
  }), {
    type: 'tool_call', callId: 'call-1', name: 'broken_json', arguments: '{',
  })
})

test('parses split SSE frames, ignores comments, and settles only at clean EOF', async () => {
  const comments = []
  const stream = byteStream([
    ': keep-',
    'alive\n\ndata: {"type":"text_delta","text":"hel',
    'lo"}\n\ndata: {"type":"done","response_id":"resp_1","stop_reason":"end_turn","usage":null}\n\n',
  ])
  const events = await Array.fromAsync(parseCodexWireSse(stream, comment => comments.push(comment)))
  assert.deepEqual(comments, ['keep-alive'])
  assert.deepEqual(events, [
    { type: 'text_delta', text: 'hello' },
    { type: 'done', responseId: 'resp_1', stopReason: 'end_turn' },
  ])
})

test('rejects truncated streams and events after settlement', async () => {
  await assert.rejects(
    Array.fromAsync(parseCodexWireSse(byteStream([
      'data: {"type":"text_delta","text":"partial"}\n\n',
    ]))),
    error => error.code === 'STREAM_CLOSED',
  )
  await assert.rejects(
    Array.fromAsync(parseCodexWireSse(byteStream([
      'data: {"type":"done","response_id":null,"stop_reason":"end_turn","usage":null}\n\n',
      'data: {"type":"text_delta","text":"late"}\n\n',
    ]))),
    error => error.code === 'PROTOCOL' && /continued after/u.test(error.message),
  )
})

test('classifies a broken body after partial output as transport without exposing its cause', async () => {
  let source
  const stream = new ReadableStream({ start(controller) { source = controller } })
  const iterator = parseCodexWireSse(stream)[Symbol.asyncIterator]()
  source.enqueue(new TextEncoder().encode('data: {"type":"text_delta","text":"partial"}\n\n'))
  assert.deepEqual(await iterator.next(), { done: false, value: { type: 'text_delta', text: 'partial' } })
  source.error(new TypeError('socket failed with secret-key'))
  await assert.rejects(iterator.next(), error => error.code === 'TRANSPORT' && !error.message.includes('secret-key'))
})

function byteStream(parts) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}
