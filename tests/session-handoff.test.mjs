import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { publishSessionHandoff, receiveSessionHandoffs } from '../vscode/out/sessionHandoff.js';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'companion-handoff-'));
  const stops = [];
  const errors = [];
  const receive = async (roots, onOpen) => {
    const stop = await receiveSessionHandoffs(root, () => roots, onOpen, error => errors.push(error));
    stops.push(stop);
  };
  try { await fn({ root, receive, errors }); }
  finally {
    for (const stop of stops) stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function until(condition) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('handoff was not delivered');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('a running target window receives a Session after the source opens its folder', async () => {
  await fixture(async ({ root, receive, errors }) => {
    const opened = [];
    await receive(['/source'], sessionId => opened.push(`source:${sessionId}`));
    await receive(['/target'], sessionId => opened.push(`target:${sessionId}`));
    await publishSessionHandoff(root, 'session-1', '/target');
    await until(() => opened.length === 1);
    assert.deepEqual(opened, ['target:session-1']);
    assert.deepEqual(errors, []);
  });
});

test('a new target window consumes a handoff published before activation', async () => {
  await fixture(async ({ root, receive, errors }) => {
    const opened = [];
    await publishSessionHandoff(root, 'session-2', '/target');
    await receive(['/target'], sessionId => opened.push(sessionId));
    await until(() => opened.length === 1);
    assert.deepEqual(opened, ['session-2']);
    assert.deepEqual(await readdir(join(root, 'session-handoffs')), []);
    assert.deepEqual(errors, []);
  });
});

test('cancelling a failed folder open leaves no delayed chat in the target', async () => {
  await fixture(async ({ root, receive, errors }) => {
    const opened = [];
    const cancel = await publishSessionHandoff(root, 'session-cancelled', '/target');
    await cancel();
    await receive(['/target'], sessionId => opened.push(sessionId));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(opened, []);
    assert.deepEqual(errors, []);
  });
});

test('two matching windows claim a handoff only once', async () => {
  await fixture(async ({ root, receive, errors }) => {
    const opened = [];
    await receive(['/target'], sessionId => opened.push(sessionId));
    await receive(['/target'], sessionId => opened.push(sessionId));
    await publishSessionHandoff(root, 'session-3', '/target');
    await until(() => opened.length === 1);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(opened, ['session-3']);
    assert.deepEqual(errors, []);
  });
});
