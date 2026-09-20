/** Provider-neutral account and allowance values. */

import type { CompanionProviderId } from '@dsh-companion/provider-catalog/types'

/** Lossless JSON value accepted on provider account wire projections. */
export type CompanionJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CompanionJsonValue[]
  | { readonly [key: string]: CompanionJsonValue }

/** One provider allowance window. */
export interface CompanionAllowanceWindow {
  readonly usedPercent: number
  readonly windowSeconds?: number
  readonly resetsAt?: number
  readonly resetsInSeconds?: number
}

/** One independently metered provider allowance group. */
export interface CompanionAllowanceGroup {
  readonly id: string
  readonly name?: string
  readonly reached?: boolean
  /** Provider observation time for this independently refreshed group, in Unix milliseconds. */
  readonly observedAt?: number
  /** Provider-reported age when no exact observation timestamp is available. */
  readonly ageSeconds?: number
  readonly primary?: CompanionAllowanceWindow
  readonly secondary?: CompanionAllowanceWindow
}

/** Optional provider credit facts; a balance remains a provider string without an invented currency. */
export interface CompanionProviderCredits {
  readonly hasCredits?: boolean
  readonly unlimited?: boolean
  readonly balance?: string
  readonly overageLimitReached?: boolean
  readonly approximateCloudMessages?: CompanionJsonValue
  readonly approximateLocalMessages?: CompanionJsonValue
}

/** Complete provider-owned account projection at one observation. */
export interface CompanionProviderAccountView {
  readonly provider: CompanionProviderId
  readonly accountStatus: 'ready' | 'authentication-required'
  readonly identity?: {
    readonly accountId?: string
    readonly displayName?: string
  }
  readonly plan?: {
    readonly id: string
    readonly name?: string
  }
  readonly credits?: CompanionProviderCredits
  readonly activeAllowance?: string
  readonly allowances: readonly CompanionAllowanceGroup[]
}

/** Registry lifecycle around the last provider-owned account projection. */
export interface CompanionProviderAccountSnapshot {
  readonly provider: CompanionProviderId
  readonly status: 'ready' | 'stale' | 'unavailable'
  readonly value?: CompanionProviderAccountView
  readonly observedAt?: number
  readonly refreshing: boolean
  readonly error?: string
}

/** Wire-safe account snapshot with the Host-only provider brand erased. */
export interface CompanionProviderAccountRemoteSnapshot
  extends Omit<CompanionProviderAccountSnapshot, 'provider' | 'value'> {
  readonly provider: string
  readonly value?: Omit<CompanionProviderAccountView, 'provider'> & { readonly provider: string }
}

/** Provider-owned account refresh operation. */
export interface CompanionProviderAccountSource {
  readonly provider: CompanionProviderId
  readonly identity: string
  refresh(signal: AbortSignal): Promise<CompanionProviderAccountView>
}

/** Live account source registration. */
export interface CompanionProviderAccountRegistration {
  /** Withdraw the source and its process-local account state. */
  (): void
  /** Replace the endpoint/configuration generation atomically. */
  replace(source: CompanionProviderAccountSource): void
  /** Publish provider-observed state, for example response-header allowances. */
  publish(view: CompanionProviderAccountView): CompanionProviderAccountSnapshot
  /** Read the current snapshot while registered. */
  current(): CompanionProviderAccountSnapshot | undefined
  /** Abort an in-flight refresh without discarding current state. */
  cancelRefresh(): void
}
