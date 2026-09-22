import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import CompanionProviderAccounts from '@dsh-companion/provider-account'
import {
  Config,
  OPENROUTER_PROVIDER,
  OPENROUTER_SETTINGS_NAMESPACE,
  apply,
  inject,
  name,
} from '../lib/index.js'
import { catalogPayload, keyPayload } from './fixture.mjs'

test('defaults the dedicated provider to disabled', () => {
  const value = Config({})
  assert.equal(value.enabled, false)
  assert.equal(value.baseURL, 'https://openrouter.ai/api/v1')
})

test('registers one configurable route backed by catalog LKG and account services', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/models')) return Response.json(catalogPayload())
    if (url.endsWith('/key')) return Response.json(keyPayload())
    throw new Error(`unexpected request ${url}`)
  }
  const ctx = new Context()
  const catalog = memoryCatalog()
  ctx.provide('credentials', {
    resolve: async ref => String(ref) === 'OPENROUTER_API_KEY'
      ? { value: 'openrouter-key', source: 'test' }
      : undefined,
  })
  ctx.provide('companionProviderCatalog', catalog)
  ctx.provide('companionModelPolicy', { isEnabled: (_provider, model) => model !== 'disabled' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CompanionProviderAccounts)
  const fiber = ctx.plugin({ name, inject, apply }, {
    enabled: true,
    baseURL: 'https://openrouter.example/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
  })
  try {
    await fiber
    assert.deepEqual(ctx.llm.listProviders(), [{ id: OPENROUTER_PROVIDER, name: 'OpenRouter' }])
    assert.deepEqual(ctx.llm.listConfigurableProviders(), [{
      provider: OPENROUTER_PROVIDER,
      displayName: 'OpenRouter',
      settingsNs: OPENROUTER_SETTINGS_NAMESPACE,
      settingsPath: [],
    }])
    await waitFor(() => catalog.snapshot(OPENROUTER_PROVIDER)?.status === 'ready')
    assert.deepEqual((await ctx.llm.listModels(OPENROUTER_PROVIDER)).map(model => model.id), ['acme/reasoner'])
    await waitFor(() => ctx.companionProviderAccounts.snapshot(OPENROUTER_PROVIDER)?.status === 'ready')
    assert.deepEqual(new Set(calls.map(call => call.url)), new Set([
      'https://openrouter.example/api/v1/models',
      'https://openrouter.example/api/v1/key',
    ]))
    assert.ok(calls.every(call => call.init.headers.authorization === 'Bearer openrouter-key'))
    assert.equal(ctx.companionProviderAccounts.snapshot(OPENROUTER_PROVIDER).value.credits.balance, '15')
  } finally {
    globalThis.fetch = originalFetch
    await fiber.dispose()
    assert.deepEqual(ctx.llm.listProviders(), [])
    assert.deepEqual(ctx.llm.listConfigurableProviders(), [])
    await ctx.fiber.dispose()
  }
})

test('keeps the provider visible but dormant when disabled', async () => {
  const ctx = new Context()
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.provide('companionProviderCatalog', memoryCatalog())
  ctx.provide('companionModelPolicy', { isEnabled: () => false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CompanionProviderAccounts)
  const fiber = ctx.plugin({ name, inject, apply }, {})
  await fiber
  assert.deepEqual(ctx.llm.listProviders(), [])
  assert.equal(ctx.llm.listConfigurableProviders()[0].provider, OPENROUTER_PROVIDER)
  await fiber.dispose()
  await ctx.fiber.dispose()
})

function memoryCatalog() {
  const entries = new Map()
  const snapshots = new Map()
  return {
    register(source) {
      let current
      const entry = { source, setCurrent: value => { current = value } }
      entries.set(source.provider, entry)
      const registration = () => {
        entries.delete(source.provider)
        snapshots.delete(source.provider)
        current = undefined
      }
      registration.replace = next => {
        entry.source = next
        current = undefined
      }
      registration.current = () => current
      registration.cancelRefresh = () => {}
      return registration
    },
    async refresh(provider) {
      const entry = entries.get(provider)
      if (entry === undefined) throw new Error('missing source')
      const source = entry.source
      const payload = await source.load(new AbortController().signal)
      const snapshot = {
        ...source.project(payload),
        status: 'ready', generation: 1, refreshedAt: 1, refreshing: false,
      }
      snapshots.set(provider, snapshot)
      entry.setCurrent({ generation: 1, payload })
      return snapshot
    },
    snapshot: provider => snapshots.get(provider),
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for provider state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
