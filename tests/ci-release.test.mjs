import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { channelForRef } from '../scripts/ci/build-metadata.mjs';
import { allowedBuildOutput, captureBaseline, collectBuildOutputs, restoreBuildOutputs } from '../scripts/ci/dsh-build-cache.mjs';
import { deleteTagIfExists, publishRelease, readReleaseAssets, reconcileRollingRelease } from '../scripts/ci/publish-release.mjs';

const commit = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const info = { format: 1, channel: 'master', commit, version: '0.2.20261010120000',
  runtimeId: 'c'.repeat(64), target: 'linux-x64',
  dsh: { version: '0.1.7-rc.2', commit: previous, patchSetSha256: 'd'.repeat(64) }, runUrl: 'https://github.com/test/product/actions/runs/1' };

function fakeGithub({ old = true, head = commit, uploadFailure = false, renameFailure = false,
  tagFailure = false, tagResponseFailure = false, advanceOnUpload = false, cleanupFailure = false,
  interrupt = null } = {}) {
  const calls = [];
  const refs = new Map([['heads/master', head], ['tags/master-build', previous], ['tags/v0.2.0', commit]]);
  const originalBody = `<!-- dsh-companion-build:1 -->\nCommit: ${previous}\n`;
  const releases = new Map(old ? [[1, { id: 1, tag_name: 'master-build', draft: false,
    body: originalBody, upload_url: 'upload/1', prerelease: true }]] : []);
  const inventory = new Map(old ? [[1, [{ id: 10, name: 'previous.vsix' }, { id: 11, name: 'build-info.json' }, { id: 12, name: 'SHA256SUMS' }]]] : []);
  let next = 2;
  let nextAsset = 20;
  let interrupted = false;
  const failure = message => { throw new Error(message); };
  const api = async (method, path, body, missing) => {
    calls.push({ method, path, body });
    if (interrupt && !interrupted && interrupt(method, path, body)) {
      interrupted = true;
      failure('process interrupted');
    }
    if (interrupted) failure('process unavailable');
    if (method === 'GET' && path === 'git/matching-refs/tags/build-') {
      return [...refs.keys()].filter(key => key.startsWith('tags/build-')).map(key => ({ ref: `refs/${key}` }));
    }
    if (method === 'GET' && /^releases\/\d+$/.test(path)) {
      const release = releases.get(Number(path.split('/')[1]));
      return release ? { ...release } : null;
    }
    if (method === 'GET' && path.startsWith('releases?')) return [...releases.values()].map(r => ({ ...r }));
    if (method === 'GET' && /^releases\/\d+\/assets/.test(path)) return (inventory.get(Number(path.split('/')[1])) ?? []).map(a => ({ ...a }));
    if (method === 'GET' && path.startsWith('git/ref/')) {
      const key = path.slice(8);
      if (!refs.has(key)) { if (missing) return null; failure('missing ref'); }
      return { object: { type: 'commit', sha: refs.get(key) } };
    }
    if (method === 'GET' && path.startsWith('releases/tags/')) {
      const release = [...releases.values()].find(r => !r.draft && r.tag_name === path.slice(14));
      return release ? { ...release } : null;
    }
    if (method === 'POST' && path === 'releases') {
      const release = { ...body, id: next++, upload_url: `upload/${next - 1}` };
      releases.set(release.id, release); inventory.set(release.id, []); return { ...release };
    }
    if (path.startsWith('releases/assets/')) {
      const id = Number(path.split('/')[2]);
      const list = [...inventory.values()].find(list => list.some(a => a.id === id));
      const asset = list?.find(a => a.id === id);
      if (method === 'GET') return asset ? { ...asset } : null;
      assert.ok(asset, 'asset must exist');
      if (method === 'PATCH') {
        if (renameFailure) { renameFailure = false; failure('rename failed'); }
        assert.ok(!list.some(a => a.id !== id && a.name === body.name), 'GitHub rejects duplicate asset names');
        Object.assign(asset, body); return { ...asset };
      }
      if (method === 'DELETE') {
        if (cleanupFailure) failure('cleanup failed');
        list.splice(list.indexOf(asset), 1); return null;
      }
    }
    if (method === 'PATCH' && path.startsWith('releases/')) {
      const release = releases.get(Number(path.slice(9))); Object.assign(release, body);
      if (body.draft === false && !refs.has(`tags/${release.tag_name}`)) refs.set(`tags/${release.tag_name}`, body.target_commitish);
      return { ...release };
    }
    if (method === 'DELETE' && path.startsWith('releases/')) {
      if (cleanupFailure) failure('cleanup failed');
      const id = Number(path.slice(9)); releases.delete(id); inventory.delete(id); return null;
    }
    if (method === 'POST' && path === 'git/refs') {
      if (body.sha !== commit) throw Object.assign(new Error('old workflow ref forbidden'), { status: 403 });
      refs.set(body.ref.slice(5), body.sha); return {};
    }
    if (method === 'PATCH' && path.startsWith('git/refs/')) {
      assert.equal(body.sha, commit, 'never move refs to old commits');
      if (tagFailure) failure('tag failed');
      refs.set(path.slice(9), body.sha);
      if (tagResponseFailure) failure('tag response failed');
      return {};
    }
    if (method === 'DELETE' && path.startsWith('git/refs/')) {
      const ref = path.slice(9);
      if (!refs.has(ref)) throw Object.assign(new Error('Reference does not exist'), { status: 422 });
      refs.delete(ref); return null;
    }
    failure(`unhandled fixture API: ${method} ${path}`);
  };
  const upload = async (url, name, publishedName = name) => {
    calls.push({ upload: name, publishedName });
    if (advanceOnUpload) refs.set('heads/master', previous);
    if (uploadFailure) failure('upload failed');
    const list = inventory.get(Number(url.split('/')[1]));
    assert.ok(!list.some(a => a.name === publishedName));
    const asset = { id: nextAsset++, name: publishedName }; list.push(asset); return { ...asset };
  };
  return { api, upload, refs, releases, inventory, calls, originalBody, runId: '12', attempt: '1',
    resume() { interrupted = false; interrupt = null; cleanupFailure = false; } };
}

