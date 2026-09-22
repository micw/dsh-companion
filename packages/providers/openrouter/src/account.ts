/** OpenRouter API-key status projection into Companion account snapshots. */

import type {
  CompanionAllowanceGroup,
  CompanionProviderAccountView,
} from '@dsh-companion/provider-account'
import { OPENROUTER_PROVIDER } from './catalog.js'
import type { OpenRouterKeyStatus } from './client.js'

/** Project one validated key observation without retaining the credential. */
export function projectOpenRouterAccount(status: OpenRouterKeyStatus): CompanionProviderAccountView {
  const allowances: CompanionAllowanceGroup[] = []
  const free = status.free_model_daily_requests
  if (free.limit > 0) {
    allowances.push({
      id: 'free-model-daily-requests',
      name: 'Free model requests',
      primary: {
        usedPercent: percent(free.used, free.limit),
        windowSeconds: 86_400,
        resetsAt: nextUtcDay(),
      },
    })
  }
  if (status.limit !== null && status.limit > 0 && status.limit_remaining !== null) {
    allowances.push({
      id: 'key-credit-limit',
      name: 'API key spending cap',
      primary: { usedPercent: percent(status.limit - status.limit_remaining, status.limit) },
    })
  }
  return {
    provider: OPENROUTER_PROVIDER,
    accountStatus: 'ready',
    identity: { displayName: status.label },
    plan: status.is_free_tier
      ? { id: 'free', name: 'Free tier' }
      : { id: 'credits-purchased', name: 'Credits purchased' },
    allowances,
  }
}

function percent(used: number, limit: number): number {
  return Math.max(0, Math.min(100, used / limit * 100))
}

function nextUtcDay(now = Date.now()): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) / 1000
}
