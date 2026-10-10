import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODEX_WRAPPER_ADVANCED_PROVIDER,
  CodexCatalogGeneration,
  CodexWrapperAdvancedAdapter,
  parseCodexWireCatalog,
} from '../lib/index.js'

function catalog(wireModel) {
  return new CodexCatalogGeneration(parseCodexWireCatalog({
    models: [{
      id: 'model',
      model: wireModel,
      display_name: 'Model',
      description: null,
      hidden: false,
      input_modalities: ['text'],
      default_context_length: 1000,
      max_context_length: 1000,
      reasoning: { levels: ['low'], default: 'low', summary_supported: true },
    }],
  }))
}

function generation(wireModel, calls, limits) {
  return {
    catalog: catalog(wireModel),
    client: {
      async responses(request) {
        calls.push(request)
        return events([
          { type: 'text_delta', text: wireModel },
          { type: 'rate_limits', value: limits },
          { type: 'done', stopReason: 'end_turn' },
        ])
      },
    },
  }
}

test('binds model metadata and dispatch to one immutable generation', async () => {
  const calls = []
  const observed = []
  const firstLimits = { account: {}, limits: { groups: [] } }
  const secondLimits = { account: { plan: { id: 'next' } }, limits: { groups: [] } }
  let current = generation('wire-v1', calls, firstLimits)
  const adapter = new CodexWrapperAdvancedAdapter({
    generation: async () => current,
    imageUrl: async () => { throw new Error('no image expected') },
    onLimits: limits => observed.push(limits),
  })

  const prepared = await adapter.prepareCall(CODEX_WRAPPER_ADVANCED_PROVIDER, 'model')
  current = generation('wire-v2', calls, secondLimits)
  const preparedChunks = await Array.fromAsync(prepared.stream(request('model')))
  const directChunks = await Array.fromAsync(adapter.stream(request('model')))

  assert.equal(prepared.model.context.contextWindow, 1000)
  assert.deepEqual(calls.map(call => call.model), ['wire-v1', 'wire-v2'])
  assert.deepEqual(preparedChunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['wire-v1'])
  assert.deepEqual(directChunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['wire-v2'])
  assert.deepEqual(observed, [firstLimits, secondLimits])
})

test('lists the captured wrapper catalog and refuses foreign provider routes', async () => {
  const adapter = new CodexWrapperAdvancedAdapter({
    generation: async () => generation('wire', [], { account: {}, limits: { groups: [] } }),
    imageUrl: async () => { throw new Error('no image expected') },
  })
  assert.deepEqual((await adapter.listModels(CODEX_WRAPPER_ADVANCED_PROVIDER)).map(model => model.id), ['model'])
  await assert.rejects(adapter.resolveModel('other-provider', 'model'), error => error.code === 'NO_ADAPTER')
})

test('contains account observer failures without changing model settlement', async () => {
  const adapter = new CodexWrapperAdvancedAdapter({
    generation: async () => generation('wire', [], { account: {}, limits: { groups: [] } }),
    imageUrl: async () => { throw new Error('no image expected') },
    onLimits: () => { throw new Error('presentation failed') },
  })
  const chunks = await Array.fromAsync(adapter.stream(request('model')))
  assert.equal(chunks.at(-1).type, 'finish')
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('filters and denies disabled models while an admitted prepared call keeps its decision', async () => {
  const calls = []
  let enabled = true
  const adapter = new CodexWrapperAdvancedAdapter({
    generation: async () => generation('wire', calls, { account: {}, limits: { groups: [] } }),
    imageUrl: async () => { throw new Error('no image expected') },
    modelEnabled: () => enabled,
  })
  const prepared = await adapter.prepareCall(CODEX_WRAPPER_ADVANCED_PROVIDER, 'model')
  enabled = false
  assert.deepEqual(await adapter.listModels(CODEX_WRAPPER_ADVANCED_PROVIDER), [])
  await assert.rejects(
    adapter.resolveModel(CODEX_WRAPPER_ADVANCED_PROVIDER, 'model'),
    error => error.code === 'MODEL_DISABLED',
  )
  await assert.rejects(
    Array.fromAsync(adapter.stream(request('model'))),
    error => error.code === 'MODEL_DISABLED',
  )
  const chunks = await Array.fromAsync(prepared.stream(request('model')))
  assert.equal(chunks.at(-1).type, 'finish')
  assert.equal(calls.length, 1)
})

function request(model) {
  return {
    provider: CODEX_WRAPPER_ADVANCED_PROVIDER,
    model,
    messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }],
  }
}

async function* events(items) {
  yield* items
}
