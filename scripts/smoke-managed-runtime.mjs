#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DshClient } from '../vscode/out/dshClient.js';
import { activatePayload, runtimeIdentity } from '../vscode/out/runtimeInstaller.js';

const { values } = parseArgs({
  options: { payload: { type: 'string' } },
  strict: true,
});
if (values.payload === undefined) throw new Error('Usage: smoke-managed-runtime.mjs --payload <runtime-payload>');
const payload = resolve(values.payload);
const manifest = JSON.parse(await readFile(join(payload, 'runtime-manifest.json'), 'utf8'));
const storage = await mkdtemp(join(tmpdir(), 'dsh-companion-managed-smoke-'));
const origin = `http://127.0.0.1:${String(await freePort())}`;
let control;
let peerControl;
let sessionClient;
try {
  [control, peerControl] = await Promise.all([0, 1].map(() => activatePayload(
    payload, storage, manifest.formatVersion === 1 ? manifest.companionVersion : '0.0.0',
    join(storage, 'runtime-owner'), join(storage, 'dsh-home'), origin,
  )));
  const profile = JSON.parse(await readFile(join(
    storage, 'dsh-home', 'profiles', 'dsh-companion', 'package.json',
  ), 'utf8'));
  const expectedBundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    ...manifest.launch.profileBundles,
  ];
  if (JSON.stringify(profile.dsh?.profile?.bundles) !== JSON.stringify(expectedBundles)) {
    throw new Error('Managed DSH profile omits packaged Companion bundles');
  }
  const unauthenticated = await fetch(control.origin, { redirect: 'manual' });
  if (unauthenticated.status !== 401 || unauthenticated.headers.get('cache-control') !== 'no-store') {
    throw new Error('Managed DSH Web UI did not reject an unauthenticated request');
  }
  const launchUrl = await control.bootstrapUrl();
  await peerControl.bootstrapUrl();
  const exchanged = await fetch(launchUrl, { redirect: 'manual' });
  if (exchanged.status !== 303) throw new Error(`Managed DSH authentication failed with HTTP ${String(exchanged.status)}`);
  const cookie = exchanged.headers.get('set-cookie')?.split(';', 1)[0];
  if (cookie === undefined) throw new Error('Managed DSH authentication returned no cookie');
  const webUi = await fetch(control.origin, { headers: { cookie } });
  const webUiHtml = await webUi.text();
  if (!webUi.ok || !webUiHtml.includes('registration.id==="@deepseek-ai/dsh-client-modules"')
    || !webUiHtml.includes('href="plugins/??')) {
    throw new Error('Managed DSH Web UI omitted its dynamic client bootstrap');
  }
  const rpcId = randomUUID();
  const response = await fetch(new URL('/api/session/list', control.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: 'session/list',
      payload: { args: { _request: {} } },
    }),
  });
  const envelope = await response.json();
  if (!response.ok || envelope?.type !== 'server-response' || envelope.rpcId !== rpcId
    || envelope.result?.ok !== true || !Array.isArray(envelope.result.value?.items)) {
    throw new Error('Managed DSH Session-list smoke returned an invalid response');
  }
  const searchRpcId = randomUUID();
  const searchResponse = await fetch(new URL('/api/session/search', control.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: searchRpcId,
      method: 'session/search',
      payload: { args: { request: { query: 'managed-runtime-search-smoke' } } },
    }),
  });
  const searchEnvelope = await searchResponse.json();
  if (!searchResponse.ok || searchEnvelope?.type !== 'server-response' || searchEnvelope.rpcId !== searchRpcId
    || searchEnvelope.result?.ok !== true || !Array.isArray(searchEnvelope.result.value?.items)
    || typeof searchEnvelope.result.value?.hasMore !== 'boolean') {
    throw new Error(`Managed DSH Session-search smoke returned an invalid response: ${JSON.stringify(searchEnvelope)}`);
  }
  const active = JSON.parse(await readFile(join(storage, 'runtime', 'active.json'), 'utf8'));
  if (active.directory !== join(storage, 'runtime', 'versions', runtimeIdentity(manifest))) {
    throw new Error('Managed DSH activation record does not select the installed payload');
  }
  const projected = { sessions: 0, resets: 0, historyStates: 0, permissionSelections: 0 };
  sessionClient = await DshClient.connect(cookie, storage, {
    sessionCreated: () => { projected.sessions += 1; },
    sessionSummary: () => {},
    reset: () => { projected.resets += 1; },
    history: () => {},
    historyPrependStart: () => {},
    historyPrependEnd: () => {},
    historyState: () => { projected.historyStates += 1; },
    modelCatalog: () => {},
    modelSelection: () => {},
    contextPressure: () => {},
    sessionCost: () => {},
    providerAccounts: () => {},
    permissionSelection: () => { projected.permissionSelections += 1; },
    compactAvailable: () => {},
    compaction: () => {},
    compacting: () => {},
    assistantStart: () => {},
    assistantDelta: () => {},
    assistantAbandoned: () => {},
    assistantTime: () => {},
    process: () => {},
    queue: () => {},
    running: () => {},
    status: () => {},
    submissionObserved: () => {},
    userCommitted: () => {},
  }, undefined, join(active.directory, 'client-runtime.js'), origin);
  if (projected.sessions !== 0 || projected.resets !== 0 || projected.historyStates !== 0
    || projected.permissionSelections !== 1) {
    throw new Error('Managed DSH Client created or opened a Session before the first prompt');
  }
  const providerSettings = await sessionClient.providerSettings();
  if (!providerSettings.families.some(family => family.id === 'openrouter')
    || providerSettings.providers.some(provider => provider.instanceId !== undefined)) {
    throw new Error('Managed DSH Client did not project the empty provider-instance baseline');
  }
  const braveBefore = await sessionClient.braveSearchCredential();
  if (braveBefore.writable) {
    const braveAfter = await sessionClient.setBraveSearchCredential('brave-smoke-key');
    if (!braveAfter.configured || !braveAfter.writable) {
      throw new Error('Managed DSH did not retain the write-only Brave credential');
    }
  }

  const first = await callRemote(control.origin, cookie, 'session/create', {
    request: { sessionId: randomUUID(), cwd: storage, agentPreset: 'dsh-companion' },
  });
  const second = await callRemote(control.origin, cookie, 'session/create', {
    request: { sessionId: randomUUID(), cwd: storage, agentPreset: 'dsh-companion' },
  });
  const sessionIds = [first?.sessionId, second?.sessionId];
  if (sessionIds.some(value => typeof value !== 'string') || new Set(sessionIds).size !== sessionIds.length) {
    throw new Error('Managed DSH Session creation did not return distinct identities');
  }

  sessionClient.dispose();
  sessionClient = undefined;
  const restored = [];
  try {
    for (let index = 0; index < 2; index += 1) {
      const state = { sessions: [] };
      const client = await DshClient.connect(cookie, storage, projectionSink({
        sessionCreated: sessionId => { state.sessions.push(sessionId); },
      }), first.sessionId, join(active.directory, 'client-runtime.js'), origin);
      restored.push(client);
      if (state.sessions.length !== 1 || state.sessions[0] !== first.sessionId) {
        throw new Error('Managed DSH Client restore did not bind the requested Session identity');
      }
    }
    if (await restored[0].refreshTitle() !== undefined) {
      throw new Error('An empty restored Session must not invent an AI title');
    }
    restored[0].dispose();
    await restored[1].loadOlder();
  } finally {
    for (const client of restored) client.dispose();
  }
  console.log(`Managed Runtime smoke passed for ${runtimeIdentity(manifest)}`);
} finally {
  sessionClient?.dispose();
  peerControl?.dispose();
  if (control !== undefined) {
    await control.stop().catch(() => undefined);
    control.dispose();
  }
  const stateFile = join(storage, 'runtime-owner', 'runtime.json');
  const deadline = Date.now() + 15_000;
  while (await exists(stateFile) && Date.now() < deadline) {
    await new Promise((resolveDelay) => { setTimeout(resolveDelay, 50); });
  }
  await rm(storage, { recursive: true, force: true });
}

