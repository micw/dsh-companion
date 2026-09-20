import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cleanupVersions,
  companionDataHome,
  companionLifecycleRoot,
  installPayload,
  verifyPayload,
} from '../vscode/out/runtimeInstaller.js';

const roots = [];
test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixturePayload(version = '0.0.20260914103045') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-companion-payload-'));
  roots.push(root);
  const files = {
    dsh: '#!/bin/sh\nexit 0\n',
    'dsh-rg': '#!/bin/sh\nexit 0\n',
    'client-runtime.js': 'export const runtime = true;\n',
    'supervisor.mjs': 'export const supervisor = true;\n',
    'DSH-LICENSE': 'MIT\n',
    'DSH-THIRD_PARTY-NOTICES.md': '# Notices\n',
  };
  const artifacts = [];
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(root, file), content);
    artifacts.push({
      file,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
      executable: file === 'dsh' || file === 'dsh-rg',
    });
  }
  await writeFile(join(root, 'runtime-manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    companionVersion: version,
    target: 'linux-x64',
    dsh: {
      upstreamRepository: 'https://github.com/deepseek-ai/deepseek-harness.git',
      upstreamVersion: '0.1.5-rc.2',
      upstreamTag: 'dsh-v0.1.5-rc.2',
      upstreamCommit: '1'.repeat(40),
      upstreamTree: '2'.repeat(40),
      modified: false,
      patchSetSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      patches: [],
    },
    launch: { executable: 'dsh', args: ['web', '--no-open'] },
    artifacts,
  }, null, 2)}\n`);
  return root;
}

test('runtime payload validation checks every declared file and rejects extras', async () => {
  const payload = await fixturePayload();
  const manifest = await verifyPayload(payload);
  assert.equal(manifest.target, 'linux-x64');
  assert.equal(manifest.artifacts.length, 6);

  await writeFile(join(payload, 'client-runtime.js'), 'tampered\n');
  await assert.rejects(verifyPayload(payload), /integrity failed/);
  await writeFile(join(payload, 'client-runtime.js'), 'export const runtime = true;\n');
  await writeFile(join(payload, 'undeclared'), 'unexpected\n');
  await assert.rejects(verifyPayload(payload), /undeclared files/);
});

test('runtime payload validation requires complete official DSH provenance', async () => {
  const payload = await fixturePayload();
  const manifestPath = join(payload, 'runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dsh.upstreamRepository = 'https://example.invalid/dsh';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verifyPayload(payload), /runtime provenance/);
});

test('runtime installation is immutable and reuses an identical packaged version', async () => {
  const payload = await fixturePayload();
  const storage = await mkdtemp(join(tmpdir(), 'dsh-companion-storage-'));
  roots.push(storage);
  const version = '0.0.20260914103045';
  const installed = await installPayload(payload, storage, version);
  assert.equal(installed, join(storage, 'runtime', 'versions', `${version}-linux-x64`));
  assert.equal(await installPayload(payload, storage, version), installed);
  assert.equal((await stat(join(installed, 'dsh'))).mode & 0o777, 0o700);

  await writeFile(join(installed, 'DSH-LICENSE'), 'different\n');
  await assert.rejects(installPayload(payload, storage, version), /integrity failed|differs/);
  await assert.rejects(installPayload(payload, storage, '0.0.1'), /does not match/);
});

test('runtime cleanup retains active and rollback versions without deleting DSH data', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'dsh-companion-cleanup-'));
  roots.push(storage);
  const runtimeRoot = join(storage, 'runtime');
  const versions = join(runtimeRoot, 'versions');
  const active = join(versions, 'active');
  const rollback = join(versions, 'rollback');
  const stale = join(versions, 'stale');
  const staging = join(runtimeRoot, 'staging', 'partial');
  const data = join(storage, 'dsh-home', 'sessions', 'kept');
  for (const path of [active, rollback, stale, staging, data]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'marker'), path);
  }

  await cleanupVersions(
    runtimeRoot,
    { formatVersion: 1, directory: active },
    { formatVersion: 1, directory: rollback },
  );
  assert.equal(await readFile(join(active, 'marker'), 'utf8'), active);
  assert.equal(await readFile(join(rollback, 'marker'), 'utf8'), rollback);
  await assert.rejects(stat(stale), (error) => error?.code === 'ENOENT');
  await assert.rejects(stat(staging), (error) => error?.code === 'ENOENT');
  assert.equal(await readFile(join(data, 'marker'), 'utf8'), data);
});

test('runtime data and lifecycle ownership use one stable XDG product root', () => {
  const environment = { XDG_DATA_HOME: '/tmp/dsh-companion-xdg' };
  assert.equal(companionDataHome(environment), '/tmp/dsh-companion-xdg/dsh-companion/dsh-home');
  assert.equal(companionLifecycleRoot(environment), '/tmp/dsh-companion-xdg/dsh-companion/runtime-owner');
  assert.throws(() => companionDataHome({ XDG_DATA_HOME: 'relative' }), /must be absolute/);
});

test('source runtime reuse precedes packaged-storage URI requirements', async () => {
  const source = await readFile(new URL('../vscode/src/runtimeInstaller.ts', import.meta.url), 'utf8');
  const reuse = source.indexOf("if (shared?.runtimeId === 'source') return shared;");
  const storageCheck = source.indexOf("context.globalStorageUri.scheme !== 'file'");
  assert.ok(reuse >= 0 && storageCheck > reuse);
});
