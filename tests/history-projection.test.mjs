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
    assistantStart() {}, assistantDelta() {}, assistantAbandoned() { output.push({ kind: 'assistant-abandoned' }); },
    assistantTime() {}, queue() {}, running() {}, status() {},
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
  return { client, output, sink };
}

function applyWindow(client, entries, change, initial = false) {
  Reflect.get(client, 'receiveCanonicalWindow').call(client, { entries, hasMore: false, change }, initial);
}

test('initial append delta replays the entire retained window before later live deltas', () => {
  const { client, output } = createProjection();
  const entries = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'existing prompt' }] }),
    event(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'existing answer' }] } }),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  // The DSH EventSource holds a full window while its latest mutation describes only an unrelated delta.
  applyWindow(client, entries, { kind: 'append', entries: [] }, true);
  assert.deepEqual(output.filter(item => item.kind === 'history').map(item => item.text), ['existing prompt', 'existing answer']);
  const next = event(5, 'turn/start', { turn: 2 });
  applyWindow(client, [...entries, next], { kind: 'append', entries: [next] });
  assert.deepEqual(output.filter(item => item.kind === 'history').map(item => item.text), ['existing prompt', 'existing answer']);
  assert.equal(output.filter(item => item.type === 'turn-start').length, 2);
});

test('initial settle-assistant delta also replays the complete retained window', () => {
  const { client, output } = createProjection();
  const entries = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'original' }] }),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  applyWindow(client, entries, { kind: 'settle-assistant', attemptId: 'old-attempt' }, true);
  assert.equal(output.find(item => item.kind === 'history' && item.text === 'original')?.role, 'user');
});

test('a recovered context-overflow attempt does not publish a final error in live or restored history', () => {
  const entries = [
    event(1, 'turn/start', { turn: 4 }),
    event(2, 'step/start', { turn: 4, step: 1 }),
    event(3, 'assistant/attempt', { turn: 4, step: 1, stream: [
      { type: 'chunk', chunk: { type: 'finish', reason: { failure: { message: 'context overflow' } } } },
    ] }),
    event(4, 'compaction/start', { compactionId: 'compact-4' }),
    event(5, 'compaction/summary', { compactionId: 'compact-4', shadowedSeqs: [1, 2], shadowedTokenCount: 100 }),
    event(6, 'compaction/end', { compactionId: 'compact-4' }),
    event(7, 'assistant/message', { turn: 4, step: 1, message: { content: [{ type: 'text', text: 'recovered answer' }] } }),
    event(8, 'turn/end', { turn: 4, reason: { kind: 'completed' } }),
  ];
  const live = createProjection();
  const replay = createProjection();
  applyWindow(live.client, entries.slice(0, 2), { kind: 'replace', entries: entries.slice(0, 2) }, true);
  for (let index = 2; index < entries.length; index += 1) {
    applyWindow(live.client, entries.slice(0, index + 1), { kind: 'append', entries: [entries[index]] });
  }
  applyWindow(replay.client, entries, { kind: 'replace', entries }, true);
  for (const projection of [live, replay]) {
    assert.deepEqual(projection.output.filter(item => item.kind === 'history').map(item => [item.role, item.text]),
      [['assistant', 'recovered answer']]);
  }
});

test('a live Assistant settlement without an entry retains the transcript and permits the next attempt', () => {
  const { client, output, sink } = createProjection();
  let resets = 0;
  sink.reset = () => { resets += 1; output.length = 0; };
  const entries = [
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'keep this prompt' }] }),
    event(3, 'step/start', { turn: 1, step: 1 }),
  ];
  applyWindow(client, entries, { kind: 'replace', entries }, true);
  Reflect.get(client, 'receiveCanonicalEntry').call(client, {
    type: 'transient', event: { type: 'assistant/live-chunk', data: {
      turn: 1, step: 1, attemptId: 'empty-attempt', chunk: { type: 'text-delta', text: 'transient only' },
    } },
  }, false);
  applyWindow(client, entries, { kind: 'settle-assistant', attemptId: 'empty-attempt' });
  assert.equal(resets, 1);
  assert.deepEqual(output.filter(item => item.kind === 'history').map(item => item.text), ['keep this prompt']);
  assert.equal(output.filter(item => item.kind === 'assistant-abandoned').length, 1);
  assert.equal(Reflect.get(client, 'hasLiveAssistantText'), false);
  const next = event(4, 'assistant/message', {
    turn: 1, step: 2, message: { content: [{ type: 'text', text: 'next attempt' }] },
  });
  applyWindow(client, [...entries, next], { kind: 'append', entries: [next] });
  assert.deepEqual(output.filter(item => item.kind === 'history').map(item => item.text),
    ['keep this prompt', 'next attempt']);
  const restored = createProjection();
  applyWindow(restored.client, [...entries, next], { kind: 'replace', entries: [...entries, next] }, true);
  assert.deepEqual(restored.output.filter(item => item.kind === 'history').map(item => item.text),
    output.filter(item => item.kind === 'history').map(item => item.text));
});

