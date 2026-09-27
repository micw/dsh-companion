import assert from 'node:assert/strict'
import test from 'node:test'
import remote from '../lib/typert.remote-client.js'

test('publishes strict list and cancellable refresh Remote descriptors', () => {
  assert.equal(remote.package, '@dsh-companion/provider-catalog')
  assert.deepEqual(remote.descriptors.map(descriptor => ({
    endpoint: `${descriptor.namespace}/${descriptor.method}`,
    mode: descriptor.result.mode,
    cancellation: descriptor.cancellation,
  })), [
    { endpoint: 'companionProviderCatalog/list', mode: 'strict', cancellation: undefined },
    {
      endpoint: 'companionProviderCatalog/refresh',
      mode: 'strict',
      cancellation: { parameter: 'signal' },
    },
  ])
  const [list, refresh] = remote.descriptors
  assert.equal(list.result.create().safeParse([]).success, true)
  assert.equal(list.result.create().safeParse([{ provider: 'x' }]).success, false)
  assert.equal(refresh.parameters[0].codec.create().safeParse('codex-wrapper-advanced').success, true)
  assert.equal(refresh.parameters[0].codec.create().safeParse(1).success, false)
})
