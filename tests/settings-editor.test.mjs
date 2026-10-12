import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import { sampleModels, sampleSearch } from './settings-fixture.mjs';
const source = await readFile(new URL('../vscode/out/settingsEditor.js', import.meta.url), 'utf8');
const require = createRequire(new URL('../vscode/out/settingsEditor.js', import.meta.url));

function fixture(connectOverride) {
  let provider; let panel; let document; let changed = 0; let disposed = 0; let stop = 0; let connectionListener;
  const commands = []; const connected = []; const posts = []; const disposers = [];
  class EventEmitter { event = () => ({ dispose() {} }); fire() { changed++; } dispose() {} }
  const uri = path => ({ path, toString: () => path });
  const client = {
    dispose: async () => { disposed++; },
    watchConnection: listener => { connectionListener = listener; listener('connected'); return () => { stop++; }; },
    providerSettings: async () => sampleModels, searchSettings: async () => sampleSearch,
    updateProviderSettings: async () => sampleModels, testProviderConnection: async () => ({ snapshot: sampleModels }),
  };
  const vscode = { EventEmitter, env: {}, Uri: { parse: uri, joinPath: (root, ...parts) => uri([root.path, ...parts].join('/')) },
    workspace: { getConfiguration: () => ({ get: () => 'off' }) },
    window: { registerCustomEditorProvider: (_name, value) => { provider = value; return { dispose() {} }; }, showWarningMessage: async () => 'Discard' },
    commands: { executeCommand: async (command, ...args) => {
      commands.push(command);
      if (command === 'vscode.openWith') {
        assert.equal(args[1], 'dshCompanion.settingsEditor'); assert.deepEqual(JSON.parse(JSON.stringify(args[2])), { preview: false });
        document = await provider.openCustomDocument(args[0]);
        panel = { active: true, reveal() { commands.push('reveal'); }, onDidDispose: f => disposers.push(f), webview: {
          asWebviewUri: value => value, postMessage: value => posts.push(value), onDidReceiveMessage: listener => { panel.receive = listener; },
        } };
        await provider.resolveCustomEditor(document, panel);
      }
      if (command === 'workbench.action.files.save') await provider.saveCustomDocument(document);
    } },
  };
  const context = { subscriptions: [], extensionUri: uri('extension'), secrets: { get: async () => 'cookie' } };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => {
    if (name === 'vscode') return vscode;
    if (name === './runtimeInstaller') return { connectRuntime: async () => { throw Error('Unexpected Runtime restart'); } };
    if (name === './dshClient') return { DSH_ORIGIN: 'http://127.0.0.1:3081', PACKAGED_DSH_ORIGIN: 'http://127.0.0.1:3082',
      DshClient: { connect: async (...args) => { connected.push(args); return connectOverride ? await connectOverride(client) : client; } }, DshHttpError: class extends Error {} };
    return require(name);
  } });
  let viewsChanged = 0;
  const editor = new module.exports.SettingsEditor(context, Promise.resolve({ origin: 'http://127.0.0.1:3082', clientModule: 'fixture' }), () => { viewsChanged++; });
  return { editor, commands, posts, client, connected, vscode, open: () => editor.open(),
    ready: async () => { await editor.open(); await panel.receive({ type: 'settingsReady' }); },
    receive: message => panel.receive(message), doc: () => document, panel: () => panel,
    dispose: () => disposers.forEach(f => f()), connection: phase => connectionListener(phase),
    stats: () => ({ changed, disposed, stop, viewsChanged }),
  };
}

test('Settings open reuses one editor and connects without a Session or chat submission', async () => {
  const f = fixture(); await Promise.all([f.open(), f.open()]); await f.ready();
  assert.equal(f.commands.filter(c => c === 'vscode.openWith').length, 1);
  assert.equal(f.connected.length, 1); assert.equal(f.connected[0][3], undefined);
  assert.match(f.panel().webview.html, /Models.*Web Search/su);
  assert.match(f.panel().webview.html, /settings-editor\.js/u);
  f.dispose(); assert.deepEqual(f.stats(), { changed: 0, disposed: 1, stop: 1, viewsChanged: 0 });
});

