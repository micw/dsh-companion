import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, sampleModels, sampleSearch } from './settings-fixture.mjs';
import { parseSettingsRequest } from '../vscode/out/settingsProtocol.js';
import { executeSettingsOperation } from '../vscode/out/settingsOperations.js';

test('Settings messages admit only bounded named operations and explicit write-only keys', () => {
  const message = { type: 'settingsRequest', requestId: 1, operation: { kind: 'search', command: { kind: 'retry', id: 'private' } } };
  assert.deepEqual(parseSettingsRequest(message), message);
  assert.equal(parseSettingsRequest({ ...message, operation: { kind: 'search', command: { kind: 'retry', id: 'one', query: 'private' } } }), undefined);
  assert.equal(parseSettingsRequest({ ...message, operation: { kind: 'saveProvider', provider: 'one', revision: 0, enabled: true, apiKey: 'bad\nkey' } }), undefined);
  assert.equal(parseSettingsRequest({ ...message, operation: { kind: 'models', provider: 'one', revision: 0, enabled: true, models: Array(1001).fill('model') } }), undefined);
});

test('loads both settings projections atomically and Retry dispatches exactly the selected canonical operation', async () => {
  const calls = [];
  const client = { providerSettings: async () => sampleModels, searchSettings: async command => { calls.push(command); return sampleSearch; } };
  assert.deepEqual(await executeSettingsOperation(client, { kind: 'load' }, async () => true), { models: sampleModels, search: sampleSearch });
  calls.length = 0;
  await executeSettingsOperation(client, { kind: 'search', command: { kind: 'retry', id: 'private' } }, async () => true);
  assert.deepEqual(calls, [{ kind: 'retry', id: 'private' }]);
  calls.length = 0;
  assert.deepEqual(await executeSettingsOperation(client, { kind: 'search', command: { kind: 'remove', id: 'private', revision: 0 } }, async () => false), { cancelled: true });
  assert.equal(calls.length, 0);
});

test('shows one connection/loading phase before either category presents forms', () => {
  const f = fixture();
  assert.match(f.content.textContent, /Connecting to DSH/u);
  assert.equal(f.content.querySelectorAll('form').length, 0);
  f.nav.children[1].click();
  assert.equal(f.content.querySelectorAll('input').length, 0);
  f.connected(); assert.match(f.content.textContent, /Loading settings/u);
  f.reply({ search: sampleSearch });
  assert.equal(f.content.querySelectorAll('article').length, 0);
  f.connected(2); f.reply({ generation: 2, models: sampleModels, search: sampleSearch });
  assert.equal(f.content.querySelectorAll('article').length, 2);
  assert.equal(f.content.querySelectorAll('form').length, 0);
});

test('background refresh keeps row identity, menu disclosure, scroll and unrelated actions', () => {
  const f = fixture(); f.ready(); f.nav.children[1].click();
  const row = f.content.querySelectorAll('article')[0]; const menu = row.querySelector('details'); menu.open = true; f.content.scrollTop = 75;
  assert.equal(f.content.querySelectorAll('button').some(e => e.textContent === 'Refresh'), false);
  f.poll(); assert.equal(f.button('Edit').disabled, false);
  f.reply({ search: { ...sampleSearch, entries: [{ ...sampleSearch.entries[0], failure: null }, sampleSearch.entries[1]] } });
  assert.equal(f.content.querySelectorAll('article')[0], row); assert.equal(menu.open, true); assert.equal(f.content.scrollTop, 75);
  assert.match(row.textContent, /Ready/u);
});

test('Retry locks only the selected access and emits no fallback query', () => {
  const f = fixture(); f.ready(); f.nav.children[1].click();
  f.button('Retry').click();
  assert.deepEqual(f.posts.at(-1).operation, { kind: 'search', command: { kind: 'retry', id: 'private' } });
  const other = f.content.querySelectorAll('article')[1]; assert.equal(other.querySelectorAll('button').find(e => e.textContent === 'Edit').disabled, false);
  f.reply({ search: sampleSearch });
  assert.equal(f.button('Retry').disabled, false);
  f.poll(); f.reply({ search: { ...sampleSearch, entries: [{ ...sampleSearch.entries[0], checking: true }, sampleSearch.entries[1]] } });
  assert.equal(f.button('Retry').disabled, true);
});