async function callRemote(origin, cookie, method, args) {
  const rpcId = randomUUID();
  const response = await fetch(new URL(`/api/${method.replace('.', '/')}`, origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  });
  const envelope = await response.json();
  if (!response.ok || envelope?.type !== 'server-response' || envelope.rpcId !== rpcId
    || envelope.result?.ok !== true) {
    throw new Error(`Managed DSH ${method} smoke returned an invalid response: ${JSON.stringify(envelope)}`);
  }
  return envelope.result.value;
}

function projectionSink(overrides = {}) {
  return {
    sessionCreated: () => {},
    sessionSummary: () => {},
    reset: () => {},
    history: () => {},
    historyPrependStart: () => {},
    historyPrependEnd: () => {},
    historyState: () => {},
    modelCatalog: () => {},
    modelSelection: () => {},
    contextPressure: () => {},
    sessionCost: () => {},
    providerAccounts: () => {},
    permissionSelection: () => {},
    compactAvailable: () => {},
    compaction: () => {},
    compacting: () => {},
    assistantStart: () => {},
    assistantDelta: () => {},
    assistantAbandoned: () => {},
    assistantTime: () => {},
    process: () => {},
    queue: () => {},
    running: () => {},
    status: () => {},
    submissionObserved: () => {},
    userCommitted: () => {},
    ...overrides,
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => { server.off('error', rejectListen); resolveListen(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Unable to reserve smoke-test port');
  await new Promise((resolveClose, rejectClose) => {
    server.close(error => { if (error === undefined) resolveClose(); else rejectClose(error); });
  });
  return address.port;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
