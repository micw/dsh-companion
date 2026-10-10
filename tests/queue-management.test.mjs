import assert from 'node:assert/strict';
import test from 'node:test';

import { DshClient, contextPresentation, parseInboxQueue } from '../vscode/out/dshClient.js';

const catalog = {
  default: { provider: 'provider', model: 'model' },
  routableProviders: ['provider'], groups: [], failures: [],
};

function message(id, text, content = [{ type: 'text', text }]) {
  return { id, source: { kind: 'user', rpcId: `rpc-${id}` }, content };
}

function imageRef(id) {
  return { attachmentId: id, mediaType: 'image/png', bytes: 3, width: 2, height: 1, name: 'capture.png' };
}

function harness(nextTurn = [], nextStep = [], running = true) {
  const events = [];
  const committed = [];
  const history = [];
  const inbox = { 'next-turn': [...nextTurn], 'next-step': [...nextStep] };
  const session = {
    projections: { faceOf(key) {
      assert.equal(key, 'inbox');
      return { getSnapshot: () => inbox };
    } },
    beginSubmission(input) {
      events.push(['begin', input.mode, input.text]);
      return { requestId: `remote-${events.length}`, abandon() { events.push(['abandon']); } };
    },
    async prompt(content, mode, _signal, requestId) {
      events.push(['prompt', mode, content, requestId]);
      return { ok: true, value: { accepted: true } };
    },
    async readAttachment(id) {
      events.push(['readImage', id]);
      return { ok: true, value: { attachment: imageRef(id), data: Uint8Array.from([1, 2, 3]) } };
    },
    async cancel() {
      events.push(['cancel']);
      return { ok: true, value: { accepted: true } };
    },
    async updateQueue(id, action) {
      events.push([action.kind === 'steer' ? 'steer' : 'remove', id, action.kind]);
      for (const target of ['next-step', 'next-turn']) {
        const index = inbox[target].findIndex(item => item.id === id);
        if (index >= 0) {
          if (action.kind === 'steer' && (target !== 'next-turn' || !client.sessionRunning)) {
            return { ok: false, error: { code: 'session/steer-unavailable', message: 'turn ended' } };
          }
          const [item] = inbox[target].splice(index, 1);
          if (action.kind === 'steer') inbox['next-step'].push(item);
          return { ok: true, value: { accepted: true } };
        }
      }
      return { ok: false, error: { code: 'session/queue-item-not-found', message: 'already claimed' } };
    },
  };
  const canonical = {
    binding: { session }, graph: {}, requestAliases: new Map(), disposers: [],
    disposeProviderRemotes: async () => {},
  };
  const client = new DshClient(undefined, {
    submissionObserved() {},
    userCommitted(...args) { committed.push(args); },
    history(...args) { history.push(args); },
  }, catalog, canonical);
  client.sessionIdValue = 'session-test';
  client.sessionRunning = running;
  return { client, events, inbox, session, canonical, committed, history };
}

test('queue and steering submissions use the same DSH Session with their requested modes', async () => {
  const { client, events } = harness();
  await client.prompt('later', 'local-queue');
  await client.prompt('next step', 'local-steer', 'steer');
  assert.deepEqual(events.map(item => item.slice(0, 2)), [
    ['begin', 'queue'], ['prompt', 'queue'], ['begin', 'steer'], ['prompt', 'steer'],
  ]);
  assert.equal(events[1][2][0].text, 'later');
  assert.equal(events[3][2][0].text, 'next step');
});

test('idle steering starts a new DSH prompt without changing its requested mode', async () => {
  const { client, events } = harness([], [], false);
  await client.prompt('inspect this', 'local-steer', 'steer');
  assert.deepEqual(events.map(item => item.slice(0, 2)), [['begin', 'steer'], ['prompt', 'steer']]);
  assert.deepEqual(events[1][2], [{ type: 'text', text: 'inspect this' }]);
});

test('an image-only prompt reaches DSH intact and keeps its delivery mode', async () => {
  const { client, events } = harness();
  const image = { mediaType: 'image/png', data: 'AQID', name: 'capture.png' };
  await client.prompt('', 'local-image', 'queue', [image]);
  await client.prompt('look', 'local-steer-image', 'steer', [image]);
  assert.deepEqual(events[1], ['prompt', 'queue', [{ type: 'image', ...image }], 'remote-1']);
  assert.deepEqual(events[3][2], [{ type: 'image', ...image }, { type: 'text', text: 'look' }]);
});