test('native dirty marker, Save and revert protect drafts without putting keys in backups', async () => {
  const f = fixture(); await f.ready();
  await f.receive({ type: 'settingsDirty', dirty: true }); assert.equal(f.stats().changed, 1);
  const saving = f.editor.saveCustomDocument(f.doc());
  assert.equal(f.posts.at(-1).type, 'settingsSaveDraft');
  await f.receive({ type: 'settingsRequest', requestId: 1, operation: { kind: 'saveProvider', provider: 'route', revision: 0, enabled: true, apiKey: 'test-key' } });
  await f.receive({ type: 'settingsDirty', dirty: false }); await saving;
  assert.equal(f.doc().dirty, false); assert.equal(f.stats().viewsChanged, 1);
  assert.doesNotMatch(JSON.stringify(await f.editor.backupCustomDocument()), /test-key/u);
  await f.receive({ type: 'settingsDirty', dirty: true }); await f.editor.revertCustomDocument(f.doc());
  assert.equal(f.doc().dirty, false); assert.equal(f.posts.at(-1).type, 'settingsDiscarded'); f.dispose();
});

test('RPC failures contain neither credentials nor provider bodies and preserve native dirty state', async () => {
  const f = fixture(); await f.ready();
  f.client.updateProviderSettings = async () => { throw Error('API_KEY search-query attachment'); };
  await f.receive({ type: 'settingsDirty', dirty: true });
  const saving = assert.rejects(f.editor.saveCustomDocument(f.doc()), /could not be saved/u);
  await f.receive({ type: 'settingsRequest', requestId: 2, operation: { kind: 'saveProvider', provider: 'route', revision: 0, enabled: true, apiKey: 'test-key' } });
  await saving;
  assert.equal(f.posts.at(-1).type, 'settingsFailed'); assert.doesNotMatch(JSON.stringify(f.posts), /API_KEY|search-query|attachment|test-key/u);
  assert.equal(f.doc().dirty, true); f.dispose();
});

test('a settings editor closed during connection disposes the late Client and emits no late ready state', async () => {
  const gate = Promise.withResolvers(); const f = fixture(async client => { await gate.promise; return client; });
  await f.open(); const ready = f.receive({ type: 'settingsReady' }); await new Promise(resolve => setImmediate(resolve));
  f.dispose(); gate.resolve(); await ready;
  assert.equal(f.stats().disposed, 1); assert.equal(f.posts.some(p => p.phase === 'connected'), false);
});

test('connection generation replacement rejects in-flight results and readonly UI requests stay bounded', async () => {
  const f = fixture(); await f.ready(); const gate = Promise.withResolvers(); f.client.searchSettings = async () => await gate.promise;
  const pending = f.receive({ type: 'settingsRequest', requestId: 3, operation: { kind: 'status' } });
  f.connection('disconnected'); f.connection('connected'); gate.resolve(sampleSearch); await pending;
  assert.equal(f.posts.at(-1).type, 'settingsFailed'); assert.equal(f.posts.at(-1).generation, 2);
  const count = f.posts.length;
  await f.receive({ type: 'settingsRequest', requestId: 4, operation: { kind: 'search', command: { kind: 'retry', id: 'private', query: 'secret' } } });
  assert.equal(f.posts.length, count); f.dispose();
});

test('file autosave cannot request or submit a password draft', async () => {
  const f = fixture(); await f.ready();
  f.vscode.workspace.getConfiguration = () => ({ get: () => 'afterDelay' });
  await f.receive({ type: 'settingsDirty', dirty: true });
  const before = f.posts.length;
  await assert.rejects(f.editor.saveCustomDocument(f.doc()), /Automatic file saving does not apply/u);
  assert.equal(f.posts.length, before); assert.equal(f.doc().dirty, true);
  f.dispose();
});

test('the settings resource is not a file editor or credential export', async () => {
  const f = fixture();
  await assert.rejects(f.editor.openCustomDocument({ toString: () => 'file:/workspace/dsh-companion-settings' }), /does not open files/u);
  await assert.rejects(f.editor.saveCustomDocumentAs(), /cannot be saved as a file/u);
  assert.equal(f.connected.length, 0);
});
