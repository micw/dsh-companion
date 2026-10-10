import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  branchTitleRevision, hasCompletedTurnAt, includesForkPreviewEvent,
  isChatEditorState, isForkAtMessage, isForkChildId, isForkDraft,
  isProvisionalForkTitle,
} from '../vscode/out/forkDraft.js';

const draft = { draftId: randomUUID(), sourceSessionId: 'session-source', atSeq: 42, sourceTitle: 'Original' };

test('fork intent accepts only a bounded source, completed-event cut, and tab identity', () => {
  assert.equal(isForkDraft(draft), true);
  assert.equal(isForkDraft({ ...draft, atSeq: -1 }), false);
  assert.equal(isForkDraft({ ...draft, atSeq: 0.5 }), false);
  assert.equal(isForkDraft({ ...draft, draftId: 'not-an-id' }), false);
  assert.equal(isForkDraft({ ...draft, sourceTitle: '' }), false);
  assert.equal(isForkDraft({ ...draft, extra: true }), false);
});

test('fork action accepts only an exact nonnegative event sequence', () => {
  assert.equal(isForkAtMessage({ type: 'forkAt', atSeq: 0 }), true);
  assert.equal(isForkAtMessage({ type: 'forkAt', atSeq: 1.5 }), false);
  assert.equal(isForkAtMessage({ type: 'forkAt', atSeq: -1 }), false);
  assert.equal(isForkAtMessage({ type: 'forkAt', atSeq: 1, sessionId: 'other' }), false);
});

test('restore distinguishes an unactivated fork from a bound child Session', () => {
  assert.equal(isChatEditorState({ version: 3, forkDraft: draft, disclosures: {} }), true);
  assert.equal(isChatEditorState({ version: 3, sessionId: 'child', disclosures: {} }), true);
  assert.equal(isChatEditorState({ version: 2, sessionId: 'older' }), true);
  assert.equal(isChatEditorState({ version: 3, sessionId: 'child', forkDraft: draft }), false);
  assert.equal(isChatEditorState({ version: 2, forkDraft: draft }), false);
  assert.equal(isChatEditorState({ version: 3, forkDraft: { ...draft, atSeq: -1 } }), false);
});

test('a fork action requires the exact durable Turn end in the visible window', () => {
  const entries = [
    { type: 'event', event: { seq: 41, type: 'assistant/message' } },
    { type: 'event', event: { seq: 42, type: 'turn/end' } },
    { type: 'transient', event: { seq: 43, type: 'turn/end' } },
  ];
  assert.equal(hasCompletedTurnAt(entries, 42), true);
  assert.equal(hasCompletedTurnAt(entries, 41), false);
  assert.equal(hasCompletedTurnAt(entries, 43), false);
});

test('preview excludes later events and transients while keeping the inclusive cut', () => {
  assert.equal(includesForkPreviewEvent({ type: 'event', event: { seq: 42 } }, 42), true);
  assert.equal(includesForkPreviewEvent({ type: 'event', event: { seq: 43 } }, 42), false);
  assert.equal(includesForkPreviewEvent({ type: 'transient', event: { seq: 42 } }, 42), false);
  assert.equal(includesForkPreviewEvent({ type: 'event', event: { seq: '42' } }, 42), false);
});

test('a provisional child title restores only with its fixed fork boundary', () => {
  assert.equal(isProvisionalForkTitle({ title: '(forked) Original', atSeq: 42 }), true);
  assert.equal(isProvisionalForkTitle({ title: 'Original', atSeq: 42 }), false);
  assert.equal(isProvisionalForkTitle({ title: '(forked) Original', atSeq: -1 }), false);
  assert.equal(isProvisionalForkTitle({ title: '(forked) Original', atSeq: 42, sourceId: 'other' }), false);
});

test('only a pinned DSH-minted child identity may resume an activated draft', () => {
  assert.equal(isForkChildId(`session-${randomUUID()}`), true);
  assert.equal(isForkChildId('source'), false);
  assert.equal(isForkChildId('session-../../other'), false);
});

test('only explicit user or Companion Agent title revisions retire a provisional title', () => {
  const event = { type: 'session/title', seq: 45, data: { title: 'Branch task',
    source: { kind: 'provider', provider: 'dsh-companion/agent-title-tool' } } };
  assert.deepEqual(branchTitleRevision(event), { seq: 45, title: 'Branch task' });
  assert.deepEqual(branchTitleRevision({ ...event, data: { ...event.data, source: { kind: 'user' } } }),
    { seq: 45, title: 'Branch task' });
  assert.equal(branchTitleRevision({ ...event, data: { ...event.data,
    source: { kind: 'provider', provider: 'first-prompt-llm' } } }), undefined);
  assert.equal(branchTitleRevision({ ...event, seq: '45' }), undefined);
  assert.equal(branchTitleRevision({ ...event, data: { ...event.data, title: '' } }), undefined);
});
