import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import CompanionProviderAccounts from '@dsh-companion/provider-account'
import {
  Config,
  OPENROUTER_FAMILY_ID,
  OPENROUTER_SETTINGS_NAMESPACE,
  apply,
  inject,
  name,
} from '../lib/index.js'
import { catalogPayload, keyPayload } from './fixture.mjs'

test('defaults the provider family to no configured instances', () => {
  const value = Config({})
  assert.deepEqual(value.instances, {})
  assert.deepEqual(value.retiredInstanceIds, [])
})

test('registers one configured instance backed by catalog LKG and account services', async () => {
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
  const settings = memorySettings({
    instances: {
      primary: {
        displayName: 'OpenRouter Work',
        enabled: true,
        provider: 'openrouter-primary',
        baseURL: 'https://openrouter.example/api/v1',
        apiKeyEnv: 'OPENROUTER_API_KEY',
      },
    },
    retiredInstanceIds: [],
  })
  ctx.provide('settings', settings)
  ctx.provide('credentials', memoryCredentials({ OPENROUTER_API_KEY: 'openrouter-key' }))
  ctx.provide('companionProviderCatalog', catalog)
  ctx.provide('companionModelPolicy', { isEnabled: (_provider, model) => model !== 'disabled' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CompanionProviderAccounts)
  const fiber = ctx.plugin({ name, inject, apply }, {})
  try {
    await fiber
    assert.deepEqual(ctx.llm.listProviderFamilies(), [{
      id: OPENROUTER_FAMILY_ID,
      displayName: 'OpenRouter',
      maxInstances: null,
      settingsNs: OPENROUTER_SETTINGS_NAMESPACE,
      instancesPath: ['instances'],
    }])
    assert.deepEqual(ctx.llm.listConfigurableProviders(), [])
    await waitFor(() => ctx.llm.listProviders().length === 1)
    assert.deepEqual(ctx.llm.listProviders(), [{ id: 'openrouter-primary', name: 'OpenRouter Work' }])
    assert.deepEqual(await ctx.llm.listProviderInstances(), [{
      id: 'primary',
      familyId: OPENROUTER_FAMILY_ID,
      provider: 'openrouter-primary',
      displayName: 'OpenRouter Work',
      enabled: true,
      active: true,
      settingsNs: OPENROUTER_SETTINGS_NAMESPACE,
      settingsPath: ['instances', 'primary'],
      credential: 'configured',
    }])
    await waitFor(() => catalog.snapshot('openrouter-primary')?.status === 'ready')
    assert.deepEqual((await ctx.llm.listModels('openrouter-primary')).map(model => model.id), ['acme/reasoner'])
    await waitFor(() => ctx.companionProviderAccounts.snapshot('openrouter-primary')?.status === 'ready')
    assert.deepEqual(new Set(calls.map(call => call.url)), new Set([
      'https://openrouter.example/api/v1/models',
      'https://openrouter.example/api/v1/key',
    ]))
    assert.ok(calls.every(call => call.init.headers.authorization === 'Bearer openrouter-key'))
    const account = ctx.companionProviderAccounts.snapshot('openrouter-primary').value
    assert.equal(account.credits, undefined)
    assert.equal(account.allowances[0].name, 'API key spending cap')
    assert.equal(account.allowances[0].primary.usedPercent, 25)
    assert.equal(account.allowances[0].primary.monetary.remainingNanos, 15_000_000_000)
  } finally {
    globalThis.fetch = originalFetch
    await fiber.dispose()
    assert.deepEqual(ctx.llm.listProviders(), [])
    assert.deepEqual(ctx.llm.listProviderFamilies(), [])
    await ctx.fiber.dispose()
  }
})

test('lists the family but no instance or route for empty settings', async () => {
  const ctx = new Context()
  ctx.provide('settings', memorySettings({ instances: {}, retiredInstanceIds: [] }))
  ctx.provide('credentials', memoryCredentials({}))
  ctx.provide('companionProviderCatalog', memoryCatalog())
  ctx.provide('companionModelPolicy', { isEnabled: () => false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CompanionProviderAccounts)
  const fiber = ctx.plugin({ name, inject, apply }, {})
  await fiber
  assert.deepEqual(ctx.llm.listProviders(), [])
  assert.equal(ctx.llm.listProviderFamilies()[0].id, OPENROUTER_FAMILY_ID)
  assert.deepEqual(await ctx.llm.listProviderInstances(), [])
  await fiber.dispose()
  await ctx.fiber.dispose()
})

test('creates, renames, and deletes isolated instances through the DSH family API', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('/models')) return Response.json(catalogPayload())
    if (url.endsWith('/key')) return Response.json(keyPayload())
    throw new Error(`unexpected request ${url}`)
  }
  const ctx = new Context()
  const settings = memorySettings({ instances: {}, retiredInstanceIds: [] })
  ctx.provide('settings', settings)
  ctx.provide('credentials', memoryCredentials({}))
  ctx.provide('companionProviderCatalog', memoryCatalog())
  ctx.provide('companionModelPolicy', { isEnabled: () => true })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CompanionProviderAccounts)
  const fiber = ctx.plugin({ name, inject, apply }, {})
  try {
    await fiber
    const signal = new AbortController().signal
    const first = await ctx.llm.saveProviderInstance(OPENROUTER_FAMILY_ID, {
      displayName: 'Work',
      enabled: true,
      config: { baseURL: 'https://openrouter.example/api/v1' },
      credential: { kind: 'replace', value: 'work-key' },
    }, signal)
    const second = await ctx.llm.saveProviderInstance(OPENROUTER_FAMILY_ID, {
      displayName: 'Personal',
      enabled: true,
      config: { baseURL: 'https://openrouter.example/api/v1' },
      credential: { kind: 'replace', value: 'personal-key' },
    }, signal)
    assert.notEqual(first.id, second.id)
    assert.notEqual(first.provider, second.provider)
    await waitFor(() => ctx.llm.listProviders().length === 2)

    const renamed = await ctx.llm.saveProviderInstance(OPENROUTER_FAMILY_ID, {
      instanceId: first.id,
      displayName: 'Work renamed',
      enabled: true,
      config: { baseURL: 'https://openrouter.example/api/v1' },
    }, signal)
    assert.equal(renamed.provider, first.provider)
    await waitFor(() => ctx.llm.listProviders().some(provider => provider.name === 'Work renamed'))

    await ctx.llm.deleteProviderInstance(OPENROUTER_FAMILY_ID, second.id, signal)
    await waitFor(async () => (await ctx.llm.listProviderInstances()).length === 1)
    assert.equal((await ctx.llm.listProviderInstances())[0].id, first.id)
    assert.ok(settings.get().retiredInstanceIds.includes(second.id))
  } finally {
    globalThis.fetch = originalFetch
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

test('removes a staged credential when the instance settings commit fails', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => String(input).endsWith('/models')
    ? Response.json(catalogPayload())
    : Response.json(keyPayload())
  const ctx = new Context()
  const settings = memorySettings({ instances: {}, retiredInstanceIds: [] })
  const credentials = memoryCredentials({})
  settings.failNextReplace(new Error('settings offline'))
  ctx.provide('settings', settings)
  ctx.provide('credentials', credentials)
  ctx.provide('companionProviderCatalog', memoryCatalog())
  ctx.provide('companionModelPolicy', { isEnabled: () => true })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CompanionProviderAccounts)
  const fiber = ctx.plugin({ name, inject, apply }, {})
  try {
    await fiber
    await assert.rejects(ctx.llm.saveProviderInstance(OPENROUTER_FAMILY_ID, {
      displayName: 'Rejected',
      enabled: true,
      config: {},
      credential: { kind: 'replace', value: 'temporary-key' },
    }, new AbortController().signal), /settings offline/u)
    assert.deepEqual(settings.get().instances, {})
    assert.deepEqual(credentials.refs(), [])
    assert.deepEqual(await ctx.llm.listProviderInstances(), [])
  } finally {
    globalThis.fetch = originalFetch
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

test('keeps the provider family separate from a legacy configurable-provider directory', async () => {
  const ctx = new Context()
  ctx.provide('settings', memorySettings({ instances: {}, retiredInstanceIds: [] }))
  ctx.provide('credentials', memoryCredentials({}))
  ctx.provide('companionProviderCatalog', memoryCatalog())
  ctx.provide('companionModelPolicy', { isEnabled: () => false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CompanionProviderAccounts)
  ctx.llm.registerConfigurableProviders([{
    provider: 'openrouter',
    displayName: 'openrouter',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'openrouter'],
  }])
  const fiber = ctx.plugin({ name, inject, apply }, {})
  await fiber
  assert.deepEqual(ctx.llm.listProviders(), [])
  assert.equal(ctx.llm.listProviderFamilies()[0].id, OPENROUTER_FAMILY_ID)
  assert.equal(ctx.llm.listConfigurableProviders()[0].settingsNs, 'llm-pi-ai')
  await fiber.dispose()
  await ctx.fiber.dispose()
})

function memorySettings(initial) {
  let current = structuredClone(initial)
  let replaceFailure
  const watchers = new Set()
  return {
    get: () => current,
    failNextReplace: (error) => { replaceFailure = error },
    register() {
      return {
        get: () => current,
        watch(callback) { watchers.add(callback); return () => watchers.delete(callback) },
        async update(patch) {
          current = { ...current, ...structuredClone(patch) }
          await Promise.all([...watchers].map(callback => callback(current, undefined)))
        },
        async replace(section) {
          if (replaceFailure !== undefined) {
            const error = replaceFailure
            replaceFailure = undefined
            throw error
          }
          current = structuredClone(section)
          await Promise.all([...watchers].map(callback => callback(current, undefined)))
        },
      }
    },
  }
}

function memoryCredentials(initial) {
  const values = new Map(Object.entries(initial))
  return {
    refs: () => [...values.keys()],
    resolve: async ref => values.has(String(ref)) ? { value: values.get(String(ref)), source: 'test' } : undefined,
    describe: async ref => ({ configured: values.has(String(ref)), writable: true }),
    set: async (ref, value) => { values.set(String(ref), value) },
    unset: async ref => { values.delete(String(ref)) },
  }
}

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
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for provider state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
