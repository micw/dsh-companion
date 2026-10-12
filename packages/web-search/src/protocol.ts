/** Secret-free search settings and bounded management requests. */
import { z } from 'zod'

export const entrySchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
  family: z.enum(['brave', 'exa']),
  displayName: z.string().trim().min(1).max(100),
  enabled: z.boolean(),
  credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{0,200}$/u),
})
export type SearchEntry = z.infer<typeof entrySchema>
export const failureSchema = z.strictObject({
  identity: z.string().max(300),
  reason: z.enum(['credentials', 'quota', 'rate-limit', 'transport', 'timeout', 'server', 'response', 'access']),
  message: z.string().max(200),
  failedAt: z.number().int().nonnegative(),
  blockedUntil: z.number().int().nonnegative().nullable(),
  retrySource: z.enum(['provider', 'default', 'manual']),
})
export type SearchFailureState = z.infer<typeof failureSchema>
export const searchSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  cooldownMs: z.number().int().min(1000).max(30 * 24 * 3600_000),
  entries: z.array(entrySchema.omit({ credentialRef: true }).extend({
    configured: z.boolean(),
    writable: z.boolean(),
    checking: z.boolean(),
    failure: failureSchema.omit({ identity: true }).nullable(),
  })).max(32),
})
export type SearchSnapshot = z.infer<typeof searchSnapshotSchema>
const revision = z.number().int().nonnegative()
const id = entrySchema.shape.id
const apiKey = z.string().max(4096).regex(/^[^\r\n\0]+$/u).trim().min(1)
export const commandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('list') }),
  z.strictObject({ kind: z.literal('save'), revision, id: id.optional(), family: entrySchema.shape.family,
    displayName: entrySchema.shape.displayName, enabled: z.boolean(), apiKey: apiKey.optional() }),
  z.strictObject({ kind: z.literal('remove'), revision, id }),
  z.strictObject({ kind: z.literal('move'), revision, id, direction: z.enum(['up', 'down']) }),
  z.strictObject({ kind: z.literal('cooldown'), revision, cooldownMs: searchSnapshotSchema.shape.cooldownMs }),
  z.strictObject({ kind: z.literal('retry'), id }),
])
export type SearchCommand = z.infer<typeof commandSchema>
/** Reject wire requests without quoting submitted values, especially credentials. */
export function decodeSearchCommand(value: unknown): SearchCommand {
  const parsed = commandSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid search settings request')
  return parsed.data
}
/** Validate the entire secret-free response before forwarding it to a Webview. */
export function decodeSearchSnapshot(value: unknown): SearchSnapshot {
  const parsed = searchSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new Error('Invalid search settings response')
  return parsed.data
}
