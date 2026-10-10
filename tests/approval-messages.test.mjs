import assert from 'node:assert/strict';
import test from 'node:test';

import { isAnswerApprovalMessage } from '../vscode/out/approvalMessages.js';

const token = '53baee11-f022-4f4b-8858-8ae267625c4c';

test('approval answers accept only one valid token and an explicit one-shot decision', () => {
  assert.equal(isAnswerApprovalMessage({ type: 'answerApproval', token, outcome: 'allowed-once' }), true);
  assert.equal(isAnswerApprovalMessage({ type: 'answerApproval', token, outcome: 'rejected' }), true);
  for (const value of [
    { type: 'answerApproval', token, outcome: 'always-allow' },
    { type: 'answerApproval', token, outcome: 'cancelled' },
    { type: 'answerApproval', token, outcome: 'allowed-once', extra: true },
    { type: 'answerApproval', token: 'stale', outcome: 'allowed-once' },
    { type: 'answerApproval', token, outcome: 'allowed-once', sessionId: 'other' },
    ['answerApproval', token, 'rejected'],
    null,
  ]) assert.equal(isAnswerApprovalMessage(value), false);
});
