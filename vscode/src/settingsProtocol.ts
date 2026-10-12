/** Bounded Settings-editor messages; passwords are accepted only on explicit save. */
import { z } from 'zod';
import { commandSchema } from '@dsh-companion/web-search/protocol';
const id = z.string().min(1).max(300);
const name = z.string().trim().min(1).max(100);
const revision = z.number().int().nonnegative();
const apiKey = z.string().max(4096).regex(/^[^\r\n\0]+$/u).optional();
const baseURL = z.string().max(4096).optional();
const operation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('load') }),
  z.strictObject({ kind: z.literal('status') }),
  z.strictObject({ kind: z.literal('search'), command: commandSchema }),
  z.strictObject({ kind: z.literal('saveProvider'), provider: id, revision, enabled: z.boolean(), displayName: name.optional(), baseURL, apiKey, test: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('createProvider'), family: id, displayName: name, enabled: z.boolean(), baseURL, apiKey }),
  z.strictObject({ kind: z.literal('deleteProvider'), family: id, instance: id, provider: id, displayName: name }),
  z.strictObject({ kind: z.literal('models'), provider: id, models: z.array(id).min(1).max(1000).refine(values => new Set(values).size === values.length), enabled: z.boolean(), revision }),
]);
const request = z.strictObject({ type: z.literal('settingsRequest'), requestId: z.number().int().positive(), operation });
export type SettingsRequest = z.infer<typeof request>;
/** Invalid messages return no parsed request and never quote submitted values. */
export function parseSettingsRequest(value: unknown): SettingsRequest | undefined {
  const parsed = request.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
