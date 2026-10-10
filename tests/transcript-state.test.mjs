import assert from 'node:assert/strict';
import test from 'node:test';

await import('../vscode/media/transcript-state.js');

const {
  activityStatusText,
  advanceTurnProcessSegment,
  createScrollBoundsRefresher,
  mergePrependedTurnState,
  placeEmptyTurnProcessAfterMessage,
  placeUserMessageBeforeTurn,
  reconcileTranscriptNodes,
  removeAbandonedAssistant,
  reattachTranscriptTail,
  relocateSelectionRange,
  scrollModeAfterScroll,
  selectReasoningStatusSegment,
  selectionTouchesNode,
  splitTurnProcessAtCompaction,
} = globalThis.dshCompanionTranscriptState;

function nodeList() {
  return new Proxy([], {
    get(target, key, receiver) {
      return key === 'indexOf' ? undefined : Reflect.get(target, key, receiver);
    },
  });
}

class FakeNode {
  constructor(name) {
    this.name = name;
    this.dataset = {};
    this.parentNode = null;
    this.childNodes = nodeList();
  }

  append(...nodes) {
    for (const node of nodes) this.insertAt(node, this.childNodes.length);
  }

  prepend(...nodes) {
    for (const [index, node] of nodes.entries()) this.insertAt(node, index);
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = nodeList();
    this.append(...nodes);
  }

  after(node) {
    if (this.parentNode === null) return;
    const parent = this.parentNode;
    node.remove();
    const index = [...parent.childNodes].indexOf(this);
    parent.insertAt(node, index + 1);
  }

  before(node) {
    if (this.parentNode === null) return;
    const parent = this.parentNode;
    node.remove();
    const index = [...parent.childNodes].indexOf(this);
    parent.insertAt(node, index);
  }

  remove() {
    if (this.parentNode === null) return;
    const index = [...this.parentNode.childNodes].indexOf(this);
    if (index >= 0) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
  }

  replaceWith(node) {
    if (this.parentNode === null) return;
    const parent = this.parentNode;
    const index = [...parent.childNodes].indexOf(this);
    this.remove();
    parent.insertAt(node, index);
  }

  insertAt(node, index) {
    node.remove();
    node.parentNode = this;
    this.childNodes.splice(index, 0, node);
  }
}

