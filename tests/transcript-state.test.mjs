import assert from 'node:assert/strict';
import test from 'node:test';

await import('../vscode/media/transcript-state.js');

const {
  activityStatusText,
  advanceTurnProcessSegment,
  appendPendingAgentRows,
  approvalOperation,
  canSteerQueued,
  clearPendingAgentRows,
  createCompactionSubmitGate,
  createScrollBoundsRefresher,
  fileLinkRequest,
  mergePrependedTurnState,
  placeEmptyTurnProcessAfterMessage,
  placeUserMessageBeforeTurn,
  projectQueueDock,
  reconcileTranscriptNodes,
  removeAbandonedAssistant,
  reattachTranscriptTail,
  relocateSelectionRange,
  scrollModeAfterScroll,
  selectReasoningStatusSegment,
  selectionTouchesNode,
  sendActionForGesture,
  settleAgentMessageRow,
  splitTurnProcessAtBoundary,
  submitModeForGesture,
  submittedPromptText,
  takePendingAgentRow,
} = globalThis.dshCompanionTranscriptState;

test('approval presentation names the exact requested write path without exposing content', () => {
  const detail = JSON.stringify({
    file_path: '/home/user/Downloads/test.txt', content: 'private file body',
    sandbox_permissions: 'danger-full-access', justification: 'private explanation',
  });
  const expected = {
    action: 'Write file (write)', targetLabel: 'Requested path',
    target: '/home/user/Downloads/test.txt', access: 'Full access for this call',
  };
  assert.deepEqual(approvalOperation('write', detail), expected);
  assert.deepEqual(approvalOperation('write', detail), expected);
  assert.doesNotMatch(JSON.stringify(expected), /private file body|private explanation/u);
});

test('approval presentation shows a shell command literally without claiming inferred file effects', () => {
  const command = 'rm -- /home/user/Downloads/test.txt';
  assert.deepEqual(approvalOperation('bash', JSON.stringify({ command,
    sandbox_permissions: 'danger-full-access' })), {
    action: 'Run Bash command (bash)', targetLabel: 'Command', target: command,
    access: 'Full access for this call',
  });
  assert.deepEqual(approvalOperation('pwsh', JSON.stringify({ command: 'Remove-Item test.txt' })), {
    action: 'Run PowerShell command (pwsh)', targetLabel: 'Command', target: 'Remove-Item test.txt',
  });
});

test('malformed or unrelated Tool arguments cannot invent an approval target', () => {
  assert.deepEqual(approvalOperation('write', '{bad json'), { action: 'Write file (write)' });
  assert.deepEqual(approvalOperation('write', JSON.stringify({ content: 'secret' })), { action: 'Write file (write)' });
  assert.deepEqual(approvalOperation('bash', JSON.stringify({ command: 17 })), { action: 'Run Bash command (bash)' });
  assert.deepEqual(approvalOperation('unknown-tool', JSON.stringify({ file_path: '/secret' })), { action: 'unknown-tool' });
  assert.deepEqual(approvalOperation('__proto__', JSON.stringify({ sandbox_permissions: '__proto__' })),
    { action: '__proto__' });
});

test('committed subagent messages reuse the pending Turn row and suppress stale Inbox echoes', () => {
  const row = { root: { id: 'same-dom-row' } };
  const pending = new Map([['message-1', { row, turnNumber: 3 }]]);
  const committed = new Set();
  assert.equal(takePendingAgentRow(pending, committed, 'message-1'), row);
  assert.equal(pending.size, 0);
  assert.equal(committed.has('message-1'), true);
  assert.equal(takePendingAgentRow(pending, committed, 'message-1'), undefined);
  assert.equal(takePendingAgentRow(pending, committed, undefined), undefined);
  assert.equal(committed.size, 1);
});

