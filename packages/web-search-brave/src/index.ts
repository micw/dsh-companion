/** Register Brave Web Search with the published DSH web provider registry. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { BraveSearchProvider } from './provider.js'

export { BraveSearchProvider, BRAVE_PROVIDER_ID, BRAVE_ENDPOINT, mapBraveResult, mapBraveResponse } from './provider.js'
export type { BraveSearchProviderOptions } from './provider.js'
/** Cordis plugin name. */
export const name = 'web-search-brave'
/** Required DSH service. */
export const inject = ['web']
const KEY_REF = credentialRef('BRAVE_SEARCH_API_KEY')
/** No literal API key or custom credential-bearing endpoint is configurable. */
export interface Config {}
/** Plugin configuration. */
export const Config: z<Config> = z.object({})
/** Register a Brave provider whose credential is resolved separately on every search. */
export function apply(ctx: Context, _config: Config): void {
  ctx.web.registerSearchProvider(new BraveSearchProvider({ resolveApiKey: async () => {
    const stored = await ctx.get('credentials')?.resolve(KEY_REF)
    if (stored?.value) return stored.value
    return launchEnvironmentOf(ctx).get(KEY_REF)?.value
  } }))
}
