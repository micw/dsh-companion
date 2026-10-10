/** DSH Companion provider integration for an external Codex Wrapper Advanced service. */

export {
  CODEX_WRAPPER_ADVANCED_SETTINGS_NAMESPACE,
  Config,
  DEFAULT_CODEX_WRAPPER_ADVANCED_API_KEY_REF,
  apply,
  inject,
  name,
} from './plugin.js'
export type { Config as ProviderConfig } from './plugin.js'
export { CodexAccountProjection } from './account.js'
export type { CodexAdapterGeneration, CodexAdapterOptions } from './adapter.js'
export { CodexWrapperAdvancedAdapter } from './adapter.js'
export {
  CODEX_WRAPPER_ADVANCED_PROVIDER,
  CodexCatalogGeneration,
  decodeCodexCatalogPayload,
  projectCompanionCatalog,
} from './catalog.js'
export type { CodexStreamObservers } from './translate.js'
export { toTokenUsage, translateCodexWireStream } from './translate.js'
export type { CodexWireClientOptions, CodexWireConnection } from './wire/client.js'
export { CodexWireClient, normalizeServiceRoot } from './wire/client.js'
export type {
  CodexReplayBlock,
  CodexReplayEnvelope,
  CodexReplayResponse,
  CodexWireRequestOptions,
} from './wire/request.js'
export { parseReplayEnvelope, serializeCodexWireRequest } from './wire/request.js'
export type {
  CodexWireAccount,
  CodexWireCatalog,
  CodexWireEvent,
  CodexWireJson,
  CodexWireLimitGroup,
  CodexWireLimitWindow,
  CodexWireModel,
  CodexWireRequest,
  CodexWireServiceInfo,
  CodexWireTurnLimits,
  CodexWireUsage,
  CodexWireUsageReport,
} from './wire/types.js'
export {
  parseCodexWireCatalog,
  parseCodexWireEvent,
  parseCodexWireServiceInfo,
  parseCodexWireUsageReport,
} from './wire/validation.js'
export { parseCodexWireSse } from './wire/sse.js'
