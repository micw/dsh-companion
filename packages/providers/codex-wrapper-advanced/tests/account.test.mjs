import assert from 'node:assert/strict'
import test from 'node:test'
import { CodexAccountProjection } from '../lib/index.js'

test('merges partial turn limits without deleting poll-only groups and account facts', () => {
  const projection = new CodexAccountProjection()
  projection.acceptUsage({
    account: {
      plan: { id: 'prolite', name: 'Pro Lite' },
      credits: {
        hasCredits: true,
        balance: '12.50',
        overageLimitReached: false,
      },
    },
    limits: {
      groups: [
        group('global', 10, false),
        group('codex_bengalfox', 20, false, 'Spark'),
      ],
    },
  })

  const view = projection.acceptTurn({
    account: {
      plan: { id: 'prolite', name: 'Pro Lite' },
      credits: { balance: '12.25' },
    },
    limits: {
      activeGroup: 'codex_bengalfox',
      groups: [group('codex_bengalfox', 21)],
    },
  })

  assert.equal(view.activeAllowance, 'codex_bengalfox')
  assert.deepEqual(view.allowances.map(item => item.id), ['global', 'codex_bengalfox'])
  assert.equal(view.allowances[0].primary.usedPercent, 10)
  assert.equal(view.allowances[1].primary.usedPercent, 21)
  assert.deepEqual(view.credits, {
    hasCredits: true,
    balance: '12.25',
    overageLimitReached: false,
  })
})

test('a complete poll replaces groups but preserves a still-existing active group', () => {
  const projection = new CodexAccountProjection()
  projection.acceptTurn({
    account: {},
    limits: { activeGroup: 'global', groups: [group('global', 5)] },
  })
  const current = projection.acceptUsage({
    account: { plan: { id: 'plus' } },
    limits: { groups: [group('global', 6), group('other', 1)] },
  })
  assert.equal(current.activeAllowance, 'global')
  assert.deepEqual(current.allowances.map(item => item.id), ['global', 'other'])

  const replaced = projection.acceptUsage({
    account: { plan: { id: 'plus' } },
    limits: { groups: [group('other', 2)] },
  })
  assert.equal(replaced.activeAllowance, undefined)
})

test('refuses a view before either account source has produced an observation', () => {
  assert.throws(() => new CodexAccountProjection().view(), /no observation/u)
})

function group(id, usedPercent, reached, name) {
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(reached === undefined ? {} : { reached }),
    primary: { usedPercent, windowSeconds: 604800 },
  }
}
