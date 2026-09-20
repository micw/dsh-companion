/** DSH Web Models-card contribution for Companion-managed provider state. */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@dsh-companion/provider-client/client'
import type {
  CompanionProviderAccountRemoteSnapshot,
  CompanionProviderCatalogRemoteSnapshot,
} from '@dsh-companion/provider-client/client'
import { ProviderDetails } from './ProviderDetails.js'
import type {
  ProviderConnectionSettings,
  ProviderDetailsInjected,
  ProviderDetailsState,
} from './ProviderDetails.js'
import type { Config as ModelPolicySettings } from '@dsh-companion/model-policy'
import { en, zh } from './locales.js'
import type { ProviderSettingsKey } from './locales.js'

export type { ProviderDetailsInjected, ProviderDetailsProps, ProviderDetailsState } from './ProviderDetails.js'
export type { ProviderSettingsKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-companion.provider-settings': ProviderSettingsKey
  }
}

const NS = 'dsh-companion.provider-settings'
const SETTINGS_NAMESPACE = 'dsh-companion-codex-wrapper-advanced'
const POLICY_NAMESPACE = 'dsh-companion-model-policy'
const DEFAULT_API_KEY_REF = 'CODEX_WRAPPER_ADVANCED_API_KEY'

/** Services required by the provider settings card. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.companionProviderCatalog', 'remote.companionProviderAccounts',
  'remote.credentials', 'settingsScope',
]

/** Register the Codex Wrapper Advanced provider-card details contribution. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-companion provider settings: dictionaries')
  const providerSettings = ctx.settingsScope.bind<ProviderConnectionSettings>({ namespace: SETTINGS_NAMESPACE })
  const modelPolicy = ctx.settingsScope.bind<ModelPolicySettings>({ namespace: POLICY_NAMESPACE })
  const operations: ProviderDetailsInjected = {
    hooks: { providerSettings, modelPolicy },
    load: provider => loadProvider(ctx, provider),
    refresh: async (provider) => {
      const [catalog, account] = await Promise.all([
        ctx.remote.companionProviderCatalog.refresh(provider),
        ctx.remote.companionProviderAccounts.refresh(provider),
      ])
      return joinResults(catalog, account)
    },
    saveProvider: async (enabled, baseURL, apiKey, revision) => {
      const ops: SettingsPathOpView[] = [
        { op: 'set', path: ['enabled'], value: enabled },
        baseURL === ''
          ? { op: 'unset', path: ['baseURL'] }
          : { op: 'set', path: ['baseURL'], value: baseURL },
      ]
      await providerSettings.mutate(ops, revision)
      const key = apiKey.trim()
      if (key === '') return
      const ref = providerSettings.getSnapshot().value?.apiKeyEnv ?? DEFAULT_API_KEY_REF
      const stored = await ctx.remote.credentials.set(ref, key)
      if (!stored.ok) throw stored.error
    },
    setModelEnabled: async (provider, model, enabled, revision) => {
      await modelPolicy.mutate([{
        op: 'set',
        path: ['providers', provider, 'models', model],
        value: enabled ? 'enabled' : 'disabled',
      }], revision)
    },
  }
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card',
    key: SETTINGS_NAMESPACE,
    locale: NS,
    inject: () => operations,
  }, ProviderDetails))
}

async function loadProvider(ctx: Context, provider: string): Promise<ProviderDetailsState> {
  const [catalogs, accounts] = await Promise.all([
    ctx.remote.companionProviderCatalog.list(),
    ctx.remote.companionProviderAccounts.list(),
  ])
  if (!catalogs.ok) return { error: catalogs.error.message }
  if (!accounts.ok) return { error: accounts.error.message }
  const catalog = found(catalogs.value, provider)
  const account = found(accounts.value, provider)
  return {
    ...catalog === undefined ? {} : { catalog },
    ...account === undefined ? {} : { account },
  }
}

function joinResults(
  catalog: Awaited<ReturnType<Context['remote']['companionProviderCatalog']['refresh']>>,
  account: Awaited<ReturnType<Context['remote']['companionProviderAccounts']['refresh']>>,
): ProviderDetailsState {
  const error = !catalog.ok
    ? catalog.error.message
    : !account.ok ? account.error.message : undefined
  return {
    ...catalog.ok ? { catalog: catalog.value } : {},
    ...account.ok ? { account: account.value } : {},
    ...error === undefined ? {} : { error },
  }
}

function found<T extends { readonly provider: string }>(values: readonly T[], provider: string): T | undefined {
  return values.find(value => value.provider === provider)
}

export type { CompanionProviderAccountRemoteSnapshot, CompanionProviderCatalogRemoteSnapshot }