class RenderNode {
  constructor(nodeName, data = '') {
    this.nodeName = nodeName;
    this.nodeType = nodeName === '#text' ? 3 : 1;
    this.data = data;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = new Map();
  }

  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() {
    if (this.parentNode === null) return null;
    return this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  remove() {
    if (this.parentNode === null) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }

  replaceWith(node) {
    const parent = this.parentNode;
    const index = parent.childNodes.indexOf(this);
    node.remove();
    parent.childNodes[index] = node;
    node.parentNode = parent;
    this.parentNode = null;
  }

  appendData(value) { this.data += value; }
  contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
  getAttributeNames() { return [...this.attributes.keys()]; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
}

function element(name, ...children) {
  const node = new RenderNode(name);
  node.append(...children);
  return node;
}

function turn(name, rows, options = {}) {
  const root = new FakeNode(`${name}-root`);
  root.dataset.turn = String(options.number ?? 1);
  const rowHost = new FakeNode(`${name}-rows`);
  rowHost.append(...rows);
  const disclosureRoot = options.disclosureRoot ?? root;
  const segment = {
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
  };
  return {
    ...segment,
    segments: [segment],
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

test('a compaction at a history-page seam keeps the same Turn in two disclosures', () => {
  const transcript = new FakeNode('transcript');
  const older = turn('before', [new FakeNode('first-tool')]);
  const newer = turn('after', [new FakeNode('retry-tool')]);
  const compaction = new FakeNode('compaction');
  transcript.append(older.root, compaction, newer.root);
  assert.equal(splitTurnProcessAtCompaction(older, compaction), true);

  const merged = mergePrependedTurnState(older, newer);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['before-root', 'compaction', 'after-root']);
  assert.deepEqual(merged.segments.map(segment => segment.rows.childNodes.map(node => node.name)),
    [['first-tool'], ['retry-tool']]);
  assert.equal(merged.segments[0].root.dataset.disclosureId, 'turn:1');
  assert.equal(merged.segments[1].root.dataset.disclosureId, 'turn:1:process:1');
});

test('older process rows restore a disclosure when a tail-only Turn had become static', () => {
  const transcript = new FakeNode('transcript');
  const staticRoot = new FakeNode('static-root');
  const disclosureRoot = new FakeNode('disclosure-root');
  const older = turn('older', [new FakeNode('older-reasoning')]);
  const newer = turn('newer', [], { disclosureRoot });
  newer.root = staticRoot;
  newer.segments[0].root = staticRoot;
  transcript.append(older.root, staticRoot);

  mergePrependedTurnState(older, newer);

  assert.equal(newer.root, disclosureRoot);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['disclosure-root']);
});

test('a mid-turn progress message separates earlier process rows from later Tool calls', () => {
  const transcript = new FakeNode('transcript');
  const earlier = new FakeNode('earlier-tool');
  const progress = new FakeNode('progress');
  const later = new FakeNode('later-tool');
  const value = turn('first', [earlier], { tools: ['call-earlier'] });
  transcript.append(value.root, progress);
  value.latestAssistantMessage = progress;
  value.pendingProcessSegment = true;

  assert.equal(advanceTurnProcessSegment(value, () => {
    const next = turn('second', []);
    transcript.append(next.root);
    return next.segments[0];
  }), true);
  value.rows.append(later);
  value.toolCallIds.add('call-later');
  value.toolCount += 1;
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['first-root', 'progress', 'second-root']);
  assert.deepEqual(value.segments.map(segment => segment.rows.childNodes.map(node => node.name)),
    [['earlier-tool'], ['later-tool']]);
  assert.deepEqual([...value.segments[0].toolCallIds], ['call-earlier']);
  assert.deepEqual([...value.toolCallIds], ['call-later']);
});

test('settled reasoning tokens attach before the streamed answer and never create a later Thinking block', () => {
  const transcript = new FakeNode('transcript');
  const value = turn('before-answer', [new FakeNode('context-one'), new FakeNode('context-two')]);
  const answer = new FakeNode('answer-with-footer');
  answer.dataset.assistantStep = '1';
  transcript.append(value.root, answer);
  value.latestAssistantMessage = answer;
  value.pendingProcessSegment = true;
  const status = { id: 'turn:1:status:reasoning-tokens:1', step: 1, retroactive: true };
  const segment = selectReasoningStatusSegment(value, status, () => {
    throw new Error('settlement must not create a post-answer segment');
  });
  segment.rows.append(new FakeNode('15-reasoning-tokens'));
  segment.statuses.set(status.id, {});
  assert.equal(segment, value.segments[0]);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['before-answer-root', 'answer-with-footer']);
  assert.deepEqual(value.rows.childNodes.map(node => node.name),
    ['context-one', 'context-two', '15-reasoning-tokens']);
  assert.equal(selectReasoningStatusSegment(value, { ...status, retroactive: false }, () => {
    throw new Error('the same Step must update its existing row');
  }), segment);
});

