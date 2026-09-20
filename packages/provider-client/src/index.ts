/** Host Loader marker whose package metadata contributes the Companion browser client. */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export const name = 'dsh-companion/provider-client'

/** Register no Host behavior; `dsh.client` supplies this package's browser half. */
export function apply(_ctx: Context): void {}
