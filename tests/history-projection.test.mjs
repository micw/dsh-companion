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
    providerAccounts() {}, permissionSelection() {}, compactAvailable() {}, compaction() {}, compacting() {},
    assistantStart() {}, assistantDelta() {}, assistantTime() {}, queue() {}, running() {}, status() {},
    submissionObserved() {},
    userCommitted(requestId, text, time, turn) { output.push({ kind: 'history', role: 'user', text, time, turn }); },
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

test('live append and cold restore project the same completed Turn result', () => {
  const entries = [
    event(1, 'turn/start', { turn: 7 }, 100),
    event(2, 'step/start', { turn: 7, step: 1 }, 101),
    event(3, 'user/message', {
      source: { kind: 'user', rpcId: 'rpc-prompt' }, content: [{ type: 'text', text: 'do work' }],
    }, 102),
    event(4, 'assistant/message', {
      turn: 7, step: 1, message: { content: [{ type: 'text', text: 'Starting.' }] },
    }, 103),
    event(5, 'tool/call', { turn: 7, step: 1, callId: 'call-1', name: 'read', arguments: {} }, 104),
    event(6, 'tool/result', {
      turn: 7, step: 1, message: { source: { callId: 'call-1' }, content: [{ type: 'text', text: 'done' }] },
    }, 105),
    event(7, 'assistant/message', {
      turn: 7, step: 2, message: { content: [{ type: 'text', text: 'Finished.' }] },
    }, 106),
    event(8, 'turn/end', { turn: 7, reason: { kind: 'completed' } }, 107),
  ];
  const restored = createProjection();
  applyWindow(restored.client, entries, { kind: 'replace', entries });
  const live = createProjection();
  Reflect.get(live.client, 'canonical').requestAliases.set('rpc-prompt', 'client-prompt');
  for (const entry of entries) applyWindow(live.client, [entry], { kind: 'append', entries: [entry] });
  const resumed = createProjection();
  Reflect.set(resumed.client, 'sessionRunning', true);
  applyWindow(resumed.client, entries.slice(0, 6), { kind: 'replace', entries: entries.slice(0, 6) });
  for (const entry of entries.slice(6)) applyWindow(resumed.client, [entry], { kind: 'append', entries: [entry] });

  const material = value => value.filter(item => item.kind === 'history' || item.kind === 'process').map((item) => {
    if (item.kind === 'history') {
      const { turn: _turn, ...message } = item;
      return message;
    }
    if (item.type === 'turn-end') {
      const { replay: _replay, ...process } = item;
      return process;
    }
    return item;
  });
  assert.deepEqual(material(live.output), material(restored.output));
  assert.deepEqual(material(resumed.output), material(restored.output));
});

test('an idle restored Turn without turn/end is projected as incomplete', () => {
  const { client, output } = createProjection();
  const entries = [
    event(1, 'turn/start', { turn: 9 }, 100),
    event(2, 'user/message', {
      source: { kind: 'user' }, content: [{ type: 'text', text: 'partial work' }],
    }, 101),
    event(3, 'tool/call', { turn: 9, step: 1, callId: 'partial-call', name: 'bash', arguments: {} }, 102),
  ];
  applyWindow(client, entries, { kind: 'replace', entries });

  assert.ok(output.some(item => item.type === 'tool-call' && item.callId === 'partial-call'));
  assert.ok(output.some(item => item.type === 'turn-incomplete' && item.turn === 9));
});

test('an active restored partial Turn remains running instead of becoming incomplete', () => {
  const { client, output } = createProjection();
  Reflect.set(client, 'sessionRunning', true);
  const entries = [
    event(1, 'turn/start', { turn: 10 }, 100),
    event(2, 'tool/call', { turn: 10, step: 1, callId: 'active-call', name: 'bash', arguments: {} }, 101),
  ];
  applyWindow(client, entries, { kind: 'replace', entries });

  assert.ok(output.some(item => item.type === 'tool-call' && item.callId === 'active-call'));
  assert.ok(!output.some(item => item.type === 'turn-incomplete'));
});

test('a long restored Tool Turn retains its preamble and final Assistant answer', () => {
  const { client, output } = createProjection();
  const entries = [
    event(1, 'turn/start', { turn: 76 }, 100),
    event(2, 'user/message', {
      source: { kind: 'user' }, content: [{ type: 'text', text: 'implement it' }],
    }, 101),
    event(3, 'assistant/message', {
      turn: 76, step: 1, message: { content: [{ type: 'text', text: 'I will implement it.' }] },
    }, 102),
  ];
  for (let index = 0; index < 120; index += 1) {
    entries.push(event(4 + index * 3, 'assistant/message', {
      turn: 76, step: index + 2, message: { content: [] },
    }, 103 + index * 3));
    entries.push(event(5 + index * 3, 'tool/call', {
      turn: 76, step: index + 2, callId: `long-call-${String(index)}`, name: 'bash', arguments: {},
    }, 104 + index * 3));
    entries.push(event(6 + index * 3, 'tool/result', {
      turn: 76, step: index + 2,
      message: { source: { callId: `long-call-${String(index)}` }, content: [] },
    }, 105 + index * 3));
  }
  entries.push(
    event(500, 'assistant/message', {
      turn: 76, step: 122, message: { content: [{ type: 'text', text: 'Implementation complete.' }] },
    }, 500),
    event(501, 'turn/end', { turn: 76, reason: { kind: 'completed' } }, 501),
  );
  applyWindow(client, entries, { kind: 'replace', entries });

  assert.equal(output.filter(item => item.type === 'tool-call').length, 120);
  const messages = output.filter(item => item.kind === 'history').map(item => `${item.role}:${item.text}`);
  assert.deepEqual(messages, [
    'user:implement it',
    'assistant:I will implement it.',
    'assistant:Implementation complete.',
  ]);
  assert.equal(output.findLast(item => item.kind === 'history')?.text, 'Implementation complete.');
  assert.equal(output.findLast(item => item.type === 'turn-end')?.turn, 76);
});