test('retroactive reasoning after an initially empty process keeps the next Tool below the answer in live and restore', () => {
  for (const replay of [false, true]) {
    const transcript = new FakeNode('transcript');
    const value = turn('before-answer', []);
    const answer = new FakeNode('answer');
    answer.dataset.assistantStep = '1';
    transcript.append(value.root);
    if (!replay) {
      transcript.append(answer);
      value.firstAssistantMessage = answer;
      value.latestAssistantMessage = answer;
      assert.equal(value.pendingProcessSegment, undefined);
    }
    const status = { id: 'turn:1:status:reasoning-tokens:1', step: 1, retroactive: !replay };
    const segment = selectReasoningStatusSegment(value, status, () => {
      if (!replay) throw new Error('retroactive status must precede the answer');
    });
    assert.equal(segment, value.segments[0]);
    segment.rows.append(new FakeNode('thinking'));
    segment.statuses.set(status.id, {});
    if (replay) {
      transcript.append(answer);
      value.firstAssistantMessage = answer;
      value.latestAssistantMessage = answer;
      if (value.rows.childNodes.length > 0) value.pendingProcessSegment = true;
    }
    assert.equal(value.pendingProcessSegment, true, `replay=${replay}`);
    assert.equal(advanceTurnProcessSegment(value, () => {
      const next = turn('after-answer', []);
      transcript.append(next.root);
      return next.segments[0];
    }), true, `replay=${replay}`);
    value.rows.append(new FakeNode('tool'));
    assert.deepEqual(transcript.childNodes.map(node => node.name),
      ['before-answer-root', 'answer', 'after-answer-root'], `replay=${replay}`);
    assert.deepEqual(value.segments.map(item => item.rows.childNodes.map(node => node.name)),
      [['thinking'], ['tool']], `replay=${replay}`);
  }
});

test('reasoning from another Step does not attach to the prior Assistant message', () => {
  const transcript = new FakeNode('transcript');
  const value = turn('before-answer', [new FakeNode('old-status')]);
  const answer = new FakeNode('answer');
  answer.dataset.assistantStep = '1';
  transcript.append(value.root, answer);
  value.latestAssistantMessage = answer;
  value.pendingProcessSegment = true;
  const selected = selectReasoningStatusSegment(value,
    { id: 'turn:1:status:reasoning-tokens:2', step: 2, retroactive: true },
    () => advanceTurnProcessSegment(value, () => {
      const next = turn('later-step', []);
      transcript.append(next.root);
      return next.segments[0];
    }));
  assert.equal(selected, value.segments[1]);
  assert.deepEqual(transcript.childNodes.map(node => node.name),
    ['before-answer-root', 'answer', 'later-step-root']);
});

test('context-overflow compaction separates process rows before a retry in live and restored transcripts', () => {
  for (const replay of [false, true]) {
    const transcript = new FakeNode('transcript');
    const value = turn('before', [new FakeNode('think'), new FakeNode('bash')]);
    const error = new FakeNode('overflow-error');
    const compaction = new FakeNode('compaction');
    transcript.append(value.root, error, compaction);

    assert.equal(splitTurnProcessAtCompaction(value, compaction), true, `replay=${replay}`);
    assert.equal(advanceTurnProcessSegment(value, () => {
      const next = turn('retry', []);
      transcript.append(next.root);
      return next.segments[0];
    }), true);
    value.rows.append(new FakeNode('retry-think'));
    assert.deepEqual(transcript.childNodes.map(node => node.name),
      ['before-root', 'overflow-error', 'compaction', 'retry-root']);
    assert.deepEqual(value.segments.map(segment => segment.rows.childNodes.map(node => node.name)),
      [['think', 'bash'], ['retry-think']]);
  }
});

test('idle manual compaction does not reopen a completed Turn', () => {
  const transcript = new FakeNode('transcript');
  const value = turn('completed', [new FakeNode('think')]);
  value.completed = true;
  const compaction = new FakeNode('compaction');
  transcript.append(value.root, compaction);
  assert.equal(splitTurnProcessAtCompaction(value, compaction), false);
  assert.equal(value.pendingProcessSegment, undefined);
});

test('a text preamble moves only an empty process block before its first Tool call', () => {
  const transcript = new FakeNode('transcript');
  const preamble = new FakeNode('preamble');
  const value = turn('process', []);
  value.latestAssistantMessage = preamble;
  transcript.append(value.root, preamble);

  assert.equal(placeEmptyTurnProcessAfterMessage(value), true);
  value.rows.append(new FakeNode('tool'));
  assert.equal(placeEmptyTurnProcessAfterMessage(value), false);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['preamble', 'process-root']);
});

