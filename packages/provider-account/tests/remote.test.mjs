import assert from 'node:assert/strict'
import test from 'node:test'
import remote from '../lib/typert.remote-client.js'

test('publishes strict list and cancellable refresh Remote descriptors', () => {
  assert.equal(remote.package, '@dsh-companion/provider-account')
  assert.deepEqual(remote.descriptors.map(descriptor => ({
    endpoint: `${descriptor.namespace}/${descriptor.method}`,
    mode: descriptor.result.mode,
    cancellation: descriptor.cancellation,
  })), [
    { endpoint: 'companionProviderAccounts/list', mode: 'strict', cancellation: undefined },
    {
      endpoint: 'companionProviderAccounts/refresh',
      mode: 'strict',
      cancellation: { parameter: 'signal' },
    },
  ])
  assert.equal(remote.descriptors[0].result.schema.safeParse([]).success, true)
  assert.equal(remote.descriptors[1].parameters[0].codec.schema.safeParse('provider').success, true)
})
