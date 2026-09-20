#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  DSH_RUNTIME_ROOT,
  loadUpstreamManifest,
  patchSetSha256,
  verifyPatchFiles,
} from './manifest.mjs';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    output: { type: 'string' },
  },
  strict: true,
});
if (values.source === undefined || values.output === undefined) {
  throw new Error('Usage: prepare.mjs --source <dsh-git-checkout> --output <absent-directory>');
}

const source = resolve(values.source);
const output = resolve(values.output);
if (output === source || output.startsWith(`${source}/`)) {
  throw new Error('Prepared DSH output must be outside the upstream checkout');
}
try {
  await stat(output);
  throw new Error(`Prepared DSH output already exists: ${output}`);
} catch (error) {
  if (error instanceof Error && error.message.startsWith('Prepared DSH output already exists:')) throw error;
  if (error?.code !== 'ENOENT') throw error;
}

const manifest = await loadUpstreamManifest();
await verifyPatchFiles(manifest);
await verifyUpstream(source, manifest.upstream);
await cloneTree(source, manifest.upstream.commit, output);
for (const patch of manifest.patches) {
  const path = join(DSH_RUNTIME_ROOT, patch.file);
  const options = { cwd: output };
  await run('git', ['apply', '--check', '--whitespace=error-all', path], options);
  await run('git', ['apply', '--whitespace=error-all', path], options);
}
const provenance = {
  formatVersion: 1,
  preparedAt: new Date().toISOString(),
  upstream: manifest.upstream,
  patchSetSha256: patchSetSha256(manifest),
  patches: manifest.patches.map((patch) => ({
    id: patch.id,
    sha256: patch.sha256,
    affectedModules: patch.affectedModules,
    upstreamDiscussion: patch.upstreamDiscussion,
  })),
};
await writeFile(
  join(output, '.dsh-companion-runtime-source.json'),
  `${JSON.stringify(provenance, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`Prepared patched DSH ${manifest.upstream.version} at ${output}`);

async function verifyUpstream(checkout, upstream) {
  const commit = await capture('git', ['-C', checkout, 'rev-parse', `${upstream.commit}^{commit}`]);
  if (commit !== upstream.commit) throw new Error(`DSH upstream commit is unavailable: ${upstream.commit}`);
  const tagCommit = await capture('git', ['-C', checkout, 'rev-parse', `${upstream.tag}^{commit}`]);
  if (tagCommit !== upstream.commit) {
    throw new Error(`DSH upstream tag ${upstream.tag} does not resolve to ${upstream.commit}`);
  }
  const tree = await capture('git', ['-C', checkout, 'rev-parse', `${upstream.commit}^{tree}`]);
  if (tree !== upstream.tree) throw new Error(`DSH upstream tree mismatch: expected ${upstream.tree}, got ${tree}`);
}

async function cloneTree(checkout, commit, destination) {
  await run('git', ['clone', '--shared', '--no-checkout', '--quiet', checkout, destination]);
  await run('git', ['checkout', '--detach', '--quiet', commit], { cwd: destination });
}

async function capture(command, args) {
  let output = '';
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  const code = await exitCode(child);
  if (code !== 0) throw new Error(`${command} exited with status ${String(code)}`);
  return output.trim();
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: 'inherit' });
  const code = await exitCode(child);
  if (code !== 0) throw new Error(`${command} exited with status ${String(code)}`);
}

function exitCode(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => {
      if (signal !== null) rejectExit(new Error(`Process terminated by ${signal}`));
      else resolveExit(code);
    });
  });
}
