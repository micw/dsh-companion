import assert from 'node:assert/strict'
import test from 'node:test'
import { toTokenUsage, translateCodexWireStream } from '../lib/index.js'

test('translates reasoning parts, text, tools, usage, limits, and replay metadata', async () => {
  const reasoningItem = { type: 'reasoning', encrypted_content: 'opaque' }
  const limits = {
    account: { plan: { id: 'plus', name: 'Plus' } },
    limits: { activeGroup: 'global', groups: [] },
  }
  const observed = []
  const chunks = await Array.fromAsync(translateCodexWireStream(events([
    { type: 'started', model: 'server-routed-model' },
    { type: 'thinking_delta', text: 'First' },
    { type: 'thinking_break' },
    { type: 'thinking_delta', text: 'Second' },
    { type: 'reasoning', item: reasoningItem, summary: ['First', 'Second'] },
    { type: 'text_delta', text: 'Answer' },
    { type: 'tool_call', callId: 'call-1', name: 'read', arguments: '{"path":"a"}' },
    { type: 'rate_limits', value: limits },
    {
      type: 'done',
      responseId: 'resp-1',
      stopReason: 'end_turn',
      usage: {
        inputTokens: 120,
        outputTokens: 20,
        cachedInputTokens: 100,
        cacheWriteInputTokens: 0,
        reasoningOutputTokens: 7,
        totalTokens: 140,
      },
    },
  ]), { limits: value => observed.push(value) }))

  assert.deepEqual(observed, [limits])
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'First' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'First' } },
    { type: 'block-start', index: 1, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 1, text: 'Second' },
    { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'Second' } },
    { type: 'block-start', index: 2, blockType: 'text' },
    { type: 'text-delta', index: 2, text: 'Answer' },
    { type: 'block-end', index: 2, block: { type: 'text', text: 'Answer' } },
    { type: 'block-start', index: 3, blockType: 'tool-call' },
    {
      type: 'tool-call-delta', index: 3, id: 'call-1', name: 'read', argumentsDelta: '{"path":"a"}',
    },
    {
      type: 'block-end', index: 3,
      block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' },
    },
    {
      type: 'usage',
      usage: {
        inputTokens: 20,
        outputTokens: 20,
        totalTokens: 140,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
        reasoningTokens: 7,
      },
    },
    {
      type: 'finish',
      reason: { kind: 'tool-calls' },
      replayState: {
        response: { version: 1, responseId: 'resp-1', actualModel: 'server-routed-model' },
        blocks: [{ reasoningItem }, null, null, null],
      },
    },
  ])
})

test('maps a clean wrapper abort to max-tokens and a normal completion to stop', async () => {
  assert.deepEqual(await Array.fromAsync(translateCodexWireStream(events([
    { type: 'done', stopReason: 'aborted' },
  ]))), [{
    type: 'finish',
    reason: { kind: 'max-tokens' },
    replayState: { response: { version: 1 }, blocks: [] },
  }])
  assert.deepEqual(await Array.fromAsync(translateCodexWireStream(events([
    { type: 'done', stopReason: 'end_turn' },
  ]))), [{
    type: 'finish',
    reason: { kind: 'stop' },
    replayState: { response: { version: 1 }, blocks: [] },
  }])
})

test('settles in-band failures after closing partial output', async () => {
  const chunks = await Array.fromAsync(translateCodexWireStream(events([
    { type: 'text_delta', text: 'partial' },
    { type: 'failed', message: 'temporarily unavailable', retryable: true },
  ])))
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
    {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'temporarily unavailable', code: 'PROVIDER_UNAVAILABLE' },
      },
    },
  ])
})

test('omits incomplete or inconsistent token accounting', () => {
  assert.equal(toTokenUsage(undefined), undefined)
  assert.equal(toTokenUsage({ inputTokens: 10, outputTokens: 2 }), undefined)
  assert.equal(toTokenUsage({
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 11,
    cacheWriteInputTokens: 0,
  }), undefined)
  assert.equal(toTokenUsage({
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 99,
  }), undefined)
  assert.equal(toTokenUsage({
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 3,
  }), undefined)
})

async function* events(items) {
  yield* items
}
