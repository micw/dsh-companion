import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

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
    version: '0.2.0-rc.2',
    tag: 'dsh-v0.2.0-rc.2',
    commit: '639ed015397290b3745d163aafe02ffee4aa3f84',
    tree: 'ac66a6a3e77f6fa396509ddfecc7beacf0cf642a',
  });
  assert.match(patchSetSha256(manifest), /^[0-9a-f]{64}$/);
  assert.deepEqual(manifest.patches.map((patch) => patch.id), [
    'node-client-object-runtime',
    'companion-model-runtime-semantics',
    'explicit-manual-compaction-route',
    'agent-preset-fallbacks',
    'compress-enhanced-sea-assets',
    'agent-session-title-proposal',
    'label-configured-user-global-instructions',
    'fix-empty-sea-assets',
    'reproducible-sea-bootstrap',
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

test('the global instructions patch labels the configured source and scope', async () => {
  const manifest = await loadUpstreamManifest();
  const { patch, text } = await patchText(manifest, 'label-configured-user-global-instructions');
  assert.match(text, /fromHome = relative\(homedir\(\), dshHome\)/u);
  assert.match(text, /These user-global instructions apply across workspaces/u);
  assert.match(text, /~\/\.agents\/AGENTS\.md/u);
  assert.deepEqual(patch.affectedModules, ['@deepseek-ai/dsh-agent-instructions']);
});

test('the executable patch compresses the existing enhanced SEA closure', async () => {
  const manifest = await loadUpstreamManifest();
  const { patch, text } = await patchText(manifest, 'compress-enhanced-sea-assets');
  assert.match(text, /'--compress',\n\+      'Zstd'/u);
  assert.match(text, /pkg --sea --compress Zstd/u);
  assert.doesNotMatch(text, /node2[5-9]/u);
  assert.deepEqual(patch.affectedModules, ['scripts/build-exe-for-python-sdk']);
});

test('SEA bootstrap uses a canonical embedded filename and permits exact target Node versions', async () => {
  const manifest = await loadUpstreamManifest();
  const { text } = await patchText(manifest, 'reproducible-sea-bootstrap');
  assert.match(text, /\+\s+main: 'sea-main\.js'/);
  assert.match(text, /node24\.21\.0-linux-x64/);
  assert.match(text, /filename: relative\(REPOSITORY_ROOT, fileId\)/);
  assert.match(text, /await rm\(join\(this\.staging, 'node_modules', '\.modules\.yaml'\), \{ force: true \}\)/);
  const builder = await readFile(new URL('../runtime/dsh/scripts/build-linux.mjs', import.meta.url), 'utf8');
  assert.match(builder, /absWorkingDir: prepared/);
  assert.match(builder, /const NODE_TARGET = 'node24\.21\.0-linux-x64'/);
});

test('compressed SEA assets admit empty files without dropping the decoded-size check', async () => {
  const manifest = await loadUpstreamManifest();
  const { patch, text } = await patchText(manifest, 'fix-empty-sea-assets');
  assert.deepEqual(patch.affectedModules, ['patches/@yao-pkg__pkg@6.21.0.patch']);
  assert.match(text, /Math\.max\(1, maxOutputLength\)/u);
  assert.match(text, /buf\.length !== maxOutputLength/u);
  const compressed = zstdCompressSync(Buffer.alloc(0));
  assert.throws(() => zstdDecompressSync(compressed, { maxOutputLength: 0 }), {
    code: 'ERR_OUT_OF_RANGE',
  });
  assert.equal(zstdDecompressSync(compressed, { maxOutputLength: 1 }).length, 0);
});
