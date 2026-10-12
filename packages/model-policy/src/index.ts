/** DSH Settings-backed user intent for provider and model enablement. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-settings'

/** Durable DSH Settings namespace for the shared policy. */
export const COMPANION_MODEL_POLICY_SETTINGS_NAMESPACE = 'dsh-companion-model-policy'

/** One provider's optional switch and exact model overrides. */
export interface ProviderModelPolicy {
  readonly enabled?: boolean
  /** Default for models without an exact override; omission inherits the shared default. */
  readonly defaultModelState?: 'enabled' | 'disabled'
  readonly models?: Readonly<Record<string, 'enabled' | 'disabled'>>
}

/** Shared provider/model policy settings. */
export interface Config {
  readonly defaultModelState: Volatile<'enabled' | 'disabled'>
  readonly providers: Volatile<Readonly<Record<string, ProviderModelPolicy>>>
}

/** Plain policy value accepted by the standalone resolver. */
export interface ModelPolicyValue {
  readonly defaultModelState?: 'enabled' | 'disabled'
  readonly providers?: Readonly<Record<string, ProviderModelPolicy>>
}

/** Runtime schema for the shared policy namespace. */
export const Config = z.object({
  defaultModelState: z.union(['enabled', 'disabled']).default('enabled').volatile(),
  providers: z.dict(z.object({
    enabled: z.boolean(),
    defaultModelState: z.union(['enabled', 'disabled']),
    models: z.dict(z.union(['enabled', 'disabled'])).default({}),
  })).default({}).volatile(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    companionModelPolicy: CompanionModelPolicy
  }
}

/** Settings-backed policy resolver; adapters remain the enforcement points. */
export class CompanionModelPolicy extends Service {
  static Config = Config

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'companionModelPolicy')
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  }

  /** Whether one exact provider/model route is enabled, optionally inheriting its family policy. */
  isEnabled(provider: string, model: string, family?: string): boolean {
    return modelEnabled({
      defaultModelState: this.config.defaultModelState.get(),
      providers: this.config.providers.get(),
    }, provider, model, family)
  }
}

/** Resolve one exact route without requiring a mounted Cordis service. */
export function modelEnabled(config: ModelPolicyValue, provider: string, model: string, family?: string): boolean {
  const routePolicy = config.providers?.[provider]
  const familyPolicy = family === undefined ? undefined : config.providers?.[family]
  const policy = routePolicy ?? familyPolicy
  if (policy?.enabled === false) return false
  const override = policy?.models?.[model]
  if (override !== undefined) return override === 'enabled'
  const defaultState = routePolicy?.defaultModelState ?? familyPolicy?.defaultModelState
  if (defaultState !== undefined) return defaultState === 'enabled'
  return (config.defaultModelState ?? 'enabled') === 'enabled'
}

export default CompanionModelPolicy
