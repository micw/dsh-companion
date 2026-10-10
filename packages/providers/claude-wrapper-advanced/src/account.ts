/** Claude quota projection into Companion provider-account snapshots. */
import type { CompanionAllowanceGroup, CompanionProviderAccountView } from '@dsh-companion/provider-account'
import { CLAUDE_WRAPPER_ADVANCED_PROVIDER } from './catalog.js'
import type { ClaudeWireUsageReport } from './wire/types.js'

export class ClaudeAccountProjection {
  private current: ClaudeWireUsageReport | undefined
  acceptUsage(report: ClaudeWireUsageReport): CompanionProviderAccountView { this.current = report; return this.view() }
  acceptTurn(report: ClaudeWireUsageReport, limitGroups: readonly string[] = []): CompanionProviderAccountView {
    this.current = report
    return this.view(limitGroups)
  }
  view(limitGroups: readonly string[] = []): CompanionProviderAccountView {
    if (this.current === undefined) throw new Error('Claude Wrapper Advanced account has no observation')
    const allowances = this.current.groups.map(projectGroup)
    const activeAllowance = limitGroups.find(id => allowances.some(group => group.id === id))
    return {
      provider: CLAUDE_WRAPPER_ADVANCED_PROVIDER,
      accountStatus: 'ready',
      ...activeAllowance === undefined ? {} : { activeAllowance },
      allowances,
    }
  }
}
function projectGroup(group: ClaudeWireUsageReport['groups'][number]): CompanionAllowanceGroup {
  const windows = group.windows.map(window => ({ usedPercent: window.usedPercent, ...window.windowSeconds === undefined ? {} : { windowSeconds: window.windowSeconds }, ...window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt } }))
  return {
    id: group.id,
    ...group.observedAt === undefined ? {} : { observedAt: group.observedAt * 1000 },
    ...group.ageSeconds === undefined ? {} : { ageSeconds: group.ageSeconds },
    ...windows[0] === undefined ? {} : { primary: windows[0] },
    ...windows[1] === undefined ? {} : { secondary: windows[1] },
  }
}
