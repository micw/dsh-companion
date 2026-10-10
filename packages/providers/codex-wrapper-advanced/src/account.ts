/** Codex-specific merge of complete usage polls and partial per-turn allowance observations. */

import type {
  CompanionAllowanceGroup,
  CompanionProviderAccountView,
  CompanionProviderCredits,
} from '@dsh-companion/provider-account'
import { CODEX_WRAPPER_ADVANCED_PROVIDER } from './catalog.js'
import type {
  CodexWireAccount,
  CodexWireLimitGroup,
  CodexWireTurnLimits,
  CodexWireUsageReport,
} from './wire/types.js'

/** Stateful merge owned by one endpoint/credential identity. */
export class CodexAccountProjection {
  private account: CodexWireAccount = {}
  private groups = new Map<string, CodexWireLimitGroup>()
  private activeGroup: string | undefined
  private available = false

  /** Replace complete polled facts while preserving the last turn's active group. */
  acceptUsage(report: CodexWireUsageReport): CompanionProviderAccountView {
    this.account = report.account
    this.groups = new Map(report.limits.groups.map(group => [group.id, group]))
    if (this.activeGroup !== undefined && !this.groups.has(this.activeGroup)) this.activeGroup = undefined
    this.available = true
    return this.view()
  }

  /** Merge one turn's partial groups without deleting groups only the poll can see. */
  acceptTurn(turn: CodexWireTurnLimits): CompanionProviderAccountView {
    this.account = mergeAccount(this.account, turn.account)
    for (const group of turn.limits.groups) this.groups.set(group.id, group)
    if (turn.limits.activeGroup !== undefined) this.activeGroup = turn.limits.activeGroup
    this.available = true
    return this.view()
  }

  /** Current provider-neutral account view. */
  view(): CompanionProviderAccountView {
    if (!this.available) throw new Error('Codex Wrapper Advanced account has no observation')
    const plan = this.account.plan
    const credits = projectCredits(this.account)
    return {
      provider: CODEX_WRAPPER_ADVANCED_PROVIDER,
      accountStatus: 'ready',
      ...plan === undefined
        ? {}
        : { plan: { id: plan.id, ...plan.name === undefined ? {} : { name: plan.name } } },
      ...credits === undefined ? {} : { credits },
      ...this.activeGroup === undefined ? {} : { activeAllowance: this.activeGroup },
      allowances: [...this.groups.values()].map(projectGroup),
    }
  }
}

function mergeAccount(current: CodexWireAccount, turn: CodexWireAccount): CodexWireAccount {
  const currentCredits = current.credits
  const turnCredits = turn.credits
  return {
    ...current,
    ...turn,
    ...currentCredits === undefined && turnCredits === undefined
      ? {}
      : { credits: { ...currentCredits, ...turnCredits } },
  }
}

function projectCredits(account: CodexWireAccount): CompanionProviderCredits | undefined {
  const credits = account.credits
  if (credits === undefined) return undefined
  return {
    ...credits.hasCredits === undefined ? {} : { hasCredits: credits.hasCredits },
    ...credits.unlimited === undefined ? {} : { unlimited: credits.unlimited },
    ...credits.balance === undefined ? {} : { balance: credits.balance },
    ...credits.overageLimitReached === undefined ? {} : { overageLimitReached: credits.overageLimitReached },
    ...credits.approxCloudMessages === undefined
      ? {}
      : { approximateCloudMessages: credits.approxCloudMessages },
    ...credits.approxLocalMessages === undefined
      ? {}
      : { approximateLocalMessages: credits.approxLocalMessages },
  }
}

function projectGroup(group: CodexWireLimitGroup): CompanionAllowanceGroup {
  return {
    id: group.id,
    ...group.name === undefined ? {} : { name: group.name },
    ...group.reached === undefined ? {} : { reached: group.reached },
    ...group.primary === undefined ? {} : { primary: { ...group.primary } },
    ...group.secondary === undefined ? {} : { secondary: { ...group.secondary } },
  }
}