test('image-only user messages survive live commit and restored history projection', () => {
  const content = [{ type: 'image', attachment: imageRef('image-1') }];
  const record = { type: 'event', event: {
    type: 'user/message', time: 123, data: { source: { kind: 'user', rpcId: 'remote-image' }, content },
  } };
  const restored = harness();
  restored.client.currentTurn = 4;
  restored.client.currentStep = 2;
  restored.client.receiveHistoryRecord(record, true);
  assert.deepEqual(restored.history, [['user', '', 123, 4, 2, [imageRef('image-1')]]]);

  const live = harness();
  live.client.currentTurn = 4;
  live.client.currentStep = 2;
  live.canonical.requestAliases.set('remote-image', 'local-image');
  live.client.receiveHistoryRecord(record, false);
  assert.deepEqual(live.committed, [['local-image', '', 123, 4, 2, [imageRef('image-1')]]]);
});

test('a delayed committed steering message retains its actual DSH Turn and Step', () => {
  const { client, canonical, committed } = harness();
  canonical.requestAliases.set('remote-steer', 'local-steer');
  client.retireCanonicalSubmissions([
    { type: 'event', event: { type: 'turn/start', data: { turn: 4 } } },
    { type: 'event', event: { type: 'step/start', data: { step: 2 } } },
    { type: 'event', event: {
      type: 'user/message', time: 123,
      data: { source: { kind: 'user', rpcId: 'remote-steer' }, content: [
        { type: 'image', attachment: imageRef('image-1') }, { type: 'text', text: 'soon' },
      ] },
    } },
  ]);
  assert.deepEqual(committed, [['local-steer', 'soon', 123, 4, 2, [imageRef('image-1')]]]);
  assert.equal(canonical.requestAliases.size, 0);
});

test('a rejected steering submission retires its local echo without committing a transcript message', async () => {
  const { client, session, events, canonical } = harness();
  session.prompt = async () => ({ ok: false, error: { code: 'session/not-found', message: 'unavailable' } });
  await assert.rejects(client.prompt('soon', 'local-steer', 'steer'), /session\/not-found/);
  assert.deepEqual(events, [['begin', 'steer', 'soon'], ['abandon']]);
  assert.equal(canonical.requestAliases.size, 0);
});

test('Stop cancels the active turn before removing each observed steering and queued occurrence', async () => {
  const { client, events, inbox } = harness(
    [message('A', 'first'), message('B', 'second')],
    [message('S1', 'steer one'), message('S2', 'steer two')],
  );
  const result = await client.stopAndClearQueue();
  assert.deepEqual(events, [
    ['cancel'], ['remove', 'S1', 'remove'], ['remove', 'S2', 'remove'],
    ['remove', 'A', 'remove'], ['remove', 'B', 'remove'],
  ]);
  assert.deepEqual(result.removed.map(item => item.id), ['S1', 'S2', 'A', 'B']);
  assert.equal(result.failed, 0);
  assert.equal(result.cancelFailed, false);
  assert.deepEqual(parseInboxQueue(inbox, false, new Map()), []);
});

test('idle Stop removes the queue without cancelling another activity', async () => {
  const { client, events } = harness([message('A', 'later')], [], false);
  await client.stopAndClearQueue();
  assert.deepEqual(events, [['remove', 'A', 'remove']]);
});

test('removing an older occurrence preserves the later queue order', async () => {
  const { client, inbox, events, canonical } = harness([
    message('A', 'first'), message('B', 'second'), message('C', 'third'),
  ]);
  canonical.requestAliases.set('rpc-A', 'local-A');
  assert.equal((await client.removeQueued('A', false)).id, 'A');
  assert.deepEqual(events, [['remove', 'A', 'remove']]);
  assert.deepEqual(inbox['next-turn'].map(item => item.id), ['B', 'C']);
  assert.equal(canonical.requestAliases.size, 0);
});

test('steering one queued occurrence preserves its identity and the remaining FIFO order', async () => {
  const { client, inbox, events, canonical } = harness([
    message('A', 'first'), message('B', 'second'), message('C', 'third'),
  ]);
  canonical.requestAliases.set('rpc-B', 'local-B');
  await client.steerQueued('B');
  assert.deepEqual(events, [['steer', 'B', 'steer']]);
  assert.deepEqual(inbox['next-turn'].map(item => item.id), ['A', 'C']);
  assert.deepEqual(inbox['next-step'].map(item => item.id), ['B']);
  assert.deepEqual(parseInboxQueue(inbox, true, canonical.requestAliases).map(item => [item.id, item.placement]), [
    ['B', 'steering'], ['A', 'queued'], ['C', 'queued'],
  ]);
  assert.equal(parseInboxQueue(inbox, true, canonical.requestAliases)[0].requestId, 'local-B');
  assert.equal(canonical.requestAliases.get('rpc-B'), 'local-B');
});

