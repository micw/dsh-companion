import assert from 'node:assert/strict';
import test from 'node:test';

import { isLoadImageMessage, isQueueActionMessage, isStopMessage, isSubmitMessage } from '../vscode/out/queueMessages.js';

test('Webview prompt admission accepts only explicit DSH queue or steering modes', () => {
  const base = { type: 'submit', requestId: 'request-1', text: 'Do this' };
  assert.equal(isSubmitMessage({ ...base, mode: 'queue' }), true);
  assert.equal(isSubmitMessage({ ...base, mode: 'steer' }), true);
  const image = { mediaType: 'image/png', data: 'AQID', name: 'capture.png' };
  assert.equal(isSubmitMessage({ ...base, text: '', mode: 'queue', images: [image] }), true);
  assert.equal(isSubmitMessage({ ...base, mode: 'steer', images: [image] }), true);
  for (const value of [
    { ...base, mode: 'now' },
    { ...base, mode: 'queue', text: '   ' },
    { ...base, mode: 'queue', requestId: '' },
    { ...base, mode: 'queue', command: 'workbench.action.files.openFile' },
    { ...base, mode: 'queue', images: [{ ...image, mediaType: 'image/svg+xml' }] },
    { ...base, mode: 'queue', images: [{ ...image, data: 'invalid' }] },
    { ...base, mode: 'queue', images: [{ ...image, data: 'A'.repeat(28 * 1024 * 1024) }] },
    { ...base, mode: 'queue', images: Array(21).fill(image) },
    { ...base, mode: 'queue', images: [{ ...image, command: 'workbench.action.files.openFile' }] },
    [base],
  ]) assert.equal(isSubmitMessage(value), false);
});

test('image admission accepts the exact source byte cap and rejects one byte more', () => {
  const base = { type: 'submit', requestId: 'request-1', text: '', mode: 'queue' };
  const atLimit = { mediaType: 'image/png', data: Buffer.alloc(20 * 1024 * 1024).toString('base64') };
  assert.equal(isSubmitMessage({ ...base, images: [atLimit] }), true);
  assert.equal(isSubmitMessage({ ...base, images: Array(10).fill(atLimit) }), true);
  assert.equal(isSubmitMessage({ ...base, images: Array(11).fill(atLimit) }), false);
  const overLimit = { ...atLimit, data: Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64') };
  assert.equal(isSubmitMessage({ ...base, images: [overLimit] }), false);
});

test('image reads accept only a bounded attachment identity', () => {
  assert.equal(isLoadImageMessage({ type: 'loadImage', attachmentId: 'sha256:image' }), true);
  assert.equal(isLoadImageMessage({ type: 'loadImage', attachmentId: '' }), false);
  assert.equal(isLoadImageMessage({ type: 'loadImage', attachmentId: 'x'.repeat(257) }), false);
  assert.equal(isLoadImageMessage({ type: 'loadImage', attachmentId: 'image', path: '/tmp/a' }), false);
});

test('queue mutations accept only a bounded DSH occurrence identity and known action', () => {
  const valid = { type: 'queueAction', itemId: 'message-1', action: 'remove' };
  assert.equal(isQueueActionMessage(valid), true);
  assert.equal(isQueueActionMessage({ ...valid, action: 'takeBack' }), true);
  assert.equal(isQueueActionMessage({ ...valid, action: 'steer' }), true);
  for (const value of [
    { ...valid, itemId: '' },
    { ...valid, itemId: 'x'.repeat(257) },
    { ...valid, action: 'executeCommand' },
    { ...valid, action: 'steer', mode: 'queue' },
    { ...valid, text: 'private' },
    null,
  ]) assert.equal(isQueueActionMessage(value), false);
});

test('Stop rejects payload-bearing Webview messages', () => {
  assert.equal(isStopMessage({ type: 'stop' }), true);
  assert.equal(isStopMessage({ type: 'stop', clearQueue: false }), false);
});
