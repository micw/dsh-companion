import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeProgress, runtimePhaseText } from '../vscode/out/runtimeProgress.js';

test('runtime progress replays the latest phase to late subscribers and broadcasts updates', () => {
  const progress = new RuntimeProgress();
  progress.report('installing');
  const editor = [];
  const sidebar = [];
  const stopEditor = progress.subscribe(phase => editor.push(runtimePhaseText[phase]));
  const stopSidebar = progress.subscribe(phase => sidebar.push(runtimePhaseText[phase]));
  assert.deepEqual(editor, ['Installing DSH runtime…']);
  assert.deepEqual(sidebar, editor);
  progress.report('stopping');
  stopEditor();
  progress.report('starting');
  progress.report('waiting');
  assert.deepEqual(editor, ['Installing DSH runtime…', 'Stopping previous DSH runtime…']);
  assert.deepEqual(sidebar, [
    'Installing DSH runtime…', 'Stopping previous DSH runtime…',
    'Starting DSH runtime…', 'Waiting for DSH runtime…',
  ]);
  stopSidebar();
  assert.equal(progress.current, 'waiting');
});
