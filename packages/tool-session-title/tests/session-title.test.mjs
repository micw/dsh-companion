import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, requireTitleAgent } from '../lib/index.js'

function fixture() {
  const session = { id: 'current', header: { isSeeded: false }, isOwnSeq: seq => seq >= 4 }
  const agent = { id: 'root', status: 'running', session }
  let current = agent
  let live = agent
  let roots = [agent]
  let title
  let registered
  let context
  const proposals = []
  const ctx = {
    agents: {
      get: () => live,
      currentInitiator: () => current,
      roots: () => roots,
    },
    sessionTitle: {
      get: () => title,
      proposeFromAgent: (...args) => {
        proposals.push(args)
        return title
      },
    },
    systemPrompt: { context: value => { context = value } },
    tools: { register: value => { registered = value } },
  }
  apply(ctx)
  return {
    ctx, agent, session, proposals,
    get tool() { return registered },
    get context() { return context },
    setTitle(value) { title = value },
    setCurrent(value) { current = value },
    setLive(value) { live = value },
    setRoots(value) { roots = value },
  }
}

test('live title context follows canonical revisions and restored sessions', () => {
  const state = fixture()
  assert.equal(state.context.text({ agent: state.agent }), '')
  const guidance = '\nIf the latest user request starts a distinct primary task that this title no longer describes, call set_session_title once with a concise replacement. Keep the title for follow-ups and subtasks.'
  state.setTitle({ title: 'First task', source: { kind: 'fallback' } })
  assert.equal(state.context.text({ agent: state.agent }), `Current session title: First task${guidance}`)
  state.setTitle({ title: 'Restored task', source: { kind: 'provider' } })
  assert.equal(state.context.text({ agent: state.agent }), `Current session title: Restored task${guidance}`)
  state.setTitle({ title: 'My chosen title', source: { kind: 'user' } })
  assert.equal(state.context.text({ agent: state.agent }),
    'Current session title (set by the user; do not change it): My chosen title')
  state.setRoots([])
  assert.equal(state.context.text({ agent: state.agent }), '')
})

test('fork context asks for a branch title until the child owns one', () => {
  const state = fixture()
  state.session.header.isSeeded = true
  state.setTitle({ title: 'Original', eventSeq: 2, messageSeqs: [1], source: { kind: 'user' } })
  assert.match(state.context.text({ agent: state.agent }), /This conversation is a fork/u)
  assert.match(state.context.text({ agent: state.agent }), /call set_session_title once/u)
  state.setTitle({ title: 'Branch', eventSeq: 6, messageSeqs: [5],
    source: { kind: 'provider', provider: 'dsh-companion/agent-title-tool' } })
  assert.equal(state.context.text({ agent: state.agent }),
    'Current session title: Branch\nIf the latest user request starts a distinct primary task that this title no longer describes, call set_session_title once with a concise replacement. Keep the title for follow-ups and subtasks.')
})

test('tool description distinguishes a new primary task from follow-ups and protects user titles', () => {
  const state = fixture()
  assert.equal(state.tool.description,
    'Keep the session title aligned with the current primary user task. When a new user request starts a distinct task that the current title no longer describes, set a concise replacement once. Do not rename for follow-ups or subtasks, and do not change a title set by the user.')
})

test('tool rejects absent, stale, idle, detached, and child callers at execution', async () => {
  const state = fixture()
  const signal = new AbortController().signal
  assert.throws(() => requireTitleAgent(state.ctx, { signal }), /calling agent/)
  const other = { ...state.agent }
  state.setLive(other)
  assert.throws(() => requireTitleAgent(state.ctx, { agent: state.agent, signal }), /exact live/)
  state.setLive(state.agent)
  state.agent.status = 'idle'
  assert.throws(() => requireTitleAgent(state.ctx, { agent: state.agent, signal }), /exact live/)
  state.agent.status = 'running'
  state.setCurrent(other)
  assert.throws(() => requireTitleAgent(state.ctx, { agent: state.agent, signal }), /exact live/)
  state.setCurrent(state.agent)
  state.setRoots([])
  assert.throws(() => requireTitleAgent(state.ctx, { agent: state.agent, signal }), /top-level/)
  assert.equal(state.proposals.length, 0)
})

test('tool proposes only for current session and reports pinned or accepted title', async () => {
  const state = fixture()
  const signal = new AbortController().signal
  const execute = state.tool.execute
  assert.deepEqual(await execute({ title: 'Topic' }, { agent: state.agent, signal }), { updated: false })
  assert.deepEqual(state.proposals, [[state.session, 'Topic', 'dsh-companion/agent-title-tool', signal]])
  state.setTitle({ title: 'Normalized topic' })
  assert.deepEqual(await execute({ title: 'Topic' }, { agent: state.agent, signal }), {
    updated: true, title: 'Normalized topic',
  })
})
