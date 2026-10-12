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
      if ([...releases.values()].some(r => r.tag_name === body.tag_name)) throw Object.assign(new Error('Duplicate release tag'), { status: 422 });
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
      if (renameFailure && body.tag_name?.startsWith('build-previous-')) { renameFailure = false; failure('rename failed'); }
      const release = releases.get(Number(path.slice(9)));
      if (body.tag_name && [...releases.values()].some(r => r.id !== release.id && r.tag_name === body.tag_name)) throw Object.assign(new Error('Duplicate release tag'), { status: 422 });
      if (!release.draft && body.tag_name && !refs.has(`tags/${body.tag_name}`)) throw Object.assign(new Error('Missing association tag'), { status: 422 });
      if (body.draft === false && release.draft) release.published_at = `2026-10-10T12:00:${String(release.id).padStart(2, '0')}Z`;
      Object.assign(release, body);
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
  assert.equal(github.refs.has('tags/build-staging-12-1'), false);
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

test('rolling replacement creates a new public object with a version-only title and preserves old assets until canonical publication', async () => {
  const github = fakeGithub();
  const upload = github.upload;
  github.upload = async (...args) => {
    assert.equal(github.releases.get(1).tag_name, 'master-build');
    assert.equal(github.inventory.get(1).length, 3);
    return upload(...args);
  };
  const result = await publishRelease(assets, github);
  assert.notEqual(result.releaseId, 1);
  assert.equal(github.releases.get(result.releaseId).name, info.version);
  assert.ok(github.releases.get(result.releaseId).published_at);
  assert.equal(github.refs.get('tags/master-build'), commit);
  assert.equal(github.releases.size, 1);
  assert.deepEqual(github.inventory.get(result.releaseId).map(a => a.name).sort(), [...assets.names].sort());
  const stagePublication = github.calls.findIndex(c => c.method === 'PATCH' && c.path === 'releases/2' && c.body.draft === false && !c.body.tag_name);
  const oldRename = github.calls.findIndex(c => c.method === 'PATCH' && c.path === 'releases/1');
  const canonicalPublication = github.calls.findIndex(c => c.method === 'PATCH' && c.path === 'releases/2' && c.body.tag_name === 'master-build');
  assert.ok(stagePublication > github.calls.findLastIndex(c => c.upload));
  assert.ok(stagePublication < oldRename);
  assert.ok(github.calls.findIndex(c => c.method === 'DELETE' && c.path === 'releases/1') > canonicalPublication);
  assert.equal(github.calls.some(c => c.path?.startsWith('releases/assets/') && c.method !== 'GET'), false);
  for (const c of github.calls.filter(c => c.path?.startsWith('git/refs') && c.method !== 'DELETE')) assert.equal(c.body.sha, commit);
});

test('upload failure leaves the old release physically untouched', async () => {
  const github = fakeGithub({ uploadFailure: true });
  await assert.rejects(publishRelease(assets, github), /upload failed/);
  assert.equal(github.refs.get('tags/master-build'), previous);
  assert.equal(github.releases.get(1).body, github.originalBody);
  assert.equal(github.releases.size, 1);
  assert.equal(github.inventory.get(1).length, 3);
});

for (const options of [{ renameFailure: true }, { tagFailure: true }, { tagResponseFailure: true }, { cleanupFailure: true }]) {
  test(`swap failure retains assets and journal for serialized retry: ${JSON.stringify(options)}`, async () => {
    const github = fakeGithub(options);
    await assert.rejects(publishRelease(assets, github));
    assert.equal(github.inventory.get(1).length, 3);
    assert.ok([...github.releases.values()].some(r => r.body?.startsWith('<!-- dsh-companion-release-replacement:1 -->')));
    // The fixture's persistent ref failures are removed through a nonfailing API wrapper.
    github.resume();
    if (options.tagFailure || options.tagResponseFailure) {
      const api = github.api;
      github.api = async (method, path, body, missing) => {
        if (method === 'PATCH' && path.startsWith('git/refs/')) {
          assert.equal(body.sha, commit); github.refs.set(path.slice(9), body.sha); return {};
        }
        return api(method, path, body, missing);
      };
    }
    await reconcileRollingRelease(github.api);
    assert.equal(github.releases.size, 1);
    assert.equal(github.releases.has(1), false);
    assert.equal(github.refs.get('tags/master-build'), commit);
  });
}

