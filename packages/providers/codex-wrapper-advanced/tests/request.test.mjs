import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeCodexWireRequest } from '../lib/index.js'

const base = {
  provider: 'codex-wrapper-advanced',
  model: 'gpt-5.6-sol:long',
  reasoningEffort: 'high',
  tools: [{ name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } }],
  sessionId: 'session-1',
}

const imageUrl = async attachment => `data:${attachment.mediaType};base64,${attachment.id}`

test('serializes instructions, multimodal user input, non-strict tools, and stable session routing', async () => {
  const request = await serializeCodexWireRequest({
    ...base,
    messages: [
      message('system', [{ type: 'text', text: 'System instructions.' }], { kind: 'plugin', plugin: 'system' }),
      message('user', [
        { type: 'text', text: 'Inspect this.' },
        { type: 'image', attachment: { id: 'image-data', mediaType: 'image/png' } },
      ], { kind: 'user' }),
    ],
  }, { wireModel: 'gpt-5.6-sol', imageUrl })

  assert.deepEqual(request, {
    model: 'gpt-5.6-sol',
    input: [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Inspect this.' },
        { type: 'input_image', image_url: 'data:image/png;base64,image-data' },
      ],
    }],
    instructions: 'System instructions.',
    tools: [{
      type: 'function',
      strict: false,
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object' },
    }],
    effort: 'high',
    parallel_tool_calls: true,
    store: false,
    session_id: 'session-1',
  })
})

test('replays opaque reasoning in block order and preserves raw tool arguments', async () => {
  const reasoningItem = {
    type: 'reasoning',
    id: 'reasoning-1',
    encrypted_content: 'opaque',
    summary: [{ type: 'summary_text', text: 'Checked.' }],
  }
  const request = await serializeCodexWireRequest({
    ...base,
    messages: [
      message('assistant', [
        { type: 'reasoning', text: 'Checked.' },
        { type: 'text', text: 'Calling ' },
        { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' },
        { type: 'text', text: 'after call' },
      ], {
        kind: 'model',
        provider: 'codex-wrapper-advanced',
        model: 'gpt-5.6-sol',
        replayState: {
          response: { version: 1, responseId: 'resp-1' },
          blocks: [{ reasoningItem }, null, null, null],
        },
      }),
      message('user', [{
        type: 'tool-result',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'file body' }],
      }], { kind: 'tool', callId: 'call-1' }),
    ],
  }, { wireModel: 'gpt-5.6-sol', imageUrl })

  assert.deepEqual(request.input, [
    reasoningItem,
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Calling ' }] },
    { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after call' }] },
    { type: 'function_call_output', call_id: 'call-1', output: 'file body' },
  ])
})

test('drops unusable replay metadata instead of sending unvalidated opaque data', async () => {
  const request = await serializeCodexWireRequest({
    ...base,
    messages: [message('assistant', [
      { type: 'reasoning', text: 'Not replayable.' },
      { type: 'text', text: 'Visible answer.' },
    ], {
      kind: 'model',
      provider: 'codex-wrapper-advanced',
      model: 'gpt-5.6-sol',
      replayState: { response: { version: 99 }, blocks: [{ reasoningItem: 'not-an-object' }, null] },
    })],
  }, { wireModel: 'gpt-5.6-sol', imageUrl })
  assert.deepEqual(request.input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible answer.' }] },
  ])
})

test('preserves assistant blocks embedded in synthetic user input as inert text', async () => {
  const request = await serializeCodexWireRequest({
    ...base,
    messages: [message('user', [
      { type: 'text', text: 'Its closing message:' },
      { type: 'reasoning', text: 'Inspecting the package.' },
      { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"package.json"}' },
    ], { kind: 'subagent-settled', form: 'notice', summary: 'The child stopped.' })],
  }, { wireModel: 'gpt-5.6-sol', imageUrl })

  assert.deepEqual(request.input, [{
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Its closing message:' },
      { type: 'input_text', text: '[Embedded reasoning]\nInspecting the package.' },
      { type: 'input_text', text: '[Embedded tool call: read_file]\n{"path":"package.json"}' },
    ],
  }])
})

test('rejects unsupported controls and unverified mid-history system changes', async () => {
  await assert.rejects(
    serializeCodexWireRequest({ ...base, temperature: 0, messages: [] }, { wireModel: 'model', imageUrl }),
    error => error.code === 'UNSUPPORTED_OPTION' && /temperature/u.test(error.message),
  )
  await assert.rejects(
    serializeCodexWireRequest({ ...base, maxTokens: 8192, messages: [] }, { wireModel: 'model', imageUrl }),
    error => error.code === 'UNSUPPORTED_OPTION' && /maxTokens/u.test(error.message),
  )
  await assert.rejects(
    serializeCodexWireRequest({
      ...base,
      messages: [
        message('user', [{ type: 'text', text: 'before' }], { kind: 'user' }),
        message('system', [{ type: 'text', text: 'changed' }], { kind: 'plugin', plugin: 'system' }),
      ],
    }, { wireModel: 'model', imageUrl }),
    error => error.code === 'UNSUPPORTED_CONTENT' && /mid-history/u.test(error.message),
  )
  await assert.rejects(
    serializeCodexWireRequest({
      ...base,
      messages: [message('user', [{ type: 'future-content' }], { kind: 'user' })],
    }, { wireModel: 'model', imageUrl }),
    error => error.code === 'UNSUPPORTED_CONTENT' && /future-content/u.test(error.message),
  )
})

test('admits DSH compaction when the backend cannot enforce its output cap', async () => {
  const request = await serializeCodexWireRequest({
    ...base,
    purpose: 'compaction',
    maxTokens: 8192,
    messages: [message('user', [{ type: 'text', text: 'Summarize this session.' }], { kind: 'plugin', plugin: 'compaction' })],
  }, { wireModel: 'gpt-5.6-sol', imageUrl })

  assert.equal('maxTokens' in request, false)
  assert.equal('max_output_tokens' in request, false)
  assert.equal(request.input[0].content[0].text, 'Summarize this session.')
})

let nextMessage = 0
function message(role, content, source) {
  nextMessage += 1
  return { id: `${role}-${String(nextMessage)}`, role, content, source }
}
