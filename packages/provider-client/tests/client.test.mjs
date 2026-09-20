import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { apply } from '../lib/types/client/index.js'

test('mounts both generated Remote contributions and disposes them in reverse order', async () => {
  const mounted = []
  const disposed = []
  const ctx = {
    remote: {
      async $mount(contribution) {
        mounted.push(contribution)
        return async () => { disposed.push(contribution.package) }
      },
    },
  }
  const dispose = await apply(ctx)
  assert.deepEqual(mounted.map(item => item.package), [
    '@dsh-companion/provider-catalog',
    '@dsh-companion/provider-account',
  ])
  await dispose()
  assert.deepEqual(disposed, [
    '@dsh-companion/provider-account',
    '@dsh-companion/provider-catalog',
  ])
})

test('rolls back an earlier Remote mount when the next contribution fails', async () => {
  const disposed = []
  let calls = 0
  const ctx = {
    remote: {
      async $mount() {
        calls += 1
        if (calls === 2) throw new Error('duplicate namespace')
        return async () => { disposed.push('first') }
      },
    },
  }
  await assert.rejects(apply(ctx), /duplicate namespace/u)
  assert.deepEqual(disposed, ['first'])
})

test('emits a self-registering lazy-CJS browser artifact with codecs inlined', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(bundle, /^window\.__ModuleLoader__\.load\(\{\s*id: "@dsh-companion\/provider-client"/u)
  assert.match(bundle, /companionProviderCatalog\/refresh/u)
  assert.match(bundle, /companionProviderAccounts\/refresh/u)
  assert.doesNotMatch(bundle, /^import\s/mu)
  assert.doesNotMatch(bundle, /require\("zod"\)/u)

  let registered
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(value) { registered = value },
      },
    },
  })
  vm.runInContext(bundle, context)
  assert.equal(registered.id, '@dsh-companion/provider-client')
  const exports = registered.factory((specifier) => { throw new Error(`unexpected external ${specifier}`) })
  assert.equal(typeof exports.apply, 'function')
})
