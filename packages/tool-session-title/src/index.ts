/** Model-facing title proposals and canonical session-title prompt context. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'tool-session-title'
export const inject = ['agents', 'tools', 'systemPrompt', 'sessionTitle']

const TITLE_PROVIDER_ID = SessionTitleProviderId('dsh-companion/agent-title-tool')

/** Require the exact active root agent at tool execution, not registration time. */
export function requireTitleAgent(ctx: Context, exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new HarnessError('set_session_title requires a calling agent', 'SESSION_TITLE_AGENT_REQUIRED')
  }
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent || !ctx.agents.roots().includes(agent)) {
    throw new HarnessError(
      'set_session_title requires the exact live top-level calling agent inside its active driver',
      'SESSION_TITLE_DRIVER_REQUIRED',
    )
  }
  return agent
}

/** Install a session-only title tool and a user-role snapshot of the canonical title. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.context({
    name: 'dsh-companion:session-title',
    order: 125,
    text: ({ agent }) => {
      if (agent === undefined || ctx.agents.get(agent.id) !== agent || !ctx.agents.roots().includes(agent)) return ''
      const title = ctx.sessionTitle.get(agent.session)
      if (title === undefined) return ''
      if (title.source.kind === 'user') return `Current session title (set by the user; do not change it): ${title.title}`
      return `Current session title: ${title.title}\nIf the latest user request starts a distinct primary task that this title no longer describes, call set_session_title once with a concise replacement. Keep the title for follow-ups and subtasks.`
    },
  })

  ctx.tools.register(defineTool({
    name: 'set_session_title',
    description: 'Keep the session title aligned with the current primary user task. When a new user request starts a distinct task that the current title no longer describes, set a concise replacement once. Do not rename for follow-ups or subtasks, and do not change a title set by the user.',
    parameters: {
      title: { type: 'string', required: true, description: 'Concise title for the current session.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          updated: { type: 'boolean', required: true },
          title: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      const agent = requireTitleAgent(ctx, exec)
      const accepted = ctx.sessionTitle.proposeFromAgent(agent.session, args.title, TITLE_PROVIDER_ID, exec.signal)
      return Promise.resolve(accepted === undefined
        ? { updated: false }
        : { updated: true, title: accepted.title })
    },
    presentCall: args => ({ card: 'generic', title: 'Set session title', kind: 'other', rawInput: args.title }),
  }))
}
