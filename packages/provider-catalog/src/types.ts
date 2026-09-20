/** Provider-neutral catalog values shared by Host providers and client projections. */

/** Stable provider route identity. */
export type CompanionProviderId = string & { readonly __companionProviderId: unique symbol }

/** Validate and brand one provider route identity. */
export function CompanionProviderId(value: string): CompanionProviderId {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(value)) {
    throw new Error(`Companion provider id ${JSON.stringify(value)} must use lowercase letters, digits, and hyphens`)
  }
  return value as CompanionProviderId
}

/** Price provenance; virtual values are reference equivalents, never incurred cost. */
export type ModelPricingKind = 'reported' | 'estimated' | 'virtual'

/** Immutable rates associated with one model catalog generation. */
export interface ModelPricing {
  readonly kind: ModelPricingKind
  readonly currency: string
  readonly unit: 'million-tokens'
  readonly input?: string
  readonly output?: string
  readonly cacheRead?: string
  readonly cacheWrite?: string
  readonly source: string
  readonly tariffVersion: string
}

/** One provider-neutral model projected from a provider-owned catalog payload. */
export interface CompanionProviderModel {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly hidden: boolean
  readonly inputModalities?: readonly string[]
  readonly context?: {
    readonly default?: number
    readonly maximum?: number
  }
  readonly reasoning?: {
    readonly efforts: readonly string[]
    readonly defaultEffort?: string
    readonly summarySupported?: boolean
  }
  readonly pricing?: ModelPricing
}

/** Complete client-safe projection of one provider payload. */
export interface CompanionProviderCatalogView {
  readonly provider: CompanionProviderId
  readonly models: readonly CompanionProviderModel[]
}

/** Current catalog lifecycle snapshot. */
export interface CompanionProviderCatalogSnapshot extends CompanionProviderCatalogView {
  readonly status: 'ready' | 'stale' | 'unavailable'
  readonly generation: number
  readonly refreshedAt?: number
  readonly refreshing: boolean
  readonly error?: string
}

/** Wire-safe catalog snapshot with the Host-only provider brand erased. */
export interface CompanionProviderCatalogRemoteSnapshot
  extends Omit<CompanionProviderCatalogSnapshot, 'provider'> {
  readonly provider: string
}

/** Provider-owned loader and durable payload codec. */
export interface CompanionProviderCatalogSource<P> {
  readonly provider: CompanionProviderId
  /** Non-secret identity of the endpoint/configuration generation this payload belongs to. */
  readonly identity: string
  /** Load and validate one complete payload from the provider. */
  load(signal: AbortSignal): Promise<P>
  /** Validate a payload restored from durable JSON. */
  decode(value: unknown): P
  /** Project the provider payload without creating another catalog authority. */
  project(payload: P): CompanionProviderCatalogView
}

/** Provider-owned payload and the generic generation committed with it. */
export interface CompanionProviderCatalogValue<P> {
  readonly generation: number
  readonly payload: P
}

/** Live source registration with atomic source replacement. */
export interface CompanionProviderCatalogRegistration<P> {
  /** Withdraw the provider source and abort its refresh. */
  (): void
  /** Replace endpoint/configuration identity and begin a fresh refresh. */
  replace(source: CompanionProviderCatalogSource<P>): void
  /** Read the provider-owned payload from the current committed generation. */
  current(): CompanionProviderCatalogValue<P> | undefined
  /** Abort an in-flight refresh without discarding the committed LKG payload. */
  cancelRefresh(): void
}
