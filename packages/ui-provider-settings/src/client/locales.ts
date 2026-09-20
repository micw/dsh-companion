/** English copy for Companion provider status cards. */
export const en = {
  sectionLabel: 'DSH Companion provider details',
  catalog: 'Model catalog',
  account: 'Account and allowances',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  unavailable: 'Unavailable',
  stale: 'Last known data',
  ready: 'Current',
  models: 'Models',
  noModels: 'No models are available.',
  plan: 'Plan',
  allowances: 'Allowances',
  used: 'used',
  resets: 'resets',
  refreshFailed: 'Refresh failed',
  providerEnabled: 'Provider enabled',
  endpoint: 'Service URL',
  apiKey: 'API key',
  apiKeyConfigured: 'API key configured; leave blank to keep it',
  apiKeyPlaceholder: 'Enter a new API key',
  save: 'Save provider settings',
  saving: 'Saving…',
  settingsUnavailable: 'Provider settings are unavailable.',
  settingsReadOnly: 'Provider settings are read-only.',
  enabledModel: 'Enabled',
  disabledModel: 'Disabled',
} as const

/** Chinese locale currently falls back to the reviewed English product copy. */
export const zh: typeof en = en

/** Translation key owned by this plugin. */
export type ProviderSettingsKey = keyof typeof en
