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
  const generation = new OpenRouterCatalogGeneration(payload, 'https://gateway.example/v1')
  const model = generation.model('acme/reasoner')
  assert.deepEqual({
    id: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: model.cost,
  }, {
    id: 'acme/reasoner',
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
  assert.throws(() => decodeOpenRouterCatalog(malformed), /non-negative decimal/u)
  assert.throws(() => decodeOpenRouterCatalog({ ...catalogPayload(), secret: true }), /unknown field secret/u)
})