for (const stage of ['upload', 'stage-publish', 'old-rename', 'master-ref', 'canonical-publish', 'cleanup', 'tag-cleanup', 'journal-delete']) {
  test(`phase interruption recovers safely: ${stage}`, async () => {
    const github = fakeGithub({ interrupt(method, path, body) {
      if (stage === 'upload') return method === 'PATCH' && path === 'releases/3' && JSON.parse(body.body.split('\n')[1]).phase === 'upload';
      if (stage === 'stage-publish') return method === 'PATCH' && path === 'releases/2' && body.draft === false && !body.tag_name;
      if (stage === 'old-rename') return method === 'PATCH' && path === 'releases/1';
      if (stage === 'master-ref') return method === 'PATCH' && path === 'git/refs/tags/master-build';
      if (stage === 'canonical-publish') return method === 'PATCH' && path === 'releases/2' && body.tag_name === 'master-build';
      if (stage === 'cleanup') return method === 'DELETE' && path === 'releases/1';
      if (stage === 'tag-cleanup') return method === 'DELETE' && path.startsWith('git/refs/');
      if (stage === 'journal-delete') return method === 'DELETE' && path === 'releases/3';
      return false;
    } });
    await assert.rejects(publishRelease(assets, github));
    github.resume();
    await reconcileRollingRelease(github.api);
    await reconcileRollingRelease(github.api);
    assert.equal(github.releases.size, 1);
    const live = [...github.releases.values()][0];
    assert.equal(live.id === 1, stage === 'upload');
    assert.equal(github.refs.get('tags/master-build'), stage === 'upload' ? previous : commit);
  });
}

test('master advancement after upload reports a skipped replacement rather than a deleted release as success', async () => {
  const github = fakeGithub(); const api = github.api;
  github.api = async (method, path, body, missing) => {
    const result = await api(method, path, body, missing);
    if (method === 'PATCH' && path === 'releases/3' && body?.body?.includes('"phase":"swap"')) {
      github.refs.set('heads/master', 'e'.repeat(40));
    }
    return result;
  };
  const result = await publishRelease(assets, github);
  assert.equal(result.skipped, true);
  assert.equal(github.releases.size, 1);
  assert.equal(github.releases.get(1).tag_name, 'master-build');
});

test('same-commit new-version builds still create a new release and renew publication time', async () => {
  const github = fakeGithub();
  const first = await publishRelease(assets, github);
  const firstPublishedAt = github.releases.get(first.releaseId).published_at;
  const second = await publishRelease({ ...assets, info: { ...info, version: '0.2.20261010120001' } }, { ...github, runId: '13' });
  assert.notEqual(first.releaseId, second.releaseId);
  assert.notEqual(firstPublishedAt, github.releases.get(second.releaseId).published_at);
  assert.equal(github.releases.size, 1);
  assert.equal(github.releases.get(second.releaseId).name, '0.2.20261010120001');
});

for (const stage of ['master-ref', 'canonical-publish']) {
  test(`newer master recovery never writes the older journal commit: ${stage}`, async () => {
    const github = fakeGithub({ interrupt: (method, path, body) => stage === 'master-ref'
      ? method === 'PATCH' && path === 'git/refs/tags/master-build'
      : method === 'PATCH' && path === 'releases/2' && body.tag_name === 'master-build' });
    await assert.rejects(publishRelease(assets, github));
    github.resume();
    github.refs.set('heads/master', 'e'.repeat(40));
    const before = github.calls.length;
    await reconcileRollingRelease(github.api);
    assert.equal(github.calls.slice(before).some(c => ['POST', 'PATCH'].includes(c.method) && c.path.startsWith('git/refs')), false);
    assert.equal(github.releases.size, 1);
    assert.equal([...github.releases.values()][0].id, stage === 'master-ref' ? 1 : 2);
  });
}

for (const stage of ['stage-publish', 'old-rename', 'canonical-publish']) {
  test(`same-SHA interrupted rerun with advanced master uses associations, never old ref writes: ${stage}`, async () => {
    const github = fakeGithub({ interrupt(method, path, body) {
      if (stage === 'stage-publish') return method === 'PATCH' && path === 'releases/2' && body.draft === false && !body.tag_name;
      if (stage === 'old-rename') return method === 'PATCH' && path === 'releases/1';
      return method === 'PATCH' && path === 'releases/2' && body.tag_name === 'master-build';
    } });
    github.refs.set('tags/master-build', commit);
    github.releases.get(1).body = `<!-- dsh-companion-build:1 -->\nCommit: ${commit}\n`;
    await assert.rejects(publishRelease(assets, github));
    github.resume();
    github.refs.set('heads/master', 'e'.repeat(40));
    const before = github.calls.length;
    await reconcileRollingRelease(github.api);
    assert.equal(github.calls.slice(before).some(c => ['POST', 'PATCH'].includes(c.method) && c.path.startsWith('git/refs')), false);
    assert.equal(github.releases.size, 1);
    assert.equal([...github.releases.values()][0].id, stage === 'canonical-publish' ? 2 : 1);
  });
}

