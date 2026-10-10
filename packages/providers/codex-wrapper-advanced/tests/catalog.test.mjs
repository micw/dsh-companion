import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODEX_WRAPPER_ADVANCED_PROVIDER,
  CodexCatalogGeneration,
  parseCodexWireCatalog,
  projectCompanionCatalog,
} from '../lib/index.js'

function catalogPayload(overrides = {}) {
  return parseCodexWireCatalog({
    models: [{
      id: 'gpt-5.6-sol',
      model: 'gpt-5.6-sol-wire',
      display_name: 'GPT-5.6-Sol',
      description: 'Frontier coding model.',
      hidden: false,
      input_modalities: ['text', 'image'],
      default_context_length: 272000,
      max_context_length: 872000,
      reasoning: {
        levels: ['none', 'low', 'high'],
        default: 'low',
        summary_supported: true,
      },
      ...overrides,
    }],
  })
}

function generation(overrides = {}) {
  return new CodexCatalogGeneration(catalogPayload(overrides))
}

test('projects base and explicit long-budget choices onto one wire model', () => {
  const catalog = generation()
  assert.deepEqual(catalog.listModels().map(model => ({ id: model.id, name: model.name })), [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-sol:long', name: 'GPT-5.6-Sol (Long context)' },
  ])
  assert.equal(catalog.resolveModel('gpt-5.6-sol').context.contextWindow, 272000)
  assert.equal(catalog.resolveModel('gpt-5.6-sol:long').context.contextWindow, 872000)
  assert.equal(catalog.wireModel('gpt-5.6-sol'), 'gpt-5.6-sol-wire')
  assert.equal(catalog.wireModel('gpt-5.6-sol:long'), 'gpt-5.6-sol-wire')
})

test('projects capabilities and only adopts a selectable provider default', () => {
  const regular = generation().resolveModel('gpt-5.6-sol')
  assert.equal(regular.provider, CODEX_WRAPPER_ADVANCED_PROVIDER)
  assert.deepEqual(regular.inputModalities, ['text', 'image'])
  assert.deepEqual(regular.reasoning, {
    efforts: [
      { id: 'none', name: 'None' },
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'low',
  })

  const providerOwned = generation({
    reasoning: {
      levels: ['low', 'high'],
      default: 'provider-default-not-in-levels',
      summary_supported: true,
    },
  }).resolveModel('gpt-5.6-sol')
  assert.deepEqual(providerOwned.reasoning, {
    efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
  })
})

test('keeps hidden models resolvable without advertising them', () => {
  const catalog = generation({ hidden: true })
  assert.deepEqual(catalog.listModels(), [])
  assert.equal(catalog.resolveModel('gpt-5.6-sol').id, 'gpt-5.6-sol')
})

test('rejects unsupported modalities and generated-id collisions', () => {
  assert.throws(
    () => generation({ input_modalities: ['text', 'audio'] }),
    error => error.code === 'INVALID_CATALOG' && /unsupported input modality/u.test(error.message),
  )
  const source = {
    id: 'gpt-5.6-sol',
    model: 'gpt-5.6-sol',
    display_name: 'Sol',
    description: null,
    hidden: false,
    input_modalities: ['text'],
    default_context_length: 100,
    max_context_length: 200,
    reasoning: { levels: ['low'], default: 'low', summary_supported: true },
  }
  assert.throws(
    () => new CodexCatalogGeneration(parseCodexWireCatalog({
      models: [source, { ...source, id: 'gpt-5.6-sol:long' }],
    })),
    error => error.code === 'INVALID_CATALOG' && /duplicate model id/u.test(error.message),
  )
})

test('does not invent a long variant without measured headroom or ownership', () => {
  assert.deepEqual(generation({ max_context_length: 272000 }).listModels().map(model => model.id), [
    'gpt-5.6-sol',
  ])
  const other = generation({ id: 'gpt-5.6-terra', model: 'gpt-5.6-terra' })
  assert.deepEqual(other.listModels().map(model => model.id), ['gpt-5.6-terra'])
})

test('projects the new Sol long-budget choice', () => {
  const catalog = generation({
    id: 'gpt-6-sol',
    model: 'gpt-6-sol-wire',
    display_name: 'GPT-6-Sol',
  })
  assert.deepEqual(catalog.listModels().map(model => ({ id: model.id, name: model.name })), [
    { id: 'gpt-6-sol', name: 'GPT-6-Sol' },
    { id: 'gpt-6-sol:long', name: 'GPT-6-Sol (Long context)' },
  ])
  assert.equal(catalog.resolveModel('gpt-6-sol:long').context.contextWindow, 872000)
  assert.equal(catalog.wireModel('gpt-6-sol:long'), 'gpt-6-sol-wire')
})

test('projects GPT-6.1 Sol with the measured long budget and no unsupported none effort', () => {
  const payload = catalogPayload({
    id: 'gpt-6.1-sol',
    model: 'gpt-6.1-sol',
    display_name: 'GPT-6.1-Sol',
    reasoning: { levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'low', summary_supported: true },
  })
  const catalog = new CodexCatalogGeneration(payload)
  assert.deepEqual(catalog.listModels().map(model => model.id), ['gpt-6.1-sol', 'gpt-6.1-sol:long'])
  assert.equal(catalog.resolveModel('gpt-6.1-sol:long').context.contextWindow, 872000)
  assert.equal(catalog.wireModel('gpt-6.1-sol:long'), 'gpt-6.1-sol')
  assert.deepEqual(catalog.resolveModel('gpt-6.1-sol').reasoning, {
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id, name: `${id[0].toUpperCase()}${id.slice(1)}` })),
    defaultEffort: 'low',
  })
  assert.deepEqual(projectCompanionCatalog(payload).models.map(model => ({
    id: model.id,
    context: model.context,
    reasoning: model.reasoning,
  })), [
    {
      id: 'gpt-6.1-sol',
      context: { default: 272000, maximum: 872000 },
      reasoning: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low', summarySupported: true },
    },
    {
      id: 'gpt-6.1-sol:long',
      context: { default: 872000, maximum: 872000 },
      reasoning: { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low', summarySupported: true },
    },
  ])
})