test('password drafts survive refresh but never enter restore state and clear before explicit save', () => {
  const f = fixture(); f.ready(); f.nav.children[1].click(); f.button('Edit').click();
  const form = f.content.querySelector('form'); const inputs = form.querySelectorAll('input'); const password = form.querySelector('input[type="password"]');
  inputs[0].input('Renamed'); password.input('test-secret'); f.content.dispatch('scroll');
  assert.doesNotMatch(JSON.stringify(f.saved()), /test-secret|Renamed/u);
  f.poll(); f.reply({ search: { ...sampleSearch, revision: 9 } });
  assert.equal(f.content.querySelector('form'), form); assert.equal(password.value, 'test-secret');
  f.button('Save').click();
  assert.equal(password.value, '');
  assert.deepEqual(f.posts.at(-1).operation.command, { kind: 'save', revision: 0, id: 'private', family: 'brave', displayName: 'Renamed', enabled: true, apiKey: 'test-secret' });
  f.reply({ search: sampleSearch });
  assert.equal(f.content.querySelectorAll('form').length, 0);
  const restored = fixture(f.saved()); restored.ready(); assert.equal(restored.nav.children[1].getAttribute('aria-current'), 'page');
  assert.equal(restored.content.querySelectorAll('input[type="password"]').length, 0);
});

test('dirty navigation requires confirmation and native Save uses the same explicit operation', () => {
  const f = fixture(); f.ready(); f.button('Manage').click();
  const form = f.content.querySelector('form'); form.querySelector('input[type="text"]').input('Changed');
  f.nav.children[1].click(); const discard = f.posts.at(-1); assert.equal(discard.type, 'settingsDiscardRequest');
  f.send({ type: 'settingsDiscardResult', requestId: discard.requestId, accepted: false }); assert.equal(f.content.querySelector('form'), form);
  f.send({ type: 'settingsSaveDraft' }); assert.equal(f.posts.at(-1).operation.kind, 'saveProvider');
  f.reply({ models: sampleModels }); assert.equal(f.posts.some(p => p.type === 'settingsDirty' && p.dirty === false), true);
});

test('connection loss retains values, disables mutation and ignores stale generation responses', () => {
  const f = fixture(); f.ready(); f.button('Manage').click();
  const form = f.content.querySelector('form'); const name = form.querySelector('input[type="text"]'); name.input('Local draft');
  f.connected(1, 'disconnected'); assert.equal(name.value, 'Local draft'); assert.equal(f.button('Save').disabled, true);
  f.connected(2); const load = f.posts.at(-1);
  f.send({ type: 'settingsResult', generation: 1, requestId: load.requestId, models: sampleModels, search: sampleSearch }); assert.equal(name.value, 'Local draft');
  f.send({ type: 'settingsResult', generation: 2, requestId: load.requestId, models: sampleModels, search: sampleSearch });
  assert.equal(f.content.querySelector('form'), form); assert.equal(name.value, 'Local draft'); assert.equal(f.button('Save').disabled, false);
});

test('snapshot validation rejects secrets and restore extracts only bounded navigation', () => {
  const f = fixture();
  assert.equal(f.api.searchValid({ ...sampleSearch, apiKey: 'secret' }), false);
  assert.equal(f.api.modelsValid({ ...sampleModels, providers: [{ ...sampleModels.providers[0], apiKey: 'secret' }] }), false);
  assert.deepEqual(JSON.parse(JSON.stringify(f.api.restoredView({ category: 'search', id: 'private', scroll: 42, apiKey: 'secret' }))), { category: 'search', id: 'private', scroll: 42 });
});
