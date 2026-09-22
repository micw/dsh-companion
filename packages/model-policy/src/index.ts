/** DSH Settings-backed user intent for provider and model enablement. */

import { Context, Service } from '@deepseek-ai/cordis'
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
  readonly defaultModelState?: 'enabled' | 'disabled'
  readonly providers?: Readonly<Record<string, ProviderModelPolicy>>
}

/** Runtime schema for the shared policy namespace. */
export const Config: z<Config> = z.object({
  defaultModelState: z.union(['enabled', 'disabled']).default('enabled'),
  providers: z.dict(z.object({
    enabled: z.boolean(),
    defaultModelState: z.union(['enabled', 'disabled']),
    models: z.dict(z.union(['enabled', 'disabled'])).default({}),
  })).default({}),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    companionModelPolicy: CompanionModelPolicy
  }
}

/** Settings-backed policy resolver; adapters remain the enforcement points. */
export class CompanionModelPolicy extends Service {
  static inject = ['settings']
  static Config: z<Config> = Config

  private source: () => Config

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'companionModelPolicy')
    this.source = () => config
  }

  /** Register the durable user layer after the Settings service is available. */
  protected [Service.init](): void {
    this.ctx.settings.installSection(
      this.ctx,
      COMPANION_MODEL_POLICY_SETTINGS_NAMESPACE,
      Config,
      this.config,
      {
        setSource: source => { this.source = source },
        onChange: () => {
          // Every decision reads the source; this service retains no derived policy state to rebuild.
        },
      },
    )
  }

  /** Whether one exact provider/model route is enabled, optionally inheriting its family policy. */
  isEnabled(provider: string, model: string, family?: string): boolean {
    return modelEnabled(this.source(), provider, model, family)
  }
}

/** Resolve one exact route without requiring a mounted Cordis service. */
export function modelEnabled(config: Config, provider: string, model: string, family?: string): boolean {
  const policy = config.providers?.[provider] ?? (family === undefined ? undefined : config.providers?.[family])
  if (policy?.enabled === false) return false
  const override = policy?.models?.[model]
  if (override !== undefined) return override === 'enabled'
  if (policy?.defaultModelState !== undefined) return policy.defaultModelState === 'enabled'
  return (config.defaultModelState ?? 'enabled') === 'enabled'
}

export default CompanionModelPolicy
