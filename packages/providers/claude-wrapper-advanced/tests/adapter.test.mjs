import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ClaudeCatalogGeneration, ClaudeWrapperAdvancedAdapter, parseClaudeWireCatalog } from '../lib/index.js'
const catalog = new ClaudeCatalogGeneration(parseClaudeWireCatalog(JSON.parse(await readFile(new URL('./fixtures/catalog.json', import.meta.url)))))
test('adapter applies model policy and emits quota observations', async () => {
  const bodies = []; const quotas = []
  const client = { async responses(body) { bodies.push(body); return (async function* () { yield { type: 'quota', usage: { groups: [] } }; yield { type: 'done', stopReason: 'end_turn', text: 'ok', usage: { inputNew: 1, cacheRead: 0, cacheWrite: 0, inputTotal: 1, output: 1 }, cost: { coveredRequests: 1, epoch: '123e4567-e89b-12d3-a456-426614174001', byModel: {} } } })() } }
  const adapter = new ClaudeWrapperAdvancedAdapter({ generation: async () => ({ client, catalog }), imageUrl: async () => '', modelEnabled: (_provider, model) => model !== 'disabled', onQuota: value => quotas.push(value) })
  assert.equal((await adapter.listModels('claude-wrapper-advanced'))[0].id, 'sonnet-5')
  const chunks = []
  for await (const chunk of adapter.stream({ provider: 'claude-wrapper-advanced', model: 'sonnet-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) chunks.push(chunk)
  assert.equal(bodies[0].model, 'sonnet-5'); assert.equal(quotas.length, 1); assert.equal(chunks.at(-1).type, 'finish')
  await assert.rejects(adapter.resolveModel('claude-wrapper-advanced', 'disabled'), /disabled/u)
})
