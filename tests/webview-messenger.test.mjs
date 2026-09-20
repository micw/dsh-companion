import assert from 'node:assert/strict';
import test from 'node:test';

import { WebviewMessenger } from '../vscode/out/webviewMessenger.js';

test('Webview messages wait for readiness and cross the process boundary in bounded order', async () => {
  const delivered = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const failures = [];
  const messenger = new WebviewMessenger({
    async postMessage(message) {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise(resolve => setImmediate(resolve));
      delivered.push(message);
      inFlight -= 1;
      return true;
    },
  }, error => failures.push(error));

  for (let index = 0; index < 257; index++) messenger.send({ type: 'item', index });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered.length, 0);

  messenger.markReady();
  await messenger.flush();

  assert.equal(maximumInFlight, 1);
  assert.deepEqual(failures, []);
  assert.ok(delivered.every(batch => batch.type === 'batch' && batch.messages.length <= 64));
  assert.deepEqual(
    delivered.flatMap(batch => batch.messages).map(message => message.index),
    Array.from({ length: 257 }, (_, index) => index),
  );
});

test('disposing a Webview messenger retires buffered restore output', async () => {
  const delivered = [];
  const messenger = new WebviewMessenger({
    async postMessage(message) {
      delivered.push(message);
      return true;
    },
  }, error => assert.fail(String(error)));

  messenger.send({ type: 'message', text: 'durable history' });
  messenger.dispose();
  messenger.markReady();
  await messenger.flush();

  assert.deepEqual(delivered, []);
});
