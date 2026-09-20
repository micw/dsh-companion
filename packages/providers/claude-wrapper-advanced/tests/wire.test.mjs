import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { parseClaudeWireCatalog, parseClaudeWireEvent, parseClaudeWireServiceInfo, parseClaudeWireSse, parseClaudeWireUsageReport } from '../lib/index.js'

const catalog = JSON.parse(await readFile(new URL('./fixtures/catalog.json', import.meta.url)))
const doneFixture = JSON.parse(await readFile(new URL('./fixtures/done.json', import.meta.url)))
test('strictly validates info and catalog', () => {
  assert.deepEqual(parseClaudeWireServiceInfo({ service: 'claude-wrapper-advanced', version: '1.7.0' }), { service: 'claude-wrapper-advanced', version: '1.7.0' })
  assert.equal(parseClaudeWireCatalog(catalog).models[0].backendModel, 'claude-sonnet-5')
  assert.throws(() => parseClaudeWireCatalog({ ...catalog, extra: true }), /fields must be exactly/u)
})
test('validates usage groups and response cost/status events', () => {
  assert.equal(parseClaudeWireUsageReport({ groups: [{ id: 'global', upstream_id: null, scope: null, observed_at: 10, age_seconds: 1, windows: [{ id: 'five_hour', upstream_id: '5h', used_percent: 12, window_seconds: 18000, resets_at: 20 }] }] }).groups[0].windows[0].usedPercent, 12)
  assert.deepEqual(parseClaudeWireUsageReport({ groups: [{ id: 'model:fable-5', upstream_id: '7d_oi', scope: {}, observed_at: null, age_seconds: null, windows: [{ id: 'seven_day', upstream_id: '7d_oi', used_percent: null, window_seconds: 604800, resets_at: null }] }] }).groups[0].windows, [])
  assert.throws(() => parseClaudeWireUsageReport({ groups: [{ id: 'bad', upstream_id: null, scope: null, observed_at: null, age_seconds: null, windows: [{ id: 'seven_day', upstream_id: '7d', used_percent: null, window_seconds: 604800, resets_at: 20 }] }] }), /must not report resets_at/u)
  assert.deepEqual(parseClaudeWireEvent({ type: 'thinking_progress', tokens: 42 }), { type: 'thinking_progress', tokens: 42 })
  assert.deepEqual(parseClaudeWireEvent({
    type: 'limit_status', window: null, claim: '7d', status: 'rejected', resets_at: 20,
    surpassed_threshold: null, overage: {}, usage_stale: true,
  }), { type: 'limit_status', claim: '7d', status: 'rejected', resetsAt: 20, usageStale: true })
  const done = parseClaudeWireEvent(doneFixture)
  assert.equal(parseClaudeWireEvent({ ...doneFixture, usage: { ...doneFixture.usage, output: 2, thinking: 5 } }).type, 'done')
  assert.equal(done.type, 'done'); assert.equal(done.cost.scope, 'turn'); assert.equal(done.usage.thinking, 5); assert.equal(done.usage.thinkingBasis, 'reported')
  assert.throws(() => parseClaudeWireEvent({ ...doneFixture, cost: { ...doneFixture.cost, covered_requests: null } }), /turn cost must cover/u)
  assert.throws(() => parseClaudeWireEvent({ ...doneFixture, cost: { ...doneFixture.cost, scope: 'call', covered_requests: 2 } }), /call cost must cover/u)
  assert.throws(() => parseClaudeWireEvent({ ...doneFixture, cost: { ...doneFixture.cost, scope: null, covered_requests: 1 } }), /unscoped cost/u)
  assert.throws(() => parseClaudeWireEvent({ type: 'done', stop_reason: 'end_turn', text: '', usage: { input_new: 2, cache_read: 3, cache_write: 4, input_total: 99, output: 1, thinking: null, thinking_basis: null, cache_write_5m: null, cache_write_1h: null, service_tier: null }, cost: { total_usd: null, scope: null, covered_requests: null, epoch: '123e4567-e89b-12d3-a456-426614174001', by_model: {} }, timing: {} }), /input_total/u)
})
test('parses split SSE frames and rejects malformed data', async () => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: {"type":"thinking_')); controller.enqueue(encoder.encode('progress","tokens":5}\n\ndata: {"type":"failed","error_type":"test","message":"stop","upstream_status":null,"retryable":false,"cost":{"total_usd":null,"by_model":{},"scope":null,"covered_requests":null,"epoch":"123e4567-e89b-12d3-a456-426614174001"}}\n\n')); controller.close() } })
  const values = []
  for await (const event of parseClaudeWireSse(stream)) values.push(event)
  assert.deepEqual(values, [{ type: 'thinking_progress', tokens: 5 }, { type: 'failed', errorType: 'test', message: 'stop', retryable: false, cost: { epoch: '123e4567-e89b-12d3-a456-426614174001', byModel: {} } }])
  const bad = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('data: nope\n\n')); controller.close() } })
  await assert.rejects(async () => { for await (const _event of parseClaudeWireSse(bad)) {} }, /JSON/u)
})
