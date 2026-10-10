import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenRouterClient } from '../lib/index.js'
import { catalogPayload, keyPayload } from './fixture.mjs'

test('fetches the catalog with bearer auth without exposing the key in the payload', async () => {
  const calls = []
  const fetch = async (input, init) => {
    calls.push({ input: String(input), init })
    return new Response(JSON.stringify(catalogPayload()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  const result = await new OpenRouterClient({
    apiKey: 'secret',
    baseURL: 'https://openrouter.example/api/v1',
    fetch,
  }).models()
  assert.equal(result.data[0].id, 'acme/reasoner')
  assert.equal(calls[0].input, 'https://openrouter.example/api/v1/models')
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret')
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('rejects a failed catalog response before decoding its body', async () => {
  const fetch = async () => new Response('{"error":"no"}', { status: 401 })
  const client = new OpenRouterClient({ apiKey: 'bad', baseURL: 'https://openrouter.example/api/v1', fetch })
  await assert.rejects(client.models(), /HTTP 401/u)
})

test('fetches the current key status from the same credential-bound client', async () => {
  const calls = []
  const fetch = async (input, init) => {
    calls.push({ input: String(input), init })
    return Response.json(keyPayload())
  }
  const status = await new OpenRouterClient({
    apiKey: 'secret', baseURL: 'https://openrouter.example/api/v1', fetch,
  }).keyStatus()
  assert.equal(status.label, 'Companion key')
  assert.equal(calls[0].input, 'https://openrouter.example/api/v1/key')
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret')
})