test('an abandoned partial answer is removed before another attempt commits the only durable answer', () => {
  const { client, output, sink } = createProjection();
  sink.assistantDelta = text => output.push({ kind: 'assistant-delta', text });
  sink.assistantTime = time => output.push({ kind: 'assistant-time', time });
  const entries = [event(1, 'turn/start', { turn: 32 }), event(2, 'step/start', { turn: 32, step: 6 })];
  applyWindow(client, entries, { kind: 'replace', entries }, true);
  const stream = (attemptId, text) => Reflect.get(client, 'receiveCanonicalEntry').call(client, {
    type: 'transient', event: { type: 'assistant/live-chunk', data: {
      turn: 32, step: 6, attemptId, chunk: { type: 'text-delta', text },
    } },
  }, false);
  stream('abandoned', 'partial answer');
  applyWindow(client, entries, { kind: 'settle-assistant', attemptId: 'abandoned' });
  stream('committed', 'complete answer');
  const final = event(3, 'assistant/message', {
    turn: 32, step: 6, message: { content: [{ type: 'text', text: 'complete answer' }] },
  });
  applyWindow(client, [...entries, final], { kind: 'append', entries: [final] });
  applyWindow(client, [...entries, final], { kind: 'settle-assistant', attemptId: 'committed' });
  assert.deepEqual(output.filter(item => ['assistant-delta', 'assistant-abandoned', 'assistant-time'].includes(item.kind)), [
    { kind: 'assistant-delta', text: 'partial answer' },
    { kind: 'assistant-abandoned' },
    { kind: 'assistant-delta', text: 'complete answer' },
    { kind: 'assistant-time', time: 3 },
  ]);
  assert.equal(output.filter(item => item.kind === 'history' && item.role === 'assistant').length, 0);
  const restored = createProjection();
  applyWindow(restored.client, [...entries, final], { kind: 'replace', entries: [...entries, final] }, true);
  assert.deepEqual(restored.output.filter(item => item.kind === 'history' && item.role === 'assistant')
    .map(item => item.text), ['complete answer']);
});

test('settled reasoning usage retains its Step identity after live text and before restored text', () => {
  const entries = [event(1, 'turn/start', { turn: 1 }), event(2, 'step/start', { turn: 1, step: 1 })];
  const final = event(3, 'assistant/message', {
    turn: 1, step: 1,
    message: { content: [{ type: 'text', text: 'Test received. I am ready.' }] },
    usage: { reasoningTokens: 15 },
  });
  const live = createProjection();
  live.sink.assistantStart = (turn, step) => live.output.push({ kind: 'assistant-start', turn, step });
  live.sink.assistantDelta = text => live.output.push({ kind: 'assistant-delta', text });
  applyWindow(live.client, entries, { kind: 'replace', entries }, true);
  Reflect.get(live.client, 'receiveCanonicalEntry').call(live.client, {
    type: 'transient', event: { type: 'assistant/live-chunk', data: {
      turn: 1, step: 1, attemptId: 'answer', chunk: { type: 'text-delta', text: 'Test received. I am ready.' },
    } },
  }, false);
  applyWindow(live.client, [...entries, final], { kind: 'append', entries: [final] });
  const liveStatus = live.output.find(item => item.type === 'status' && item.totalTokens === 15);
  assert.deepEqual(live.output.find(item => item.kind === 'assistant-start'),
    { kind: 'assistant-start', turn: 1, step: 1 });
  assert.equal(liveStatus?.step, 1);
  assert.equal(liveStatus?.retroactive, true);

  const restored = createProjection();
  applyWindow(restored.client, [...entries, final], { kind: 'replace', entries: [...entries, final] }, true);
  const restoredStatus = restored.output.find(item => item.type === 'status' && item.totalTokens === 15);
  assert.equal(restoredStatus?.step, 1);
  assert.equal(restoredStatus?.retroactive, false);
  assert.ok(restored.output.indexOf(restoredStatus) < restored.output.findIndex(item => item.role === 'assistant'));
});

