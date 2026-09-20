/** Browser-side assembly of Companion provider Remote contributions. */

import type { Context } from '@deepseek-ai/cordis'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import { mountCompanionProviderRemotes } from '../runtime.js'

export type {} from '@dsh-companion/provider-account/remote'
export type {} from '@dsh-companion/provider-catalog/remote'
export type {
  CompanionProviderAccountRemoteSnapshot,
} from '@dsh-companion/provider-account/types'
export type {
  CompanionProviderCatalogRemoteSnapshot,
} from '@dsh-companion/provider-catalog/types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    remote: TypertClientRemote
  }
}

/** Required shared Client Remote mount service. */
export const inject = ['remote']

/** Mount account and catalog methods into the canonical DSH Client Remote. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  return mountCompanionProviderRemotes(ctx.remote)
}