test('file-link clicks and context actions preserve a line range without treating it as a path', () => {
  const dataset = {
    filePath: 'target/linux/ramips/mt76x8/base-files/etc/board.d/01_leds',
    fileLine: '117', fileEndLine: '122',
  };
  assert.deepEqual(fileLinkRequest(dataset), {
    type: 'openFile', path: dataset.filePath, action: 'open', line: 117, endLine: 122,
  });
  assert.deepEqual(fileLinkRequest(dataset, 'openBeside'), {
    type: 'openFile', path: dataset.filePath, action: 'openBeside', line: 117, endLine: 122,
  });
  assert.deepEqual(fileLinkRequest(dataset, 'copyPath'), {
    type: 'openFile', path: dataset.filePath, action: 'copyPath', line: 117, endLine: 122,
  });
  assert.equal(fileLinkRequest({ ...dataset, fileEndLine: '116' }), undefined);
  assert.equal(fileLinkRequest(dataset, 'executeCommand'), undefined);
});

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

function agentDisclosure(name, title, detail) {
  const root = new FakeNode(name);
  const heading = { textContent: title };
  root.querySelector = selector => selector === '.row-title' ? heading : null;
  root.open = false;
  return { root, heading, summary: { textContent: 'Waiting for next Step' }, detail: { textContent: detail } };
}

test('subagent steering stays in one collapsed Turn disclosure until its committed Step moves the same node', () => {
  const transcript = new FakeNode('transcript');
  const waitingTurn = turn('waiting', [], { number: 7 });
  const committedStep = turn('committed-step', [], { number: 7 });
  transcript.append(waitingTurn.root, committedStep.root);
  const rows = new Map();
  const committed = new Set();
  const inbox = [{ id: 'relay-1', sourceKind: 'agent-message', placement: 'steering', text: 'Long report' }];
  const created = [];
  const makeRow = item => {
    const row = agentDisclosure(item.id, 'Subagent message', item.text);
    created.push(row);
    return row;
  };
  assert.equal(appendPendingAgentRows(waitingTurn, 7, inbox, rows, committed, () => {}, makeRow), true);
  assert.equal(appendPendingAgentRows(waitingTurn, 7, inbox, rows, committed, () => {}, makeRow), false);
  assert.equal(created.length, 1);
  const row = created[0];
  assert.equal(row.root.parentNode, waitingTurn.rows);
  assert.equal(row.root.open, false);
  assert.equal(row.root.dataset.state, 'pending');
  assert.equal(row.summary.textContent, 'Waiting for next Step');
  row.root.open = true;

  // The Inbox can clear before the committed event arrives; it must not retire this disclosure.
  assert.deepEqual(projectQueueDock([], [], new Set(), new Set()).items, []);
  assert.equal(row.root.parentNode, waitingTurn.rows);
  const settled = settleAgentMessageRow(rows, committed, 'relay-1', committedStep.rows,
    'Subagent message', 'Committed report', () => assert.fail('a second row would duplicate the message'));
  assert.equal(settled, row);
  assert.equal(row.root.parentNode, committedStep.rows);
  assert.equal(waitingTurn.rows.childNodes.length, 0);
  assert.deepEqual(committedStep.rows.childNodes, [row.root]);
  assert.equal(row.root.open, true);
  assert.equal(row.root.dataset.state, undefined);
  assert.equal(row.heading.textContent, 'Subagent message');
  assert.equal(row.summary.textContent, 'Delivered');
  assert.equal(row.detail.textContent, 'Committed report');
  assert.equal(rows.size, 0);
  assert.equal(committed.has('relay-1'), true);
  assert.equal(appendPendingAgentRows(committedStep, 7, inbox, rows, committed, () => {}, makeRow), false);
  assert.equal(created.length, 1);
});

