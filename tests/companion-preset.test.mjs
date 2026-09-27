import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

import { loadUpstreamManifest } from '../runtime/dsh/scripts/manifest.mjs';

const execFileAsync = promisify(execFile);
const presetUrl = new URL('../packages/bundle/presets/dsh-companion.patch.yml', import.meta.url);

function rowIds(value) {
  return [...value.matchAll(/^-?\s*- id: ([^\n]+)$/gmu)].map(match => match[1]);
}

test('the Companion preset tracks pinned DSH standard except fork delegation', async () => {
  const manifest = await loadUpstreamManifest();
  const source = process.env.DSH_COMPANION_DSH_SOURCE
    ?? new URL('../../deepseek-harness', import.meta.url).pathname;
  const { stdout: standard } = await execFileAsync('git', [
    '-C', source,
    'show', `${manifest.upstream.commit}:packages/bundle/web-app/presets/standard.patch.yml`,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const companion = await readFile(presetUrl, 'utf8');
  const standardIds = rowIds(standard)
    .filter(id => id !== 'tool-subagent-fork')
    .map(id => id === 'preset-standard' ? 'preset-dsh-companion' : id);
  assert.deepEqual(rowIds(companion), standardIds);
  assert.match(companion, /id: dsh-companion/u);
  assert.doesNotMatch(companion, /tool-subagent-fork|subagent_fork|provider: fork/u);
});

test('the Companion preset keeps current delegation, workflow, Goals, and explicit Ralph behavior', async () => {
  const preset = await readFile(presetUrl, 'utf8');
  assert.match(preset, /- id: tool-subagent\n[\s\S]*?provider: spawn\n\s+toolName: subagent/u);
  assert.match(preset, /- id: command-goal\n\s+name: '@deepseek-ai\/dsh-command-goal'/u);
  assert.match(preset, /- id: tool-goal\n\s+name: '@deepseek-ai\/dsh-tool-goal'/u);
  assert.match(preset, /- id: workflow-ptc\n\s+name: '@deepseek-ai\/dsh-workflow-ptc'/u);
  assert.match(preset, /- id: tool-ralph\n\s+name: '@deepseek-ai\/dsh-tool-ralph'\n\s+config:/u);
});

test('the Companion bundle selects its declarative preset and dedicated providers', async () => {
  const [patch, packageJson] = await Promise.all([
    readFile(new URL('../packages/bundle/cordis.patch.yml', import.meta.url), 'utf8'),
    readFile(new URL('../packages/bundle/package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  assert.match(patch, /- id: agent-preset-registry\n\s+config:\n\s+default: dsh-companion/u);
  assert.match(patch, /fallbacks:\n\s+standard: dsh-companion/u);
  assert.match(patch, /- id: llm-deepseek\n\s+disabled: true/u);
  assert.match(patch, /- id: llm-pi-ai\n\s+disabled: true/u);
  assert.match(patch, /- id: session-query-sqlite\n\s+config:\n\s+path: !!js dshHomePath\('session-search\.sqlite'\)\n\s+openAt: first-search/u);
  assert.doesNotMatch(patch, /default: (?:standard|ptc|cordis)/u);
  assert.deepEqual(packageJson.dsh.bundle.patch, [
    './cordis.patch.yml',
    './presets/dsh-companion.patch.yml',
  ]);
});
