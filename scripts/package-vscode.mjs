#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVsix } from './create-vsix.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(root, 'vscode');
const runtimePayload = join(root, 'build', 'runtime-payload', 'linux-x64');

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

rmSync(runtimePayload, { recursive: true, force: true });
run(process.execPath, [
  join(root, 'runtime', 'dsh', 'scripts', 'build-linux.mjs'),
  '--source', resolve(root, dshSource),
  '--output', runtimePayload,
  '--companion-version', version,
]);
run('pnpm', ['run', 'build']);
run(process.execPath, [
  join(root, 'scripts', 'smoke-managed-runtime.mjs'),
  '--payload', runtimePayload,
]);
await createVsix({ version, runtimePayload });
