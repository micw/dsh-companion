import assert from 'node:assert/strict'
import test from 'node:test'
import { toTokenUsage, toVirtualAccounting, translateClaudeWireStream } from '../lib/index.js'

async function* events(values) { yield* values }
const epoch = '123e4567-e89b-12d3-a456-426614174000'
const emptyCost = { epoch, byModel: {} }
const usage = { inputNew: 2, cacheRead: 3, cacheWrite: 4, inputTotal: 9, output: 6, thinking: 5, thinkingBasis: 'reported' }

test('maps thinking progress, reported reasoning usage, and scoped virtual cost', async () => {
  const chunks = []
  for await (const chunk of translateClaudeWireStream(events([
    { type: 'started', model: 'claude-sonnet-5', reused: false },
    { type: 'thinking_progress', tokens: 40 },
    { type: 'text_delta', text: 'Hi' },
    { type: 'done', stopReason: 'end_turn', text: 'Hi', usage, cost: { totalUsd: 0.0035, scope: 'turn', coveredRequests: 2, epoch, byModel: {} } },
  ]))) chunks.push(chunk)
  const settlement = chunks.find(c => c.type === 'usage')
  assert.deepEqual(settlement.statuses, [{ kind: 'reasoning-token-progress', deltaTokens: 40, basis: 'estimated' }])
  assert.equal(settlement.usage.reasoningTokens, 5)
  assert.deepEqual(settlement.accounting, {
    scope: 'turn',
    costs: [{ kind: 'virtual', amount: { currency: 'USD', nanos: 3_500_000 }, source: 'claude-wrapper-advanced done.cost.total_usd; covered_requests=2', tariffVersion: `counter-epoch:${epoch}` }],
  })
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal('replayState' in chunks.at(-1), false)
})

test('repairs incomplete text deltas from authoritative done text', async () => {
  const chunks = []
  for await (const chunk of translateClaudeWireStream(events([
    { type: 'text_delta', text: 'Hel' },
    { type: 'done', stopReason: 'end_turn', text: 'Hello', usage: { ...usage, thinking: undefined, thinkingBasis: undefined }, cost: emptyCost },
  ]))) chunks.push(chunk)
  assert.deepEqual(chunks.filter(c => c.type === 'text-delta').map(c => c.text), ['Hel', 'lo'])
  assert.equal(chunks.find(c => c.type === 'block-end').block.text, 'Hello')
})

test('rejects terminal text that contradicts streamed text', async () => {
  await assert.rejects(async () => {
    for await (const _chunk of translateClaudeWireStream(events([
      { type: 'text_delta', text: 'wrong' },
      { type: 'done', stopReason: 'end_turn', text: 'right', usage: { ...usage, thinking: undefined, thinkingBasis: undefined }, cost: emptyCost },
    ]))) { /* drain */ }
  }, /terminal text contradicts/u)
})

test('omits estimated final reasoning usage', () => {
  assert.equal(toTokenUsage({ ...usage, thinkingBasis: 'estimated' }).reasoningTokens, undefined)
  assert.equal(toTokenUsage(usage).reasoningTokens, 5)
})

test('maps retryable and terminal failures and preserves failed accounting', async () => {
  const retryable = []
  for await (const chunk of translateClaudeWireStream(events([{
    type: 'failed', errorType: 'timeout', message: 'idle', retryable: true, cost: emptyCost,
  }]))) retryable.push(chunk)
  assert.equal(retryable.at(-1).reason.failure.code, 'TIMEOUT')

  const terminal = []
  for await (const chunk of translateClaudeWireStream(events([{
    type: 'failed', errorType: 'cli_error', message: 'bad model', upstreamStatus: 404, retryable: false,
    cost: { totalUsd: 0.1, scope: 'call', coveredRequests: 1, epoch, byModel: {} },
  }]))) terminal.push(chunk)
  assert.equal(terminal.at(-1).accounting.scope, 'call')
  assert.deepEqual(terminal.at(-1).reason.failure, { message: 'bad model', code: 'CLAUDE_WRAPPER_ERROR', status: 404 })
})

test('never emits unknown cost and keeps input_new disjoint', () => {
  assert.deepEqual(toTokenUsage({ inputNew: 2, cacheRead: 3, cacheWrite: 4, inputTotal: 9, output: 1 }), { inputTokens: 2, outputTokens: 1, totalTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 4 })
  assert.equal(toVirtualAccounting({ coveredRequests: 1, epoch, byModel: {} }), undefined)
  assert.equal(toVirtualAccounting({ totalUsd: 1, coveredRequests: 1, epoch, byModel: {} }), undefined)
})
