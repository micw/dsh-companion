import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { CompanionProviderId } from '@dsh-companion/provider-catalog'
import CompanionProviderAccounts from '../lib/index.js'

const provider = CompanionProviderId('fixture-provider')

test('shares refreshes and publishes immutable account snapshots', async () => {
  const ctx = new Context()
  const service = new CompanionProviderAccounts(ctx)
  const gate = deferred()
  let loads = 0
  const registration = service.register(source(async () => {
    loads += 1
    return gate.promise
  }))
  const first = service.refresh(provider)
  assert.equal(first, service.refresh(provider))
  assert.equal(loads, 1)
  gate.resolve(view('plus', 10))
  const snapshot = await first
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.value.plan.id, 'plus')
  assert.equal(snapshot.value.allowances[0].primary.usedPercent, 10)
  assert.equal(Object.isFrozen(snapshot.value.allowances), true)
  assert.equal(registration.current(), snapshot)
  await ctx.fiber.dispose()
})

test('keeps the latest in-process observation when a refresh fails', async () => {
  const ctx = new Context()
  const service = new CompanionProviderAccounts(ctx)
  const registration = service.register(source(async () => { throw new Error('usage unavailable') }))
  registration.publish(view('pro', 25))
  await assert.rejects(service.refresh(provider), /usage unavailable/u)
  const snapshot = service.snapshot(provider)
  assert.equal(snapshot.status, 'stale')
  assert.equal(snapshot.value.plan.id, 'pro')
  assert.equal(snapshot.error, 'usage unavailable')
  await ctx.fiber.dispose()
})

test('replacement aborts the old source and resets account identity', async () => {
  const ctx = new Context()
  const service = new CompanionProviderAccounts(ctx)
  const gate = deferred()
  const registration = service.register(source(() => gate.promise, 'account-a'))
  const old = service.refresh(provider)
  registration.replace(source(async () => view('new-plan', 1), 'account-b'))
  gate.resolve(view('old-plan', 99))
  await assert.rejects(old)
  const snapshot = await service.refresh(provider)
  assert.equal(snapshot.value.plan.id, 'new-plan')
  assert.equal(snapshot.value.allowances[0].primary.usedPercent, 1)
  await ctx.fiber.dispose()
})

test('isolates listener failures and removes state on disposal', async () => {
  const ctx = new Context()
  const service = new CompanionProviderAccounts(ctx)
  let observed = 0
  service.subscribe(() => { throw new Error('listener failure') })
  service.subscribe(() => { observed += 1 })
  const registration = service.register(source(async () => view('plus', 0)))
  await service.refresh(provider)
  assert.ok(observed >= 2)
  registration()
  assert.equal(service.snapshot(provider), undefined)
  await ctx.fiber.dispose()
})

function source(refresh, identity = 'account-a') {
  return { provider, identity, refresh }
}

function view(plan, usedPercent) {
  return {
    provider,
    accountStatus: 'ready',
    plan: { id: plan, name: plan.toUpperCase() },
    allowances: [{
      id: 'global',
      primary: { usedPercent, windowSeconds: 604800 },
    }],
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
