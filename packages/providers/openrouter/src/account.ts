/** OpenRouter API-key status projection into Companion account snapshots. */

import type {
  CompanionAllowanceGroup,
  CompanionProviderAccountView,
} from '@dsh-companion/provider-account'
import { OPENROUTER_PROVIDER } from './catalog.js'
import type { OpenRouterKeyStatus } from './client.js'

/** Project one validated key observation without retaining the credential. */
export function projectOpenRouterAccount(status: OpenRouterKeyStatus): CompanionProviderAccountView {
  const now = Date.now()
  const allowances: CompanionAllowanceGroup[] = []
  if (status.limit !== null && status.limit > 0 && status.limit_remaining !== null) {
    allowances.push({
      id: 'key-credit-limit',
      name: 'API key spending cap',
      primary: {
        usedPercent: percent(status.limit - status.limit_remaining, status.limit),
        monetary: {
          currency: 'USD',
          limitNanos: usdNanos(status.limit),
          remainingNanos: usdNanos(status.limit_remaining),
        },
        ...keyResetWindow(status.limit_reset, now),
      },
    })
  }
  const free = status.free_model_daily_requests
  if (free.limit > 0) {
    allowances.push({
      id: 'free-model-daily-requests',
      name: 'Free model requests',
      primary: {
        usedPercent: percent(free.used, free.limit),
        windowSeconds: 86_400,
        resetsAt: nextUtcDay(now),
      },
    })
  }
  return {
    provider: OPENROUTER_PROVIDER,
    accountStatus: 'ready',
    identity: { displayName: status.label },
    allowances,
  }
}

function percent(used: number, limit: number): number {
  return Math.max(0, Math.min(100, used / limit * 100))
}

function usdNanos(value: number): number {
  const nanos = Math.round(value * 1_000_000_000)
  if (!Number.isSafeInteger(nanos)) throw new Error('OpenRouter key amount exceeds safe USD nanos')
  return nanos
}

function nextUtcDay(now = Date.now()): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) / 1000
}

function keyResetWindow(reset: OpenRouterKeyStatus['limit_reset'], now: number): {
  readonly windowSeconds?: number
  readonly resetsAt?: number
  readonly resetsInSeconds?: number
} {
  if (reset === null) return { resetsInSeconds: -1 }
  const date = new Date(now)
  if (reset === 'daily') return { windowSeconds: 86_400, resetsAt: nextUtcDay(now) }
  if (reset === 'weekly') {
    const days = (8 - date.getUTCDay()) % 7 || 7
    return {
      windowSeconds: 7 * 86_400,
      resetsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days) / 1000,
    }
  }
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  return { windowSeconds: (end - start) / 1000, resetsAt: end / 1000 }
}