const assets = { info, names: ['dsh-companion-0.2.20261010120000-linux-x64.vsix', 'build-info.json', 'SHA256SUMS'], releaseTag: '' };

test('CI admits only master and supported product release tags', () => {
  assert.deepEqual(channelForRef('refs/heads/master'), { channel: 'master', releaseTag: '' });
  assert.deepEqual(channelForRef('refs/tags/v0.2.0'), { channel: 'release', releaseTag: 'v0.2.0' });
  for (const ref of ['refs/heads/feature', 'refs/tags/master-build', 'refs/tags/v0.2.1', 'refs/tags/v0.2.0-rc.1', 'refs/tags/v01.2.0']) {
    assert.throws(() => channelForRef(ref), /must target/);
  }
});

test('first master publication succeeds when its draft never created a staging tag', async () => {
  const github = fakeGithub({ old: false });
  github.refs.delete('tags/master-build');
  const result = await publishRelease(assets, github);
  assert.equal(result.tag, 'master-build');
  assert.equal(github.releases.size, 1);
  assert.equal(github.refs.get('tags/master-build'), commit);
  assert.equal(github.calls.some(call => call.method === 'DELETE' && call.path === 'git/refs/tags/build-staging-12-1'), false);
});

test('tag cleanup confirms absence instead of swallowing protected-reference errors', async () => {
  for (const status of [404, 422]) {
    let reads = 0;
    await deleteTagIfExists(async method => {
      if (method === 'GET') return ++reads === 1 ? { object: { sha: commit } } : null;
      throw Object.assign(new Error('concurrently removed'), { status });
    }, 'build-staging-12-1');
    assert.equal(reads, 2);
  }
  for (const status of [403, 422, 500]) {
    await assert.rejects(deleteTagIfExists(async method => {
      if (method === 'GET') return { object: { sha: commit } };
      throw Object.assign(new Error('protected or unavailable'), { status });
    }, 'build-staging-12-1'), /protected or unavailable/);
  }
});

test('rolling publication updates assets in place and never creates an old-commit ref', async () => {
  const github = fakeGithub();
  const result = await publishRelease(assets, github);
  assert.equal(result.releaseId, 1);
  assert.equal(github.refs.get('tags/master-build'), commit);
  assert.equal(github.releases.size, 1);
  assert.deepEqual(github.inventory.get(1).map(a => a.name).sort(), [...assets.names].sort());
  const lastUpload = github.calls.findLastIndex(call => call.upload);
  const firstRename = github.calls.findIndex(call => call.method === 'PATCH' && call.path.startsWith('releases/assets/'));
  assert.ok(lastUpload < firstRename);
  assert.equal(github.calls.some(c => c.method === 'POST' && c.path === 'git/refs'), false);
  const commitPoint = github.calls.findIndex(c => c.method === 'PATCH' && c.path === 'git/refs/tags/master-build');
  assert.ok(github.calls.findIndex(c => c.method === 'DELETE' && c.path.startsWith('releases/assets/')) > commitPoint);
});

