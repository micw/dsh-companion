import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function appendRetry('), source.indexOf('function appendModelStatus('));
function presentation() {
  const context = vm.createContext({
    activeProcessSegment() {}, updateTurnProcessLabel() {}, followOutput() {},
    formatDuration: ms => `${ms / 1000}s`,
    disclosureRow: () => ({ root: { dataset: {} }, summary: {}, detail: {} }),
  });
  vm.runInContext(functions, context);
  const rows = [];
  return { context, turn: { rows: { append: row => rows.push(row) } }, rows };
}
const waiting = { id: 'retry-1', step: 1, retry: 2, maxRetries: 4,
  state: 'waiting', delayMs: 1500, failure: '<b>Connection lost</b>' };

test('live and restored retry reuse one row and preserve literal failure through start', () => {
  for (const restored of [false, true]) {
    const { context, turn, rows } = presentation();
    context.appendRetry(turn, { ...waiting });
    assert.match(turn.retries.get(waiting.id).summary.textContent, /Retry 2 of 4 · waiting 1.5s/);
    context.appendRetry(turn, { id: waiting.id, step: 1, retry: 2, state: 'started' });
    assert.equal(rows.length, 1, `restore=${restored}`);
    assert.equal(turn.retries.get(waiting.id).detail.textContent, waiting.failure);
    assert.equal(turn.retries.get(waiting.id).summary.textContent, 'Retry 2 of 4 · started');
  }
});

test('retry terminal states settle the row and malformed input does not create rows', () => {
  for (const reason of ['completed', 'cancelled', 'failed', 'interrupted']) {
    const { context, turn } = presentation();
    context.appendRetry(turn, waiting);
    context.settleRetries(turn, reason);
    assert.equal(turn.retries.get(waiting.id).root.dataset.state, reason);
    assert.match(turn.retries.get(waiting.id).summary.textContent, new RegExp(`${reason}$`));
  }
  const { context, turn, rows } = presentation();
  for (const invalid of [{ ...waiting, retry: 0 }, { ...waiting, delayMs: Infinity },
    { ...waiting, failure: {} }, { ...waiting, maxRetries: 1 }]) context.appendRetry(turn, invalid);
  assert.equal(rows.length, 0);
});