test('restored and stale subagent messages do not duplicate committed rows', () => {
  const restored = turn('restored', [], { number: 8 });
  const rows = new Map();
  const committed = new Set();
  const row = settleAgentMessageRow(rows, committed, 'settled-1', restored.rows,
    'Subagent finished', 'Finished report', () => agentDisclosure('settled-1', 'Subagent finished', 'Finished report'));
  assert.deepEqual(restored.rows.childNodes, [row.root]);
  assert.equal(row.root.open, false);
  assert.equal(appendPendingAgentRows(restored, 8,
    [{ id: 'settled-1', sourceKind: 'subagent-settled', placement: 'steering', text: 'Finished report' }],
    rows, committed, () => {}, () => assert.fail('committed message reappeared')), false);
  assert.deepEqual(restored.rows.childNodes, [row.root]);
  clearPendingAgentRows(rows);
  assert.deepEqual(restored.rows.childNodes, [row.root]);
});

test('only uncommitted non-user next-Step messages become provisional rows and ended Turns clear them', () => {
  const current = turn('current', [], { number: 10 });
  const later = turn('later', [], { number: 11 });
  const rows = new Map();
  const committed = new Set();
  const inbox = [
    { id: 'human', sourceKind: 'user', placement: 'steering', text: 'User steer' },
    { id: 'unknown', sourceKind: 'other', placement: 'steering', text: 'Other context' },
    { id: 'queued-agent', sourceKind: 'agent-message', placement: 'queued', text: 'Later' },
    { id: 'relay-1', sourceKind: 'agent-message', placement: 'steering', text: 'First' },
    { id: 'relay-2', sourceKind: 'subagent-settled', placement: 'steering', text: 'Second' },
  ];
  let activations = 0;
  const create = item => agentDisclosure(item.id, item.sourceKind, item.text);
  assert.equal(appendPendingAgentRows(current, 10, inbox, rows, committed,
    () => { activations += 1; }, create), true);
  assert.equal(activations, 3);
  assert.deepEqual(current.rows.childNodes.map(node => node.name), ['unknown', 'relay-1', 'relay-2']);
  assert.equal(appendPendingAgentRows(later, 11,
    [{ id: 'relay-3', sourceKind: 'agent-message', placement: 'steering', text: 'Later turn' }],
    rows, committed, () => {}, create), true);
  clearPendingAgentRows(rows, 10);
  assert.deepEqual(current.rows.childNodes, []);
  assert.deepEqual(later.rows.childNodes.map(node => node.name), ['relay-3']);
  assert.deepEqual([...rows.keys()], ['relay-3']);
  later.completed = true;
  assert.equal(appendPendingAgentRows(later, 11,
    [{ id: 'relay-4', sourceKind: 'agent-message', placement: 'steering', text: 'Too late' }],
    rows, committed, () => {}, create), false);
  clearPendingAgentRows(rows);
  assert.equal(later.rows.childNodes.length, 0);
});

test('a background-job notice keeps its disclosure and DSH summary from pending through committed Step', () => {
  const pendingTurn = turn('pending-job', [], { number: 12 });
  const committedStep = turn('committed-job', [], { number: 12 });
  const rows = new Map();
  const committed = new Set();
  const item = { id: 'job-1', sourceKind: 'other', contextLabel: 'Background job',
    placement: 'steering', text: 'Full completion notice' };
  const dock = projectQueueDock([item], [], committed, new Set());
  assert.equal(dock.items[0].state, 'Background job · Next step');
  assert.equal(appendPendingAgentRows(pendingTurn, 12, [item], rows, committed, () => {},
    value => agentDisclosure(value.id, value.contextLabel, value.text)), true);
  const row = rows.get('job-1').row;
  assert.equal(row.heading.textContent, 'Background job');
  assert.equal(row.summary.textContent, 'Waiting for next Step');
  row.root.open = true;
  const delivered = settleAgentMessageRow(rows, committed, 'job-1', committedStep.rows,
    'Background job', 'Full completion notice', () => assert.fail('duplicate row'), 'bash-828 finished');
  assert.equal(delivered, row);
  assert.equal(row.root.open, true);
  assert.equal(row.summary.textContent, 'bash-828 finished');
  assert.equal(row.root.parentNode, committedStep.rows);
  assert.equal(appendPendingAgentRows(committedStep, 12, [item], rows, committed,
    () => {}, () => assert.fail('stale Inbox row')), false);
  const restored = turn('restored-job', [], { number: 12 });
  const restoredRow = settleAgentMessageRow(new Map(), new Set(), 'job-1', restored.rows,
    'Background job', 'Full completion notice',
    () => agentDisclosure('job-1', 'Background job', 'Full completion notice'), 'bash-828 finished');
  assert.equal(restoredRow.root.open, false);
  assert.equal(restoredRow.root.parentNode, restored.rows);
});

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
  assert.equal(splitTurnProcessAtBoundary(older, compaction), true);

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

    assert.equal(splitTurnProcessAtBoundary(value, compaction), true, `replay=${replay}`);
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
  assert.equal(splitTurnProcessAtBoundary(value, compaction), false);
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

