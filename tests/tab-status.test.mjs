import assert from 'node:assert/strict';
import test from 'node:test';
import { TabStatusProjection } from '../vscode/out/tabStatus.js';

test('running, unseen completion, and viewing a finished turn', () => {
  const status = new TabStatusProjection();
  assert.equal(status.status, 'seen');
  status.setRunning(true);
  assert.equal(status.status, 'running');
  status.end(100, 'completed');
  assert.equal(status.status, 'running');
  assert.equal(status.acknowledge(), undefined);
  status.setRunning(false);
  assert.equal(status.status, 'finished');
  assert.equal(status.acknowledge(), 100);
  assert.equal(status.status, 'seen');
});

test('failed turns stay red until viewed, and a later run supersedes them', () => {
  const status = new TabStatusProjection();
  status.end(100, 'error');
  assert.equal(status.status, 'error');
  status.setRunning(true);
  assert.equal(status.status, 'running');
  status.end(200, 'completed');
  status.setRunning(false);
  assert.equal(status.status, 'finished');
  assert.equal(status.acknowledge(), 200);
  assert.equal(status.status, 'seen');
});

test('restore reconstructs the last unseen result without rewinding on older history', () => {
  const status = new TabStatusProjection(100);
  status.end(200, 'error');
  status.end(50, 'completed');
  assert.equal(status.status, 'error');
  assert.equal(status.acknowledge(), 200);
  assert.equal(status.status, 'seen');
  const restored = new TabStatusProjection(200);
  restored.end(50, 'error');
  restored.end(200, 'error');
  assert.equal(restored.status, 'seen');
});
