import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/build-release.yml', import.meta.url), 'utf8');

test('build workflow pins external actions and separates build and publishing rights', () => {
  const uses = [...workflow.matchAll(/uses:\s+([^\s]+)\s/g)].map(match => match[1]);
  assert.ok(uses.length > 5);
  for (const action of uses) assert.match(action, /^[\w/-]+@[a-f0-9]{40}$/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  assert.match(workflow, /publish:[\s\S]*needs: build[\s\S]*permissions:\s+contents: write/);
  assert.match(workflow, /publish:[\s\S]*cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.[A-Z]|git push/);
});

test('master and tag packaging share one timestamp and restore only exact output cache keys', () => {
  assert.match(workflow, /branches: \[master\]/);
  assert.match(workflow, /tags: \['v\*'\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.equal((workflow.match(/DSH_COMPANION_BUILD_ID: \$\{\{ steps\.meta\.outputs\.buildId \}\}/g) ?? []).length, 2);
  assert.equal((workflow.match(/export DSH_COMPANION_RELEASE_TAG="\$RELEASE_TAG"/g) ?? []).length, 2);
  assert.match(workflow, /Compute content-addressed Runtime identity[\s\S]*Restore verified Runtime payload candidate[\s\S]*Package VSIX and smoke-test/);
  assert.equal((workflow.match(/restore-keys:/g) ?? []).length, 1, 'Only dependency downloads may use partial-key fallback');
  assert.match(workflow, /retention-days: 7/);
  assert.match(workflow, /node-version: 24\.21\.0/);
  assert.match(workflow, /version: 11\.7\.0/);
  assert.match(workflow, /pnpm test\s+pnpm run test:runtime-inputs/);
  assert.equal((workflow.match(/DSH_COMPANION_EXPECTED_RUNTIME_ID: \$\{\{ steps\.runtime\.outputs\.runtimeId \}\}/g) ?? []).length, 2);
  assert.match(workflow, /Require the exact packaged cache payload before saving[\s\S]*verify-runtime-cache\.mjs[\s\S]*Save successfully verified Runtime payload/);
});
