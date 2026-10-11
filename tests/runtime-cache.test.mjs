import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runtimeHostFingerprint, runtimeTreeFingerprint } from '../runtime/dsh/scripts/fingerprint.mjs';
import { reuseOrBuildRuntime } from '../scripts/runtime-cache.mjs';
import { assertRuntimeCacheIdentity } from '../scripts/runtime-cache-identity.mjs';

test('packaging must keep the exact Runtime identity selected for CI cache restore and save', () => {
  const selected = 'a'.repeat(64);
  assert.equal(assertRuntimeCacheIdentity(selected), selected);
  assert.equal(assertRuntimeCacheIdentity(selected, selected), selected);
  assert.throws(() => assertRuntimeCacheIdentity('b'.repeat(64), selected), /inputs changed after cache lookup/);
  assert.throws(() => assertRuntimeCacheIdentity(selected, ''), /inputs changed after cache lookup/);
  assert.throws(() => assertRuntimeCacheIdentity('invalid'), /Invalid calculated/);
});

const roots = [];
test.afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-companion-runtime-cache-'));
  roots.push(root);
  return root;
}

test('runtime input hashing tracks staged bytes but ignores fetched and private files', async () => {
  const root = await temporaryRoot();
  await writeFile(join(root, 'package.json'), '{"name":"provider"}\n');
  await mkdir(join(root, 'lib'));
  await writeFile(join(root, 'lib', 'index.js'), 'export const value = 1;\n');
  const first = await runtimeTreeFingerprint(root);
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', 'dependency.js'), 'ignored\n');
  await writeFile(join(root, '.env'), 'SECRET=ignored\n');
  assert.equal(await runtimeTreeFingerprint(root), first);
  await writeFile(join(root, 'lib', 'index.js'), 'export const value = 2;\n');
  assert.notEqual(await runtimeTreeFingerprint(root), first);
});

test('Extension client changes do not change the managed runtime host identity', async () => {
  const root = await temporaryRoot();
  await mkdir(join(root, 'vscode', 'runtime'), { recursive: true });
  await mkdir(join(root, 'vscode', 'src'));
  await writeFile(join(root, 'vscode', 'runtime', 'supervisor.mjs'), 'export const version = 1;\n');
  await writeFile(join(root, 'vscode', 'package.json'), '{"name":"extension"}\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(root, 'package.json'), '{"name":"workspace"}\n');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: [packages/*, packages/providers/*]\n');
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts', 'product-packages.mjs'), 'export const providers = [];\n');
  await writeFile(join(root, 'vscode', 'src', 'dshClient.ts'), 'export const transcript = 1;\n');
  const first = await runtimeHostFingerprint(root);
  await writeFile(join(root, 'vscode', 'src', 'dshClient.ts'), 'export const transcript = 2;\n');
  assert.equal(await runtimeHostFingerprint(root), first);
  await writeFile(join(root, 'vscode', 'runtime', 'supervisor.mjs'), 'export const version = 2;\n');
  assert.notEqual(await runtimeHostFingerprint(root), first);
});

test('a verified runtime cache survives frontend versions and fails closed on tampering', async () => {
  const root = await temporaryRoot();
  const runtimeId = 'a'.repeat(64);
  let builds = 0;
  const verify = async (payload, expected) => {
    const value = JSON.parse(await readFile(join(payload, 'runtime-manifest.json'), 'utf8'));
    if (value.runtimeId !== expected) throw new Error('runtime identity mismatch');
    if ((await readFile(join(payload, 'dsh'), 'utf8')) !== 'runtime bytes') throw new Error('runtime integrity failed');
  };
  const build = async (payload, id) => {
    builds += 1;
    await mkdir(payload);
    await writeFile(join(payload, 'dsh'), 'runtime bytes');
    await writeFile(join(payload, 'runtime-manifest.json'), JSON.stringify({ runtimeId: id }));
  };
  const first = await reuseOrBuildRuntime(root, runtimeId, verify, build);
  assert.equal(first.reused, false);
  const second = await reuseOrBuildRuntime(root, runtimeId, verify, build);
  assert.deepEqual(second, { payload: first.payload, reused: true });
  assert.equal(builds, 1);
  await writeFile(join(first.payload, 'dsh'), 'tampered');
  await assert.rejects(reuseOrBuildRuntime(root, runtimeId, verify, build), /integrity failed/);
  assert.equal(builds, 1);
  const changed = await reuseOrBuildRuntime(root, 'b'.repeat(64), verify, build);
  assert.equal(changed.reused, false);
  assert.equal(builds, 2);
});

test('CI cache-save check rejects a missing or differently identified packaged payload', async () => {
  const root = await temporaryRoot(); const id = 'a'.repeat(64);
  const script = fileURLToPath(new URL('../scripts/ci/verify-runtime-cache.mjs', import.meta.url));
  const run = () => execFileSync(process.execPath, [script], { cwd: root,
    env: { ...process.env, DSH_COMPANION_EXPECTED_RUNTIME_ID: id }, stdio: 'pipe' });
  assert.throws(run);
  const directory = join(root, 'build', 'runtime-cache', id, 'linux-x64'); await mkdir(directory, { recursive: true });
  const path = join(directory, 'runtime-manifest.json');
  await writeFile(path, JSON.stringify({ formatVersion: 2, target: 'linux-x64', runtimeId: 'b'.repeat(64) }));
  assert.throws(run, /Command failed/);
  await writeFile(path, JSON.stringify({ formatVersion: 2, target: 'linux-x64', runtimeId: id }));
  assert.match(run().toString(), /Verified CI Runtime cache payload/);
});

test('a failed runtime build leaves no reusable partial cache entry', async () => {
  const root = await temporaryRoot();
  const runtimeId = 'c'.repeat(64);
  const verify = async payload => readFile(join(payload, 'runtime-manifest.json'), 'utf8');
  await assert.rejects(reuseOrBuildRuntime(root, runtimeId, verify, async payload => {
    await mkdir(payload);
    throw new Error('build failed');
  }), /build failed/);
  const entries = await (await import('node:fs/promises')).readdir(root);
  assert.deepEqual(entries, []);
});