test('Inbox rows preserve subagent provenance and stable message identity for pending Turn presentation', () => {
  const relay = { id: 'relay-1', source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child' },
    content: [{ type: 'text', text: 'Long child report' }] };
  const settled = { id: 'settled-1', source: { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child' },
    content: [{ type: 'text', text: 'Child finished' }] };
  const unknown = { id: 'other-1', source: { kind: 'future-source' }, content: [{ type: 'text', text: 'Other' }] };
  const rows = parseInboxQueue({ 'next-turn': [], 'next-step': [relay, settled, unknown] }, true, new Map());
  assert.deepEqual(rows.map(row => [row.id, row.sourceKind, row.placement]), [
    ['relay-1', 'agent-message', 'steering'],
    ['settled-1', 'subagent-settled', 'steering'],
    ['other-1', 'other', 'steering'],
  ]);
  assert.deepEqual(rows.map(row => row.contextLabel), ['Subagent message', 'Subagent finished', 'Context update']);
});

test('background-job Inbox context keeps its source label without changing user steering', () => {
  const notice = { id: 'job-1', source: { kind: 'tool-jobs', form: 'notice', summary: 'bash-828 finished' },
    content: [{ type: 'text', text: 'Full completion notice' }] };
  const rows = parseInboxQueue({ 'next-turn': [], 'next-step': [notice, message('S', 'Human steering')] }, true, new Map());
  assert.equal(rows[0].sourceKind, 'other');
  assert.equal(rows[0].contextLabel, 'Background job');
  assert.equal(rows[0].text, 'Full completion notice');
  assert.equal(rows[1].sourceKind, 'user');
  assert.equal(rows[1].contextLabel, undefined);
  assert.throws(() => parseInboxQueue({ 'next-turn': [], 'next-step': [{ ...notice, source: { kind: 7 } }] },
    true, new Map()), /invalid Inbox message/);
});

test('context presentation uses known source kinds and only bounded notice summaries', () => {
  assert.deepEqual(contextPresentation({ kind: 'tool-jobs', form: 'notice', summary: 'bash\nset -e finished' }),
    { label: 'Background job', summary: 'bash set -e finished' });
  assert.deepEqual(contextPresentation({ kind: 'runtime-context', form: 'snapshot' }),
    { label: 'Runtime context' });
  assert.deepEqual(contextPresentation({ kind: 'subagent-settled', form: 'notice', summary: 'Child finished' }),
    { label: 'Subagent finished' });
  assert.deepEqual(contextPresentation({ kind: 'constructor', form: 'notice', summary: 'x'.repeat(200) }),
    { label: 'Context update', summary: 'x'.repeat(120) });
  assert.deepEqual(contextPresentation({ kind: 'future-source', form: 'notice', summary: 7 }),
    { label: 'Context update' });
});

test('composer queue actions cannot remove or steer subagent messages', async () => {
  const relay = { id: 'relay-1', source: { kind: 'agent-message', form: 'relay' },
    content: [{ type: 'text', text: 'Child report' }] };
  const { client, events } = harness([relay]);
  await assert.rejects(client.removeQueued('relay-1', false), /Only user messages/);
  await assert.rejects(client.removeQueued('relay-1', true), /Only user messages/);
  await assert.rejects(client.steerQueued('relay-1'), /only steer while a Turn is running/);
  assert.deepEqual(events, []);
});

test('queued steering rejects idle, claimed, and already-steering occurrences', async () => {
  const idle = harness([message('A', 'later')], [], false);
  await assert.rejects(idle.client.steerQueued('A'), /only steer while a Turn is running/);
  assert.deepEqual(idle.events, []);

  const active = harness([message('A', 'later')], [message('S', 'soon')]);
  await assert.rejects(active.client.steerQueued('S'), /only steer while a Turn is running/);
  await assert.rejects(active.client.steerQueued('missing'), /only steer while a Turn is running/);
  active.session.updateQueue = async () => ({
    ok: false, error: { code: 'session/steer-unavailable', message: 'turn ended before steering' },
  });
  await assert.rejects(active.client.steerQueued('A'), /session\/steer-unavailable/);
  assert.deepEqual(active.inbox['next-turn'].map(item => item.id), ['A']);
});

test('a claimed occurrence cannot be taken back or falsely reported as removed', async () => {
  const { client, inbox } = harness([message('A', 'first'), message('B', 'second')]);
  await assert.rejects(client.removeQueued('A', true), /last text-and-image queued message/);
  assert.equal((await client.removeQueued('B', true)).text, 'second');
  assert.deepEqual(inbox['next-turn'].map(item => item.id), ['A']);
  inbox['next-turn'].length = 0;
  await assert.rejects(client.removeQueued('A', false), /no longer pending/);
});

test('take-back restores image bytes before removing the last queued message', async () => {
  const mixed = message('image', 'caption', [
    { type: 'text', text: 'caption' }, { type: 'image', attachment: imageRef('image-1') },
  ]);
  const { client, inbox, events } = harness([mixed]);
  assert.equal(parseInboxQueue(inbox, true, new Map())[0].textOnly, false);
  assert.equal(parseInboxQueue(inbox, true, new Map())[0].takeBackAvailable, true);
  const taken = await client.removeQueued('image', true);
  assert.deepEqual(taken.restoredImages, [{ mediaType: 'image/png', data: 'AQID', name: 'capture.png' }]);
  assert.deepEqual(events, [['readImage', 'image-1'], ['remove', 'image', 'remove']]);
  assert.equal(inbox['next-turn'].length, 0);
});

test('take-back preserves the queue if an image read fails or the occurrence is claimed', async () => {
  const image = message('image', '', [{ type: 'image', attachment: imageRef('image-1') }]);
  const { client, inbox, session, events } = harness([image]);
  session.readAttachment = async () => ({ ok: false, error: { code: 'session/attachment-invalid', message: 'missing' } });
  await assert.rejects(client.removeQueued('image', true), /session\/attachment-invalid/);
  assert.equal(inbox['next-turn'].length, 1);
  assert.deepEqual(events, []);
  session.readAttachment = async (id) => ({ ok: true, value: { attachment: imageRef(id), data: Uint8Array.from([1, 2, 3]) } });
  session.updateQueue = async () => ({ ok: false, error: { code: 'session/queue-item-not-found', message: 'claimed' } });
  await assert.rejects(client.removeQueued('image', true), /session\/queue-item-not-found/);
  assert.equal(inbox['next-turn'].length, 1);
});

test('take-back rejects queued content that includes an unsupported file', async () => {
  const mixed = message('file', 'caption', [
    { type: 'text', text: 'caption' }, { type: 'file', attachment: { attachmentId: 'file-1' } },
  ]);
  const { client, inbox } = harness([mixed]);
  assert.equal(parseInboxQueue(inbox, true, new Map())[0].takeBackAvailable, false);
  await assert.rejects(client.removeQueued('file', true), /last text-and-image queued message/);
  assert.equal(inbox['next-turn'].length, 1);
});

test('image reads reject mismatched metadata before returning bytes to the Webview', async () => {
  const { client, session } = harness();
  session.readAttachment = async () => ({
    ok: true, value: { attachment: imageRef('image-1'), data: Uint8Array.from([1, 2]) },
  });
  await assert.rejects(client.readImage('image-1'), /invalid image byte length/);
  session.readAttachment = async () => ({
    ok: true, value: { attachment: imageRef('different'), data: Uint8Array.from([1, 2, 3]) },
  });
  await assert.rejects(client.readImage('image-1'), /different image attachment/);
});

test('Stop reports a claim race while removing the remaining observed queue', async () => {
  const { client, inbox, session } = harness([message('A', 'first'), message('B', 'second')]);
  const originalCancel = session.cancel;
  session.cancel = async () => {
    const result = await originalCancel();
    inbox['next-turn'].shift();
    return result;
  };
  const result = await client.stopAndClearQueue();
  assert.deepEqual(result.removed.map(item => item.id), ['B']);
  assert.equal(result.failed, 1);
  assert.deepEqual(inbox['next-turn'], []);
});

test('Stop still clears observed queue items when the active-turn cancel request fails', async () => {
  const { client, session, inbox } = harness([message('A', 'later')]);
  session.cancel = async () => ({ ok: false, error: { code: 'session/not-found', message: 'turn ended' } });
  const result = await client.stopAndClearQueue();
  assert.equal(result.cancelFailed, true);
  assert.deepEqual(result.removed.map(item => item.id), ['A']);
  assert.deepEqual(inbox['next-turn'], []);
});
