import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProviderDetailsView } from '../lib/types/client/ProviderDetails.js'
import { apply } from '../lib/types/client/index.js'
import { en } from '../lib/types/client/locales.js'

const require = createRequire(import.meta.url)

test('registers under the provider settings namespace and reads both Host authorities', async () => {
  const registrations = []
  const provider = 'codex-wrapper-advanced'
  const catalog = catalogSnapshot(provider)
  const account = accountSnapshot(provider)
  const settings = settingsBinder()
  const credentials = []
  const ctx = {
    effect(factory) { return factory() },
    locale: { register() { return () => {} } },
    slots: {
      inject(_name, register) { return register() },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    },
    remote: {
      settings: settings.service,
      credentials: {
        async set(ref, value) { credentials.push({ ref, value }); return { ok: true, value: undefined } },
      },
      companionProviderCatalog: {
        async list() { return { ok: true, value: [catalog] } },
        async refresh() { return { ok: true, value: catalog } },
      },
      companionProviderAccounts: {
        async list() { return { ok: true, value: [account] } },
        async refresh() { return { ok: true, value: account } },
      },
    },
  }
  apply(ctx)
  assert.deepEqual(registrations.map(item => item.options.key), [
    'dsh-companion-openrouter',
    'dsh-companion-codex-wrapper-advanced',
    'dsh-companion-claude-wrapper-advanced',
  ])
  const registered = registrations[1]
  assert.equal(registered.options.name, 'settings.models.provider-card')
  assert.equal(registered.options.locale, 'dsh-companion.provider-settings')
  assert.equal(typeof registered.component, 'function')
  const operations = registered.options.inject()
  assert.deepEqual(await operations.load(provider), { catalog, account })
  assert.deepEqual(await operations.loadConfiguration(), {
    status: 'ready',
    writable: true,
    providerRevision: 1,
    policyRevision: 1,
    provider: { enabled: true, apiKeyEnv: 'CODEX_WRAPPER_ADVANCED_API_KEY' },
    policy: { defaultModelState: 'enabled', providers: {} },
  })
  assert.deepEqual(await operations.refresh(provider), { catalog, account })
  await operations.saveProvider(true, 'https://wrapper.example', 'new-key', 1)
  await operations.setModelEnabled(provider, 'gpt-5.6-sol', false, 1)
  assert.deepEqual(credentials, [{ ref: 'CODEX_WRAPPER_ADVANCED_API_KEY', value: 'new-key' }])
  assert.deepEqual(settings.mutations.map(item => item.namespace), [
    'dsh-companion-codex-wrapper-advanced',
    'dsh-companion-model-policy',
  ])
})

test('renders catalog freshness, models, plan, and allowance usage as quiet native controls', () => {
  const provider = 'codex-wrapper-advanced'
  const html = renderToStaticMarkup(ProviderDetailsView({
    state: { catalog: catalogSnapshot(provider), account: accountSnapshot(provider) },
    refreshing: false,
    onRefresh() {},
    t: key => en[key],
    modelEnabled: model => model === 'gpt-5.6-sol',
    onModelEnabled() {},
  }))
  assert.match(html, /DSH Companion provider details/u)
  assert.match(html, /Model catalog/u)
  assert.match(html, /gpt-5\.6-sol/u)
  assert.match(html, /aria-label="GPT-5\.6-Sol: Enabled"[^>]*checked=""/u)
  assert.doesNotMatch(html, /hidden-model/u)
  assert.match(html, /Plan: Plus/u)
  assert.match(html, /Weekly — 12[.,]5% used/u)
  assert.match(html, /<button type="button">Refresh<\/button>/u)
})

test('keeps a successful refresh half while reporting the other Host refusal', async () => {
  let registered
  const catalog = catalogSnapshot('codex-wrapper-advanced')
  const settings = settingsBinder()
  const ctx = {
    effect(factory) { return factory() },
    locale: { register() { return () => {} } },
    slots: {
      inject(_name, register) { return register() },
      register(options) { registered = options; return () => {} },
    },
    remote: {
      settings: settings.service,
      credentials: { async set() { return { ok: true, value: undefined } } },
      companionProviderCatalog: {
        async list() { return { ok: false, error: { message: 'offline' } } },
        async refresh() { return { ok: true, value: catalog } },
      },
      companionProviderAccounts: {
        async list() { return { ok: true, value: [] } },
        async refresh() { return { ok: false, error: { message: 'quota unavailable' } } },
      },
    },
  }
  apply(ctx)
  const operations = registered.inject()
  assert.deepEqual(await operations.load('codex-wrapper-advanced'), { error: 'offline' })
  assert.deepEqual(await operations.refresh('codex-wrapper-advanced'), {
    catalog,
    error: 'quota unavailable',
  })
})

test('emits a materializable DSH lazy client bundle with only platform externals', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registered
  vm.runInContext(bundle, vm.createContext({
    window: { __ModuleLoader__: { load(value) { registered = value } } },
  }))
  assert.equal(registered.id, '@dsh-companion/ui-provider-settings')
  const exports = registered.factory((specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return require(specifier)
    throw new Error(`unexpected external ${specifier}`)
  })
  assert.equal(typeof exports.apply, 'function')
})

function catalogSnapshot(provider) {
  return {
    provider,
    status: 'ready',
    generation: 2,
    refreshedAt: 100,
    refreshing: false,
    models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', hidden: false },
      { id: 'hidden-model', name: 'Hidden', hidden: true },
    ],
  }
}

function accountSnapshot(provider) {
  return {
    provider,
    status: 'ready',
    observedAt: 100,
    refreshing: false,
    value: {
      provider,
      accountStatus: 'ready',
      plan: { id: 'plus', name: 'Plus' },
      allowances: [{
        id: 'global',
        name: 'Weekly',
        primary: { usedPercent: 12.5, windowSeconds: 604800 },
      }],
    },
  }
}

function settingsBinder() {
  const mutations = []
  const snapshots = [
    {
      ns: 'dsh-companion-codex-wrapper-advanced',
      value: { enabled: true, apiKeyEnv: 'CODEX_WRAPPER_ADVANCED_API_KEY' },
      revision: 1,
    },
    {
      ns: 'dsh-companion-model-policy',
      value: { defaultModelState: 'enabled', providers: {} },
      revision: 1,
    },
  ]
  return {
    mutations,
    service: {
      async describe() {
        return { ok: true, value: { writable: true, hasDocument: true, namespaces: snapshots } }
      },
      async mutate(namespace, ops, revision) {
        mutations.push({ namespace, ops, revision })
        const snapshot = snapshots.find(candidate => candidate.ns === namespace)
        return { ok: true, value: snapshot }
      },
    },
  }
}
