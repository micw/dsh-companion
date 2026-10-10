import assert from 'node:assert/strict';
import test from 'node:test';

import { DshClient } from '../vscode/out/dshClient.js';

function createClient() {
  const events = [];
  const listeners = new Set();
  let entries = [];
  const eventSource = {
    getSnapshot() { return { entries }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const sink = {
    process(event) { events.push(event); },
    reset() { events.length = 0; },
    historyState() {}, compacting() {}, status() {},
  };
  const catalog = { default: { provider: 'test', model: 'test' }, routableProviders: [], groups: [], failures: [] };
  const client = Reflect.construct(DshClient, [undefined, sink, catalog, {
    requestAliases: new Map(), disposers: [], disposeProviderRemotes: async () => {},
    binding: { eventSource },
    graph: { dispose: async () => {} },
  }]);
  Reflect.set(client, 'currentTurn', 7);
  Reflect.set(client, 'openTurn', 7);
  return { client, events, listeners, publish(next) { entries = next; for (const listener of listeners) listener(); } };
}

function record(seq, type, data) {
  return { type: 'event', event: { seq, type, data, time: seq } };
}

function window(client, entries, initial = false) {
  Reflect.get(client, 'receiveCanonicalWindow').call(client, {
    entries, hasMore: false, change: { kind: initial ? 'replace' : 'append', entries },
  }, initial);
}

function publishAsk(view, callId, reason) {
  view.publish([record(1, 'turn/start', { turn: 7 }),
    record(2, 'approval/asked', { id: `ask-${callId}`, toolName: 'bash', callId,
      ...(reason === undefined ? {} : { reason }) })]);
}

test('a pending approval accepts exactly one local answer and retires its token', async () => {
  const view = createClient();
  const { client, events } = view;
  publishAsk(view, 'call-1', 'audit reason');
  const signal = new AbortController();
  const answer = Reflect.get(client, 'receiveApprovalRequest').call(client, {
    toolName: 'bash', callId: 'call-1', reason: 'audit reason',
    displayReason: { en: 'Needs network' }, signal: signal.signal,
  }, async () => 'unavailable');
  const pending = events.at(-1);
  assert.equal(pending.type, 'approval-pending');
  assert.equal(pending.state, 'answerable');
  assert.equal(pending.callId, 'call-1');
  assert.equal(pending.reason, 'Needs network');
  assert.equal(client.answerApproval(pending.token, 'allowed-once'), true);
  assert.equal(client.answerApproval(pending.token, 'rejected'), false);
  assert.equal(await answer, 'allowed-once');
  assert.equal(events.at(-1).state, 'closed');
  assert.equal(client.answerApproval(pending.token, 'rejected'), false);
});

test('a competing client settlement or Stop withdraws a prompt without granting it', async () => {
  const first = createClient();
  const second = createClient();
  publishAsk(first, 'call-2');
  publishAsk(second, 'call-2');
  const firstSignal = new AbortController();
  const secondSignal = new AbortController();
  const firstAnswer = Reflect.get(first.client, 'receiveApprovalRequest').call(first.client, {
    toolName: 'bash', callId: 'call-2', signal: firstSignal.signal,
  }, async () => 'unavailable');
  const secondAnswer = Reflect.get(second.client, 'receiveApprovalRequest').call(second.client, {
    toolName: 'bash', callId: 'call-2', signal: secondSignal.signal,
  }, async () => 'unavailable');
  const firstToken = first.events.at(-1).token;
  const secondToken = second.events.at(-1).token;
  assert.equal(first.client.answerApproval(firstToken, 'rejected'), true);
  secondSignal.abort();
  assert.equal(await firstAnswer, 'rejected');
  assert.equal(await secondAnswer, 'cancelled');
  assert.equal(second.client.answerApproval(secondToken, 'allowed-once'), false);
  assert.equal(second.events.at(-1).state, 'closed');
});

test('closing a tab delegates an unanswered request instead of approving it', async () => {
  const view = createClient();
  const { client, events } = view;
  publishAsk(view, 'call-3');
  const signal = new AbortController();
  let delegated = false;
  const answer = Reflect.get(client, 'receiveApprovalRequest').call(client, {
    toolName: 'bash', callId: 'call-3', signal: signal.signal,
  }, async () => { delegated = true; return 'unavailable'; });
  const token = events.at(-1).token;
  client.dispose();
  assert.equal(await answer, 'unavailable');
  assert.equal(delegated, true);
  assert.equal(client.answerApproval(token, 'allowed-once'), false);
});

test('a malformed request fails closed without presenting an answerable prompt', async () => {
  const { client, events } = createClient();
  let delegated = false;
  const result = await Reflect.get(client, 'receiveApprovalRequest').call(client, {
    toolName: 'bash', callId: 17,
  }, async () => { delegated = true; return 'allowed-once'; });
  assert.equal(result, 'unavailable');
  assert.equal(delegated, false);
  assert.deepEqual(events, []);
});

test('a Remote request arriving before the Turn stream waits for the correct Turn', async () => {
  const view = createClient();
  const { client, events, listeners } = view;
  Reflect.set(client, 'currentTurn', 6);
  const signal = new AbortController();
  const answer = Reflect.get(client, 'receiveApprovalRequest').call(client, {
    toolName: 'bash', callId: 'call-next', signal: signal.signal,
  }, async () => 'unavailable');
  assert.equal(events.length, 0);
  window(client, [record(1, 'turn/start', { turn: 7 }),
    record(2, 'tool/call', { turn: 7, callId: 'call-next', name: 'bash', arguments: '{}' })], true);
  publishAsk(view, 'call-next');
  await Promise.resolve();
  const pending = events.find(event => event.type === 'approval-pending');
  assert.equal(pending.turn, 7);
  assert.equal(client.answerApproval(pending.token, 'allowed-once'), true);
  assert.equal(await answer, 'allowed-once');
  assert.equal(listeners.size, 0);
});

test('closing the tab while waiting for the Turn delegates without a stale prompt', async () => {
  const { client, events, listeners } = createClient();
  const signal = new AbortController();
  let delegated = false;
  const answer = Reflect.get(client, 'receiveApprovalRequest').call(client, {
    toolName: 'bash', callId: 'call-late', signal: signal.signal,
  }, async () => { delegated = true; return 'unavailable'; });
  client.dispose();
  assert.equal(await answer, 'unavailable');
  assert.equal(delegated, true);
  assert.equal(listeners.size, 0);
  assert.deepEqual(events, []);
});

test('replacing the canonical window restores only the still-live approval token', async () => {
  const view = createClient();
  const { client, events } = view;
  publishAsk(view, 'call-restore');
  const signal = new AbortController();
  const answer = Reflect.get(client, 'receiveApprovalRequest').call(client, {
    toolName: 'bash', callId: 'call-restore', signal: signal.signal,
  }, async () => 'unavailable');
  const token = events.at(-1).token;
  window(client, [record(1, 'turn/start', { turn: 7 }),
    record(2, 'approval/asked', { id: 'ask-restore', toolName: 'bash', callId: 'call-restore' })], true);
  assert.deepEqual(events.filter(event => event.type?.startsWith('approval-')).map(event => event.type),
    ['approval-asked', 'approval-pending']);
  assert.equal(events.find(event => event.type === 'approval-pending').token, token);
  signal.abort();
  assert.equal(await answer, 'cancelled');
  assert.equal(client.answerApproval(token, 'allowed-once'), false);
});

test('approval audit results project identically live and after restoring the Turn', () => {
  const entries = [
    record(1, 'turn/start', { turn: 7 }),
    record(2, 'tool/call', { turn: 7, callId: 'call-4', name: 'bash', arguments: '{}' }),
    record(3, 'approval/asked', { id: 'ask-4', toolName: 'bash', callId: 'call-4', reason: 'Needs network' }),
    record(4, 'approval/decided', { id: 'ask-4', outcome: 'rejected' }),
    record(5, 'turn/end', { turn: 7, reason: { kind: 'completed' } }),
  ];
  const live = createClient();
  const restored = createClient();
  window(live.client, entries.slice(0, 2), true);
  for (const entry of entries.slice(2)) window(live.client, [entry]);
  window(restored.client, entries, true);
  const approvals = ({ events }) => events.filter(event => event.type?.startsWith('approval-'));
  assert.deepEqual(approvals(live), approvals(restored));
  assert.deepEqual(approvals(restored), [
    { type: 'approval-asked', turn: 7, id: 'ask-4', toolName: 'bash', callId: 'call-4', reason: 'Needs network' },
    { type: 'approval-decided', turn: 7, id: 'ask-4', outcome: 'rejected' },
  ]);
});
