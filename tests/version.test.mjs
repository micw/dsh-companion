import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveVersion } from '../scripts/version.mjs';

test('an exact release tag becomes the stable version', () => {
  assert.equal(resolveVersion(['v0.14.0'], 'v0.14.0', '20260908220001'), '0.14.0');
});

test('an untagged commit becomes a patch-level development version', () => {
  assert.equal(resolveVersion([], 'v0.14.0', '20260908220001'), '0.14.20260908220001');
});

test('a non-release tag does not turn a build into a release', () => {
  assert.equal(resolveVersion(['experiment'], 'v0.14.0', '7'), '0.14.7');
});

test('development builds before the first release use the implicit 0.0 base', () => {
  assert.equal(resolveVersion([], '', '20260908220001'), '0.0.20260908220001');
});

test('multiple release tags on one commit are rejected', () => {
  assert.throws(
    () => resolveVersion(['v0.14.0', 'v0.15.0'], 'v0.15.0', '7'),
    /more than one release tag/,
  );
});

test('master always uses a development version, even with multiple exact release tags', () => {
  assert.equal(resolveVersion(['v1.2.0', 'v1.3.0'], 'v1.3.0', '7', { channel: 'master' }), '1.3.7');
});

test('release explicitly selects one valid HEAD tag', () => {
  assert.equal(resolveVersion(['v1.2.0', 'v1.3.0'], 'v1.3.0', '7', {
    channel: 'release', releaseTag: 'v1.2.0',
  }), '1.2.0');
  assert.throws(() => resolveVersion(['v1.2.0'], '', '7', { channel: 'release' }), /explicit releaseTag/);
  assert.throws(() => resolveVersion(['v1.2.0'], '', '7', {
    channel: 'release', releaseTag: 'v1.3.0',
  }), /does not point at HEAD/);
});

test('invalid channels, options, release tags, and build IDs are rejected', () => {
  for (const options of [null, [], new Date(), 'master', { unknown: true }, { [Symbol('unknown')]: true }, { channel: '' }, { channel: 'preview' }]) {
    assert.throws(() => resolveVersion([], '', '7', options), /invalid/);
  }
  for (const releaseTag of ['', 'v01.2.0', 'v1.2.1', 'v1.2.0-rc.1', 123, null]) {
    assert.throws(() => resolveVersion([], '', '7', { channel: 'release', releaseTag }), /invalid release tag/);
  }
  for (const channel of ['auto', 'master']) {
    assert.throws(() => resolveVersion([], '', '7', { channel, releaseTag: 'v1.2.0' }), /requires the release/);
  }
  for (const buildId of ['', '0', '01', '-1', '1.2', ' 7', '7\n', 7, null]) {
    assert.throws(() => resolveVersion(['v1.2.0'], 'v1.2.0', buildId), /invalid development build id/);
  }
});

test('unsupported exact tags remain development builds', () => {
  for (const tag of ['v1.2.1', 'v1.2.0-rc.1', 'v01.2.0']) {
    assert.equal(resolveVersion([tag], 'v1.1.0', '7'), '1.1.7');
  }
});

test('CLI channels and nearest-tag filtering work in an isolated Git repository', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-companion-version-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '--initial-branch=master');
  git('config', 'user.name', 'Version Test');
  git('config', 'user.email', 'version-test@example.invalid');
  let commitCount = 0;
  const commit = () => {
    writeFileSync(join(cwd, 'fixture.txt'), String(++commitCount));
    git('add', 'fixture.txt');
    git('commit', '-m', `Fixture ${commitCount}`);
  };
  const script = fileURLToPath(new URL('../scripts/version.mjs', import.meta.url));
  const run = (overrides = {}) => {
    const env = { ...process.env };
    for (const key of ['DSH_COMPANION_BUILD_CHANNEL', 'DSH_COMPANION_BUILD_ID', 'DSH_COMPANION_RELEASE_TAG']) delete env[key];
    return spawnSync(process.execPath, [script], {
      cwd, encoding: 'utf8', env: { ...env, DSH_COMPANION_BUILD_ID: '42', ...overrides },
    });
  };
  const expectVersion = (expected, overrides) => {
    const result = run(overrides);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  };
  commit();
  expectVersion('0.0.42');
  const timestamp = run({ DSH_COMPANION_BUILD_ID: undefined });
  assert.equal(timestamp.status, 0, timestamp.stderr);
  assert.match(timestamp.stdout.trim(), /^0\.0\.[1-9]\d{13}$/);
  git('tag', 'v1.2.0');
  expectVersion('1.2.0');
  expectVersion('1.2.42', { DSH_COMPANION_BUILD_CHANNEL: 'master' });
  commit();
  git('tag', 'v1.2.1');
  commit();
  git('tag', 'v1.3.0-rc.1');
  expectVersion('1.2.42');
  git('tag', 'v1.3.0');
  git('tag', 'v2.0.0');
  assert.equal(run().status, 1);
  expectVersion('1.3.0', { DSH_COMPANION_BUILD_CHANNEL: 'release', DSH_COMPANION_RELEASE_TAG: 'v1.3.0' });
  expectVersion('2.0.0', { DSH_COMPANION_BUILD_CHANNEL: 'release', DSH_COMPANION_RELEASE_TAG: 'v2.0.0' });
  const wrongHead = run({ DSH_COMPANION_BUILD_CHANNEL: 'release', DSH_COMPANION_RELEASE_TAG: 'v1.2.0' });
  assert.equal(wrongHead.status, 1);
  assert.match(wrongHead.stderr, /does not point at HEAD/);
  for (const overrides of [
    { DSH_COMPANION_BUILD_CHANNEL: 'invalid' },
    { DSH_COMPANION_BUILD_CHANNEL: '' },
    { DSH_COMPANION_BUILD_ID: '' },
    { DSH_COMPANION_BUILD_CHANNEL: 'release' },
    { DSH_COMPANION_BUILD_CHANNEL: 'release', DSH_COMPANION_RELEASE_TAG: 'v1.2.1' },
  ]) assert.equal(run(overrides).status, 1);
  writeFileSync(join(cwd, 'fixture.txt'), 'dirty');
  assert.match(run().stderr, /dirty working tree/);
});

test('development versions reject an invalid release base and nonnumeric build id', () => {
  assert.throws(() => resolveVersion([], 'experiment', '7'), /no valid release tag/);
  assert.throws(() => resolveVersion([], 'v0.14.0', 'dev'), /invalid development build id/);
  assert.throws(() => resolveVersion([], '', 'dev'), /invalid development build id/);
});
