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

test('the extension contributes the Session sidebar, chat, Web UI, and managed-runtime commands', () => {
  assert.deepEqual(manifest.contributes.commands, [
    {
      command: 'dshCompanion.newChatEditor',
      title: 'DSH: New Chat Editor',
      icon: '$(add)',
    },
    {
      command: 'dshCompanion.openSession',
      title: 'DSH: Open Session',
    },
    {
      command: 'dshCompanion.refreshSessions',
      title: 'DSH: Refresh Sessions',
      icon: '$(refresh)',
    },
    {
      command: 'dshCompanion.searchSessions',
      title: 'DSH: Search Sessions',
      icon: '$(search)',
    },
    {
      command: 'dshCompanion.openProviderSettings',
      title: 'DSH: Settings',
      icon: '$(settings-gear)',
    },
    {
      command: 'dshCompanion.openDevelopmentWebUi',
      title: 'DSH: Open Web UI',
    },
    {
      command: 'dshCompanion.stopManagedRuntime',
      title: 'DSH: Stop Managed Runtime',
    },
    { command: 'dshCompanion.openWebviewLink', title: 'Open Link' },
    { command: 'dshCompanion.openWebviewLinkBeside', title: 'Open File to the Side' },
    { command: 'dshCompanion.copyWebviewLink', title: 'Copy Link' },
    { command: 'dshCompanion.copyWebviewAbsolutePath', title: 'Copy Absolute Path' },
  ]);
  assert.deepEqual(manifest.activationEvents, [
    'onStartupFinished',
    'onCommand:dshCompanion.newChatEditor',
    'onCommand:dshCompanion.openDevelopmentWebUi',
    'onCommand:dshCompanion.openProviderSettings',
    'onCommand:dshCompanion.searchSessions',
    'onCommand:dshCompanion.stopManagedRuntime',
    'onView:dshCompanion.sessions',
    'onWebviewPanel:dshCompanion.chatEditor',
  ]);
  assert.deepEqual(manifest.contributes.views.dshCompanion, [{
    id: 'dshCompanion.sessions', name: 'Sessions', type: 'webview',
  }]);
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].id, 'dshCompanion');
  assert.equal(manifest.contributes.viewsWelcome, undefined);
  const linkMenu = manifest.contributes.menus['webview/context'];
  assert.deepEqual(linkMenu.map(item => item.command), [
    'dshCompanion.openWebviewLink', 'dshCompanion.openWebviewLinkBeside',
    'dshCompanion.copyWebviewLink', 'dshCompanion.copyWebviewAbsolutePath',
  ]);
  assert.ok(linkMenu.every(item => item.when.includes("webviewId == 'dshCompanion.chatEditor'")
    && item.when.includes("webviewSection == 'dshCompanionLink'")));
});