test('abandoning a live answer removes only that article and its pending render', () => {
  const transcript = new FakeNode('transcript');
  const committed = new FakeNode('committed');
  const live = new FakeNode('live');
  live.dataset.liveAssistant = 'true';
  transcript.append(committed, live);
  const body = new FakeNode('live-body');
  const pending = new Map([[body, '<p>partial</p>']]);
  const value = { firstAssistantMessage: committed, latestAssistantMessage: live,
    rows: { childElementCount: 1 }, pendingProcessSegment: true };
  assert.equal(removeAbandonedAssistant(value, live, body, pending), true);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['committed']);
  assert.equal(value.firstAssistantMessage, committed);
  assert.equal(value.latestAssistantMessage, committed);
  assert.equal(pending.size, 0);
  assert.equal(removeAbandonedAssistant(value, committed, undefined, pending), false);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['committed']);
});

test('restored progress stays between process segments when history pages join', () => {
  const transcript = new FakeNode('transcript');
  const older = turn('older', [new FakeNode('old-tool')], { tools: ['old'] });
  const progress = new FakeNode('progress');
  const newer = turn('newer', [new FakeNode('new-tool')], { tools: ['new'] });
  older.pendingProcessSegment = true;
  older.latestAssistantMessage = progress;
  transcript.append(older.root, progress, newer.root);

  mergePrependedTurnState(older, newer);

  assert.deepEqual(transcript.childNodes.map(node => node.name), ['older-root', 'progress', 'newer-root']);
  assert.deepEqual(newer.segments.map(segment => segment.rows.childNodes.map(node => node.name)),
    [['old-tool'], ['new-tool']]);
  assert.deepEqual(newer.segments.map(segment => segment.root.dataset.disclosureId),
    ['turn:1', 'turn:1:process:1']);
  const prompt = new FakeNode('prompt');
  assert.equal(placeUserMessageBeforeTurn(newer, prompt), true);
  assert.deepEqual(transcript.childNodes.map(node => node.name),
    ['prompt', 'older-root', 'progress', 'newer-root']);
});

