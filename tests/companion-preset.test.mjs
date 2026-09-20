import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import test from 'node:test';

import { loadUpstreamManifest } from '../runtime/dsh/scripts/manifest.mjs';

const execFileAsync = promisify(execFile);
const presetUrl = new URL('../packages/bundle/presets/dsh-companion/agent.cordis.yml', import.meta.url);
const forkBlock = `    # Fork omits model selection so provider/model stay equal to the parent and
    # the inherited history remains eligible for KV Cache reuse. This preset
    # keeps fork continuable; parent and child inherit the same messaging tool,
    # while the parent id and return guidance follow the inherited history.
    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable

`;

test('the Companion preset tracks pinned DSH standard except fork delegation', async () => {
  const manifest = await loadUpstreamManifest();
  const source = process.env.DSH_COMPANION_DSH_SOURCE
    ?? new URL('../../deepseek-harness', import.meta.url).pathname;
  const { stdout: standard } = await execFileAsync('git', [
    '-C', source,
    'show', `${manifest.upstream.commit}:packages/preset/agent-presets/presets/standard/agent.cordis.yml`,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(standard.split(forkBlock).length, 2, 'pinned standard must contain the reviewed fork block once');
  assert.equal(await readFile(presetUrl, 'utf8'), standard.replace(forkBlock, ''));
});

test('the Companion preset keeps fresh delegation and Goals without fork delegation', async () => {
  const preset = await readFile(presetUrl, 'utf8');
  assert.doesNotMatch(preset, /tool-subagent-fork|subagent_fork|provider: fork/u);
  assert.match(preset, /- id: tool-subagent\n[\s\S]*?provider: spawn\n\s+toolName: subagent/u);
  assert.match(preset, /- id: command-goal\n\s+name: '@deepseek-ai\/dsh-command-goal'/u);
  assert.match(preset, /- id: tool-goal\n\s+name: '@deepseek-ai\/dsh-tool-goal'/u);
});

test('the Companion bundle exposes only its system preset roster', async () => {
  const [patch, packageJson] = await Promise.all([
    readFile(new URL('../packages/bundle/cordis.patch.yml', import.meta.url), 'utf8'),
    readFile(new URL('../packages/bundle/package.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  assert.match(patch, /default: dsh-companion/u);
  assert.match(patch, /path: !!js ctx\.companionPresetRoot\.path/u);
  assert.match(patch, /fallbacks:\n\s+standard: dsh-companion/u);
  assert.match(patch, /includeShippedRoot: false/u);
  assert.match(patch, /includeUserRoot: false/u);
  assert.match(patch, /- id: llm-deepseek\n\s+config:\n\s+enabled: false/u);
  assert.doesNotMatch(patch, /default: (?:standard|ptc|cordis)/u);
  assert.ok(packageJson.files.includes('presets/**/*.yml'));
});
