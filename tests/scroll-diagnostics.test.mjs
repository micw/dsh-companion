import assert from 'node:assert/strict';
import test from 'node:test';

await import('../vscode/media/scroll-diagnostics.js');
const { createScrollTrace } = globalThis.dshCompanionScrollDiagnostics;

function harness() {
  let time = 0;
  const frames = [];
  const reports = [];
  const output = { scrollTop: 2_000, scrollHeight: 3_000, clientHeight: 600 };
  const view = { mode: 'follow', intent: false, pointer: false };
  const trace = createScrollTrace(output, () => view, value => reports.push(value),
    callback => frames.push(callback), () => time);
  return { output, view, trace, frames, reports, advance: ms => { time += ms; } };
}

test('one upward wheel reports the first later jump with only structural coordinates', () => {
  const { output, view, trace, reports, advance } = harness();
  trace.arm();
  view.mode = 'sticky';
  output.scrollTop = 1_900;
  trace.record('native-scroll');
  trace.setBatch(42);
  trace.record('host-process-before');
  advance(20);
  output.scrollTop = 0;
  output.scrollHeight = 2_900;
  trace.afterMutation('host-process-after');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].reason, 'host-process-after');
  assert.equal(reports[0].startTop, 2_000);
  assert.deepEqual(reports[0].samples.map(item => item.kind), [
    'wheel-up', 'wheel-armed', 'native-scroll', 'host-process-before', 'host-process-after',
  ]);
  assert.equal(reports[0].samples.at(-1).batchId, 42);
  assert.equal(reports[0].samples.at(-1).top, 0);
  assert.doesNotMatch(JSON.stringify(reports[0]), /prompt|content|secret|html/u);
  trace.record('native-scroll');
  trace.arm();
  assert.equal(reports.length, 1, 'only one report is emitted per Webview');
});

test('animation-frame sampling identifies a browser-driven jump without a JS scroll write', () => {
  const { output, trace, frames, reports } = harness();
  trace.arm();
  output.scrollTop = 1_920;
  trace.record('native-scroll');
  output.scrollTop = 100;
  frames.shift()();
  assert.equal(reports[0].reason, 'frame-one');
  frames.shift()();
  assert.equal(reports.length, 1);
});

test('trace keeps only the latest 48 structural samples', () => {
  const { output, trace, reports } = harness();
  trace.arm();
  output.scrollTop = 1_960;
  for (let index = 0; index < 100; index++) trace.record('host-assistant-after');
  assert.deepEqual(reports, []);
  output.scrollTop = 0;
  trace.record('native-scroll');
  assert.equal(reports[0].samples.length, 48);
  assert.equal(reports[0].startTop, 2_000);
});

test('several ordinary wheel-scroll steps do not count as one jump', () => {
  const { output, trace, reports } = harness();
  trace.arm();
  for (let index = 0; index < 10; index++) {
    output.scrollTop -= 60;
    trace.record('native-scroll');
  }
  assert.deepEqual(reports, []);
});

test('trace expires without reporting after the bounded observation window', () => {
  const { output, trace, reports, advance } = harness();
  trace.arm();
  output.scrollTop = 1_960;
  trace.record('native-scroll');
  advance(120_001);
  output.scrollTop = 0;
  trace.record('native-scroll');
  assert.deepEqual(reports, []);
});
