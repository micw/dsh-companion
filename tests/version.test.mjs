import assert from 'node:assert/strict';
import test from 'node:test';

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

test('development versions reject an invalid release base and nonnumeric build id', () => {
  assert.throws(() => resolveVersion([], 'experiment', '7'), /no valid release tag/);
  assert.throws(() => resolveVersion([], 'v0.14.0', 'dev'), /invalid development build id/);
  assert.throws(() => resolveVersion([], '', 'dev'), /invalid development build id/);
});
