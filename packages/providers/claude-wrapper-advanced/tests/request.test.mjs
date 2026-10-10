import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeClaudeWireRequest } from '../lib/index.js'
test('serializes chat messages, tools, images, and effort', async () => {
  const body = await serializeClaudeWireRequest({ provider: 'claude-wrapper-advanced', model: 'sonnet-5', reasoningEffort: 'high', sessionId: 'session-1', turnId: 'session-1:7', messages: [
    { role: 'system', content: [{ type: 'text', text: 'system' }] },
    { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', attachment: { id: 'image' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool-call', id: 'call-1', name: 'weather', arguments: '{"city":"B"}' }] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'sunny' }] },
  ], tools: [{ name: 'weather', description: 'Weather', parameters: { type: 'object' } }] }, { wireModel: 'claude-sonnet-5', imageUrl: async () => 'data:image/png;base64,AA==' })
  assert.equal(body.model, 'claude-sonnet-5'); assert.equal(body.reasoning_effort, 'high'); assert.equal(body.session_id, 'session-1'); assert.equal(body.cost_scope_id, 'session-1:7')
  assert.equal(body.messages[1].content[1].type, 'image_url')
  assert.equal(body.messages[2].tool_calls[0].function.name, 'weather')
  assert.equal(body.messages[3].role, 'tool')
  assert.equal(body.tools[0].function.name, 'weather')
})

test('passes image-bearing tool results to the wrapper without changing text-only results', async () => {
  const image = { mediaType: 'image/png' }
  const seen = []
  const signal = new AbortController().signal
  const body = await serializeClaudeWireRequest({
    provider: 'claude-wrapper-advanced', model: 'sonnet-5', signal,
    messages: [
      { role: 'tool', toolCallId: 'plain', content: [{ type: 'text', text: 'plain result' }] },
      { role: 'tool', toolCallId: 'image', content: [
        { type: 'text', text: 'Screenshot' },
        { type: 'image', attachment: image },
        { type: 'text', text: 'End of result' },
      ] },
    ],
  }, { wireModel: 'sonnet-5', imageUrl: async (ref, receivedSignal) => {
    seen.push([ref, receivedSignal])
    return 'data:image/png;base64,AA=='
  } })
  assert.deepEqual(body.messages, [
    { role: 'tool', tool_call_id: 'plain', content: 'plain result' },
    { role: 'tool', tool_call_id: 'image', content: [
      { type: 'text', text: 'Screenshot' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      { type: 'text', text: 'End of result' },
    ] },
  ])
  assert.deepEqual(seen, [[image, signal]])
})

test('does not treat assistant-only blocks in tool results as ordinary text', async () => {
  await assert.rejects(serializeClaudeWireRequest({
    provider: 'claude-wrapper-advanced', model: 'sonnet-5',
    messages: [{ role: 'tool', toolCallId: 'call', content: [{ type: 'reasoning', text: 'private' }] }],
  }, { wireModel: 'sonnet-5', imageUrl: async () => '' }), error => error.code === 'UNSUPPORTED_CONTENT')
})

test('rejects unsupported controls outside compaction', async () => {
  const base = { provider: 'claude-wrapper-advanced', model: 'opus-4-8', messages: [] }
  const options = { wireModel: 'opus-4-8', imageUrl: async () => '' }
  await assert.rejects(serializeClaudeWireRequest({ ...base, temperature: 0 }, options), error => error.code === 'UNSUPPORTED_OPTION' && /temperature/u.test(error.message))
  await assert.rejects(serializeClaudeWireRequest({ ...base, maxTokens: 8192 }, options), error => error.code === 'UNSUPPORTED_OPTION' && /maxTokens/u.test(error.message))
  await assert.rejects(serializeClaudeWireRequest({ ...base, stop: ['END'] }, options), error => error.code === 'UNSUPPORTED_OPTION' && /stop/u.test(error.message))
})

test('admits an auxiliary DSH title request without forwarding its unsupported output cap', async () => {
  const body = await serializeClaudeWireRequest({
    provider: 'claude-wrapper-advanced', model: 'opus-4-8', purpose: 'session-title', maxTokens: 64,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Give this session a short title.' }] }],
  }, { wireModel: 'opus-4-8', imageUrl: async () => '' })
  assert.equal('max_tokens' in body, false)
  assert.equal(body.messages[0].content[0].text, 'Give this session a short title.')
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