for (const options of [{ uploadFailure: true }, { renameFailure: true }, { tagFailure: true }]) {
  test(`precommit failure preserves previous release: ${JSON.stringify(options)}`, async () => {
    const github = fakeGithub(options);
    await assert.rejects(publishRelease(assets, github), /failed/);
    assert.equal(github.refs.get('tags/master-build'), previous);
    assert.equal(github.releases.get(1).body, github.originalBody);
    assert.deepEqual(github.inventory.get(1).map(a => a.name), ['previous.vsix', 'build-info.json', 'SHA256SUMS']);
    assert.equal(github.releases.size, 1);
  });
}

test('lost tag update response finishes committed publication instead of rewinding', async () => {
  const github = fakeGithub({ tagResponseFailure: true });
  await assert.rejects(publishRelease(assets, github), /tag response failed/);
  assert.equal(github.refs.get('tags/master-build'), commit);
  assert.deepEqual(github.inventory.get(1).map(a => a.name).sort(), [...assets.names].sort());
  assert.equal(github.releases.size, 1);
});

test('same-commit rolling retries do not create an ambiguous recovery journal', async () => {
  const github = fakeGithub();
  await publishRelease(assets, github);
  const before = github.calls.length;
  assert.equal((await publishRelease(assets, github)).skipped, true);
  assert.equal(github.calls.slice(before).some(call => call.method === 'POST'), false);
});

for (const stage of ['pending-upload', 'rename', 'body-switch', 'after-commit', 'partial-cleanup']) {
  test(`serialized recovery after process interruption: ${stage}`, async () => {
    let journalWrites = 0;
    let renames = 0;
    let deletions = 0;
    const github = fakeGithub({ interrupt(method, path) {
      if (stage === 'pending-upload' && method === 'PATCH' && path === 'releases/2') return ++journalWrites === 1;
      if (stage === 'rename' && method === 'PATCH' && path.startsWith('releases/assets/')) return ++renames === 5;
      if (stage === 'body-switch') return method === 'PATCH' && path === 'git/refs/tags/master-build';
      if (stage === 'partial-cleanup' && method === 'DELETE' && path.startsWith('releases/assets/')) return ++deletions === 2;
      if (stage === 'after-commit') return method === 'DELETE' && path.startsWith('releases/assets/');
      return false;
    } });
    await assert.rejects(publishRelease(assets, github));
    assert.equal(github.releases.size, 2, 'durable draft journal retained');
    github.resume();
    await reconcileRollingRelease(github.api);
    assert.equal(github.releases.size, 1);
    const committed = ['after-commit', 'partial-cleanup'].includes(stage);
    assert.equal(github.refs.get('tags/master-build'), committed ? commit : previous);
    assert.deepEqual(github.inventory.get(1).map(a => a.name).sort(),
      committed ? [...assets.names].sort() : ['previous.vsix', 'build-info.json', 'SHA256SUMS'].sort());
  });
}

test('cleanup errors retain committed journal for retry', async () => {
  const github = fakeGithub({ cleanupFailure: true });
  await assert.rejects(publishRelease(assets, github), /cleanup failed/);
  assert.equal(github.refs.get('tags/master-build'), commit);
  assert.equal(github.releases.size, 2);
  github.resume();
  await reconcileRollingRelease(github.api);
  await reconcileRollingRelease(github.api);
  assert.equal(github.releases.size, 1);
  assert.deepEqual(github.inventory.get(1).map(a => a.name).sort(), [...assets.names].sort());
});

