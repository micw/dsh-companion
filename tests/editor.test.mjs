import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DSH_ORIGIN,
  TurnStats,
  collectPreviousPromptBatch,
  exchangeLaunchUrl,
  parseQueueItems,
} from '../vscode/out/dshClient.js';

test('the editor has output, process, persistent state, composer, send, and stop support', async () => {
  const script = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
  const style = await readFile(new URL('../vscode/media/style.css', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(script, /getElementById\('output'\)/);
  assert.match(script, /getElementById\('sticky-prompt'\)/);
  assert.match(script, /getElementById\('queue'\)/);
  assert.match(script, /getElementById\('composer'\)/);
  assert.match(script, /getElementById\('prompt'\)/);
  assert.match(script, /getElementById\('send'\)/);
  assert.match(script, /getElementById\('stop'\)/);
  assert.match(script, /vscode\.getState\(\)/);
  assert.match(script, /vscode\.setState\(state\)/);
  assert.match(script, /disclosures: \{ \.\.\.restoredDisclosures \}/);
  assert.match(script, /root\.dataset\.disclosureId = disclosureId/);
  assert.match(script, /function applyProcessEvent/);
  assert.match(script, /function setMessageTime/);
  assert.match(script, /function completeTurn/);
  assert.match(script, /`Thought for \$\{formatDuration\(measuredRunMs\)\}`/);
  assert.match(script, /turn-process turn-process-static/);
  assert.doesNotMatch(script, /Thought for a while/);
  assert.match(script, /function updateTurnProcessLabel/);
  assert.match(script, /labels\.push\('Reasoning'\)/);
  assert.match(script, /contextCount/);
  assert.match(script, /function autoGrowPrompt/);
  assert.match(script, /Math\.min\(prompt\.scrollHeight, 200\)/);
  assert.match(script, /function appendTurnSummary/);
  assert.match(script, /function usageControl/);
  assert.match(script, /function timingControl/);
  assert.match(script, /function closeStatControls/);
  assert.match(script, /function renderQueue/);
  assert.match(script, /function requestOlderHistory/);
  assert.match(script, /function beginHistoryPrepend/);
  assert.match(script, /output\.scrollTop = previous\.scrollTop \+ output\.scrollHeight - previous\.scrollHeight/);
  assert.match(script, /function updateStickyPrompt/);
  assert.match(script, /function setStickyPrompt/);
  assert.match(script, /output\.getBoundingClientRect\(\)/);
  assert.match(script, /stickyPromptTarget\.scrollIntoView/);
  assert.match(script, /message\.type === 'userCommitted'/);
  assert.match(script, /event\.key === 'Escape'/);
  assert.match(script, /Usage \$\{compactTokens\(total\)\} tok/);
  assert.match(script, /Number\(usage\.reasoningTokens\) > 0/);
  assert.match(style, /grid-template-rows: minmax\(0, 1fr\) auto auto auto/);
  assert.match(style, /html,[\s\S]*body \{[\s\S]*padding: 0;[\s\S]*overflow: hidden/);
  assert.match(style, /\.turn-process/);
  assert.match(style, /\.turn-process-static/);
  assert.match(style, /\.message\.assistant pre/);
  assert.match(style, /#output \{[\s\S]*padding: 24px 20px/);
  assert.match(style, /#sticky-prompt \{[\s\S]*position: absolute/);
  assert.match(style, /\.message\.assistant blockquote \{[\s\S]*border-radius: 6px/);
  assert.match(style, /\.stat-panel/);
  assert.match(style, /\.stat-trigger \{[\s\S]*background: transparent/);
  assert.match(style, /\.stat-icon \{[\s\S]*width: 14px/);
  assert.match(style, /#prompt \{[\s\S]*max-height: 200px/);
  assert.match(style, /#status\[data-running='true'\]::before/);
  assert.match(extension, /rows="1"/);
  assert.match(extension, /Ask DSH Companion… \(Enter sends, Shift\+Enter = newline\)/);
});

test('the development connection is fixed to the running DSH origin', () => {
  assert.equal(DSH_ORIGIN, 'http://127.0.0.1:3081');
});

test('turn statistics aggregate usage and timing across attempts', () => {
  const stats = new TurnStats(1_000);
  stats.startStep(1, 1_100);
  stats.firstToken(1, 1_200);
  stats.selectRoute('gpt', 'model-a');
  stats.addAttempt(1, 1_500, {
    inputTokens: 10,
    cacheReadTokens: 90,
    cacheWriteTokens: 0,
    outputTokens: 5,
    reasoningTokens: 0,
    totalTokens: 105,
  });
  stats.startStep(2, 1_600);
  stats.firstToken(2, 1_700);
  stats.addAttempt(2, 1_900, {
    inputTokens: 20,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    outputTokens: 10,
    reasoningTokens: 2,
    totalTokens: 110,
  });

  assert.deepEqual(stats.finish(2_000, 'completed'), {
    completedAt: 2_000,
    runMs: 1_000,
    reason: 'completed',
    usage: {
      uncachedInputTokens: 30,
      cacheReadTokens: 170,
      cacheWriteTokens: 0,
      outputTokens: 15,
      reasoningTokens: 2,
      totalTokens: 215,
      routes: ['gpt/model-a'],
    },
    ttftMs: 100,
    tokensPerSecond: 30,
  });
});

test('the control queue preserves host order, request identity, and placement', () => {
  assert.deepEqual(parseQueueItems([
    {
      id: 'message-1',
      rpcId: 'request-1',
      placement: 'queued',
      message: { content: [{ type: 'text', text: 'first' }] },
    },
    {
      id: 'message-2',
      placement: 'steering',
      message: { content: [{ type: 'text', text: 'second' }] },
    },
  ]), [
    { id: 'message-1', requestId: 'request-1', text: 'first', placement: 'queued' },
    { id: 'message-2', text: 'second', placement: 'steering' },
  ]);
});

test('history paging continues to and trims at the next older human-prompt Turn', async () => {
  const requests = [];
  const pages = [
    {
      records: [
        historyRecord(80, 'user/message', { source: { kind: 'plugin' }, content: [] }),
        historyRecord(90, 'assistant/message', { message: { content: [] } }),
      ],
      hasMore: true,
    },
    {
      records: [
        historyRecord(40, 'assistant/message', { message: { content: [] } }),
        historyRecord(50, 'turn/start', { turn: 3 }),
        historyRecord(51, 'user/message', { source: { kind: 'user' }, content: [] }),
        historyRecord(70, 'turn/end', { turn: 3 }),
      ],
      hasMore: false,
    },
  ];
  const batch = await collectPreviousPromptBatch(100, 140, async (beforeSeq, throughSeq) => {
    requests.push({ beforeSeq, throughSeq });
    return pages.shift();
  });

  assert.deepEqual(requests, [
    { beforeSeq: 100, throughSeq: 140 },
    { beforeSeq: 80, throughSeq: 140 },
  ]);
  assert.deepEqual(batch.records.map((record) => record.event.seq), [50, 51, 70, 80, 90]);
  assert.equal(batch.hasMore, true);
});

test('history paging stops at the beginning when no older human prompt exists', async () => {
  const batch = await collectPreviousPromptBatch(10, 20, async () => ({
    records: [historyRecord(0, 'turn/start', { turn: 1 })],
    hasMore: false,
  }));
  assert.deepEqual(batch.records.map((record) => record.event.seq), [0]);
  assert.equal(batch.hasMore, false);
});

test('history paging rejects a page that does not move its cursor backwards', async () => {
  await assert.rejects(
    collectPreviousPromptBatch(10, 20, async () => ({
      records: [historyRecord(10, 'turn/start', { turn: 1 })],
      hasMore: true,
    })),
    /made no backwards progress/,
  );
});

test('tabs restore through the serializer and Stop uses DSH session cancellation', async () => {
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  const client = await readFile(new URL('../vscode/src/dshClient.ts', import.meta.url), 'utf8');
  assert.match(extension, /registerWebviewPanelSerializer\(CHAT_EDITOR_VIEW_TYPE/);
  assert.match(extension, /restoredSessionId/);
  assert.match(client, /restoredSessionId \?\?/);
  assert.match(client, /reasoningDisclosureId/);
  assert.match(client, /context:\$\{String\(event\.seq\)\}/);
  assert.match(client, /'session\/modelCatalog'/);
  assert.match(client, /endpoint: 'session\/control'/);
  assert.match(client, /'session\/page'/);
  assert.match(client, /collectPreviousPromptBatch/);
  assert.match(client, /function parseQueueItems/);
  assert.match(client, /function modelLabelMap/);
  assert.match(client, /'session\/cancel'/);
  assert.match(client, /retaining pending DSH inbox work/);
});

test('launch authentication rejects another origin before connecting', async () => {
  await assert.rejects(
    exchangeLaunchUrl('http://127.0.0.1:9999/?token=wrong'),
    /Expected the launch URL printed by DSH/,
  );
});

function historyRecord(seq, type, data) {
  return { type: 'event', event: { seq, type, time: seq, data } };
}
