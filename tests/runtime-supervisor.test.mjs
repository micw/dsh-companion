import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RuntimeSupervisor, parseConfig } from '../vscode/runtime/supervisor.mjs';
import { RuntimeControl } from '../vscode/out/runtimeControl.js';

test('supervisor validates a loopback DSH runtime configuration', () => {
  assert.throws(() => parseConfig({}), /Invalid DSH Companion runtime supervisor configuration/);
  assert.throws(() => parseConfig({
    version: 1,
    stateFile: '/tmp/state.json',
    command: process.execPath,
    args: [],
    cwd: '/tmp',
    origin: 'http://example.com:3081',
  }), /loopback/);
  assert.throws(() => parseConfig({
    version: 1,
    stateFile: '/tmp/state.json',
    command: process.execPath,
    args: [],
    cwd: '/tmp',
    origin: 'http://127.0.0.1:3081',
    runtimeId: 'unversioned',
  }), /runtime identity/);
});

test('supervisor publishes authenticated lifecycle state and stops its DSH process tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-companion-supervisor-'));
  const extensionPath = join(root, 'dsh-companion', 'vscode');
  const stateFile = join(root, '.dev', 'dsh-companion', 'runtime.json');
  const childProgram = [
    "console.log('dsh web: http://127.0.0.1:39181/?token=test-token')",
    'setInterval(() => {}, 1000)',
  ].join(';');
  const supervisor = new RuntimeSupervisor({
    version: 1,
    stateFile,
    command: process.execPath,
    args: ['-e', childProgram],
    cwd: root,
    origin: 'http://127.0.0.1:39181',
    runtimeId: 'source',
    clientModule: join(root, 'client-runtime.js'),
  });

  try {
    await supervisor.start();
    const state = await waitForState(stateFile, (value) => value.runtime?.state === 'ready');
    assert.equal(state.version, 2);
    assert.equal(state.runtime.origin, 'http://127.0.0.1:39181');
    assert.equal(state.runtime.runtimeId, 'source');
    assert.equal(state.runtime.clientModule, join(root, 'client-runtime.js'));
    assert.equal(typeof state.runtime.pid, 'number');
    assert.equal('bootstrapUrl' in state, false);

    const headers = { authorization: `Bearer ${state.controlToken}` };
    const status = await fetch(`${state.controlOrigin}/v1/status`, { headers });
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), {
      version: 1,
      instanceId: state.instanceId,
      state: 'ready',
      origin: 'http://127.0.0.1:39181',
      runtimePid: state.runtime.pid,
      runtimeStartedAt: state.runtime.startedAt,
      clients: 0,
      idleShutdown: 'awaiting-dsh-quiescence',
    });

    const unauthorized = await fetch(`${state.controlOrigin}/v1/bootstrap`);
    assert.equal(unauthorized.status, 401);
    const bootstrap = await fetch(`${state.controlOrigin}/v1/bootstrap`, { headers });
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(await bootstrap.json(), {
      version: 1,
      launchUrl: 'http://127.0.0.1:39181/?token=test-token',
    });

    const lease = await fetch(`${state.controlOrigin}/v1/clients/test-client`, {
      method: 'PUT',
      headers,
    });
    assert.equal(lease.status, 200);
    assert.equal((await lease.json()).expiresInMs, 45_000);
    assert.equal((await fetch(`${state.controlOrigin}/v1/status`, { headers }).then((value) => value.json())).clients, 1);
    const release = await fetch(`${state.controlOrigin}/v1/clients/test-client`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(release.status, 204);

    const control = await RuntimeControl.discover({ fsPath: extensionPath });
    assert.ok(control);
    assert.equal(control.origin, 'http://127.0.0.1:39181');
    assert.equal(control.runtimeId, 'source');
    assert.equal(control.clientModule, join(root, 'client-runtime.js'));
    assert.equal(new URL(await control.bootstrapUrl()).searchParams.get('token'), 'test-token');
    control.dispose();

    const runtimePid = state.runtime.pid;
    await supervisor.stop('test complete');
    assert.equal(processExists(runtimePid), false);
    await assert.rejects(stat(stateFile), (error) => error?.code === 'ENOENT');
  } finally {
    await supervisor.stop('test cleanup');
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForState(path, predicate) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (predicate(value)) return value;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for supervisor state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}
