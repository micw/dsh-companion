import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

await import('../vscode/media/transcript-state.js');
const source = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
const approvalSource = source.slice(source.indexOf('function appendToolCall(turn, event) {'),
  source.indexOf('function appendContext(turn, event) {'));

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.open = false;
    this.parent = undefined;
    this.listeners = new Map();
  }

  append(...children) {
    for (const child of children) {
      child.remove();
      this.children.push(child);
      child.parent = this;
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parent = undefined;
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (this.parent === undefined) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.')
      ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector;
    return this.children.flatMap(child => [
      ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
}

function fixture() {
  const tools = new Map();
  const approvalRows = new Map();
  const approvalAsked = new Map();
  const approvalPending = new Map();
  const rows = new Element('div');
  const toolCallIds = new Set();
  const turn = { rows, toolCallIds, toolCount: 0, segments: [{ toolCallIds, toolCount: 0 }] };
  const messages = [];
  const context = {
    document: { createElement: tag => new Element(tag) },
    tools, approvalRows, approvalAsked, approvalPending,
    approvalOperation: globalThis.dshCompanionTranscriptState.approvalOperation,
    ensureTurn: () => turn,
    activeProcessSegment: () => turn,
    updateTurnProcessLabel: () => {},
    followOutput: () => {},
    titleCase: name => name[0].toUpperCase() + name.slice(1),
    vscode: { postMessage: message => messages.push(message) },
    disclosureRow: (_kind, id, title, summaryText, detailText) => {
      const root = new Element('details');
      root.dataset.disclosureId = id;
      const summary = new Element('summary');
      const titleNode = new Element('span');
      titleNode.className = 'row-title';
      titleNode.textContent = title;
      const summaryNode = new Element('span');
      summaryNode.className = 'row-summary';
      summaryNode.textContent = summaryText;
      summary.append(titleNode, summaryNode);
      const detail = new Element('pre');
      detail.textContent = detailText;
      root.append(summary, detail);
      return { root, summary: summaryNode, detail };
    },
  };
  vm.runInNewContext(approvalSource, context);
  return { context, turn, tools, approvalRows, messages };
}

function fields(row) {
  return row.approvalSubject.children.map(item => [item.children[0].textContent, item.children[1].textContent]);
}

const callId = 'call-write-file';
const token = '53baee11-f022-4f4b-8858-8ae267625c4c';
const toolCall = {
  turn: 3, callId, name: 'write', summary: 'test.txt',
  detail: JSON.stringify({ file_path: '/home/user/Downloads/test.txt', content: 'private body',
    sandbox_permissions: 'danger-full-access' }),
};
const asked = { turn: 3, id: 'approval-1', toolName: 'write', callId };
const decided = { turn: 3, id: 'approval-1', outcome: 'allowed-once' };

test('live approval keeps action and path beside the one-shot result after the buttons close', () => {
  const view = fixture();
  view.context.appendToolCall(view.turn, toolCall);
  view.context.appendApprovalAsked(asked);
  view.context.updateApprovalPending({ ...asked, token, state: 'answerable', reason: 'Approve this write?' });
  const row = view.tools.get(callId);
  assert.deepEqual(fields(row), [
    ['Action', 'Write file (write)'],
    ['Requested path', '/home/user/Downloads/test.txt'],
    ['Access', 'Full access for this call'],
  ]);
  const buttons = row.approvalPanel.querySelectorAll('button');
  assert.equal(buttons.length, 2);
  assert.doesNotMatch(JSON.stringify(fields(row)), /private body/u);
  buttons[0].listeners.get('click')();
  assert.equal(buttons.every(button => button.disabled), true);
  assert.equal(view.messages.length, 1);
  assert.equal(view.messages[0].type, 'answerApproval');
  assert.equal(view.messages[0].outcome, 'allowed-once');
  assert.equal(view.messages[0].token, token);
  view.context.appendApprovalDecided(decided);
  view.context.updateApprovalPending({ ...asked, token, state: 'closed' });
  assert.equal(row.approvalBadge.textContent, 'Allowed once');
  assert.equal(row.approvalPanel.querySelectorAll('button').length, 0);
  assert.equal(row.approvalPanel.parent, row.root);
});

test('restore reconstructs the same action and path without answer buttons', () => {
  const view = fixture();
  view.context.appendToolCall(view.turn, toolCall);
  view.context.appendApprovalAsked(asked);
  view.context.appendApprovalDecided(decided);
  const row = view.tools.get(callId);
  assert.deepEqual(fields(row), [
    ['Action', 'Write file (write)'],
    ['Requested path', '/home/user/Downloads/test.txt'],
    ['Access', 'Full access for this call'],
  ]);
  assert.equal(row.approvalBadge.textContent, 'Allowed once');
  assert.equal(row.approvalPanel.querySelectorAll('button').length, 0);
});

test('a delayed Tool call fills an already visible approval row without duplication', () => {
  const view = fixture();
  view.context.appendApprovalAsked(asked);
  const row = view.approvalRows.get(`call:${callId}`);
  assert.deepEqual(fields(row), [['Action', 'Write file (write)']]);
  view.context.appendToolCall(view.turn, toolCall);
  assert.equal(view.turn.rows.children.length, 1);
  assert.equal(view.tools.get(callId), row);
  assert.deepEqual(fields(row)[1], ['Requested path', '/home/user/Downloads/test.txt']);
});

test('a shell approval shows the literal command rather than inferring a target path', () => {
  const view = fixture();
  view.context.appendToolCall(view.turn, {
    turn: 4, callId: 'call-bash', name: 'bash', summary: 'remove test file',
    detail: JSON.stringify({ command: 'rm -- /home/user/Downloads/test.txt',
      sandbox_permissions: 'danger-full-access' }),
  });
  view.context.appendApprovalAsked({ turn: 4, id: 'approval-bash', toolName: 'bash', callId: 'call-bash' });
  assert.deepEqual(fields(view.tools.get('call-bash')), [
    ['Action', 'Run Bash command (bash)'],
    ['Command', 'rm -- /home/user/Downloads/test.txt'],
    ['Access', 'Full access for this call'],
  ]);
});
