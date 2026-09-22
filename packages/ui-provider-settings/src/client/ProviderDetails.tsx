/** Provider connection, catalog, policy, and allowance details inside one Models-page card. */

import { useCallback, useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config as ModelPolicySettings } from '@dsh-companion/model-policy'
import type {
  CompanionProviderAccountRemoteSnapshot,
  CompanionProviderCatalogRemoteSnapshot,
} from '@dsh-companion/provider-client/client'
import type { ProviderSettingsKey } from './locales.js'

/** Joined Host snapshots rendered for one provider route. */
export interface ProviderDetailsState {
  readonly catalog?: CompanionProviderCatalogRemoteSnapshot
  readonly account?: CompanionProviderAccountRemoteSnapshot
  readonly error?: string
}

/** Provider connection settings owned by the Host plugin. */
export interface ProviderConnectionSettings {
  readonly enabled?: boolean
  readonly baseURL?: string
  readonly apiKeyEnv?: string
}

/** Registration-injected hooks and operations over canonical DSH services. */
export interface ProviderDetailsInjected {
  hooks: {
    readonly providerSettings: SettingsScope<ProviderConnectionSettings>
    readonly modelPolicy: SettingsScope<ModelPolicySettings>
  }
  load(provider: string): Promise<ProviderDetailsState>
  refresh(provider: string): Promise<ProviderDetailsState>
  saveProvider(enabled: boolean, baseURL: string, apiKey: string, revision?: number): Promise<void>
  setModelEnabled(provider: string, model: string, enabled: boolean, revision?: number): Promise<void>
}

/** Complete props derived from the Models slot, locale seat, and injected face. */
export type ProviderDetailsProps =
  & PropsRuntime<'settings.models.provider-card'>
  & PropsLocale<'dsh-companion.provider-settings'>
  & InjectFace<ProviderDetailsInjected>

/** Pure presentation props used after local request state has been resolved. */
export interface ProviderDetailsViewProps {
  readonly state: ProviderDetailsState
  readonly refreshing: boolean
  readonly onRefresh: () => void
  readonly t: (key: ProviderSettingsKey) => string
  readonly modelEnabled?: (model: string) => boolean
  readonly onModelEnabled?: (model: string, enabled: boolean) => void
}

/** Render and edit one provider while Host services retain every durable fact. */
export function ProviderDetails(props: ProviderDetailsProps) {
  const {
    provider, keyConfigured, load, refresh, saveProvider, setModelEnabled,
    useProviderSettings, useModelPolicy, t,
  } = props
  const [state, setState] = useState<ProviderDetailsState>({})
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draftDirty, setDraftDirty] = useState(false)
  const [draftEnabled, setDraftEnabled] = useState(true)
  const [draftBaseURL, setDraftBaseURL] = useState('')
  const [draftApiKey, setDraftApiKey] = useState('')
  const [saveError, setSaveError] = useState<string>()
  const providerId = provider.provider
  const settings = useProviderSettings(snapshot => snapshot)
  const policy = useModelPolicy(snapshot => snapshot)

  useEffect(() => {
    if (draftDirty || settings.value === undefined) return
    setDraftEnabled(settings.value.enabled ?? true)
    setDraftBaseURL(settings.value.baseURL ?? '')
  }, [draftDirty, settings.value])

  useEffect(() => {
    let active = true
    void load(providerId).then((next) => { if (active) setState(next) })
    return () => { active = false }
  }, [load, providerId])

  const runRefresh = useCallback(() => {
    setRefreshing(true)
    void refresh(providerId).then(setState).finally(() => { setRefreshing(false) })
  }, [providerId, refresh])

  const runSave = useCallback(() => {
    setSaving(true)
    setSaveError(undefined)
    void saveProvider(draftEnabled, draftBaseURL, draftApiKey, settings.revision)
      .then(() => {
        setDraftApiKey('')
        setDraftDirty(false)
      })
      .catch((error: unknown) => { setSaveError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { setSaving(false) })
  }, [draftApiKey, draftBaseURL, draftEnabled, saveProvider, settings.revision])

  const enabled = useCallback((model: string) => modelEnabled(policy, providerId, model), [policy, providerId])
  const setEnabled = useCallback((model: string, value: boolean) => {
    void setModelEnabled(providerId, model, value, policy.revision).catch((error: unknown) => {
      setSaveError(error instanceof Error ? error.message : String(error))
    })
  }, [policy.revision, providerId, setModelEnabled])

  return (
    <>
      {settings.status !== 'ready' || settings.value === undefined
        ? <p>{t('settingsUnavailable')}</p>
        : (
          <form onSubmit={(event) => { event.preventDefault(); runSave() }}>
            <label>
              <input
                type="checkbox"
                checked={draftEnabled}
                disabled={!settings.writable || saving}
                onChange={(event) => { setDraftEnabled(event.currentTarget.checked); setDraftDirty(true) }}
              />{' '}{t('providerEnabled')}
            </label>
            <label>
              {t('endpoint')}
              <input
                type="url"
                value={draftBaseURL}
                disabled={!settings.writable || saving}
                onChange={(event) => { setDraftBaseURL(event.currentTarget.value); setDraftDirty(true) }}
              />
            </label>
            <label>
              {t('apiKey')}
              <input
                type="password"
                value={draftApiKey}
                placeholder={keyConfigured ? t('apiKeyConfigured') : t('apiKeyPlaceholder')}
                disabled={!settings.writable || saving}
                onChange={(event) => { setDraftApiKey(event.currentTarget.value) }}
              />
            </label>
            <button type="submit" disabled={!settings.writable || saving}>
              {saving ? t('saving') : t('save')}
            </button>
            {!settings.writable && <p>{t('settingsReadOnly')}</p>}
          </form>
        )}
      {saveError === undefined ? null : <p role="alert">{saveError}</p>}
      <ProviderDetailsView
        state={state}
        refreshing={refreshing}
        onRefresh={runRefresh}
        t={t}
        modelEnabled={enabled}
        onModelEnabled={setEnabled}
      />
    </>
  )
}

