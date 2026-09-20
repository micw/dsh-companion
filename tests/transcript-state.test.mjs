import assert from 'node:assert/strict';
import test from 'node:test';

await import('../vscode/media/transcript-state.js');

const {
  activityStatusText,
  mergePrependedTurnState,
  placeTurnProcessAfterMessage,
  placeUserMessageBeforeTurn,
  reattachTranscriptTail,
} = globalThis.dshCompanionTranscriptState;

class FakeNode {
  constructor(name) {
    this.name = name;
    this.parentNode = null;
    this.childNodes = [];
  }

  append(...nodes) {
    for (const node of nodes) this.insertAt(node, this.childNodes.length);
  }

  prepend(...nodes) {
    for (const [index, node] of nodes.entries()) this.insertAt(node, index);
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  after(node) {
    if (this.parentNode === null) return;
    const parent = this.parentNode;
    node.remove();
    const index = parent.childNodes.indexOf(this);
    parent.insertAt(node, index + 1);
  }

  before(node) {
    if (this.parentNode === null) return;
    const parent = this.parentNode;
    node.remove();
    const index = parent.childNodes.indexOf(this);
    parent.insertAt(node, index);
  }

  remove() {
    if (this.parentNode === null) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index >= 0) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }

  replaceWith(node) {
    if (this.parentNode === null) return;
    const parent = this.parentNode;
    const index = parent.childNodes.indexOf(this);
    this.remove();
    parent.insertAt(node, index);
  }

  insertAt(node, index) {
    node.remove();
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
  }
}

function turn(name, rows, options = {}) {
  const root = new FakeNode(`${name}-root`);
  const rowHost = new FakeNode(`${name}-rows`);
  rowHost.append(...rows);
  const disclosureRoot = options.disclosureRoot ?? root;
  return {
    root,
    label: { name: `${name}-label` },
    rows: rowHost,
    disclosureRoot,
    disclosureLabel: { name: `${name}-disclosure-label` },
    reasoning: new Map(options.reasoning ?? []),
    statuses: new Map(options.statuses ?? []),
    toolCallIds: new Set(options.tools ?? []),
    contextIds: new Set(options.contexts ?? []),
    toolCount: options.tools?.length ?? 0,
    contextCount: options.contexts?.length ?? 0,
    startedAt: options.startedAt,
    firstAssistantMessage: options.firstAssistantMessage,
    latestAssistantMessage: options.latestAssistantMessage,
  };
}

test('a Turn split across history pages merges into one ordered process presentation', () => {
  const transcript = new FakeNode('transcript');
  const olderRootRow = new FakeNode('older-tool');
  const newerRootRow = new FakeNode('newer-tool');
  const older = turn('older', [olderRootRow], {
    reasoning: [['reasoning-old', {}]], tools: ['call-old'], contexts: ['context-old'], startedAt: 100,
  });
  const newer = turn('newer', [newerRootRow], {
    reasoning: [['reasoning-new', {}]], tools: ['call-new'], startedAt: 200,
  });
  transcript.append(older.root, newer.root);

  const merged = mergePrependedTurnState(older, newer);

  assert.equal(merged, newer);
  assert.deepEqual(newer.rows.childNodes.map(node => node.name), ['older-tool', 'newer-tool']);
  assert.deepEqual([...newer.reasoning.keys()], ['reasoning-old', 'reasoning-new']);
  assert.deepEqual([...newer.toolCallIds], ['call-old', 'call-new']);
  assert.deepEqual([...newer.contextIds], ['context-old']);
  assert.equal(newer.toolCount, 2);
  assert.equal(newer.contextCount, 1);
  assert.equal(newer.startedAt, 100);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['newer-root']);
});

test('older process rows restore a disclosure when a tail-only Turn had become static', () => {
  const transcript = new FakeNode('transcript');
  const staticRoot = new FakeNode('static-root');
  const disclosureRoot = new FakeNode('disclosure-root');
  const older = turn('older', [new FakeNode('older-reasoning')]);
  const newer = turn('newer', [], { disclosureRoot });
  newer.root = staticRoot;
  transcript.append(older.root, staticRoot);

  mergePrependedTurnState(older, newer);

  assert.equal(newer.root, disclosureRoot);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['disclosure-root']);
});

test('a Tool call places the growing process block after its Assistant preamble', () => {
  const transcript = new FakeNode('transcript');
  const process = new FakeNode('process');
  const preamble = new FakeNode('preamble');
  const final = new FakeNode('final');
  transcript.append(process, preamble, final);
  const value = { root: process, latestAssistantMessage: preamble };

  assert.equal(placeTurnProcessAfterMessage(value), true);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['preamble', 'process', 'final']);
});

test('a delayed canonical prompt moves before an already populated Turn process', () => {
  const transcript = new FakeNode('transcript');
  const process = new FakeNode('process');
  const prompt = new FakeNode('prompt');
  transcript.append(process);

  assert.equal(placeUserMessageBeforeTurn({ root: process }, prompt), true);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['prompt', 'process']);
});

test('a delayed canonical prompt also precedes an Assistant preamble', () => {
  const transcript = new FakeNode('transcript');
  const preamble = new FakeNode('preamble');
  const process = new FakeNode('process');
  const final = new FakeNode('final');
  const prompt = new FakeNode('prompt');
  transcript.append(preamble, process, final);

  assert.equal(placeUserMessageBeforeTurn({ root: process, firstAssistantMessage: preamble }, prompt), true);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['prompt', 'preamble', 'process', 'final']);
});

test('activity status keeps running work distinct from connection readiness', () => {
  assert.equal(activityStatusText({ running: true, compacting: false, hostStatus: 'Connected' }), 'Running…');
  assert.equal(
    activityStatusText({ running: true, compacting: false, hostStatus: 'Codex/Sol responding…' }),
    'Codex/Sol responding…',
  );
  assert.equal(
    activityStatusText({ running: true, compacting: false, hostStatus: 'Disconnected; retrying…' }),
    'Disconnected; retrying…',
  );
  assert.equal(
    activityStatusText({ running: false, compacting: false, hostStatus: 'Codex/Sol responding…' }),
    'Connected',
  );
  assert.equal(
    activityStatusText({ running: true, compacting: true, hostStatus: 'Connected' }),
    'Compacting context…',
  );
});

test('a history prepend reattaches the complete existing transcript tail', () => {
  const transcript = new FakeNode('transcript');
  const oldPrompt = new FakeNode('old-prompt');
  const process = new FakeNode('process');
  const finalAnswer = new FakeNode('final-answer');
  const laterTurn = new FakeNode('later-turn');
  transcript.append(process, finalAnswer, laterTurn);
  const tail = [...transcript.childNodes];

  reattachTranscriptTail(transcript, [oldPrompt], tail);

  assert.deepEqual(
    transcript.childNodes.map(node => node.name),
    ['old-prompt', 'process', 'final-answer', 'later-turn'],
  );
});