for (const forgery of ['oldID', 'newBody', 'extra-key', 'draft-target', 'foreign-asset', 'release-title']) {
  test(`replacement ownership refuses ${forgery} before mutation`, async () => {
    const github = fakeGithub({ interrupt: (method, path) => method === 'PATCH' && path === 'releases/1' });
    await assert.rejects(publishRelease(assets, github));
    github.resume();
    const draft = github.releases.get(3);
    const marker = '<!-- dsh-companion-release-replacement:1 -->';
    const journal = JSON.parse(draft.body.slice(marker.length).trim());
    if (forgery === 'oldID') journal.oldID = 2;
    if (forgery === 'newBody') journal.newBody = `Commit: ${commit}\n`;
    if (forgery === 'extra-key') journal.unexpected = true;
    if (forgery === 'draft-target') draft.target_commitish = previous;
    if (forgery === 'foreign-asset') journal.newAssets[0].id = 10;
    if (forgery === 'release-title') github.releases.get(2).name = 'Master build';
    draft.body = `${marker}\n${JSON.stringify(journal)}`;
    const before = github.calls.length;
    await assert.rejects(reconcileRollingRelease(github.api), /journal ownership/);
    assert.equal(github.calls.slice(before).some(c => c.method !== 'GET'), false);
  });
}

test('duplicate canonical associations are rejected before mutations', async () => {
  const github = fakeGithub();
  github.releases.set(8, { ...github.releases.get(1), id: 8 });
  await assert.rejects(publishRelease(assets, github), /duplicate release associations/);
  assert.equal(github.calls.some(c => c.method !== 'GET'), false);
});

test('incidental build markers never authorize legacy public backup deletion', async () => {
  const github = fakeGithub();
  github.releases.set(8, { id: 8, tag_name: 'build-previous-11-1', draft: false, prerelease: true,
    body: `Manual release\n<!-- dsh-companion-build:1 -->\nCommit: ${previous}\n` });
  github.inventory.set(8, [{ id: 80, name: 'manual.vsix' }]);
  await assert.rejects(reconcileRollingRelease(github.api), /manual intervention/);
  assert.equal(github.releases.has(8), true);
  assert.equal(github.calls.some(c => c.method !== 'GET'), false);
});

for (const old of [true, false]) {
  test(`stale first/replacement publication discard survives accepted DELETE response loss: old=${old}`, async () => {
    const github = fakeGithub({ old, interrupt: (method, path, body) => method === 'PATCH' && path === (old ? 'releases/1' : 'releases/2')
      && (old ? body.tag_name?.startsWith('build-previous-') : body.draft === false) });
    if (!old) github.refs.delete('tags/master-build');
    await assert.rejects(publishRelease(assets, github));
    github.resume();
    github.refs.set('heads/master', 'e'.repeat(40));
    const api = github.api;
    let lost = false;
    const unreliable = async (method, path, body, missing) => {
      const result = await api(method, path, body, missing);
      if (!lost && method === 'DELETE' && path === 'releases/2') { lost = true; throw new Error('lost delete response'); }
      return result;
    };
    await assert.rejects(reconcileRollingRelease(unreliable), /lost delete response/);
    await reconcileRollingRelease(api);
    assert.equal(github.releases.size, old ? 1 : 0);
    assert.equal([...github.releases.values()].some(r => r.body?.startsWith('<!-- dsh-companion-release-replacement:1 -->')), false);
    assert.equal(github.refs.get('tags/master-build'), old ? previous : undefined);
  });
}

test('legacy in-place upload journals still recover without ref writes', async () => {
  const github = fakeGithub();
  const marker = '<!-- dsh-companion-rolling-journal:1 -->';
  const journal = { format: 1, releaseId: 1, oldBody: github.originalBody, oldSHA: previous,
    newSHA: commit, newBody: `<!-- dsh-companion-build:1 -->\nCommit: ${commit}\n`,
    prefix: 'dsh-stage-11-1-', phase: 'upload', oldAssets: github.inventory.get(1).map(a => ({ ...a })),
    newAssets: [{ name: 'new.vsix', stagedName: 'dsh-stage-11-1-new-0-new.vsix' }] };
  github.releases.set(8, { id: 8, tag_name: 'build-staging-11-1', target_commitish: commit,
    draft: true, prerelease: true, body: `${marker}\n${JSON.stringify(journal)}` });
  github.inventory.set(8, []);
  await reconcileRollingRelease(github.api);
  assert.equal(github.releases.size, 1);
  assert.equal(github.inventory.get(1).length, 3);
  assert.equal(github.refs.get('tags/master-build'), previous);
  assert.equal(github.calls.some(c => ['POST', 'PATCH'].includes(c.method) && c.path.startsWith('git/refs')), false);
});

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
  const stableResult = await publishRelease(stable, github);
  assert.equal(stableResult.tag, 'v0.2.0');
  assert.equal(github.releases.get(stableResult.releaseId).name, '0.2.0');
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
