import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'

const output = resolve(process.argv[2] ?? '')
if (output.length === 0) throw new Error('Expected an output path')
const root = resolve(dirname(output), '.generated-v3-session')
await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
const originalNow = Date.now
let eventTime = 1_795_000_000_001
Date.now = () => eventTime++
const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
const session = ctx.sessions.create(SessionId('dsh-companion-v3-upgrade-fixture'), {
  meta: {
    createdAt: 1_795_000_000_000,
    cwd: '/workspace',
    agentPreset: 'standard',
  },
})
const handle = await ctx.sessionPersistence.create(session.header)
const queued = {
  id: 'queued-message',
  role: 'user' as const,
  content: [{ type: 'text' as const, text: 'Queued after the completed turn.' }],
  source: { kind: 'user' as const },
}
session.append('turn/start', { turn: 1 })
session.append('step/start', { turn: 1, step: 1 })
session.append('user/message', {
  id: 'user-message',
  role: 'user',
  content: [
    { type: 'text', text: 'Inspect the fixture and use the attached image.' },
    {
      type: 'image',
      attachment: {
        attachmentId: 'a'.repeat(64),
        mediaType: 'image/png',
        bytes: 68,
        width: 1,
        height: 1,
        name: 'pixel.png',
      },
    },
  ],
  source: { kind: 'user' },
}, { surfaceOp: 'append' })
session.append('request/header', {
  header: { config: { provider: 'fixture-provider', model: 'fixture-model' } },
  reason: 'initial',
})
session.append('request/context', {
  provider: 'fixture-provider',
  model: 'fixture-model',
  contextWindow: 128_000,
})
const accounting = {
  scope: 'call' as const,
  costs: [{
    kind: 'reported' as const,
    amount: { currency: 'USD', nanos: 7 },
    source: 'fixture-provider',
  }],
}
session.append('assistant/message', {
  turn: 1,
  step: 1,
  message: {
    id: 'assistant-message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'I will inspect it.' },
      { type: 'tool-call', id: 'fixture-call', name: 'fixture_tool', arguments: '{"path":"pixel.png"}' },
    ],
    source: { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' },
  },
  stream: [
    { type: 'text-chunks', time0: 1_795_000_000_010, index: 0, dt: [], texts: ['I will inspect it.'] },
    { type: 'chunk', time: 1_795_000_000_011, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
    { type: 'chunk', time: 1_795_000_000_012, chunk: {
      type: 'tool-call-delta', index: 1, id: 'fixture-call', name: 'fixture_tool', argumentsDelta: '{"path":"pixel.png"}',
    } },
    { type: 'chunk', time: 1_795_000_000_013, chunk: {
      type: 'block-end', index: 1,
      block: { type: 'tool-call', id: 'fixture-call', name: 'fixture_tool', arguments: '{"path":"pixel.png"}' },
    } },
    { type: 'chunk', time: 1_795_000_000_014, chunk: { type: 'accounting', accounting } },
    { type: 'chunk', time: 1_795_000_000_015, chunk: {
      type: 'status', status: { kind: 'reasoning-token-progress', deltaTokens: 3, basis: 'reported' },
    } },
    { type: 'chunk', time: 1_795_000_000_016, chunk: {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 },
    } },
    { type: 'chunk', time: 1_795_000_000_017, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
  ],
  usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 },
  accounting,
  statuses: [{
    time: 1_795_000_000_015,
    status: { kind: 'reasoning-token-progress', deltaTokens: 3, basis: 'reported' },
  }],
}, { surfaceOp: 'append' })
session.append('tool/call', {
  turn: 1,
  step: 1,
  callId: 'fixture-call',
  name: 'fixture_tool',
  arguments: '{"path":"pixel.png"}',
})
session.append('tool/result', {
  turn: 1,
  step: 1,
  message: {
    id: 'tool-message',
    role: 'user',
    content: [{
      type: 'tool-result',
      toolCallId: 'fixture-call',
      content: [{ type: 'text', text: 'The image is one pixel.' }],
    }],
    source: { kind: 'tool', callId: 'fixture-call' },
  },
}, { surfaceOp: 'append' })
session.append('step/end', { turn: 1, step: 1 })
session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [queued] })
await ctx.sessions.flush(session)
await handle.close()
await ctx.fiber.dispose()
Date.now = originalNow

async function findGeneration(path: string): Promise<string | undefined> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const candidate = join(path, entry.name)
    if (entry.isDirectory()) {
      const nested = await findGeneration(candidate)
      if (nested !== undefined) return nested
    } else if (entry.name === 'session.v3.jsonl') return candidate
  }
  return undefined
}

const generation = await findGeneration(root)
if (generation === undefined) throw new Error('Generated V3 Session file not found')
await cp(generation, output)
await rm(root, { recursive: true, force: true })
