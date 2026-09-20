#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DshClient } from '../vscode/out/dshClient.js';
import { activatePayload } from '../vscode/out/runtimeInstaller.js';

const { values } = parseArgs({
  options: { payload: { type: 'string' } },
  strict: true,
});
if (values.payload === undefined) throw new Error('Usage: smoke-managed-runtime.mjs --payload <runtime-payload>');
const payload = resolve(values.payload);
const manifest = JSON.parse(await readFile(join(payload, 'runtime-manifest.json'), 'utf8'));
const storage = await mkdtemp(join(tmpdir(), 'dsh-companion-managed-smoke-'));
let control;
let peerControl;
let sessionClient;
try {
  [control, peerControl] = await Promise.all([0, 1].map(() => activatePayload(
    payload, storage, manifest.companionVersion,
    join(storage, 'runtime-owner'), join(storage, 'dsh-home'),
  )));
  const launchUrl = await control.bootstrapUrl();
  await peerControl.bootstrapUrl();
  const exchanged = await fetch(launchUrl, { redirect: 'manual' });
  if (exchanged.status !== 303) throw new Error(`Managed DSH authentication failed with HTTP ${String(exchanged.status)}`);
  const cookie = exchanged.headers.get('set-cookie')?.split(';', 1)[0];
  if (cookie === undefined) throw new Error('Managed DSH authentication returned no cookie');
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
  const active = JSON.parse(await readFile(join(storage, 'runtime', 'active.json'), 'utf8'));
  if (active.directory !== join(storage, 'runtime', 'versions', `${manifest.companionVersion}-linux-x64`)) {
    throw new Error('Managed DSH activation record does not select the installed payload');
  }
  const projected = { resets: 0, historyStates: 0 };
  sessionClient = await DshClient.connect(cookie, storage, {
    reset: () => { projected.resets += 1; },
    history: () => {},
    historyPrependStart: () => {},
    historyPrependEnd: () => {},
    historyState: () => { projected.historyStates += 1; },
    modelCatalog: () => {},
    modelSelection: () => {},
    contextPressure: () => {},
    compactAvailable: () => {},
    compaction: () => {},
    compacting: () => {},
    assistantStart: () => {},
    assistantDelta: () => {},
    assistantTime: () => {},
    process: () => {},
    queue: () => {},
    running: () => {},
    status: () => {},
    submissionObserved: () => {},
    userCommitted: () => {},
  }, undefined, join(active.directory, 'client-runtime.js'));
  if (projected.resets < 1 || projected.historyStates < 1) {
    throw new Error('Managed DSH Client did not project its initial Session window');
  }
  console.log(`Managed Runtime smoke passed for ${manifest.companionVersion}`);
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

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
