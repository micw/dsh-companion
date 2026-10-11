import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UpdateService, compareVersions } from '../vscode/out/updateService.js';
import { VersionController } from '../vscode/out/versionController.js';
import { parseVersionRequest } from '../vscode/out/versionProtocol.js';
import { validateUpdatePackage } from '../vscode/out/updatePackage.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const api = 'https://api.github.com/repos/micw/dsh-companion';
const payload = Buffer.from('VSIX fixture');
const candidate = { version: '0.2.20261010120000', channel: 'master', commit: 'a'.repeat(40), assetId: 3,
  name: 'dsh-companion-0.2.20261010120000-linux-x64.vsix', size: payload.length, sha256: sha(payload),
  publishedAt: '2026-10-10T12:00:00Z', releaseUrl: 'https://github.com/micw/dsh-companion/releases/tag/master-build' };
function releaseFixture(overrides = {}) {
  const info = { format: 1, channel: 'master', version: candidate.version, commit: candidate.commit, runtimeId: 'b'.repeat(64),
    target: 'linux-x64', assets: [{ name: candidate.name, sha256: candidate.sha256, size: candidate.size }] };
  const infoBytes = JSON.stringify(info);
  const sums = `${candidate.sha256}  ${candidate.name}\n${sha(infoBytes)}  build-info.json\n`;
  const release = { draft: false, prerelease: true, tag_name: 'master-build', published_at: candidate.publishedAt,
    assets: [{ id: 1, name: 'build-info.json', size: Buffer.byteLength(infoBytes), state: 'uploaded' },
      { id: 2, name: 'SHA256SUMS', size: Buffer.byteLength(sums), state: 'uploaded' },
      { id: 3, name: candidate.name, size: candidate.size, state: 'uploaded', digest: `sha256:${candidate.sha256}` }], ...overrides };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === `${api}/releases/tags/master-build`) return Response.json(release);
    if (url === `${api}/releases/assets/1`) return new Response(infoBytes);
    if (url === `${api}/releases/assets/2`) return new Response(sums);
    if (url === `${api}/releases/assets/3`) return new Response(payload);
    if (url === `${api}/git/ref/tags/master-build`) return Response.json({ object: { type: 'commit', sha: candidate.commit } });
    throw Error('unexpected dispatch');
  };
  return { service: new UpdateService(fetcher), calls, release, infoBytes, sums, fetcher };
}

test('version messages reject injected URLs, paths, commands and invalid request identities', () => {
  const value = { type: 'versionRequest', requestId: 1, action: 'check', channel: 'master' };
  assert.deepEqual(parseVersionRequest(value), value);
  for (const bad of [{ ...value, url: 'https://evil.example' }, { ...value, path: '/tmp/package.vsix' },
    { ...value, action: 'execute' }, { ...value, requestId: -1 }, { ...value, channel: 'nightly' }]) assert.equal(parseVersionRequest(bad), undefined);
});