test('a steered prompt stays after earlier output in its committed Turn step', () => {
  const transcript = new FakeNode('transcript');
  const firstPrompt = new FakeNode('first-prompt');
  const process = new FakeNode('process');
  const answer = new FakeNode('answer');
  const steering = new FakeNode('steering');
  transcript.append(firstPrompt, process, answer);
  assert.equal(placeUserMessageBeforeTurn({ root: process, firstAssistantMessage: answer }, steering, 2), false);
  transcript.append(steering);
  assert.deepEqual(transcript.childNodes.map(node => node.name), [
    'first-prompt', 'process', 'answer', 'steering',
  ]);
});

test('three steering messages split one Turn process in live and restored Step order', () => {
  for (const replay of [false, true]) {
    const transcript = new FakeNode('transcript');
    const value = turn('before-steering', [new FakeNode('tool-before')], { number: 13 });
    transcript.append(value.root);
    for (const step of [5, 6, 8]) {
      const steering = new FakeNode(`steer-${step}`);
      transcript.append(steering);
      assert.equal(placeUserMessageBeforeTurn(value, steering, step), false, `replay=${replay}`);
      assert.equal(splitTurnProcessAtBoundary(value, steering), true, `replay=${replay}`);
      assert.equal(advanceTurnProcessSegment(value, () => {
        const next = turn(`after-${step}`, [], { number: 13 });
        transcript.append(next.root);
        return next.segments[0];
      }), true, `replay=${replay}`);
      value.rows.append(new FakeNode(`tool-after-${step}`));
    }
    assert.deepEqual(transcript.childNodes.map(node => node.name), [
      'before-steering-root', 'steer-5', 'after-5-root', 'steer-6',
      'after-6-root', 'steer-8', 'after-8-root',
    ], `replay=${replay}`);
    assert.deepEqual(value.segments.map(segment => segment.rows.childNodes.map(node => node.name)), [
      ['tool-before'], ['tool-after-5'], ['tool-after-6'], ['tool-after-8'],
    ], `replay=${replay}`);
  }
});

test('batched steering messages share one process boundary', () => {
  const transcript = new FakeNode('transcript');
  const value = turn('before', [new FakeNode('tool')]);
  const first = new FakeNode('first-steer');
  const second = new FakeNode('second-steer');
  transcript.append(value.root, first, second);
  assert.equal(splitTurnProcessAtBoundary(value, first), true);
  assert.equal(splitTurnProcessAtBoundary(value, second), true);
  assert.equal(advanceTurnProcessSegment(value, () => {
    const next = turn('after', []);
    transcript.append(next.root);
    return next.segments[0];
  }), true);
  assert.deepEqual(transcript.childNodes.map(node => node.name), [
    'before-root', 'first-steer', 'second-steer', 'after-root',
  ]);
  assert.equal(value.segments.length, 2);
});

