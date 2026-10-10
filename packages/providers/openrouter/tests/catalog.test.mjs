import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OpenRouterCatalogGeneration,
  decodeOpenRouterCatalog,
  projectOpenRouterCatalog,
} from '../lib/index.js'
import { catalogPayload } from './fixture.mjs'

test('strictly decodes and projects one dynamic OpenRouter generation', () => {
  const payload = decodeOpenRouterCatalog(catalogPayload())
  const generation = new OpenRouterCatalogGeneration(payload, 'openrouter-work', 'https://gateway.example/v1')
  const model = generation.model('acme/reasoner')
  assert.deepEqual({
    id: model.id,
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
  }, {
    id: 'acme/reasoner',
    provider: 'openrouter-work',
    api: 'openai-completions',
    baseUrl: 'https://gateway.example/v1',
    input: ['text', 'image'],
    contextWindow: 131_072,
    maxTokens: 32_768,
    cost: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
  })

  assert.deepEqual(projectOpenRouterCatalog(payload).models[0], {
    id: 'acme/reasoner',
    name: 'Acme: Reasoner',
    description: 'A reasoning model.',
    hidden: false,
    inputModalities: ['text', 'image'],
    context: { default: 131_072, maximum: 131_072 },
    reasoning: { efforts: ['low', 'high'], defaultEffort: 'high' },
    pricing: {
      kind: 'reported',
      currency: 'USD',
      unit: 'million-tokens',
      input: '0.25',
      output: '1.5',
      cacheRead: '0.025',
      source: 'openrouter-models-api',
      tariffVersion: 'acme/reasoner-20260920@1789900000',
    },
  })
})

test('rejects pagination, malformed prices, and unknown root fields', () => {
  assert.throws(() => decodeOpenRouterCatalog({ ...catalogPayload(), links: { next: '/models?offset=1' } }), /without pagination/u)
  const malformed = catalogPayload()
  malformed.data[0].pricing.prompt = '-1'
  assert.throws(() => decodeOpenRouterCatalog(malformed), /both token prices or neither/u)
  assert.throws(() => decodeOpenRouterCatalog({ ...catalogPayload(), secret: true }), /unknown field secret/u)
})

test('normalizes OpenRouter none reasoning effort to DSH off', () => {
  const source = catalogPayload()
  source.data[0].reasoning.supported_efforts = ['none', 'high']
  source.data[0].reasoning.default_effort = 'none'
  const payload = decodeOpenRouterCatalog(source)
  assert.deepEqual(payload.data[0].reasoning, {
    mandatory: false,
    default_enabled: true,
    supported_efforts: ['off', 'high'],
    default_effort: 'off',
  })
  assert.deepEqual(projectOpenRouterCatalog(payload).models[0].reasoning, {
    efforts: ['off', 'high'],
    defaultEffort: 'off',
  })
})

test('does not advertise reasoning without selectable efforts', () => {
  const source = catalogPayload()
  delete source.data[0].reasoning.supported_efforts
  delete source.data[0].reasoning.default_effort
  const payload = decodeOpenRouterCatalog(source)
  assert.equal(payload.data[0].reasoning, undefined)
  assert.equal(projectOpenRouterCatalog(payload).models[0].reasoning, undefined)
  const model = new OpenRouterCatalogGeneration(payload, 'openrouter-work').models[0]
  assert.equal(model.reasoning, false)
  assert.equal(model.thinkingLevelMap, undefined)
})

test('one malformed reasoning block does not remove independent models', () => {
  const source = catalogPayload()
  const malformed = structuredClone(source.data[0])
  malformed.id = 'apodex/apodex-1.1-mini:free'
  malformed.reasoning.supported_efforts = ['surprise']
  source.data.push(malformed)
  source.total_count = 2
  const payload = decodeOpenRouterCatalog(source)
  assert.equal(payload.data.length, 2)
  assert.equal(payload.data[1].reasoning, undefined)
  assert.deepEqual(projectOpenRouterCatalog(payload).models.map(model => model.id), [
    'acme/reasoner', 'apodex/apodex-1.1-mini:free',
  ])
  const generation = new OpenRouterCatalogGeneration(payload, 'openrouter-work')
  assert.equal(generation.model('acme/reasoner').reasoning, true)
  assert.equal(generation.model(malformed.id).reasoning, false)
})

test('keeps dynamically priced router models without inventing reported rates', () => {
  const source = catalogPayload()
  source.data[0].pricing = { prompt: '-1', completion: '-1' }
  source.data[0].top_provider.context_length = null
  source.data[0].top_provider.max_completion_tokens = null
  const payload = decodeOpenRouterCatalog(source)
  const model = new OpenRouterCatalogGeneration(payload, 'openrouter-work', 'https://gateway.example/v1').models[0]
  assert.deepEqual(model.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  })
  assert.equal(model.contextWindow, source.data[0].context_length)
  assert.equal(model.maxTokens, source.data[0].context_length)
  assert.equal(projectOpenRouterCatalog(payload).models[0].pricing, undefined)
})
