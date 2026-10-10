import assert from 'node:assert/strict';
import test from 'node:test';

import { isCopyTextMessage } from '../vscode/out/clipboardMessages.js';

test('text-copy ingress admits only bounded plain and HTML requests', () => {
  assert.equal(isCopyTextMessage({ type: 'copyText', format: 'plain', text: 'code' }), true);
  assert.equal(isCopyTextMessage({ type: 'copyText', format: 'html', text: '# Heading' }), true);
  assert.equal(isCopyTextMessage({ type: 'copyText', format: 'command', text: 'x' }), false);
  assert.equal(isCopyTextMessage({ type: 'copyText', format: 'plain', text: 7 }), false);
  assert.equal(isCopyTextMessage({ type: 'copyText', format: 'plain', text: 'x', command: 'run' }), false);
  assert.equal(isCopyTextMessage({ type: 'copyText', format: 'plain', text: '€'.repeat(1_400_000) }), false);
});
