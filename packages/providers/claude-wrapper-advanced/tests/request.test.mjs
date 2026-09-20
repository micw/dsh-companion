import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeClaudeWireRequest } from '../lib/index.js'
test('serializes chat messages, tools, images, and effort', async () => {
  const body = await serializeClaudeWireRequest({ provider: 'claude-wrapper-advanced', model: 'sonnet-5', reasoningEffort: 'high', sessionId: 'session-1', turnId: 'session-1:7', messages: [
    { role: 'system', content: [{ type: 'text', text: 'system' }] },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { id: 'image' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool-call', id: 'call-1', name: 'weather', arguments: '{"city":"B"}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'sunny' }] }] },
  ], tools: [{ name: 'weather', description: 'Weather', parameters: { type: 'object' } }] }, { wireModel: 'claude-sonnet-5', imageUrl: async () => 'data:image/png;base64,AA==' })
  assert.equal(body.model, 'claude-sonnet-5'); assert.equal(body.reasoning_effort, 'high'); assert.equal(body.session_id, 'session-1'); assert.equal(body.cost_scope_id, 'session-1:7')
  assert.equal(body.messages[1].content[1].type, 'image_url')
  assert.equal(body.messages[2].tool_calls[0].function.name, 'weather')
  assert.equal(body.messages[3].role, 'tool')
  assert.equal(body.tools[0].function.name, 'weather')
})

test('rejects unsupported controls outside compaction', async () => {
  const base = { provider: 'claude-wrapper-advanced', model: 'opus-4-8', messages: [] }
  const options = { wireModel: 'opus-4-8', imageUrl: async () => '' }
  await assert.rejects(serializeClaudeWireRequest({ ...base, temperature: 0 }, options), error => error.code === 'UNSUPPORTED_OPTION' && /temperature/u.test(error.message))
  await assert.rejects(serializeClaudeWireRequest({ ...base, maxTokens: 8192 }, options), error => error.code === 'UNSUPPORTED_OPTION' && /maxTokens/u.test(error.message))
  await assert.rejects(serializeClaudeWireRequest({ ...base, stop: ['END'] }, options), error => error.code === 'UNSUPPORTED_OPTION' && /stop/u.test(error.message))
})

test('admits DSH compaction when the backend cannot enforce its output cap', async () => {
  const body = await serializeClaudeWireRequest({
    provider: 'claude-wrapper-advanced',
    model: 'opus-4-8',
    purpose: 'compaction',
    maxTokens: 8192,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarize this session.' }] }],
  }, { wireModel: 'opus-4-8', imageUrl: async () => '' })
  assert.equal('maxTokens' in body, false)
  assert.equal('max_tokens' in body, false)
  assert.equal(body.messages[0].content[0].text, 'Summarize this session.')
})
