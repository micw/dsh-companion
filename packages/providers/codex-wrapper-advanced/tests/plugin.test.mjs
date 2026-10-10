import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import CompanionProviderAccounts from '@dsh-companion/provider-account'
import {
  CODEX_WRAPPER_ADVANCED_PROVIDER,
  CODEX_WRAPPER_ADVANCED_SETTINGS_NAMESPACE,
  Config,
  apply,
  inject,
  name,
} from '../lib/index.js'

const model = {
  id: 'model',
  model: 'wire-model',
  display_name: 'Model',
  description: null,
  hidden: false,
  input_modalities: ['text'],
  default_context_length: 1000,
  max_context_length: 1000,
  reasoning: { levels: ['low'], default: 'low', summary_supported: true },
}

test('defaults the installed provider to disabled', () => {
  assert.equal(Config({}).enabled.get(), false)
})

test('registers a configurable native route and loads its catalog through the generic LKG owner', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/wire/v1/info')) {
      return Response.json({ service: 'codex-api-wrapper', version: '1.8.0' })
    }
    if (String(url).endsWith('/wire/v1/models')) return Response.json({ models: [model] })
    if (String(url).endsWith('/wire/v1/usage')) {
      return Response.json({
        account: { plan: { id: 'plus', name: 'Plus' }, credits: null, spend_control: null, reset_credits: null },
        limits: { active_group: null, groups: [] },
        promo: null,
      })
    }
    throw new Error(`unexpected request ${String(url)}`)
  }
  const ctx = new Context()
  const catalog = memoryCatalog()
  ctx.provide('credentials', {
    resolve: async ref => String(ref) === 'CODEX_WRAPPER_ADVANCED_API_KEY'
      ? { value: 'wrapper-key', source: 'test' }
      : undefined,
  })
  ctx.provide('companionProviderCatalog', catalog)
  ctx.provide('companionModelPolicy', { isEnabled: () => true })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CompanionProviderAccounts)
  const fiber = ctx.plugin({ name, inject, Config, apply }, {
    enabled: true,
    baseURL: 'https://wrapper.example/prefix',
    apiKeyEnv: 'CODEX_WRAPPER_ADVANCED_API_KEY',
  })
  try {
    await fiber
    assert.deepEqual(ctx.llm.listProviders(), [
      { id: CODEX_WRAPPER_ADVANCED_PROVIDER, name: 'Codex' },
    ])
    assert.deepEqual(ctx.llm.listConfigurableProviders(), [{
      provider: CODEX_WRAPPER_ADVANCED_PROVIDER,
      displayName: 'Codex Wrapper Advanced',
      settingsNs: CODEX_WRAPPER_ADVANCED_SETTINGS_NAMESPACE,
      settingsPath: [],
    }])
    await waitFor(() => catalog.snapshot(CODEX_WRAPPER_ADVANCED_PROVIDER)?.status === 'ready')
    assert.deepEqual((await ctx.llm.listModels(CODEX_WRAPPER_ADVANCED_PROVIDER)).map(item => item.id), ['model'])
    await waitFor(() => ctx.companionProviderAccounts.snapshot(CODEX_WRAPPER_ADVANCED_PROVIDER)?.status === 'ready')
    assert.deepEqual(new Set(calls.map(call => call.url)), new Set([
      'https://wrapper.example/prefix/wire/v1/info',
      'https://wrapper.example/prefix/wire/v1/models',
      'https://wrapper.example/prefix/wire/v1/usage',
    ]))
    assert.equal(calls[0].init.headers.authorization, 'Bearer wrapper-key')
    assert.equal(catalog.snapshot(CODEX_WRAPPER_ADVANCED_PROVIDER).status, 'ready')
    assert.equal(ctx.companionProviderAccounts.snapshot(CODEX_WRAPPER_ADVANCED_PROVIDER).value.plan.id, 'plus')
  } finally {
    globalThis.fetch = originalFetch
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

test('keeps an unconfigured provider dormant but visible for repair', async () => {
  const ctx = new Context()
  ctx.provide('credentials', { resolve: async () => undefined })
  ctx.provide('companionProviderCatalog', memoryCatalog())
  ctx.provide('companionModelPolicy', { isEnabled: () => true })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CompanionProviderAccounts)
  const fiber = ctx.plugin({ name, inject, Config, apply }, { enabled: true })
  await fiber
  assert.deepEqual(ctx.llm.listProviders(), [])
  assert.equal(ctx.llm.listConfigurableProviders()[0].provider, CODEX_WRAPPER_ADVANCED_PROVIDER)
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
