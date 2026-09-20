/** DSH Companion profile bundle runtime support. */

import { Context, Service } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'

/** Absolute location of the system presets shipped by DSH Companion. */
export class CompanionPresetRoot extends Service {
  readonly path = fileURLToPath(new URL('../presets', import.meta.url))

  constructor(ctx: Context) {
    super(ctx, 'companionPresetRoot')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    companionPresetRoot: CompanionPresetRoot
  }
}

export default CompanionPresetRoot