for (const forgery of ['stable-release', 'prefix', 'body', 'foreign-asset', 'extra-key', 'draft-target', 'unexpected-live-name']) {
  test(`journal ownership refuses ${forgery} before any mutation`, async () => {
    const github = fakeGithub({ interrupt: (method, path) => method === 'PATCH' && path.startsWith('releases/assets/') });
    await assert.rejects(publishRelease(assets, github));
    github.resume();
    const draft = github.releases.get(2);
    const marker = '<!-- dsh-companion-rolling-journal:1 -->';
    const journal = JSON.parse(draft.body.slice(marker.length).trim());
    github.releases.set(8, { id: 8, tag_name: 'v0.2.0', prerelease: false, draft: false, body: github.originalBody });
    github.inventory.set(8, [{ id: 80, name: 'stable.vsix' }]);
    if (forgery === 'stable-release') journal.releaseId = 8;
    if (forgery === 'prefix') journal.prefix = 'dsh-stage-12-1-unowned-';
    if (forgery === 'body') journal.newBody = `Commit: ${commit}\n`;
    if (forgery === 'foreign-asset') journal.newAssets[0].id = 80;
    if (forgery === 'extra-key') journal.unexpected = true;
    if (forgery === 'draft-target') draft.target_commitish = previous;
    if (forgery === 'unexpected-live-name') github.inventory.get(1)[0].name = 'unowned.vsix';
    draft.body = `${marker}\n${JSON.stringify(journal)}`;
    const before = github.calls.length;
    await assert.rejects(reconcileRollingRelease(github.api), /journal ownership/);
    assert.equal(github.calls.slice(before).some(call => call.method !== 'GET'), false);
    assert.equal(github.inventory.get(8)[0].name, 'stable.vsix');
  });
}

test('legacy recovery refuses ref rewinds but can restore a release on an unchanged tag', async () => {
  const github = fakeGithub();
  Object.assign(github.releases.get(1), { tag_name: 'build-previous-11-1' });
  github.refs.set('tags/build-previous-11-1', previous);
  github.refs.set('tags/master-build', commit);
  await assert.rejects(reconcileRollingRelease(github.api), /manual intervention/);
  github.refs.set('tags/master-build', previous);
  await reconcileRollingRelease(github.api);
  assert.equal(github.releases.get(1).tag_name, 'master-build');
  assert.equal(github.refs.has('tags/build-previous-11-1'), false);
});

test('stale master builds never replace a newer head, including advancement during upload', async () => {
  for (const options of [{ head: previous }, { advanceOnUpload: true }]) {
    const github = fakeGithub(options);
    assert.equal((await publishRelease(assets, github)).skipped, true);
    assert.equal(github.refs.get('tags/master-build'), previous);
    assert.equal(github.releases.size, 1);
  }
});

test('tag releases are durable and cannot overwrite an existing successful release', async () => {
  const github = fakeGithub();
  const stable = { ...assets, info: { ...info, channel: 'release', version: '0.2.0' }, releaseTag: 'v0.2.0' };
  assert.equal((await publishRelease(stable, github)).tag, 'v0.2.0');
  const before = github.calls.length;
  await assert.rejects(publishRelease(stable, github), /already exists/);
  assert.equal(github.calls.slice(before).some(call => call.method === 'POST'), false);
  assert.equal(github.refs.get('tags/master-build'), previous);
  github.refs.set('tags/v0.2.0', previous);
  await assert.rejects(publishRelease(stable, github), /tag moved/);
});

test('a cancelled same-commit stable draft can be retried without replacing published assets', async () => {
  const github = fakeGithub();
  github.releases.set(8, { id: 8, tag_name: 'v0.2.0', draft: true,
    body: `<!-- dsh-companion-build:1 -->\nCommit: ${commit}\n` });
  const stable = { ...assets, info: { ...info, channel: 'release', version: '0.2.0' }, releaseTag: 'v0.2.0' };
  await publishRelease(stable, github);
  assert.equal(github.releases.has(8), false);
  assert.ok([...github.releases.values()].some(release => release.tag_name === 'v0.2.0' && !release.draft));
});

