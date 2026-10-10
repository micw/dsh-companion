import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { eventWindowTrace, installRestoreTraceSink, isDiagnosticBatchMessage, isDiagnosticScrollMessage, restoreTrace, sequenceRange } from '../vscode/out/restoreDiagnostics.js';
import { WebviewMessenger } from '../vscode/out/webviewMessenger.js';

const event = (seq, text = 'secret text') => ({ type: 'event', event: { seq, type: 'user/message', data: { content: [{ type: 'text', text }] } } });
const transient = { type: 'transient', event: { type: 'assistant/live-chunk', data: { text: 'private delta' } } };

test('restore trace writes only through the installed persistent log sink', () => {
  const lines = [];
  const release = installRestoreTraceSink(line => { lines.push(line); });
  restoreTrace('session-1', 'event-window', eventWindowTrace([event(8)], { kind: 'replace' }, false));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /session-1.*event-window.*firstSeq.*8/u);
  assert.doesNotMatch(lines[0], /secret text/u);
  release();
  restoreTrace('session-1', 'ready', {});
  assert.equal(lines.length, 1);
});

test('window diagnostics keep only durable sequence coordinates and change kind', () => {
  const entries = [transient, event(8), event(9), transient];
  assert.deepEqual(sequenceRange(entries), { count: 2, firstSeq: 8, lastSeq: 9 });
  for (const kind of ['append', 'prepend']) {
    const trace = eventWindowTrace(entries, { kind, entries: [event(9)] }, true);
    assert.deepEqual(trace, { kind, hasMore: true, window: { count: 2, firstSeq: 8, lastSeq: 9 }, changed: { count: 1, firstSeq: 9, lastSeq: 9 } });
    assert.doesNotMatch(JSON.stringify(trace), /secret|private/u);
  }
  assert.deepEqual(eventWindowTrace(entries, { kind: 'replace' }, false).changed, { count: 0 });
  assert.deepEqual(eventWindowTrace([], { kind: 'settle-assistant', entry: event(10) }, false).changed, { count: 1, firstSeq: 10, lastSeq: 10 });
  assert.equal(eventWindowTrace(entries, { kind: 'untrusted\nentry' }, false).kind, 'invalid');
});

test('extension activates a VS Code log channel rather than console-only tracing', async () => {
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  const diagnostics = await readFile(new URL('../vscode/src/restoreDiagnostics.ts', import.meta.url), 'utf8');
  assert.match(extension, /createOutputChannel\('DSH Companion Restore', \{ log: true \}\)/u);
  assert.match(extension, /installRestoreTraceSink\(line => restoreLog\.info\(line\)\)/u);
  assert.match(extension, /'diagnostics-started'/u);
  assert.match(extension, /scroll-diagnostics\.js/u);
  assert.match(extension, /isDiagnosticScrollMessage\(message\)/u);
  assert.match(extension, /scrollTraceLogged = true;[\s\S]*restoreTrace\(traceSessionId, 'scroll-jump'/u);
  assert.doesNotMatch(diagnostics, /console\.info\(/u);
});

test('Webview acknowledgment validation rejects content, malformed counts and extra keys', () => {
  assert.equal(isDiagnosticBatchMessage({ type: 'diagnosticBatch', batchId: 1, processed: 64, failed: false }), true);
  for (const message of [
    { type: 'diagnosticBatch', batchId: 0, processed: 1, failed: false },
    { type: 'diagnosticBatch', batchId: 1, processed: 65, failed: false },
    { type: 'diagnosticBatch', batchId: 1, processed: 0, failed: false, text: 'secret' },
    { type: 'diagnosticBatch', batchId: 1, processed: 0, failed: 'false' },
  ]) assert.equal(isDiagnosticBatchMessage(message), false);
});

test('scroll diagnostics accept only bounded coordinates and fixed event kinds', () => {
  const sample = {
    kind: 'host-assistant-after', ms: 20, top: 0, height: 3_000, viewport: 600,
    mode: 'sticky', intent: false, pointer: false, batchId: 42, target: null,
  };
  const valid = { type: 'diagnosticScroll', reason: 'host-assistant-after', startTop: 2_000, samples: [sample] };
  assert.equal(isDiagnosticScrollMessage(valid), true);
  for (const value of [
    { ...valid, text: 'secret' },
    { ...valid, reason: 'model output' },
    { ...valid, startTop: Infinity },
    { ...valid, samples: [] },
    { ...valid, samples: Array.from({ length: 49 }, () => sample) },
    { ...valid, samples: [{ ...sample, html: '<script>private</script>' }] },
    { ...valid, samples: [{ ...sample, kind: 'secret' }] },
    { ...valid, samples: [{ ...sample, top: -1 }] },
    { ...valid, samples: [{ ...sample, target: 'private' }] },
  ]) assert.equal(isDiagnosticScrollMessage(value), false);
});

test('Webview batch markers distinguish restore delivery from acceptance', async () => {
  const posted = [];
  const reported = [];
  const messenger = new WebviewMessenger({
    async postMessage(value) { posted.push(value); return true; },
  }, error => assert.fail(String(error)), batch => reported.push(batch));
  for (let index = 0; index < 65; index++) messenger.send({ type: index === 0 ? 'resetTranscript' : 'message', text: 'private' });
  messenger.markReady();
  await messenger.flush();
  assert.deepEqual(posted.map(batch => ({ id: batch.batchId, trace: batch.trace, count: batch.messages.length })), [
    { id: 1, trace: true, count: 64 }, { id: 2, trace: true, count: 1 },
  ]);
  assert.deepEqual(reported, [
    { id: 1, count: 64, accepted: true, trace: true }, { id: 2, count: 1, accepted: true, trace: true },
  ]);
  assert.doesNotMatch(JSON.stringify(reported), /private/u);
});

test('rejected Webview batches are reported without logging their content', async () => {
  const failures = [];
  const reported = [];
  const messenger = new WebviewMessenger({
    async postMessage() { return false; },
  }, error => failures.push(error), batch => reported.push(batch));
  messenger.send({ type: 'resetTranscript', text: 'do not log me' });
  messenger.markReady();
  await messenger.flush();
  assert.equal(failures.length, 1);
  assert.deepEqual(reported, [{ id: 1, count: 1, accepted: false, trace: true }]);
  assert.doesNotMatch(JSON.stringify(reported), /do not log me/u);
});

test('Webview application sends bounded success and failure acknowledgments', async () => {
  const script = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
  assert.match(script, /reportDiagnosticBatch\(message\.batchId, processed, true\)/u);
  assert.match(script, /if \(message\.trace\) reportDiagnosticBatch\(message\.batchId, processed, false\)/u);
  assert.match(script, /vscode\.postMessage\(\{ type: 'diagnosticBatch', batchId, processed, failed \}\)/u);
  assert.doesNotMatch(script, /type: 'diagnosticBatch'[^\n]*(?:text|content|error)/u);
});
