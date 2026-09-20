import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DSH_RUNTIME_ROOT,
  loadUpstreamManifest,
  patchSetSha256,
  verifyPatchFiles,
} from '../runtime/dsh/scripts/manifest.mjs';

test('the DSH runtime pin and ordered patch series are integrity checked', async () => {
  const manifest = await loadUpstreamManifest();
  await verifyPatchFiles(manifest);
  assert.equal(manifest.upstream.repository, 'https://github.com/deepseek-ai/deepseek-harness.git');
  assert.equal(manifest.upstream.version, '0.1.5-rc.2');
  assert.equal(manifest.upstream.tag, 'dsh-v0.1.5-rc.2');
  assert.match(patchSetSha256(manifest), /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.patches.map((patch) => patch.id), [
    'node-client-object-runtime',
    'web-runtime-session-title-dependency',
    'sea-compatible-preset-directory-scan',
  ]);
});

test('the downstream Client patch stays outside DSH Agent and Session ownership', async () => {
  const manifest = await loadUpstreamManifest();
  const patch = manifest.patches[0];
  assert.ok(patch);
  const text = await readFile(new URL(`../runtime/dsh/${patch.file}`, import.meta.url), 'utf8');
  assert.match(text, /packages\/api\/client-runtime\/src\/index\.ts/);
  assert.match(text, /packages\/api\/gateway\/src\/client\/stream-client\.ts/);
  assert.doesNotMatch(text, /packages\/core\/(?:agent|agent-loop|session)\/src/);
  assert.equal(patch.upstreamDiscussion, null);
  assert.deepEqual(patch.affectedModules, [
    '@deepseek-ai/dsh-api-client-runtime',
    '@deepseek-ai/dsh-api-gateway/client',
  ]);
  assert.equal(DSH_RUNTIME_ROOT.endsWith('/runtime/dsh'), true);
});

test('the DSH executable closure patch admits only its required title package', async () => {
  const manifest = await loadUpstreamManifest();
  const patch = manifest.patches[1];
  assert.ok(patch);
  const text = await readFile(new URL(`../runtime/dsh/${patch.file}`, import.meta.url), 'utf8');
  assert.match(text, /python\/sdk-runtime\/package\.json/);
  assert.match(text, /@deepseek-ai\/dsh-session-title-llm/);
  assert.doesNotMatch(text, /packages\/.*\/src\//);
});

test('the SEA compatibility patch retains directory validation for preset candidates', async () => {
  const manifest = await loadUpstreamManifest();
  const patch = manifest.patches[2];
  assert.ok(patch);
  const text = await readFile(new URL(`../runtime/dsh/${patch.file}`, import.meta.url), 'utf8');
  assert.match(text, /packages\/preset\/agent-presets\/src\/discovery\.ts/);
  assert.match(text, /await isDirectory\(directory\)/);
  assert.doesNotMatch(text, /packages\/(?:core\/agent|core\/agent-loop|core\/session)\/src/);
});