test('version ordering handles timestamp components without unsafe numeric conversion', () => {
  assert.equal(compareVersions('0.2.20261010120000', '0.2.0'), 1);
  assert.equal(compareVersions('0.2.0', '0.1.999999999999999999999'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.throws(() => compareVersions('v0.2.0', '0.2.0'), /Invalid/);
});

test('manual updatecheck validates canonical GitHub release and integrity metadata without credentials', async () => {
  const f = releaseFixture();
  assert.deepEqual(await f.service.check('master', AbortSignal.timeout(1000)), candidate);
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every(call => call.options.redirect === 'manual' && !('authorization' in call.options.headers)));
  for (const release of [{ draft: true }, { prerelease: false }, { tag_name: 'unexpected' }, { assets: [] }]) {
    await assert.rejects(releaseFixture(release).service.check('master', AbortSignal.timeout(1000)));
  }
  const absent = new UpdateService(async () => new Response('', { status: 404 }));
  assert.equal(await absent.check('stable', AbortSignal.timeout(1000)), null);
});

test('master updatecheck rejects canonical metadata until the rolling tag commits that build', async () => {
  const fixture = releaseFixture();
  const service = new UpdateService(async (url, options) => url === `${api}/git/ref/tags/master-build`
    ? Response.json({ object: { type: 'commit', sha: 'c'.repeat(40) } }) : fixture.fetcher(url, options));
  await assert.rejects(service.check('master', AbortSignal.timeout(1000)), /publication completes/);
});

test('updates reject external redirects, malformed/oversized metadata, and inconsistent hashes', async () => {
  const redirect = new UpdateService(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/secret' } }));
  await assert.rejects(redirect.check('master', AbortSignal.timeout(1000)), /authority/);
  const oversized = new UpdateService(async () => new Response('x'.repeat(1024 * 1024 + 1)));
  await assert.rejects(oversized.check('master', AbortSignal.timeout(1000)), /too large/);
  const f = releaseFixture(); f.release.assets[2].digest = `sha256:${'c'.repeat(64)}`;
  await assert.rejects(f.service.check('master', AbortSignal.timeout(1000)), /identity mismatch/);
});

test('VSIX downloads stream privately with size/hash checks and never accept tampered bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-update-download-'));
  try {
    const f = releaseFixture(); const path = join(root, 'update.vsix'); const progress = [];
    await f.service.download(candidate, path, AbortSignal.timeout(1000), percent => progress.push(percent));
    assert.deepEqual(await readFile(path), payload);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(progress.at(-1), 100);
    await assert.rejects(f.service.download({ ...candidate, sha256: 'c'.repeat(64) }, join(root, 'bad.vsix'), AbortSignal.timeout(1000), () => {}), /integrity/);
    const tooLong = new UpdateService(async () => new Response(Buffer.concat([payload, Buffer.from('x')])));
    await assert.rejects(tooLong.download(candidate, join(root, 'long.vsix'), AbortSignal.timeout(1000), () => {}), /exceeds/);
    const gate = new AbortController(); gate.abort();
    await assert.rejects(f.service.download(candidate, join(root, 'abort.vsix'), gate.signal, () => {}));
  } finally { await rm(root, { recursive: true, force: true }); }
});

function controllerFixture(overrides = {}) {
  const calls = []; const snapshots = [];
  const host = { installedVersion: '0.2.0', target: 'SSH · fixture · linux x64', blockedReason: null,
    check: async () => { calls.push('check'); return candidate; },
    download: async (_candidate, _path, _signal, progress) => { calls.push('download'); progress(100); },
    confirm: async () => { calls.push('confirm'); return true; },
    acquire: async () => async () => {},
    temporary: async () => ({ path: '/fixture/update.vsix', remove: async () => { calls.push('cleanup'); } }),
    validate: async () => { calls.push('validate'); }, install: async () => { calls.push('install'); },
    restart: async () => { calls.push('restart'); }, saveChannel: async () => {}, ...overrides };
  const controller = new VersionController(host, 'master', snapshot => snapshots.push(snapshot));
  return { host, controller, calls, snapshots };
}

test('confirmed update rechecks immutable identity, validates and cleans up before restart', async () => {
  const f = controllerFixture(); await f.controller.check('master');
  assert.equal(f.controller.snapshot().canInstall, true);
  await f.controller.install('master');
  assert.deepEqual(f.calls, ['check', 'confirm', 'check', 'download', 'validate', 'install', 'cleanup', 'restart']);
});

