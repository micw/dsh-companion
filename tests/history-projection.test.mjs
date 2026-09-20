import assert from 'node:assert/strict';
import test from 'node:test';

import { DshClient, historyTurnHints } from '../vscode/out/dshClient.js';

function event(seq, type, data, time = seq) {
  return { type: 'event', event: { seq, type, data, time } };
}

function createProjection() {
  const output = [];
  const sink = {
    reset() { output.length = 0; },
    history(role, text, time) { output.push({ kind: 'history', role, text, time }); },
    historyPrependStart() { output.push({ kind: 'prepend-start' }); },
    historyPrependEnd() { output.push({ kind: 'prepend-end' }); },
    historyState() {}, modelCatalog() {}, modelSelection() {}, contextPressure() {}, sessionCost() {},
    providerAccounts() {}, compactAvailable() {}, compaction() {}, compacting() {}, assistantStart() {},
    assistantDelta() {}, assistantTime() {}, queue() {}, running() {}, status() {}, submissionObserved() {},
    userCommitted() {},
    process(value) { output.push({ kind: 'process', ...value }); },
  };
  const catalog = {
    default: { provider: 'test', model: 'test' },
    routableProviders: ['test'],
    groups: [{ id: 'test', name: 'Test', models: [{ id: 'test', name: 'Test' }] }],
    failures: [],
  };
  const canonical = { requestAliases: new Map() };
  const client = Reflect.construct(DshClient, ['session-test', sink, catalog, canonical]);
  return { client, output };
}

function applyWindow(client, entries, change) {
  Reflect.get(client, 'receiveCanonicalWindow').call(client, { entries, hasMore: false, change });
}

test('history Turn hints associate a page-leading context injection with its following Turn', () => {
  const entries = [
    event(1, 'user/message', {
      source: { kind: 'agent-message' },
      content: [{ type: 'text', text: 'older context' }],
    }),
    event(2, 'step/start', { turn: 17, step: 8 }),
    event(3, 'assistant/message', {
      turn: 17,
      step: 8,
      message: { content: [{ type: 'text', text: 'older response' }] },
    }),
  ];
  assert.deepEqual(historyTurnHints(entries), [17, 17, 17]);
});

test('prepending a page uses page-local Turn coordinates and restores the live parser position', () => {
  const { client, output } = createProjection();
  const tail = [
    event(20, 'turn/start', { turn: 23 }),
    event(21, 'step/start', { turn: 23, step: 1 }),
  ];
  applyWindow(client, tail, { kind: 'replace', entries: tail });

  const older = [
    event(1, 'user/message', {
      source: { kind: 'agent-message' },
      content: [{ type: 'text', text: 'older context' }],
    }),
    event(2, 'step/start', { turn: 17, step: 8 }),
    event(3, 'assistant/message', {
      turn: 17,
      step: 8,
      message: { content: [{ type: 'reasoning', text: 'older reasoning' }] },
    }),
  ];
  applyWindow(client, [...older, ...tail], { kind: 'prepend', entries: older });

  const context = output.find(item => item.type === 'context');
  const reasoning = output.find(item => item.type === 'reasoning');
  assert.equal(context.turn, 17);
  assert.match(context.id, /^turn:17:/u);
  assert.equal(reasoning.turn, 17);

  Reflect.get(client, 'receiveCanonicalEntry').call(client, event(22, 'user/message', {
    source: { kind: 'plugin', plugin: 'after-prepend' },
    content: [{ type: 'text', text: 'live context' }],
  }), false);
  assert.equal(output.findLast(item => item.type === 'context').turn, 23);
});

test('a large restore retains the error and human Turns after the long Tool Turn', () => {
  const { client, output } = createProjection();
  const entries = [event(1, 'turn/start', { turn: 17 }), event(2, 'step/start', { turn: 17, step: 1 })];
  for (let index = 0; index < 120; index++) {
    entries.push(event(3 + index * 2, 'tool/call', {
      turn: 17, step: 1, callId: `call-${String(index)}`, name: 'read', arguments: { path: String(index) },
    }));
    entries.push(event(4 + index * 2, 'tool/result', {
      turn: 17, step: 1,
      message: { source: { callId: `call-${String(index)}` }, content: [] },
    }));
  }
  entries.push(
    event(300, 'turn/end', { turn: 17, reason: { kind: 'completed' } }),
    event(301, 'turn/start', { turn: 18 }),
    event(302, 'turn/end', { turn: 18, reason: { kind: 'error', error: { message: 'session limit' } } }),
    event(303, 'turn/start', { turn: 19 }),
    event(304, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'where are we?' }] }),
    event(305, 'assistant/message', {
      turn: 19, step: 1, message: { content: [{ type: 'text', text: 'current status' }] },
    }),
    event(306, 'turn/end', { turn: 19, reason: { kind: 'completed' } }),
  );
  applyWindow(client, entries, { kind: 'replace', entries });

  assert.equal(output.filter(item => item.type === 'tool-call').length, 120);
  assert.ok(output.some(item => item.kind === 'history' && item.role === 'error' && item.text === 'session limit'));
  assert.ok(output.some(item => item.kind === 'history' && item.role === 'user' && item.text === 'where are we?'));
  assert.ok(output.some(item => item.kind === 'history' && item.role === 'assistant' && item.text === 'current status'));
  assert.deepEqual(output.filter(item => item.type === 'turn-end').map(item => item.turn), [17, 18, 19]);
});
