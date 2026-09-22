import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeOpenRouterKeyStatus, projectOpenRouterAccount } from '../lib/index.js'
import { keyPayload } from './fixture.mjs'

test('projects key limits as allowances without inventing an account balance', () => {
  const status = decodeOpenRouterKeyStatus(keyPayload())
  const view = projectOpenRouterAccount(status)
  assert.equal(view.provider, 'openrouter')
  assert.deepEqual(view.identity, { displayName: 'Companion key' })
  assert.equal(view.plan, undefined)
  assert.equal(view.credits, undefined)
  assert.equal(view.activeAllowance, undefined)
  assert.equal(view.allowances[0].name, 'API key spending cap')
  assert.equal(view.allowances[0].primary.usedPercent, 25)
  assert.deepEqual(view.allowances[0].primary.monetary, {
    currency: 'USD',
    limitNanos: 20_000_000_000,
    remainingNanos: 15_000_000_000,
  })
  assert.equal(view.allowances[0].primary.resetsInSeconds, -1)
  assert.equal(view.allowances[1].primary.usedPercent, 20)
  assert.equal(view.allowances[1].primary.windowSeconds, 86_400)
  assert.ok(view.allowances[1].primary.resetsAt < 100_000_000_000)
  assert.equal(JSON.stringify(view).includes('secret'), false)
})

test('projects every documented key spending-cap reset period', () => {
  for (const [reset, windowSeconds] of [['daily', 86_400], ['weekly', 604_800], ['monthly', undefined]]) {
    const payload = keyPayload()
    payload.data.limit_reset = reset
    const window = projectOpenRouterAccount(decodeOpenRouterKeyStatus(payload)).allowances[0].primary
    assert.ok(window.resetsAt > Date.now() / 1000)
    if (windowSeconds === undefined) {
      assert.ok(window.windowSeconds >= 28 * 86_400 && window.windowSeconds <= 31 * 86_400)
    } else {
      assert.equal(window.windowSeconds, windowSeconds)
    }
  }
})

test('rejects malformed finite usage and free-request counters', () => {
  const malformed = keyPayload()
  malformed.data.usage = Number.POSITIVE_INFINITY
  assert.throws(() => decodeOpenRouterKeyStatus(malformed), /non-negative and finite/u)
  const negative = keyPayload()
  negative.data.free_model_daily_requests.remaining = -1
  assert.throws(() => decodeOpenRouterKeyStatus(negative), /natural safe integer/u)
  const unknownReset = keyPayload()
  unknownReset.data.limit_reset = 'yearly'
  assert.throws(() => decodeOpenRouterKeyStatus(unknownReset), /daily, weekly, monthly, or null/u)
  const inconsistent = keyPayload()
  inconsistent.data.limit_remaining = 21
  assert.throws(() => decodeOpenRouterKeyStatus(inconsistent), /must not exceed limit/u)
})
