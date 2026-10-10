import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.js'

const titleConfig = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionTitleService, titleConfig)
  apply(ctx)
  const session = ctx.sessions.create(SessionId(`companion-title-${crypto.randomUUID()}`))
  const agent = { id: session.id, session, ctx, status: 'running', options: {} }
  await ctx.agents.register(agent)
  const human = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Build an editor extension' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return { ctx, session, agent, human }
}

async function call({ ctx, agent }, title) {
  return ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`title-call-${crypto.randomUUID()}`),
    name: 'set_session_title',
    arguments: { title },
    agent,
  }))
}

test('DSH executor commits a root Agent proposal with durable model provenance', async () => {
  const f = await fixture()
  try {
    const result = await call(f, 'A new architecture topic')
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.deepEqual(result.value, { updated: true, title: 'A new architecture topic' })
    const event = f.session.snapshotEvents().findLast(item => item.type === 'session/title')
    assert.equal(event.data.title, 'A new architecture topic')
    assert.deepEqual(event.data.messageSeqs, [f.human.seq])
    assert.deepEqual(event.data.source, {
      kind: 'provider', provider: 'dsh-companion/agent-title-tool',
    })
    assert.equal(f.ctx.sessionTitle.get(f.session).title, event.data.title)
  } finally {
    await f.ctx.fiber.dispose()
  }
})

test('DSH executor preserves a manually pinned title from the Agent Tool', async () => {
  const f = await fixture()
  try {
    f.ctx.sessionTitle.rename(f.session, 'My chosen title')
    const result = await call(f, 'Model suggestion')
    assert.equal(result.isError, false, JSON.stringify(result.content))
    assert.deepEqual(result.value, { updated: false })
    assert.equal(f.ctx.sessionTitle.get(f.session).title, 'My chosen title')
  } finally {
    await f.ctx.fiber.dispose()
  }
})
