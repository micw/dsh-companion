/** Two independent cold Runtime builds must install as one immutable backend across Extension versions. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFingerprint } from '../runtime/dsh/scripts/fingerprint.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.DSH_COMPANION_DSH_SOURCE;
const supplied = process.argv.slice(2);
if (supplied.length !== 0 && supplied.length !== 2) throw new Error('Pass either no arguments or two independently built payloads');
if (!source && supplied.length === 0) throw new Error('DSH_COMPANION_DSH_SOURCE is required');
const runtimeId = supplied.length ? JSON.parse(await readFile(join(supplied[0], 'runtime-manifest.json'), 'utf8')).runtimeId
  : await runtimeFingerprint(resolve(root, source));
await mkdir(join(root, 'build'), { recursive: true });
const directory = await mkdtemp(join(root, 'build', 'runtime-repro-'));
const run = async args => {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  if (code !== 0) throw new Error(`Independent Runtime build failed (${code})`);
};
try {
  const outputs = supplied.length ? supplied.map(path => resolve(path))
    : [join(directory, 'cold-A', 'linux-x64'), join(directory, 'cold-B', 'linux-x64')];
  if (!supplied.length) {
    for (const output of outputs) await run(['runtime/dsh/scripts/build-linux.mjs', '--source', resolve(root, source), '--output', output, '--runtime-id', runtimeId]);
  }
  const { verifyPayload, installPayload, shouldReuseInstalledRuntime, runtimeIdentity } = await import('../vscode/out/runtimeInstaller.js');
  const manifests = await Promise.all(outputs.map(verifyPayload));
  assert.equal(manifests[0].runtimeId, runtimeId);
  if (source) assert.equal(manifests[0].runtimeId, await runtimeFingerprint(resolve(root, source)), 'Payload must match the current backend inputs');
  assert.deepEqual(manifests[1], manifests[0], 'Independent builds with identical backend inputs must have identical artifact hashes');
  assert.equal(await readFile(join(outputs[0], 'runtime-manifest.json'), 'utf8'), await readFile(join(outputs[1], 'runtime-manifest.json'), 'utf8'));
  const storage = join(directory, 'storage'); const phases = [];
  const installed = await installPayload(outputs[0], storage, '0.1.20261011000000', phase => phases.push(phase));
  assert.equal(await installPayload(outputs[1], storage, '0.1.20261012000000', phase => phases.push(phase)), installed);
  assert.deepEqual(phases, ['installing']);
  assert.equal(shouldReuseInstalledRuntime(installed, runtimeIdentity(manifests[0]), installed, manifests[1]), true);
  for (const output of outputs) await run(['scripts/smoke-managed-runtime.mjs', '--payload', output]);
  console.log(`Independent cold Runtime builds, immutable installation and frontend-update reuse passed: ${runtimeId}`);
} finally {
  if (process.env.DSH_COMPANION_KEEP_REPRO !== '1') await rm(directory, { recursive: true, force: true });
  else console.log(`Runtime reproducibility outputs retained at ${directory}`);
}
