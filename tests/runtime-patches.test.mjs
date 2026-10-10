import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DSH_RUNTIME_ROOT,
  loadUpstreamManifest,
  patchSetSha256,
  verifyPatchFiles,
} from '../runtime/dsh/scripts/manifest.mjs';

async function patchText(manifest, id) {
  const patch = manifest.patches.find((candidate) => candidate.id === id);
  assert.ok(patch, `missing patch ${id}`);
  return { patch, text: await readFile(new URL(`../runtime/dsh/${patch.file}`, import.meta.url), 'utf8') };
}

test('the exact DSH runtime pin and ordered patch series are integrity checked', async () => {
  const manifest = await loadUpstreamManifest();
  await verifyPatchFiles(manifest);
  assert.deepEqual(manifest.upstream, {
    repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
    version: '0.1.7-rc.2',
    tag: 'dsh-v0.1.7-rc.2',
    commit: '477b4f420553e8a52c2fbccc464d7561b239c443',
    tree: 'e3e63253d1d35ad07f785273235c40813cb6c8bd',
  });
  assert.match(patchSetSha256(manifest), /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.patches.map((patch) => patch.id), [
    'node-client-object-runtime',
    'companion-model-runtime-semantics',
    'explicit-manual-compaction-route',
    'agent-preset-fallbacks',
    'compress-enhanced-sea-assets',
    'agent-session-title-proposal',
  ]);
});

test('the Node Client patch stays outside DSH Agent and Session ownership', async () => {
  const manifest = await loadUpstreamManifest();
  const { patch, text } = await patchText(manifest, 'node-client-object-runtime');
  assert.match(text, /packages\/api\/client-runtime\/src\/index\.ts/u);
  assert.match(text, /packages\/api\/gateway\/src\/client\/stream-client\.ts/u);
  assert.doesNotMatch(text, /packages\/core\/(?:agent|agent-loop|session)\/src/u);
  assert.deepEqual(patch.affectedModules, [
    '@deepseek-ai/dsh-api-client-runtime',
    '@deepseek-ai/dsh-api-gateway/client',
  ]);
  assert.equal(DSH_RUNTIME_ROOT.endsWith('/runtime/dsh'), true);
});

test('the model runtime patch carries persistence, migration, accounting, and provider contracts together', async () => {
  const manifest = await loadUpstreamManifest();
  const { text } = await patchText(manifest, 'companion-model-runtime-semantics');
  assert.match(text, /interface ModelCallAccounting/u);
  assert.match(text, /statuses\?: readonly TimedModelStatus\[\]/u);
  assert.match(text, /legacy accounting requires a usage or finish chunk/u);
  assert.match(text, /2026-09-25-assistant-accounting-status\.md/u);
  assert.match(text, /interface LlmProviderFamily/u);
  assert.match(text, /mapAccounting\?:/u);
  assert.match(text, /turnId\?: LlmTurnId/u);
  assert.match(text, /latestReleasedVersion: 4/u);
  assert.doesNotMatch(text, /ProviderInstancesSection/u);
});

test('the manual compaction patch routes one summary call without mutating selection', async () => {
  const manifest = await loadUpstreamManifest();
  const { text } = await patchText(manifest, 'explicit-manual-compaction-route');
  assert.match(text, /interface ManualCompactionTarget/u);
  assert.match(text, /--provider <id> --model <id>/u);
  assert.match(text, /target\?: ManualCompactionTarget/u);
  assert.match(text, /docs\/subsystems\/compaction\.md/u);
});

test('the preset fallback patch keeps retired ids out of the roster', async () => {
  const manifest = await loadUpstreamManifest();
  const { patch, text } = await patchText(manifest, 'agent-preset-fallbacks');
  assert.match(text, /fallbacks: z\.dict\(z\.string\(\)\)\.default\(\{\}\)/u);
  assert.match(text, /definitionFor\(id: string\)/u);
  assert.match(text, /some\(row => row\.id === 'retired'\)\)\.toBe\(false\)/u);
  assert.deepEqual(patch.affectedModules, ['@deepseek-ai/dsh-agent-preset-registry']);
});

test('the title patch accepts model proposals without changing the persisted source vocabulary', async () => {
  const manifest = await loadUpstreamManifest();
  const { patch, text } = await patchText(manifest, 'agent-session-title-proposal');
  assert.match(text, /proposeFromAgent\(/u);
  assert.match(text, /agent title superseded automatic title generation/u);
  assert.match(text, /provider: providerId/u);
  assert.match(text, /JSONL|persist|round.trip/iu);
  assert.doesNotMatch(text, /kind: 'agent'/u);
  assert.deepEqual(patch.affectedModules, ['@deepseek-ai/dsh-session-title', '@deepseek-ai/dsh-tool-cordis']);
});

test('the executable patch compresses the existing enhanced SEA closure', async () => {
  const manifest = await loadUpstreamManifest();
  const { patch, text } = await patchText(manifest, 'compress-enhanced-sea-assets');
  assert.match(text, /'--compress',\n\+      'Zstd'/u);
  assert.match(text, /pkg --sea --compress Zstd/u);
  assert.doesNotMatch(text, /node2[5-9]/u);
  assert.deepEqual(patch.affectedModules, ['scripts/build-exe-for-python-sdk']);
});
