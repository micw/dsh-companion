import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertRuntimeCacheIdentity } from '../runtime-cache-identity.mjs';

const expected = process.env.DSH_COMPANION_EXPECTED_RUNTIME_ID;
assertRuntimeCacheIdentity(expected, expected);
const path = join('build', 'runtime-cache', expected, 'linux-x64', 'runtime-manifest.json');
const manifest = JSON.parse(await readFile(path, 'utf8'));
assertRuntimeCacheIdentity(manifest.runtimeId, expected);
if (manifest.formatVersion !== 2 || manifest.target !== 'linux-x64') throw new Error('Unexpected packaged Runtime cache manifest');
console.log(`Verified CI Runtime cache payload at ${path}`);