test('a steering message moves an empty process disclosure below itself', () => {
  const transcript = new FakeNode('transcript');
  const value = turn('empty', []);
  const steering = new FakeNode('steering');
  transcript.append(value.root, steering);
  assert.equal(splitTurnProcessAtBoundary(value, steering), true);
  assert.deepEqual(transcript.childNodes.map(node => node.name), ['steering', 'empty-root']);
  assert.equal(value.pendingProcessSegment, undefined);
});

test('queue dock preserves DSH order through live acceptance, removal, and restore', () => {
  const host = [
    { id: 'S', requestId: 'steer', sourceKind: 'user', text: 'soon', placement: 'steering' },
    { id: 'A', requestId: 'first', sourceKind: 'user', text: 'first', placement: 'queued' },
    { id: 'B', requestId: 'second', sourceKind: 'user', text: 'second', placement: 'queued' },
  ];
  const pending = [
    { requestId: 'first', text: 'first', mode: 'queue' },
    { requestId: 'third', text: 'third', mode: 'steer' },
  ];
  const committed = new Set();
  const removed = new Set();
  const live = projectQueueDock(host, pending, committed, removed);
  assert.deepEqual(live.items.map(item => [item.id ?? item.requestId, item.state]), [
    ['S', 'Steering'], ['A', 'Queued'], ['B', 'Queued'], ['third', 'Submitting steering'],
  ]);
  assert.equal(live.lastQueuedId, 'B');
  committed.add('first');
  removed.add('B');
  assert.deepEqual(projectQueueDock(host, pending, committed, removed).items.map(item => item.id ?? item.requestId), [
    'S', 'third',
  ]);
  const restored = projectQueueDock([host[0]], [], new Set(), new Set());
  assert.deepEqual(restored.items.map(item => item.id), ['S']);
  assert.equal(restored.lastQueuedId, undefined);
  assert.equal(projectQueueDock([...host, { id: 'agent', sourceKind: 'agent-message', placement: 'queued' }],
    [], new Set(), new Set()).lastQueuedId, 'B');
  assert.equal(projectQueueDock([{ id: 'context', sourceKind: 'other', placement: 'steering' }],
    [], new Set(), new Set()).items[0].state, 'Context update · Next step');
});

test('queued image references replace the local preview and survive queue restore', () => {
  const pending = [{ requestId: 'image', text: '', mode: 'queue', images: [{ previewUrl: 'blob:preview' }] }];
  const image = { attachmentId: 'image-1', mediaType: 'image/png', bytes: 3, width: 2, height: 1 };
  const admitted = [{ id: 'queued-image', requestId: 'image', text: '', images: [image], placement: 'queued' }];
  const local = projectQueueDock([], pending, new Set(), new Set());
  assert.equal(local.items[0].images[0].previewUrl, 'blob:preview');
  const live = projectQueueDock(admitted, pending, new Set(), new Set());
  assert.equal(live.items.length, 1);
  assert.deepEqual(live.items[0].images, [image]);
  const restored = projectQueueDock(admitted, [], new Set(), new Set());
  assert.deepEqual(restored.items[0].images, [image]);
});

test('only DSH next-Turn rows can steer during a running Turn, including after restore', () => {
  const queued = { id: 'Q', placement: 'queued' };
  const steering = { id: 'S', placement: 'steering' };
  assert.equal(canSteerQueued(queued, true), true);
  assert.equal(canSteerQueued(queued, false), false);
  assert.equal(canSteerQueued(steering, true), false);
  assert.equal(canSteerQueued({ id: 'C', placement: 'context' }, true), false);
  assert.equal(canSteerQueued({ requestId: 'pending' }, true), false);
  const restored = projectQueueDock([steering, queued], [], new Set(), new Set());
  assert.deepEqual(restored.items.map(item => canSteerQueued(item, true)), [false, true]);
});

