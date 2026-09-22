import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import CompanionModelPolicy, { modelEnabled } from '../lib/index.js'

test('uses the shared default for newly discovered models', () => {
  assert.equal(modelEnabled({}, 'provider', 'new-model'), true)
  assert.equal(modelEnabled({ defaultModelState: 'disabled' }, 'provider', 'new-model'), false)
})

test('uses a provider default before the shared default', () => {
  const config = {
    defaultModelState: 'enabled',
    providers: { openrouter: { defaultModelState: 'disabled', models: { selected: 'enabled' } } },
  }
  assert.equal(modelEnabled(config, 'openrouter', 'new-model'), false)
  assert.equal(modelEnabled(config, 'openrouter', 'selected'), true)
  assert.equal(modelEnabled(config, 'other', 'new-model'), true)
})

test('applies provider denial before exact model overrides', () => {
  const config = {
    defaultModelState: 'enabled',
    providers: {
      provider: {
        enabled: false,
        models: { allowed: 'enabled' },
      },
    },
  }
  assert.equal(modelEnabled(config, 'provider', 'allowed'), false)
  assert.equal(modelEnabled(config, 'provider', 'other'), false)
})

test('retains exact overrides independently of current catalog membership', () => {
  const config = {
    defaultModelState: 'disabled',
    providers: {
      provider: { models: { returning: 'enabled', blocked: 'disabled' } },
    },
  }
  assert.equal(modelEnabled(config, 'provider', 'returning'), true)
  assert.equal(modelEnabled(config, 'provider', 'blocked'), false)
  assert.equal(modelEnabled(config, 'provider', 'unknown'), false)
})

test('reads the latest committed DSH Settings source', async () => {
  const ctx = new Context()
  let current = { defaultModelState: 'enabled' }
  ctx.provide('settings', {
    installSection(_owner, _namespace, _schema, _base, hooks) {
      hooks.setSource(() => current)
    },
  })
  const service = new CompanionModelPolicy(ctx, {})
  service[Service.init]()
  assert.equal(service.isEnabled('provider', 'model'), true)
  current = { defaultModelState: 'disabled' }
  assert.equal(service.isEnabled('provider', 'model'), false)
  await ctx.fiber.dispose()
})
