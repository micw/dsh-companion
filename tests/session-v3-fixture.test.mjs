import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const fixtureUrl = new URL('./fixtures/dsh-companion-v3-session.jsonl', import.meta.url);
const validator = new URL('./fixtures/validate-v4-migration.ts', import.meta.url).pathname;

test('the target DSH runtime migrates the Companion V3 fixture only on write', async () => {
  const dshSource = resolve(process.env.DSH_COMPANION_DSH_SOURCE
    ?? new URL('../../deepseek-harness', import.meta.url).pathname);
  const root = await mkdtemp(join(tmpdir(), 'dsh-companion-v3-fixture-'));
  try {
    const { stdout } = await execFileAsync(join(dshSource, 'node_modules', '.bin', 'tsx'), [
      validator, fixtureUrl.pathname, root,
    ], {
      cwd: dshSource,
      maxBuffer: 1024 * 1024,
    });
    assert.deepEqual(JSON.parse(stdout), {
      beforeVersion: 4,
      afterVersion: 4,
      beforeEvents: 11,
      afterEvents: 11,
      preset: 'standard',
      accounting: {
        scope: 'call',
        costs: [{ kind: 'reported', amount: { currency: 'USD', nanos: 7 }, source: 'fixture-provider' }],
      },
      statuses: [{
        time: 1_795_000_000_015,
        status: { kind: 'reasoning-token-progress', deltaTokens: 3, basis: 'reported' },
      }],
      toolRole: 'tool',
      queuedText: 'Queued after the completed turn.',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the V3 migration fixture covers Companion-owned durable behavior', async () => {
  const records = (await readFile(fixtureUrl, 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(record => record.type), [
    'session',
    'turn/start',
    'step/start',
    'user/message',
    'request/header',
    'request/context',
    'assistant/message',
    'tool/call',
    'tool/result',
    'step/end',
    'turn/end',
    'agent/inbox/spliced',
  ]);
  assert.equal(records[0].version, 3);
  assert.equal(records[0].agentPreset, 'standard');
  assert.equal(records[3].data.content[1].attachment.name, 'pixel.png');
  assert.deepEqual(records[6].data.accounting, {
    scope: 'call',
    costs: [{
      kind: 'reported',
      amount: { currency: 'USD', nanos: 7 },
      source: 'fixture-provider',
    }],
  });
  assert.deepEqual(records[6].data.statuses, [{
    time: 1_795_000_000_015,
    status: { kind: 'reasoning-token-progress', deltaTokens: 3, basis: 'reported' },
  }]);
  assert.equal(records[8].data.message.content[0].toolCallId, 'fixture-call');
  assert.equal(records[11].data.target, 'next-turn');
  assert.equal(records[11].data.inserted[0].content[0].text, 'Queued after the completed turn.');
});