test('a newer page starting with Assistant text does not merge process rows across that text', () => {
  const transcript = new FakeNode('transcript');
  const older = turn('older', [new FakeNode('old-tool')], { tools: ['old'] });
  const progress = new FakeNode('progress');
  const newer = turn('newer', [new FakeNode('new-tool')], {
    firstAssistantMessage: progress, tools: ['new'],
  });
  transcript.append(older.root, progress, newer.root);

  mergePrependedTurnState(older, newer);

  assert.deepEqual(transcript.childNodes.map(node => node.name), ['older-root', 'progress', 'newer-root']);
  assert.deepEqual(newer.segments.map(segment => segment.rows.childNodes.map(node => node.name)),
    [['old-tool'], ['new-tool']]);
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

test('layout scroll events cannot resume follow after the user scrolls upward', () => {
  assert.equal(scrollModeAfterScroll('follow', false, true), 'sticky');
  assert.equal(scrollModeAfterScroll('follow', true, true, true), 'sticky');
  assert.equal(scrollModeAfterScroll('sticky', true, false), 'sticky');
  assert.equal(scrollModeAfterScroll('sticky', true, false, false, true), 'follow');
  assert.equal(scrollModeAfterScroll('sticky', false, false, false, true), 'sticky');
  assert.equal(scrollModeAfterScroll('sticky', true, false, false, false), 'sticky');
  assert.equal(scrollModeAfterScroll('sticky', true, true), 'follow');
  assert.equal(scrollModeAfterScroll('follow', true, true), 'follow');
});

test('first overflow refreshes scroll bounds once and preserves the reading position', () => {
  const frames = [];
  let relayouts = 0;
  const container = {
    scrollHeight: 100,
    clientHeight: 100,
    scrollTop: 0,
    style: { display: '' },
    get offsetHeight() { relayouts += 1; this.scrollTop = 0; return 100; },
  };
  const refresh = createScrollBoundsRefresher(container, callback => frames.push(callback));
  const flush = () => { while (frames.length > 0) frames.shift()(); };
  refresh();
  flush();
  assert.equal(relayouts, 0);
  container.scrollHeight = 400;
  container.scrollTop = 67;
  refresh();
  refresh();
  assert.equal(frames.length, 1);
  flush();
  assert.equal(relayouts, 1);
  assert.equal(container.scrollTop, 67);
  assert.equal(container.style.display, '');
  refresh();
  flush();
  assert.equal(relayouts, 1);
  refresh.invalidate();
  refresh();
  flush();
  assert.equal(relayouts, 2);
  container.scrollHeight = 100;
  refresh();
  flush();
  container.scrollHeight = 500;
  refresh();
  flush();
  assert.equal(relayouts, 3);
});

test('streamed Markdown keeps unchanged paragraphs and growing text nodes in place', () => {
  const stableText = new RenderNode('#text', 'Earlier answer');
  const growingText = new RenderNode('#text', 'Current');
  const stable = element('P', stableText);
  const growing = element('P', growingText);
  const body = element('DIV', stable, growing);
  const incoming = element('FRAGMENT',
    element('P', new RenderNode('#text', 'Earlier answer')),
    element('P', new RenderNode('#text', 'Current answer')),
    element('P', new RenderNode('#text', 'Next paragraph')));

  reconcileTranscriptNodes(body, incoming);

  assert.equal(body.childNodes[0], stable);
  assert.equal(body.childNodes[1], growing);
  assert.equal(growing.firstChild, growingText);
  assert.equal(growingText.data, 'Current answer');
  assert.equal(body.childNodes[2].firstChild.data, 'Next paragraph');
  assert.equal(selectionTouchesNode(body, { isCollapsed: false, anchorNode: stableText, focusNode: growingText }), true);
  assert.equal(selectionTouchesNode(body, { isCollapsed: true, anchorNode: growingText, focusNode: growingText }), false);
  assert.equal(selectionTouchesNode(body, { isCollapsed: true, anchorNode: growingText, focusNode: growingText }, true), true);
});

test('streamed Markdown replaces only a block whose structure changed', () => {
  const stable = element('P', new RenderNode('#text', 'Earlier answer'));
  const changing = element('P', new RenderNode('#text', '```'));
  const body = element('DIV', stable, changing);
  const code = element('CODE', new RenderNode('#text', 'value'));
  code.setAttribute('class', 'language-js');
  const incoming = element('FRAGMENT',
    element('P', new RenderNode('#text', 'Earlier answer')),
    element('PRE', code));

  reconcileTranscriptNodes(body, incoming);

  assert.equal(body.childNodes[0], stable);
  assert.equal(body.childNodes[1].nodeName, 'PRE');
  assert.equal(body.childNodes[1].firstChild.getAttribute('class'), 'language-js');
  assert.equal(changing.parentNode, null);
  assert.equal(selectionTouchesNode(body, null), false);
});

test('selection relocation follows streamed Markdown text without pausing updates', () => {
  const snapshot = { anchor: 12, focus: 8, start: 8, end: 12,
    selected: 'text', before: 'Earlier ', after: ' later' };
  assert.deepEqual(relocateSelectionRange(snapshot, 'Earlier text later and more'), { start: 8, end: 12 });
  assert.deepEqual(relocateSelectionRange(snapshot, 'Prefix Earlier text later'), { start: 15, end: 19 });
  assert.equal(relocateSelectionRange(snapshot, 'The passage vanished'), undefined);
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