test('downloaded publication assets must match commit, channel, exact inventory and hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-release-assets-'));
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  try {
    const name = `dsh-companion-${info.version}-linux-x64.vsix`;
    const bytes = Buffer.from('VSIX fixture');
    const metadata = JSON.stringify({ ...info, assets: [{ name, sha256: digest(bytes), size: bytes.length }] });
    await writeFile(join(root, name), bytes);
    await writeFile(join(root, 'build-info.json'), metadata);
    await writeFile(join(root, 'SHA256SUMS'), `${digest(bytes)}  ${name}\n${digest(metadata)}  build-info.json\n`);
    assert.equal((await readReleaseAssets(root, commit, 'refs/heads/master')).info.commit, commit);
    await assert.rejects(readReleaseAssets(root, previous, 'refs/heads/master'), /identity mismatch/);
    await assert.rejects(readReleaseAssets(root, commit, 'refs/tags/v0.2.0'), /identity mismatch/);
    await writeFile(join(root, name), 'corrupted');
    await assert.rejects(readReleaseAssets(root, commit, 'refs/heads/master'), /integrity mismatch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DSH build cache selects generated outputs, never dependencies, patch source or private state', () => {
  for (const path of ['packages/core/agent/lib/index.js', 'apps/web/dist/index.html', 'lib/tsconfig.host.tsbuildinfo',
    'packages/core/agent/.tsbuildinfo', '.dsh-build/client-build-environment.json', 'native/system/packages/linux-x64/bin/glibc/system.node']) {
    assert.equal(allowedBuildOutput(path), true, path);
  }
  for (const path of ['../escape.tsbuildinfo', '/absolute/lib/index.js', 'node_modules/lib/index.js',
    'packages/core/agent/src/index.ts', '.env', '.dev/runtime.json', 'lib/../escape', 'lib/.env.secret', 'lib/node_modules/secret']) {
    assert.equal(allowedBuildOutput(path), false, path);
  }
});

test('DSH cache round trip excludes prepared patch files and fails closed on changed source or bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-dsh-cache-'));
  const source = join(root, 'source');
  const cache = join(root, 'cache');
  const baseline = join(root, 'baseline.json');
  const git = (...args) => execFileSync('git', args, { cwd: source, stdio: 'ignore' });
  try {
    await mkdir(source); git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    await writeFile(join(source, 'package.json'), '{}'); git('add', '.'); git('commit', '-m', 'fixture');
    await writeFile(join(source, 'patch-added.ts'), 'source');
    await captureBaseline(source, baseline);
    await mkdir(join(source, 'lib'));
    await writeFile(join(source, 'lib', 'index.js'), 'generated');
    await collectBuildOutputs(source, baseline, cache, 'fixture-key');
    const manifest = JSON.parse(await readFile(join(cache, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.entries.map(entry => entry.path), ['lib/index.js']);
    await rm(join(source, 'lib'), { recursive: true });
    await restoreBuildOutputs(source, cache, 'fixture-key');
    assert.equal(await readFile(join(source, 'lib', 'index.js'), 'utf8'), 'generated');
    await assert.rejects(restoreBuildOutputs(source, cache, 'fixture-key'), /overwrite/);
    await assert.rejects(restoreBuildOutputs(source, cache, 'wrong'), /identity/);
    await rm(join(source, 'lib'), { recursive: true });
    await writeFile(join(cache, 'files', 'lib', 'index.js'), 'corrupt');
    await assert.rejects(restoreBuildOutputs(source, cache, 'fixture-key'), /Corrupt/);
    await writeFile(join(source, 'patch-added.ts'), 'changed');
    await assert.rejects(collectBuildOutputs(source, baseline, join(root, 'other-cache'), 'key'), /modified baseline/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DSH cache restore rejects symlinked ancestors on both sides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-cache-ancestor-'));
  const source = join(root, 'source');
  const cache = join(root, 'cache');
  const outside = join(root, 'outside');
  const hash = createHash('sha256').update('generated').digest('hex');
  try {
    await mkdir(source); await mkdir(join(cache, 'files'), { recursive: true }); await mkdir(outside);
    await writeFile(join(outside, 'output.js'), 'generated');
    await writeFile(join(cache, 'manifest.json'), JSON.stringify({ format: 1, key: 'key',
      entries: [{ path: 'lib/output.js', sha256: hash, mode: 0o644 }] }));
    await symlink(outside, join(cache, 'files', 'lib'));
    await assert.rejects(restoreBuildOutputs(source, cache, 'key'), /unsafe ancestor/);
    await rm(join(cache, 'files', 'lib'));
    await mkdir(join(cache, 'files', 'lib'));
    await writeFile(join(cache, 'files', 'lib', 'output.js'), 'generated');
    await rm(join(outside, 'output.js'));
    await symlink(outside, join(source, 'lib'));
    await assert.rejects(restoreBuildOutputs(source, cache, 'key'), /unsafe ancestor/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DSH cache does not follow non-regular output files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-dsh-cache-link-'));
  try {
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    await writeFile(join(root, 'source'), 'data');
    await mkdir(join(root, 'lib'));
    await symlink('../source', join(root, 'lib', 'output.js'));
    await assert.rejects(captureBaseline(root, join(root, 'baseline.json')), /non-regular/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
