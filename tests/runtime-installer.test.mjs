import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cleanupVersions,
  companionDataHome,
  companionLifecycleRoot,
  ensureManagedProfile,
  installPayload,
  readRuntimeManifest,
  runtimeIdentity,
  runtimeStoragePath,
  shouldReuseInstalledRuntime,
  shouldReuseSourceRuntime,
  verifyPayload,
  withManagerLock,
} from '../vscode/out/runtimeInstaller.js';

const roots = [];
test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixturePayload(version = '0.0.20260914103045', runtimeId) {
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
    ...(runtimeId === undefined ? { formatVersion: 1, companionVersion: version } : { formatVersion: 2, runtimeId }),
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
    launch: {
      executable: 'dsh',
      args: ['web', '--no-open'],
      profileBundles: [
        '@dsh-companion/bundle',
        '@dsh-companion/provider-openrouter',
        '@dsh-companion/provider-claude-wrapper-advanced',
        '@dsh-companion/provider-codex-wrapper-advanced',
      ],
    },
    artifacts,
  }, null, 2)}\n`);
  return root;
}

test('runtime manager recovers a lock left by a terminated extension host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-manager-lock-'));
  roots.push(root);
  await writeFile(join(root, 'manager.lock'), '999999999\n');
  let entered = false;
  await withManagerLock(root, async () => { entered = true; });
  assert.equal(entered, true);
  await assert.rejects(stat(join(root, 'manager.lock')), { code: 'ENOENT' });
});

test('runtime manager never steals a live owner and serializes waiting windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-manager-lock-'));
  roots.push(root);
  let release;
  const held = withManagerLock(root, () => new Promise(resolve => { release = resolve; }));
  while (release === undefined) await new Promise(resolve => setTimeout(resolve, 5));
  let entered = false;
  const waiting = withManagerLock(root, async () => { entered = true; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(entered, false);
  release();
  await Promise.all([held, waiting]);
  assert.equal(entered, true);
});

test('runtime manager recovers an abandoned recovery guard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-manager-lock-'));
  roots.push(root);
  await writeFile(join(root, 'manager.lock'), '999999999\n');
  const guard = join(root, 'manager.recovery.lock');
  await writeFile(guard, '999999999\n');
  const old = new Date(Date.now() - 10_000);
  await utimes(guard, old, old);
  await withManagerLock(root, async () => {});
  await assert.rejects(stat(guard), { code: 'ENOENT' });
});

test('simultaneous recovery claims preserve exclusive runtime ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-manager-lock-'));
  roots.push(root);
  await writeFile(join(root, 'manager.lock'), '999999999\n');
  let active = 0;
  const calls = Array.from({ length: 5 }, () => withManagerLock(root, async () => {
    active += 1;
    assert.equal(active, 1);
    await new Promise(resolve => setTimeout(resolve, 25));
    active -= 1;
  }));
  await Promise.all(calls);
});

test('runtime payload validation checks every declared file and rejects extras', async () => {
  const payload = await fixturePayload();
  const manifest = await verifyPayload(payload);
  assert.equal(manifest.target, 'linux-x64');
  assert.equal(manifest.artifacts.length, 6);
  assert.deepEqual(manifest.launch.profileBundles, [
    '@dsh-companion/bundle',
    '@dsh-companion/provider-openrouter',
    '@dsh-companion/provider-claude-wrapper-advanced',
    '@dsh-companion/provider-codex-wrapper-advanced',
  ]);

  await writeFile(join(payload, 'client-runtime.js'), 'tampered\n');
  await assert.rejects(verifyPayload(payload), /integrity failed/);
  await writeFile(join(payload, 'client-runtime.js'), 'export const runtime = true;\n');
  await writeFile(join(payload, 'undeclared'), 'unexpected\n');
  await assert.rejects(verifyPayload(payload), /undeclared files/);
});

test('runtime payload validation rejects malformed or reordered profile bundles', async () => {
  const payload = await fixturePayload();
  const manifestPath = join(payload, 'runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.launch.profileBundles.reverse();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verifyPayload(payload), /profile bundle list/);
});

test('runtime payload validation requires complete official DSH provenance', async () => {
  const payload = await fixturePayload();
  const manifestPath = join(payload, 'runtime-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.dsh.upstreamRepository = 'https://example.invalid/dsh';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verifyPayload(payload), /runtime provenance/);
});

test('runtime installation verifies new bytes and reuses a matching installed identity without rehashing', async () => {
  const payload = await fixturePayload();
  const storage = await mkdtemp(join(tmpdir(), 'dsh-companion-storage-'));
  roots.push(storage);
  const version = '0.0.20260914103045';
  const phases = [];
  const installed = await installPayload(payload, storage, version, phase => phases.push(phase));
  assert.deepEqual(phases, ['installing']);
  assert.equal(installed, join(storage, 'runtime', 'versions', `${version}-linux-x64`));
  assert.equal(await installPayload(payload, storage, version, phase => phases.push(phase)), installed);
  assert.deepEqual(phases, ['installing'], 'reusing an installed identity does not announce installation');
  assert.equal((await stat(join(installed, 'dsh'))).mode & 0o777, 0o700);

  await writeFile(join(installed, 'DSH-LICENSE'), 'different\n');
  await rm(join(payload, 'dsh'));
  assert.equal((await readRuntimeManifest(installed)).artifacts.length, 6);
  assert.equal(await installPayload(payload, storage, version), installed);
  await assert.rejects(verifyPayload(installed), /integrity failed/);
  await assert.rejects(installPayload(payload, storage, '0.0.1'), /does not match/);
});

test('a new installation rejects changed packaged bytes before publishing a runtime directory', async () => {
  const payload = await fixturePayload();
  const storage = await mkdtemp(join(tmpdir(), 'dsh-companion-storage-'));
  roots.push(storage);
  await writeFile(join(payload, 'dsh'), 'changed\n');
  const phases = [];
  await assert.rejects(installPayload(payload, storage, '0.0.20260914103045', phase => phases.push(phase)),
    /integrity failed/);
  assert.deepEqual(phases, ['installing']);
  await assert.rejects(stat(join(storage, 'runtime', 'versions', '0.0.20260914103045-linux-x64')),
    { code: 'ENOENT' });
});

test('a reused runtime refuses a different installed manifest for the same identity', async () => {
  const payload = await fixturePayload();
  const storage = await mkdtemp(join(tmpdir(), 'dsh-companion-storage-'));
  roots.push(storage);
  const version = '0.0.20260914103045';
  const installed = await installPayload(payload, storage, version);
  const path = join(installed, 'runtime-manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.launch.args.push('--different');
  await writeFile(path, `${JSON.stringify(manifest)}\n`);
  await assert.rejects(installPayload(payload, storage, version), /differs from the packaged payload/);
});

test('content-addressed runtime survives a frontend-only Extension version change', async () => {
  const runtimeId = 'a'.repeat(64);
  const payload = await fixturePayload('0.0.20260914103045', runtimeId);
  const storage = await mkdtemp(join(tmpdir(), 'dsh-companion-storage-'));
  roots.push(storage);
  const manifest = await verifyPayload(payload);
  const directory = join(storage, 'runtime', 'versions', `runtime-${runtimeId}-linux-x64`);
  const phases = [];
  assert.equal(runtimeIdentity(manifest), `runtime-${runtimeId}-linux-x64`);
  assert.equal(await installPayload(payload, storage, '0.0.20260914103045', phase => phases.push(phase)), directory);
  assert.equal(await installPayload(payload, storage, '0.0.20260915103045', phase => phases.push(phase)), directory);
  assert.deepEqual(phases, ['installing']);
  assert.equal(shouldReuseInstalledRuntime(directory, runtimeIdentity(manifest), directory, manifest), true);
  assert.equal(shouldReuseInstalledRuntime(directory, 'older-runtime', directory, manifest), false);
  assert.equal(shouldReuseInstalledRuntime(undefined, runtimeIdentity(manifest), directory, manifest), false);
  await assert.rejects(installPayload(payload, storage, 'not-a-version'), /Invalid DSH Companion extension version/);
  const invalid = JSON.parse(await readFile(join(payload, 'runtime-manifest.json'), 'utf8'));
  invalid.runtimeId = 'bad';
  await writeFile(join(payload, 'runtime-manifest.json'), `${JSON.stringify(invalid)}\n`);
  await assert.rejects(verifyPayload(payload), /invalid DSH Companion runtime manifest/i);
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

test('managed profile refresh preserves the user patch document', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-companion-profile-'));
  roots.push(home);
  const profile = join(home, 'profiles', 'dsh-companion');
  await mkdir(profile, { recursive: true });
  const patch = '- id: provider\n  config:\n    enabled: true\n';
  await writeFile(join(profile, 'cordis.patch.yml'), patch);

  await ensureManagedProfile(home, ['@dsh-companion/bundle']);

  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), patch);
  assert.deepEqual(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dsh.profile.bundles, [
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-companion/bundle',
  ]);
});

test('runtime data and lifecycle ownership use one stable XDG product root', () => {
  const environment = { XDG_DATA_HOME: '/tmp/dsh-companion-xdg' };
  assert.equal(companionDataHome(environment), '/tmp/dsh-companion-xdg/dsh-companion/dsh-home');
  assert.equal(companionLifecycleRoot(environment), '/tmp/dsh-companion-xdg/dsh-companion/runtime-owner');
  assert.throws(() => companionDataHome({ XDG_DATA_HOME: 'relative' }), /must be absolute/);
});

test('native runtime installation accepts VS Code local user-data storage', () => {
  assert.equal(runtimeStoragePath({ scheme: 'file', fsPath: '/tmp/file-storage' }), '/tmp/file-storage');
  assert.equal(
    runtimeStoragePath({ scheme: 'vscode-userdata', fsPath: '/tmp/user-data-storage' }),
    '/tmp/user-data-storage',
  );
  assert.equal(runtimeStoragePath({ scheme: 'vscode-remote', fsPath: '/tmp/remote-storage' }), undefined);
  assert.throws(
    () => runtimeStoragePath({ scheme: 'vscode-userdata', fsPath: 'relative' }),
    /must be absolute/,
  );
});

test('only an Extension Development Host reuses a source runtime', async () => {
  const source = await readFile(new URL('../vscode/src/runtimeInstaller.ts', import.meta.url), 'utf8');
  assert.equal(shouldReuseSourceRuntime('source', 2), true);
  assert.equal(shouldReuseSourceRuntime('source', 1), false);
  assert.equal(shouldReuseSourceRuntime('installed-version', 2), false);
  const reuse = source.indexOf('if (shouldReuseSourceRuntime(shared?.runtimeId, context.extensionMode)) return shared;');
  const storageCheck = source.indexOf('runtimeStoragePath(context.globalStorageUri)');
  assert.ok(reuse >= 0 && storageCheck > reuse);
  assert.match(source, /manifest\.dsh\.upstreamVersion[\s\S]*upstreamCommit\.slice\(0, 8\)[\s\S]*patchSetSha256\.slice\(0, 8\)/);
});