/** Render resolved provider state without transport or subscription behavior. */
export function ProviderDetailsView({
  state, refreshing, onRefresh, t, modelEnabled: enabled, onModelEnabled,
}: ProviderDetailsViewProps) {
  const catalog = state.catalog
  const account = state.account?.value
  return (
    <section aria-label={t('sectionLabel')}>
      <div>
        <strong>{t('catalog')}</strong>{' '}
        <span>{catalog === undefined ? t('unavailable') : statusLabel(catalog.status, t)}</span>{' '}
        <button type="button" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? t('refreshing') : t('refresh')}
        </button>
      </div>
      {state.error === undefined ? null : <p role="alert">{t('refreshFailed')}: {state.error}</p>}
      {catalog === undefined ? null : (
        <details>
          <summary>{t('models')} ({String(catalog.models.filter(model => !model.hidden).length)})</summary>
          {catalog.models.length === 0
            ? <p>{t('noModels')}</p>
            : (
              <ul>
                {catalog.models.filter(model => !model.hidden).map(model => (
                  <li key={model.id}>
                    {enabled === undefined || onModelEnabled === undefined
                      ? null
                      : (
                        <input
                          type="checkbox"
                          aria-label={`${model.name}: ${enabled(model.id) ? t('enabledModel') : t('disabledModel')}`}
                          checked={enabled(model.id)}
                          onChange={(event) => { onModelEnabled(model.id, event.currentTarget.checked) }}
                        />
                      )}{' '}
                    <code>{model.id}</code> — {model.name}
                  </li>
                ))}
              </ul>
            )}
        </details>
      )}
      {account === undefined ? null : (
        <details>
          <summary>{t('account')}</summary>
          {account.plan === undefined ? null : <p>{t('plan')}: {account.plan.name ?? account.plan.id}</p>}
          <strong>{t('allowances')}</strong>
          <ul>
            {account.allowances.map(allowance => (
              <li key={allowance.id}>
                {allowance.name ?? allowance.id}
                {allowance.primary === undefined
                  ? null
                  : ` — ${formatPercent(allowance.primary.usedPercent)} ${t('used')}${resetText(allowance.primary.resetsAt, t)}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

function modelEnabled(
  snapshot: SettingsScopeSnapshot<ModelPolicySettings>,
  provider: string,
  model: string,
): boolean {
  const policy = snapshot.value?.providers?.[provider]
  if (policy?.enabled === false) return false
  const override = policy?.models?.[model]
  if (override !== undefined) return override === 'enabled'
  if (policy?.defaultModelState !== undefined) return policy.defaultModelState === 'enabled'
  return (snapshot.value?.defaultModelState ?? 'enabled') === 'enabled'
}

function statusLabel(
  status: CompanionProviderCatalogRemoteSnapshot['status'],
  t: (key: ProviderSettingsKey) => string,
): string {
  if (status === 'ready') return t('ready')
  if (status === 'stale') return t('stale')
  return t('unavailable')
}

function formatPercent(value: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)}%`
}

function resetText(resetsAt: number | undefined, t: (key: ProviderSettingsKey) => string): string {
  return resetsAt === undefined ? '' : `; ${t('resets')} ${new Date(resetsAt * 1000).toLocaleString()}`
}
