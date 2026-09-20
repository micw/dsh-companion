import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const manifest = JSON.parse(
  await readFile(new URL('../vscode/package.json', import.meta.url), 'utf8'),
);
const workspaceManifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

test('source manifests keep the neutral internal version', () => {
  assert.equal(workspaceManifest.version, '0.0.0');
  assert.equal(manifest.version, '0.0.0');
});

test('the extension contributes chat creation and managed-runtime stop commands', () => {
  assert.deepEqual(manifest.contributes.commands, [
    {
      command: 'dshCompanion.newChatEditor',
      title: 'DSH: New Chat Editor',
    },
    {
      command: 'dshCompanion.stopManagedRuntime',
      title: 'DSH: Stop Managed Runtime',
    },
  ]);
  assert.deepEqual(manifest.activationEvents, [
    'onCommand:dshCompanion.newChatEditor',
    'onCommand:dshCompanion.stopManagedRuntime',
    'onWebviewPanel:dshCompanion.chatEditor',
  ]);
});
