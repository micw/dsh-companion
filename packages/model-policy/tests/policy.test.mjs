import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
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

test('inherits a family policy until an instance route has exact policy', () => {
  const config = {
    providers: {
      openrouter: { defaultModelState: 'disabled', models: { selected: 'enabled' } },
      'openrouter-work': { models: { selected: 'disabled' } },
    },
  }
  assert.equal(modelEnabled(config, 'openrouter-personal', 'new-model', 'openrouter'), false)
  assert.equal(modelEnabled(config, 'openrouter-personal', 'selected', 'openrouter'), true)
  assert.equal(modelEnabled(config, 'openrouter-work', 'selected', 'openrouter'), false)
  assert.equal(modelEnabled(config, 'openrouter-work', 'new-model', 'openrouter'), false)
  assert.equal(modelEnabled({ providers: { ...config.providers,
    'openrouter-work': { defaultModelState: 'enabled', models: { selected: 'disabled' } },
  } }, 'openrouter-work', 'new-model', 'openrouter'), true)
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

test('reads the latest profile-owned volatile configuration', async () => {
  const ctx = new Context()
  const defaultModelState = createVolatile('enabled')
  const service = new CompanionModelPolicy(ctx, {
    defaultModelState,
    providers: createVolatile({}),
  })
  assert.equal(service.isEnabled('provider', 'model'), true)
  updateVolatile(defaultModelState, createVolatile('disabled'))
  assert.equal(service.isEnabled('provider', 'model'), false)
  await ctx.fiber.dispose()
})
