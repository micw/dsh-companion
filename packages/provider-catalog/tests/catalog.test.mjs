import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import CompanionProviderCatalog, { CompanionProviderId } from '../lib/index.js'

test('shares one refresh and publishes only after durable LKG storage', async () => {
  const harness = await setup()
  const gate = deferred()
  let loads = 0
  const source = fixtureSource(async () => {
    loads += 1
    return gate.promise
  })
  const registration = harness.service.register(source)
  const first = harness.service.refresh(source.provider)
  const second = harness.service.refresh(source.provider)
  assert.equal(first, second)
  assert.equal(loads, 1)
  assert.equal(harness.service.snapshot(source.provider).refreshing, true)

  gate.resolve({ models: [{ id: 'model-1', name: 'Model 1' }] })
  const snapshot = await first
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.generation, 1)
  assert.equal(snapshot.models[0].id, 'model-1')
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(harness.records.get(source.provider).generation, 1)
  assert.deepEqual(harness.service.snapshot(source.provider).models, snapshot.models)
  assert.equal(registration.current().generation, 1)
  assert.equal(Object.isFrozen(registration.current().payload), true)
  await harness.dispose()
})

test('restores a matching generation as stale and keeps it after refresh failure', async () => {
  const records = new Map([['fixture-provider', {
    identity: 'endpoint-a',
    generation: 4,
    refreshedAt: 100,
    payload: { models: [{ id: 'cached', name: 'Cached' }] },
  }]])
  const harness = await setup(records)
  const source = fixtureSource(async () => { throw new Error('provider offline') })
  harness.service.register(source)
  await assert.rejects(harness.service.refresh(source.provider), /provider offline/u)
  const snapshot = harness.service.snapshot(source.provider)
  assert.equal(snapshot.status, 'stale')
  assert.equal(snapshot.generation, 4)
  assert.equal(snapshot.error, 'provider offline')
  assert.deepEqual(snapshot.models.map(model => model.id), ['cached'])
  assert.deepEqual(harness.service.list().map(item => item.provider), [source.provider])
  await harness.dispose()
})

test('ignores an LKG from another non-secret source identity', async () => {
  const records = new Map([['fixture-provider', {
    identity: 'old-endpoint',
    generation: 2,
    refreshedAt: 100,
    payload: { models: [{ id: 'old', name: 'Old' }] },
  }]])
  const harness = await setup(records)
  const gate = deferred()
  const source = fixtureSource(() => gate.promise, 'new-endpoint')
  const registration = harness.service.register(source)
  assert.equal(harness.service.snapshot(source.provider).status, 'unavailable')
  assert.deepEqual(harness.service.snapshot(source.provider).models, [])
  registration()
  gate.reject(new Error('disposed'))
  await harness.dispose()
})

test('source replacement aborts publication from the superseded operation', async () => {
  const harness = await setup()
  const oldGate = deferred()
  const oldSource = fixtureSource(() => oldGate.promise, 'endpoint-a')
  const registration = harness.service.register(oldSource)
  const oldRefresh = harness.service.refresh(oldSource.provider)
  const nextSource = fixtureSource(async () => ({ models: [{ id: 'new', name: 'New' }] }), 'endpoint-b')
  registration.replace(nextSource)
  oldGate.resolve({ models: [{ id: 'old', name: 'Old' }] })
  await assert.rejects(oldRefresh)
  const current = await harness.service.refresh(nextSource.provider)
  assert.deepEqual(current.models.map(model => model.id), ['new'])
  assert.equal(harness.records.get(nextSource.provider).identity, 'endpoint-b')
  await harness.dispose()
})

function fixtureSource(load, identity = 'endpoint-a') {
  const provider = CompanionProviderId('fixture-provider')
  return {
    provider,
    identity,
    load,
    decode(value) {
      if (typeof value !== 'object' || value === null || !Array.isArray(value.models)) throw new Error('invalid fixture payload')
      return value
    },
    project(payload) {
      return {
        provider,
        models: payload.models.map(model => ({ ...model, hidden: false })),
      }
    },
  }
}

async function setup(seed = new Map()) {
  const records = seed
  const table = {
    get: key => records.get(key),
    entries: () => new Map(records).entries(),
    keys: () => new Map(records).keys(),
    get size() { return records.size },
    async put(key, value) { records.set(key, structuredClone(value)) },
    async delete(key) { return records.delete(key) },
    async update(key, transform) {
      const current = records.get(key)
      if (current === undefined) throw new Error('missing')
      const next = transform(current)
      records.set(key, next)
      return next
    },
  }
  const ctx = new Context()
  ctx.provide('storageDomain', {
    async open() {
      return { table: () => table, close: async () => {} }
    },
  })
  const service = new CompanionProviderCatalog(ctx)
  await service[Service.init]()
  return { service, records, dispose: () => ctx.fiber.dispose() }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