test('late results for older Turns do not move the live or restored parser position', () => {
  const entries = [
    event(1, 'turn/start', { turn: 8 }),
    event(2, 'tool/call', { turn: 8, step: 1, callId: 'old-call', name: 'read', arguments: {} }),
    event(3, 'turn/end', { turn: 8, reason: { kind: 'completed' } }),
    event(4, 'turn/start', { turn: 142 }),
    event(5, 'step/start', { turn: 142, step: 13 }),
    event(6, 'tool/result', {
      turn: 8, step: 1, message: { source: { callId: 'old-call' }, content: [] },
    }),
    event(7, 'tool/result', {
      turn: 12, step: 2, message: { source: { callId: 'not-in-window' }, content: [] },
    }),
    event(8, 'user/message', {
      source: { kind: 'plugin', plugin: 'context' }, content: [{ type: 'text', text: 'current context' }],
    }),
  ];
  const live = createProjection();
  for (const entry of entries) applyWindow(live.client, [entry], { kind: 'append', entries: [entry] });
  const restored = createProjection();
  Reflect.set(restored.client, 'sessionRunning', true);
  applyWindow(restored.client, entries, { kind: 'replace', entries });
  for (const { client, output } of [live, restored]) {
    assert.deepEqual(output.filter(item => item.type === 'tool-result').map(item => [item.turn, item.callId]),
      [[8, 'old-call'], [12, 'not-in-window']]);
    assert.equal(output.findLast(item => item.type === 'context')?.turn, 142);
    assert.equal(Reflect.get(client, 'currentTurn'), 142);
    assert.equal(Reflect.get(client, 'currentStep'), 13);
    assert.equal(Reflect.get(client, 'openTurn'), 142);
  }
});

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

test('mid-turn text and following Tool call retain the same event order live and on restore', () => {
  const entries = [
    event(1, 'turn/start', { turn: 55 }),
    event(2, 'step/start', { turn: 55, step: 1 }),
    event(3, 'assistant/message', {
      turn: 55, step: 1, message: { content: [{ type: 'reasoning', text: 'first thought' }] },
    }),
    event(4, 'tool/call', { turn: 55, step: 1, callId: 'earlier', name: 'read', arguments: {} }),
    event(5, 'step/start', { turn: 55, step: 2 }),
    event(6, 'assistant/message', {
      turn: 55, step: 2, message: { content: [
        { type: 'reasoning', text: 'checked counts' },
        { type: 'text', text: 'Progress update' },
        { type: 'reasoning', text: 'continue' },
        { type: 'tool-call', id: 'later', name: 'bash', arguments: '{}' },
      ] },
    }),
    event(7, 'tool/call', { turn: 55, step: 2, callId: 'later', name: 'bash', arguments: '{}' }),
  ];
  const restored = createProjection();
  applyWindow(restored.client, entries, { kind: 'replace', entries });
  const live = createProjection();
  live.sink.assistantDelta = text => live.output.push({ kind: 'history', role: 'assistant', text });
  const stream = (step, chunk) => Reflect.get(live.client, 'receiveCanonicalEntry').call(live.client, {
    type: 'transient', event: { type: 'assistant/live-chunk', data: {
      turn: 55, step, attemptId: `step-${String(step)}`, chunk,
    } },
  }, false);
  for (const entry of entries) {
    if (entry.event.seq === 3) stream(1, { type: 'reasoning-delta', text: 'first thought', index: 0 });
    if (entry.event.seq === 6) {
      stream(2, { type: 'reasoning-delta', text: 'checked counts', index: 0 });
      stream(2, { type: 'text-delta', text: 'Progress update', index: 1 });
      stream(2, { type: 'reasoning-delta', text: 'continue', index: 2 });
    }
    applyWindow(live.client, [entry], { kind: 'append', entries: [entry] });
  }
  const relevant = value => value.filter(item => item.type === 'reasoning' || item.type === 'tool-call'
    || item.kind === 'history' && item.role === 'assistant')
    .map(item => item.type === 'reasoning' ? `reasoning:${item.text}`
      : item.type === 'tool-call' ? `tool:${item.callId}` : `text:${item.text}`);
  assert.deepEqual(relevant(restored.output), [
    'reasoning:first thought', 'tool:earlier', 'reasoning:checked counts',
    'text:Progress update', 'reasoning:continue', 'tool:later',
  ]);
  assert.deepEqual(relevant(live.output), relevant(restored.output));
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
