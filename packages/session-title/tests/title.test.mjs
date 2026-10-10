import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import CompanionSessionTitle from '../lib/index.js'
import remote from '../lib/typert.remote-client.js'

test('generated Remote descriptor validates arguments, title, and cancellation', () => {
  assert.equal(remote.package, '@dsh-companion/session-title')
  const [descriptor] = remote.descriptors
  assert.equal(remote.descriptors.length, 1)
  assert.equal(`${descriptor.namespace}/${descriptor.method}`, 'companionSessionTitle/refreshTitle')
  assert.deepEqual(descriptor.cancellation, { parameter: 'signal' })
  assert.equal(descriptor.parameters[0].codec.create().safeParse('session-1').success, true)
  assert.equal(descriptor.parameters[0].codec.create().safeParse(3).success, false)
  assert.equal(descriptor.result.create().safeParse('Fresh title').success, true)
  assert.equal(descriptor.result.create().safeParse(undefined).success, true)
  assert.equal(descriptor.result.create().safeParse(3).success, false)
})

const config = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 40 }

async function fixture() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SessionTitleService, config)
  await ctx.plugin(CompanionSessionTitle)
  return ctx
}

test('refresh delegates the exact live session and returns DSH title', async () => {
  const ctx = await fixture()
  const session = ctx.sessions.create(SessionId('session-1'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', {
    content: [{ type: 'text', text: 'The original prompt title' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  ctx.sessionTitle.rename(session, 'Pinned custom title')
  const signal = new AbortController().signal
  const title = await ctx.companionSessionTitle.refreshTitle('session-1', signal)
  assert.equal(title, 'The original prompt title')
  assert.equal(ctx.sessionTitle.get(session).title, title)
  assert.notEqual(ctx.sessionTitle.get(session).source.kind, 'user')
  await assert.rejects(ctx.companionSessionTitle.refreshTitle('missing', signal), /not live/u)
  assert.equal(await ctx.companionSessionTitle.refreshTitle('session-1', signal), title)
  await ctx.fiber.dispose()
})

test('rejects invalid identifiers and aborted calls without mutating title', async () => {
  const ctx = await fixture()
  const session = ctx.sessions.create(SessionId('session-1'))
  ctx.sessionTitle.rename(session, 'Pinned custom title')
  const controller = new AbortController()
  for (const value of ['', ' session', 'session ']) {
    await assert.rejects(ctx.companionSessionTitle.refreshTitle(value, controller.signal), /canonical session id/u)
  }
  controller.abort(new Error('cancelled'))
  await assert.rejects(ctx.companionSessionTitle.refreshTitle('session-1', controller.signal), /cancelled/u)
  assert.equal(ctx.sessionTitle.get(session).title, 'Pinned custom title')
  await ctx.fiber.dispose()
})
