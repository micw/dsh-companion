import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeOpenRouterKeyStatus, projectOpenRouterAccount } from '../lib/index.js'
import { keyPayload } from './fixture.mjs'

test('projects key credits and request allowances without retaining the secret', () => {
  const status = decodeOpenRouterKeyStatus(keyPayload())
  const view = projectOpenRouterAccount(status)
  assert.equal(view.provider, 'openrouter')
  assert.deepEqual(view.identity, { displayName: 'Companion key' })
  assert.deepEqual(view.plan, { id: 'paid', name: 'Paid' })
  assert.deepEqual(view.credits, { unlimited: false, balance: '15', hasCredits: true })
  assert.equal(view.allowances[0].primary.usedPercent, 20)
  assert.equal(view.allowances[1].primary.usedPercent, 25)
  assert.equal(JSON.stringify(view).includes('secret'), false)
})

test('rejects malformed finite usage and free-request counters', () => {
  const malformed = keyPayload()
  malformed.data.usage = Number.POSITIVE_INFINITY
  assert.throws(() => decodeOpenRouterKeyStatus(malformed), /non-negative and finite/u)
  const negative = keyPayload()
  negative.data.free_model_daily_requests.remaining = -1
  assert.throws(() => decodeOpenRouterKeyStatus(negative), /natural safe integer/u)
})
