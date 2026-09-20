import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ClaudeAccountProjection, ClaudeCatalogGeneration, parseClaudeWireCatalog, projectCompanionCatalog } from '../lib/index.js'
const catalog = parseClaudeWireCatalog(JSON.parse(await readFile(new URL('./fixtures/catalog.json', import.meta.url))))
test('projects models, context, effort, and wire identity', () => {
  const generation = new ClaudeCatalogGeneration(catalog)
  assert.equal(generation.resolveModel('sonnet-5').context.contextWindow, 1_000_000)
  assert.equal(generation.resolveModel('sonnet-5').reasoning.defaultEffort, 'high')
  assert.equal(generation.wireModel('sonnet-5'), 'sonnet-5')
  assert.deepEqual(generation.limitGroups('sonnet-5'), ['global'])
  assert.deepEqual(projectCompanionCatalog(catalog).models[0].reasoning.efforts, ['low', 'high'])
})
test('projects quota windows into provider account allowances', () => {
  const projection = new ClaudeAccountProjection()
  const report = { groups: [
    { id: 'global', observedAt: 100, ageSeconds: 2, windows: [{ id: '5h', usedPercent: 25, windowSeconds: 18000, resetsAt: 100 }, { id: '7d', usedPercent: 50, windowSeconds: 604800 }] },
    { id: 'model:fable-5', windows: [{ id: '5h', usedPercent: 10 }] },
  ] }
  const view = projection.acceptTurn(report, ['model:fable-5', 'global'])
  assert.equal(view.provider, 'claude-wrapper-advanced')
  assert.equal(view.activeAllowance, 'model:fable-5')
  assert.equal(view.allowances[0].observedAt, 100_000)
  assert.equal(view.allowances[0].ageSeconds, 2)
  assert.equal(view.allowances[0].primary.usedPercent, 25)
  assert.equal(view.allowances[0].secondary.usedPercent, 50)
})