test('Ctrl+Enter steers only during a running Turn', () => {
  assert.equal(submitModeForGesture(true, true), 'steer');
  assert.equal(submitModeForGesture(true, false), 'queue');
  assert.equal(submitModeForGesture(false, true), 'queue');
  assert.equal(submitModeForGesture(false, false), 'queue');
});

test('leading ! keeps the draft in steering mode after a Turn ends without entering DSH text', () => {
  for (const running of [true, false]) {
    assert.equal(submitModeForGesture(running, false, '! inspect this'), 'steer');
    assert.equal(submitModeForGesture(running, true, '! inspect this'), 'steer');
    assert.equal(submittedPromptText('! inspect this'), 'inspect this');
    assert.equal(submittedPromptText('!\ninspect this'), 'inspect this');
  }
  assert.equal(submittedPromptText('!'), '');
  assert.equal(submittedPromptText('!   '), '');
  assert.equal(submittedPromptText('!!literal'), '!literal');
  assert.equal(submittedPromptText('normal ! text'), 'normal ! text');
  assert.equal(submitModeForGesture(true, false, 'normal ! text'), 'queue');
  assert.equal(submitModeForGesture(false, false, 'normal ! text'), 'queue');
  assert.equal(submitModeForGesture(true, false, ' ! not at the start'), 'queue');
});

test('send action shows Send, Queue, and Steer for the active modifier state', () => {
  assert.deepEqual(sendActionForGesture(false, false), {
    mode: 'send', label: 'Send', title: 'Send message (Enter or click)',
  });
  assert.deepEqual(sendActionForGesture(false, true), sendActionForGesture(false, false));
  assert.deepEqual(sendActionForGesture(true, false), {
    mode: 'queue', label: 'Queue', title: 'Queue for the next Turn (Enter or click)',
  });
  assert.deepEqual(sendActionForGesture(true, true), {
    mode: 'steer', label: 'Steer', title: 'Steer into the current Turn (Ctrl+Enter or Ctrl+click)',
  });
  assert.deepEqual(sendActionForGesture(true, false, '! inspect this'), {
    mode: 'steer', label: 'Steer', title: 'Steer into the current Turn; leading ! is not sent',
  });
  assert.deepEqual(sendActionForGesture(false, false, '! inspect this'), {
    mode: 'steer', label: 'Steer', title: 'Send immediately in a new Turn; leading ! is not sent',
  });
  assert.deepEqual(sendActionForGesture(false, false, 'inspect this'), sendActionForGesture(false, false));
});

test('a live compaction start releases only the local request gate', () => {
  const gate = createCompactionSubmitGate();
  assert.equal(gate.locked, false);
  gate.request();
  assert.equal(gate.locked, true);
  assert.equal(gate.observe({ type: 'start', id: 'older', time: 1 }), false);
  assert.equal(gate.observe({ type: 'summary', id: 'current' }), false);
  assert.equal(gate.locked, true);
  assert.equal(gate.observe({ type: 'start', id: 'current', time: 2, live: true }), true);
  assert.equal(gate.locked, false);
  assert.equal(gate.settle(), false);

  gate.request();
  assert.equal(gate.settle(), true);
  assert.equal(gate.locked, false);
  assert.equal(gate.observe({ type: 'start', id: 'late', time: 3, live: true }), false);
  assert.equal(createCompactionSubmitGate().locked, false);
});

test('manual compaction queues instead of steering, including Ctrl and leading bang', () => {
  assert.equal(submitModeForGesture(false, false, 'later', true), 'queue');
  assert.equal(submitModeForGesture(false, true, '! later', true), 'queue');
  assert.deepEqual(sendActionForGesture(false, true, '! later', true), {
    mode: 'queue', label: 'Queue', title: 'Queue after compaction; leading ! is not sent',
  });
  assert.deepEqual(sendActionForGesture(false, false, 'later', true), {
    mode: 'queue', label: 'Queue', title: 'Queue after compaction (Enter or click)',
  });
  assert.equal(submitModeForGesture(true, true, 'later', true), 'steer');
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
