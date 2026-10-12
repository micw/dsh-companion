import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  BRAVE_SEARCH_CREDENTIAL_REF, isLoadBraveCredentialMessage, isSaveBraveCredentialMessage,
} from '../vscode/out/braveCredential.js';

test('Brave credential messages admit only bounded write-only requests', () => {
  assert.equal(BRAVE_SEARCH_CREDENTIAL_REF, 'BRAVE_SEARCH_API_KEY');
  assert.equal(isLoadBraveCredentialMessage({ type: 'loadBraveCredential', requestId: 1 }), true);
  assert.equal(isSaveBraveCredentialMessage({ type: 'saveBraveCredential', requestId: 2, apiKey: 'brave-secret' }), true);
  for (const message of [
    { type: 'saveBraveCredential', requestId: 2, apiKey: '' },
    { type: 'saveBraveCredential', requestId: 2, apiKey: ' \t ' },
    { type: 'saveBraveCredential', requestId: 2, apiKey: 'secret\nnext' },
    { type: 'saveBraveCredential', requestId: 2, apiKey: 'x'.repeat(4097) },
    { type: 'saveBraveCredential', requestId: 0, apiKey: 'secret' },
    { type: 'saveBraveCredential', requestId: 2, apiKey: 'secret', ref: 'OTHER_KEY' },
  ]) assert.equal(isSaveBraveCredentialMessage(message), false);
  assert.equal(isLoadBraveCredentialMessage({ type: 'loadBraveCredential', requestId: 1, secret: true }), false);
});

test('search settings reload canonical access status without returning credentials', async () => {
  const [script, extension, client, provider] = await Promise.all([
    readFile(new URL('../vscode/media/settings-editor.js', import.meta.url), 'utf8'),
    readFile(new URL('../vscode/src/settingsEditor.ts', import.meta.url), 'utf8'),
    readFile(new URL('../vscode/src/dshClient.ts', import.meta.url), 'utf8'),
    readFile(new URL('../packages/web-search/src/index.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(script, /querySelectorAll\('input\[type="password"\]'\)\.forEach\(e => \{ e\.value = ''/);
  assert.match(extension, /parseSettingsRequest\(value\)/);
  assert.match(client, /'companionWebSearch', 'manage'/);
  assert.match(client, /'credentials', 'describe', \[ref\]/);
  assert.match(provider, /credentialRef: 'BRAVE_SEARCH_API_KEY'/);
  assert.doesNotMatch(script, /localStorage|innerHTML/);
});
