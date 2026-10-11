#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFingerprint } from '../runtime/dsh/scripts/fingerprint.mjs';
import { createVsix } from './create-vsix.mjs';
import { reuseOrBuildRuntime } from './runtime-cache.mjs';
import { assertRuntimeCacheIdentity } from './runtime-cache-identity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(root, 'vscode');
const runtimeCacheRoot = join(root, 'build', 'runtime-cache');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
}

const workspaceManifest = readJson(join(root, 'package.json'));
const extensionManifestPath = join(extensionRoot, 'package.json');
const extensionManifest = readJson(extensionManifestPath);
if (workspaceManifest.version !== '0.0.0' || extensionManifest.version !== '0.0.0') {
  throw new Error('source manifests must keep the neutral version 0.0.0');
}

const version = execFileSync(process.execPath, [join(root, 'scripts', 'version.mjs')], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const dshSource = process.env.DSH_COMPANION_DSH_SOURCE;
if (dshSource === undefined || dshSource.length === 0) {
  throw new Error('DSH_COMPANION_DSH_SOURCE must name an exact DSH Git checkout');
}
run('pnpm', ['run', 'build']);
const runtimeId = assertRuntimeCacheIdentity(await runtimeFingerprint(resolve(root, dshSource)),
  process.env.DSH_COMPANION_EXPECTED_RUNTIME_ID);
const { verifyPayload } = await import('../vscode/out/runtimeInstaller.js');
const verifiedRuntime = async (payload, expectedId) => {
  const manifest = await verifyPayload(payload);
  if (manifest.formatVersion !== 2 || manifest.runtimeId !== expectedId) {
    throw new Error('Cached runtime identity does not match its content-addressed directory');
  }
};
const { payload: runtimePayload, reused } = await reuseOrBuildRuntime(runtimeCacheRoot, runtimeId, verifiedRuntime,
  async (output, id) => run(process.execPath, [
    join(root, 'runtime', 'dsh', 'scripts', 'build-linux.mjs'),
    '--source', resolve(root, dshSource),
    '--output', output,
    '--runtime-id', id,
  ]));
if (!existsSync(join(runtimePayload, 'runtime-manifest.json'))) throw new Error('Verified Runtime cache payload is missing');
if (reused) console.log(`Reusing verified DSH Companion runtime ${runtimeId}`);
run(process.execPath, [
  join(root, 'scripts', 'smoke-managed-runtime.mjs'),
  '--payload', runtimePayload,
]);
await createVsix({ version, runtimePayload, runtimeId });
