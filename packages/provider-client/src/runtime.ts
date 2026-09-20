/** Platform-neutral mount of Companion provider Remote contributions. */

import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import accountRemote from '@dsh-companion/provider-account/remote'
import catalogRemote from '@dsh-companion/provider-catalog/remote'

/** Mount catalog and account namespaces with atomic rollback on failure. */
export async function mountCompanionProviderRemotes(
  remote: TypertClientRemote,
): Promise<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const contribution of [catalogRemote, accountRemote]) {
      disposers.push(await remote.$mount(contribution))
    }
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
  }
}
