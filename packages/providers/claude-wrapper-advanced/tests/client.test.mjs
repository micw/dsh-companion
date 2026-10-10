import assert from 'node:assert/strict'
import test from 'node:test'
import { ClaudeWireClient } from '../lib/index.js'
test('calls strict info/models/usage paths with auth', async () => {
  const paths = []
  const fetch = async (url, init) => { paths.push([String(url), init.headers.authorization]); const path = new URL(String(url)).pathname; const body = path.endsWith('/info') ? { service: 'claude-wrapper-advanced', version: '1.7.0' } : path.endsWith('/models') ? { models: [] } : { groups: [] }; return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) }
  const client = new ClaudeWireClient({ baseURL: 'https://wrapper.example/', apiKey: 'secret' }, { fetch })
  await client.info(); await client.models(); await client.usage()
  assert.deepEqual(paths.map(x => x[0]), ['https://wrapper.example/wire/v1/info','https://wrapper.example/wire/v1/models','https://wrapper.example/wire/v1/usage'])
  assert.ok(paths.every(x => x[1] === 'Bearer secret'))
})

test('surfaces FastAPI wire error messages', async () => {
  const fetch = async () => new Response(JSON.stringify({ detail: { error: {
    message: 'The model `claude-opus-4-8` does not exist or you do not have access to it.',
  } } }), { status: 404, headers: { 'content-type': 'application/json' } })
  const client = new ClaudeWireClient({ baseURL: 'https://wrapper.example', apiKey: 'secret' }, { fetch })
  await assert.rejects(client.responses({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'test' }] }),
    /The model `claude-opus-4-8` does not exist/u)
})
