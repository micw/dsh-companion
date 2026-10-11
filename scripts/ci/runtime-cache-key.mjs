import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runtimeFingerprint } from '../../runtime/dsh/scripts/fingerprint.mjs';

if (!process.env.GITHUB_OUTPUT || !process.env.DSH_COMPANION_DSH_SOURCE) throw new Error('CI Runtime paths are required');
const runtimeId = await runtimeFingerprint(resolve(process.env.DSH_COMPANION_DSH_SOURCE));
await appendFile(process.env.GITHUB_OUTPUT, `runtimeId=${runtimeId}\n`);
