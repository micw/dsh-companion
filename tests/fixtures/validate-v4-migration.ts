import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Context } from '../../../deepseek-harness/vendor/cordis/src/index.ts'
import { SessionId } from '../../../deepseek-harness/packages/core/session/src/index.ts'
import JsonlSessionPersistence from '../../../deepseek-harness/packages/session/session-persistence-jsonl/src/index.ts'
import { generationLogPath } from '../../../deepseek-harness/packages/session/session-persistence-jsonl/src/format.ts'

const [fixtureInput, rootInput] = process.argv.slice(2)
if (fixtureInput === undefined || rootInput === undefined) {
  throw new Error('Expected fixture and persistence root paths')
}
const fixture = resolve(fixtureInput)
const root = resolve(rootInput)
const id = SessionId('dsh-companion-v3-upgrade-fixture')
const v3 = generationLogPath(root, '/workspace', id, 3, 'none')
const v4 = generationLogPath(root, '/workspace', id, 4, 'none')
await mkdir(dirname(v3), { recursive: true })
await copyFile(fixture, v3)

const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
const read = await ctx.sessionPersistence.open(id, 'read')
const before = await read.read()
await read.close()
if (await exists(v4)) throw new Error('Read-only V3 open published V4')

const write = await ctx.sessionPersistence.open(id, 'write')
const after = await write.read()
await write.flush()
await write.close()
if (!await exists(v4)) throw new Error('Write V3 open did not publish V4')
await ctx.fiber.dispose()

const assistant = after.events.find(event => event.type === 'assistant/message')
const tool = after.events.find(event => event.type === 'tool/result')
const queued = after.events.find(event => event.type === 'agent/inbox/spliced')
console.log(JSON.stringify({
  beforeVersion: read.header.version,
  afterVersion: write.header.version,
  beforeEvents: before.events.length,
  afterEvents: after.events.length,
  preset: write.header.agentPreset,
  accounting: assistant?.type === 'assistant/message' ? assistant.data.accounting : undefined,
  statuses: assistant?.type === 'assistant/message' ? assistant.data.statuses : undefined,
  toolRole: tool?.type === 'tool/result' ? tool.data.message.role : undefined,
  queuedText: queued?.type === 'agent/inbox/spliced'
    ? queued.data.inserted[0]?.content[0]?.type === 'text' ? queued.data.inserted[0].content[0].text : undefined
    : undefined,
}))

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}
