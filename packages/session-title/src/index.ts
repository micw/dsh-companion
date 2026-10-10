/** Remote access to DSH-owned live session title refresh. */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import '@deepseek-ai/dsh-session-title'

declare module '@deepseek-ai/cordis' {
  interface Context {
    companionSessionTitle: CompanionSessionTitle
  }
}

/** Exposes explicit title regeneration without retaining a second title state. */
export class CompanionSessionTitle extends TypertRemoteService {
  static inject = ['sessions', 'sessionTitle']

  constructor(ctx: Context) {
    super(ctx, 'companionSessionTitle')
  }

  /** Refresh only an existing live session; absent sessions have no title to refresh. */
  @Remote('refreshTitle')
  async refreshTitle(sessionId: string, signal: AbortSignal): Promise<string | undefined> {
    signal.throwIfAborted()
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.trim() !== sessionId) {
      throw new Error('A nonempty canonical session id is required')
    }
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined) throw new Error(`Session ${JSON.stringify(sessionId)} is not live`)
    const snapshot = await this.ctx.sessionTitle.refresh(session, signal)
    return snapshot?.title
  }

  /** Release only a fork-inherited user pin so the branch agent may set its own title. */
  @Remote('prepareForkTitle')
  async prepareForkTitle(sessionId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.trim() !== sessionId) {
      throw new Error('A nonempty canonical session id is required')
    }
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined || !session.header.isSeeded || session.header.origin === 'subagent') {
      throw new Error('A live ordinary fork is required')
    }
    const title = this.ctx.sessionTitle.get(session)
    if (title?.source.kind === 'user' && !session.isOwnSeq(title.eventSeq)) {
      await this.ctx.sessionTitle.refresh(session, signal)
    }
  }
}

export default CompanionSessionTitle
