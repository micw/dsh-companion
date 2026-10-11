import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './settings-fixture.mjs';
const snapshot = (patch = {}) => ({ installedVersion: '0.1.0', target: 'linux-x64', channel: 'stable', phase: 'idle', available: null, canInstall: false, blockedReason: null, progress: null, message: 'Check manually.', ...patch });
const send = (f, patch) => f.send({ type: 'versionState', snapshot: snapshot(patch) });
const requests = f => f.posts.filter(p => p.type === 'versionRequest');
const candidate = { version: '0.2.0', size: 1234, publishedAt: '2026-01-01', releaseUrl: 'javascript:alert(1)' };

test('Version restore is navigation-only and startup preserves the persisted host channel', () => {
  const f = fixture({ category: 'version', id: 'secret', scroll: 42, available: candidate, channel: 'master' });
  assert.match(f.content.textContent, /Installed version/);
  assert.equal(requests(f).length, 0);
  send(f); assert.equal(f.content.querySelector('select').value, 'stable');
  f.content.dispatch('scroll'); assert.deepEqual(f.saved(), { category: 'version', scroll: 42 });
  f.button('Check for Updates').click();
  assert.deepEqual(requests(f), [{ type: 'versionRequest', requestId: 1, action: 'check', channel: 'stable' }]);
});

test('Version remains available offline and ignores background DSH patches', () => {
  const f = fixture(); send(f); f.button('Version').click();
  assert.equal(requests(f).at(-1).action, 'load'); send(f);
  f.connected(1, 'disconnected'); assert.match(f.content.textContent, /Installed version0.1.0/);
  assert.doesNotMatch(f.content.textContent, /Connecting to DSH/);
  f.ready(); assert.match(f.content.textContent, /Installed version0.1.0/);
  f.button('Check for Updates').click(); assert.equal(requests(f).at(-1).channel, 'stable');
});

test('strict snapshot validation rejects injected fields and malformed values without changing UI', () => {
  const f = fixture({ category: 'version' }); send(f);
  for (const patch of [{ apiKey: 'secret' }, { progress: 101 }, { progress: 1.5 }, { channel: 'other' }, { available: { ...candidate, command: 'secret' } }, { canInstall: 'true' }, { phase: 'unknown' }]) {
    assert.equal(f.api.versionValid(snapshot(patch)), false); send(f, patch);
  }
  assert.doesNotMatch(f.content.textContent, /secret|unknown/);
  send(f, { message: '<img src=x onerror=alert(1)>', available: candidate });
  assert.match(f.content.textContent, /<img src=x/); assert.equal(f.content.querySelectorAll('img, a').length, 0);
  assert.equal(f.api.versionValid(snapshot()), true);
});

test('busy controls, progress and exact install request prevent duplicate installation', () => {
  const f = fixture({ category: 'version' }); send(f, { phase: 'available', available: candidate, canInstall: true });
  f.button('Install update and restart').click(); f.button('Install update and restart').click();
  assert.deepEqual(requests(f), [{ type: 'versionRequest', requestId: 1, action: 'install', channel: 'stable' }]);
  send(f, { phase: 'downloading', progress: 37, canInstall: true, available: candidate });
  assert.equal(f.content.querySelector('progress').value, 37); assert.match(f.content.textContent, /37%/);
  assert.equal(f.content.querySelector('select').disabled, true);
  assert.equal(f.button('Check for Updates').disabled, true); assert.equal(f.button('Install update and restart').disabled, true);
  send(f, { phase: 'current', canInstall: true, available: candidate }); assert.equal(f.button('Install update and restart').disabled, true);
});

test('channel switch clears candidates, loads only, rejects stale channel and requires manual check', () => {
  const f = fixture({ category: 'version' }); send(f, { phase: 'available', available: candidate, canInstall: true });
  const select = f.content.querySelector('select'); select.value = 'master'; select.dispatch('change');
  assert.deepEqual(requests(f).at(-1), { type: 'versionRequest', requestId: 1, action: 'load', channel: 'master' });
  assert.doesNotMatch(f.content.textContent, /0.2.0/);
  send(f, { phase: 'available', available: candidate, canInstall: true }); assert.equal(f.button('Install update and restart').disabled, true);
  send(f, { channel: 'master' }); assert.equal(f.button('Install update and restart').disabled, true);
  send(f, { phase: 'available', available: candidate, canInstall: true }); assert.equal(f.content.querySelector('select').value, 'master');
  f.button('Check for Updates').click(); assert.equal(requests(f).at(-1).action, 'check');
});

test('dirty Models draft still confirms navigation to Version', () => {
  const f = fixture(); f.ready(); f.button('Manage').click();
  f.content.querySelector('input[type="text"]').input('Changed'); f.button('Version').click();
  const discard = f.posts.at(-1); assert.equal(discard.type, 'settingsDiscardRequest'); assert.equal(requests(f).length, 0);
  f.send({ type: 'settingsDiscardResult', requestId: discard.requestId, accepted: false }); assert.match(f.content.textContent, /Work/);
  f.button('Version').click(); f.send({ type: 'settingsDiscardResult', requestId: f.posts.at(-1).requestId, accepted: true });
  assert.equal(requests(f).at(-1).action, 'load');
});
