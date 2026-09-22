/** DSH Companion's dedicated OpenRouter provider integration. */
export { projectOpenRouterAccount } from './account.js'
export type { OpenRouterAdapterOptions, OpenRouterPiAiLimits } from './adapter.js'
export { OpenRouterAdapter } from './adapter.js'
export type {
  OpenRouterCatalog,
  OpenRouterModel,
  OpenRouterPricing,
  OpenRouterReasoning,
} from './catalog.js'
export {
  DEFAULT_OPENROUTER_API_BASE_URL,
  OPENROUTER_PROVIDER,
  OpenRouterCatalogGeneration,
  decodeOpenRouterCatalog,
  projectOpenRouterCatalog,
} from './catalog.js'
export type { OpenRouterClientOptions, OpenRouterKeyStatus } from './client.js'
export { OpenRouterClient, decodeOpenRouterKeyStatus } from './client.js'
export {
  Config,
  DEFAULT_OPENROUTER_API_KEY_REF,
  OPENROUTER_SETTINGS_NAMESPACE,
  apply,
  inject,
  name,
} from './plugin.js'
export type { Config as ProviderConfig } from './plugin.js'