test('cancelled, changed, failed, unsupported and downgraded updates never restart', async () => {
  for (const host of [{ confirm: async () => false }, { download: async () => { throw Error('private response'); } },
    { validate: async () => { throw Error('bad manifest'); } }, { install: async () => { throw Error('cancelled'); } }]) {
    const f = controllerFixture(host); await f.controller.check('master'); await f.controller.install('master');
    assert.equal(f.calls.includes('restart'), false);
    assert.doesNotMatch(JSON.stringify(f.snapshots), /private response|bad manifest/);
  }
  const changed = controllerFixture(); await changed.controller.check('master'); changed.host.check = async () => ({ ...candidate, assetId: 4 });
  await changed.controller.install('master'); assert.equal(changed.controller.snapshot().available, null);
  assert.equal(changed.calls.includes('install'), false);
  for (const overrides of [{ blockedReason: 'Development Host' }, { installedVersion: '0.3.0' }]) {
    const f = controllerFixture(overrides); await f.controller.check('master'); assert.equal(f.controller.snapshot().canInstall, false);
    await f.controller.install('master'); assert.equal(f.calls.includes('confirm'), false);
  }
});

test('closing settings aborts downloads and simultaneous installation is admitted once', async () => {
  const gate = Promise.withResolvers(); let signal;
  const f = controllerFixture({ download: async (_candidate, _path, received) => { signal = received; await gate.promise; received.throwIfAborted(); } });
  await f.controller.check('master'); const first = f.controller.install('master');
  await new Promise(resolve => setImmediate(resolve)); await f.controller.install('master');
  assert.equal(f.calls.filter(call => call === 'confirm').length, 1);
  f.controller.dispose(); gate.resolve(); await first;
  assert.equal(signal.aborted, true); assert.equal(f.calls.includes('install'), false); assert.equal(f.calls.includes('restart'), false);
});

function zipManifest(value, extra = [], xmlOverride) {
  const files = [['extension/package.json', JSON.stringify(value)], ['extension.vsixmanifest', xmlOverride ??
    `<PackageManifest><Metadata><Identity Id="dsh-companion-vscode" Publisher="dsh-companion" Version="${value.version}" TargetPlatform="linux-x64"/></Metadata></PackageManifest>`], ...extra];
  const locals = []; const entries = []; let offset = 0;
  for (const [path, content] of files) {
    const name = Buffer.from(path); const bytes = Buffer.from(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    const packed = Buffer.concat([local, name, bytes]); locals.push(packed); entries.push(Buffer.concat([central, name])); offset += packed.length;
  }
  const directory = Buffer.concat(entries); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('package inspection pins extension identity and workspace target before VS Code chooses local or remote server', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-update-manifest-'));
  const manifest = { name: 'dsh-companion-vscode', publisher: 'dsh-companion', version: '0.2.0', extensionKind: ['workspace'] };
  try {
    const path = join(root, 'package.vsix'); await writeFile(path, zipManifest(manifest)); await validateUpdatePackage(path, '0.2.0');
    for (const override of [{ extensionKind: ['ui'] }, { publisher: 'other' }, { version: '0.3.0' }, { name: 'other' }, { contributes: { localizations: [] } }]) {
      await writeFile(path, zipManifest({ ...manifest, ...override })); await assert.rejects(validateUpdatePackage(path, '0.2.0'), /identity|target platform/);
    }
    for (const name of ['../escape', '/absolute', 'extension/../escape', 'extension/package.json']) {
      await writeFile(path, zipManifest(manifest, [[name, 'bad']])); await assert.rejects(validateUpdatePackage(path, '0.2.0'), /Unsafe/);
    }
    const misleading = `<PackageManifest><Metadata><!-- <Identity Id="dsh-companion-vscode" Publisher="dsh-companion" Version="0.2.0" TargetPlatform="linux-x64"/> --><Identity Id='other' Publisher='other' Version='0.2.0' TargetPlatform='win32-x64'></Identity></Metadata></PackageManifest>`;
    await writeFile(path, zipManifest(manifest, [], misleading)); await assert.rejects(validateUpdatePackage(path, '0.2.0'), /target platform/);
    await writeFile(path, 'not a ZIP'); await assert.rejects(validateUpdatePackage(path, '0.2.0'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
