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
    'model-capabilities-and-selection-intent',
    'provider-neutral-model-cost-accounting',
    'turn-cost-snapshots-and-model-status',
    'explicit-manual-compaction-route',
    'agent-preset-fallbacks',
    'sea-client-module-proxies',
  ]);
});

test('the SEA client-module patch follows launcher-generated package proxies', async () => {
  const manifest = await loadUpstreamManifest();
  const patch = manifest.patches[8];
  assert.ok(patch);
  const text = await readFile(new URL(`../runtime/dsh/${patch.file}`, import.meta.url), 'utf8');
  assert.match(text, /moduleFallback\?\.targets\?\.\['\.\/client'\]/u);
  assert.match(text, /this\.nearestPackage\(fallback, packageName\)/u);
  assert.match(text, /follows a packaged module proxy to its virtual client bundle metadata/u);
  assert.deepEqual(patch.affectedModules, ['@deepseek-ai/dsh-client-modules']);
});

test('the preset fallback patch keeps retired ids out of the roster', async () => {
  const manifest = await loadUpstreamManifest();
  const patch = manifest.patches[7];
  assert.ok(patch);
  const text = await readFile(new URL(`../runtime/dsh/${patch.file}`, import.meta.url), 'utf8');
  assert.match(text, /fallbacks: z\.dict\(z\.string\(\)\)\.default\(\{\}\)/u);
  assert.match(text, /presets\.find\(preset => preset\.id === this\.config\.fallbacks\?\.\[wanted\]\)/u);
  assert.match(text, /some\(preset => preset\.id === 'retired'\)\)\.toBe\(false\)/u);
  assert.deepEqual(patch.affectedModules, ['@deepseek-ai/dsh-agent-presets']);
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

test('the model cost patch persists validated accounting and projects coverage', async () => {
  const manifest = await loadUpstreamManifest();
  const patch = manifest.patches[4];
  assert.ok(patch);
  const text = await readFile(new URL(`../runtime/dsh/${patch.file}`, import.meta.url), 'utf8');
  assert.match(text, /interface ModelCallAccounting/);
  assert.match(text, /type: 'accounting'/);
  assert.match(text, /accounting\?: ModelCallAccounting/);
  assert.match(text, /key: 'modelCost'/);
  assert.match(text, /unaccountedTurns/);
  assert.match(text, /accounting disagrees with its embedded stream/);
  assert.equal(patch.upstreamDiscussion, null);
  assert.deepEqual(patch.affectedModules, [
    '@deepseek-ai/dsh-headless',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-token-meter',
    '@deepseek-ai/dsh-session-persistence-jsonl',
    '@deepseek-ai/dsh-tool-cordis',
  ]);
});

test('the model capabilities patch projects catalog fields without core ownership', async () => {
  const manifest = await loadUpstreamManifest();
  const patch = manifest.patches[3];
  assert.ok(patch);
  const text = await readFile(new URL(`../runtime/dsh/${patch.file}`, import.meta.url), 'utf8');
  assert.match(text, /packages\/api\/session-controller\/src\/types\.ts/);
  assert.match(text, /inputModalities/);
  assert.match(text, /contextWindow/);
  assert.doesNotMatch(text, /^diff --git a\/packages\/core\/(?:agent|agent-loop|session)\/src/m);
  assert.equal(patch.upstreamDiscussion, null);
  assert.deepEqual(patch.affectedModules, [
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-tool-cordis',
  ]);
});

test('the Turn accounting patch carries its runtime and documentation contracts together', async () => {
  const manifest = await loadUpstreamManifest();
  const patch = manifest.patches[5];
  assert.ok(patch);
  const text = await readFile(new URL(`../runtime/dsh/${patch.file}`, import.meta.url), 'utf8');
  assert.match(text, /readonly scope: 'call' \| 'turn'/u);
  assert.match(text, /turnId\?: LlmTurnId/u);
  assert.match(text, /type: 'status'/u);
  assert.match(text, /statuses\?: readonly TimedModelStatus\[\]/u);
  assert.match(text, /"symbol": "TimedModelStatus"/u);
  assert.match(text, /docs\/subsystems\/llm-streaming\.md/u);
  assert.match(text, /docs\/persistence-catalog\.md/u);
});

test('the manual compaction route patch carries its API, generator, and documentation together', async () => {
  const manifest = await loadUpstreamManifest();
  const patch = manifest.patches[6];
  assert.ok(patch);
  const text = await readFile(new URL(`../runtime/dsh/${patch.file}`, import.meta.url), 'utf8');
  assert.match(text, /interface ManualCompactionTarget/u);
  assert.match(text, /--provider <id> --model <id>/u);
  assert.match(text, /target\?: ManualCompactionTarget/u);
  assert.match(text, /scripts\/gen-cordis-catalog\.ts/u);
  assert.match(text, /docs\/subsystems\/compaction\.md/u);
  assert.match(text, /2026-07-30-queued-manual-compaction\.md/u);
});
