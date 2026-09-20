import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DSH_ORIGIN,
  PACKAGED_DSH_ORIGIN,
  TurnStats,
  advanceContextPressure,
  advanceModelSelection,
  contextPressureForModel,
  exchangeLaunchUrl,
  parseCompactionEvent,
  parseModelCatalog,
} from '../vscode/out/dshClient.js';

test('the editor has output, process, persistent state, composer, send, and stop support', async () => {
  const script = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
  const style = await readFile(new URL('../vscode/media/style.css', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  const dshClient = await readFile(new URL('../vscode/src/dshClient.ts', import.meta.url), 'utf8');
  assert.match(script, /getElementById\('output'\)/);
  assert.match(script, /getElementById\('sticky-prompt'\)/);
  assert.match(script, /getElementById\('queue'\)/);
  assert.match(script, /getElementById\('composer'\)/);
  assert.match(script, /getElementById\('prompt'\)/);
  assert.match(script, /getElementById\('model-trigger'\)/);
  assert.match(script, /getElementById\('context-trigger'\)/);
  assert.match(script, /function renderModelPicker/);
  assert.match(script, /function renderEffortMenu/);
  assert.match(script, /if \(effort === undefined\) return 'Provider default'/);
  assert.match(script, /const efforts = \[\s*\{ id: undefined, name: 'Provider default' \}/);
  assert.doesNotMatch(script, /reasoningEffort \?\? model\.reasoning\.defaultEffort/);
  assert.match(script, /function renderContextMeter/);
  assert.match(script, /function applyCompactionEvent/);
  assert.match(script, /prompt\.disabled = compacting/);
  assert.match(script, /running \|\| compacting/);
  assert.match(script, /function positionContextPanel/);
  assert.match(script, /window\.innerWidth - width - margin/);
  assert.match(script, /getElementById\('send'\)/);
  assert.match(script, /getElementById\('stop'\)/);
  assert.match(script, /vscode\.getState\(\)/);
  assert.match(script, /vscode\.setState\(state\)/);
  assert.doesNotMatch(script, /restoredScrollTop/);
  assert.match(script, /message\.sessionId === restoredSessionId[\s\S]*requestAnimationFrame\(setOutputFollow\)/);
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
  assert.match(script, /function appendTurnSummary[\s\S]*activeAssistantMessage\.append\(footer\);[\s\S]*followOutput\(\)/);
  assert.match(script, /function usageControl/);
  assert.match(script, /function timingControl/);
  assert.match(script, /function closeStatControls/);
  assert.match(script, /function renderQueue/);
  assert.match(script, /function requestOlderHistory/);
  assert.match(script, /function resetTranscript/);
  assert.match(script, /function beginHistoryPrepend/);
  assert.match(script, /output\.scrollTop = previous\.scrollTop \+ output\.scrollHeight - previous\.scrollHeight/);
  assert.match(script, /function updateStickyPrompt/);
  assert.match(script, /function setStickyPrompt/);
  assert.match(script, /output\.getBoundingClientRect\(\)/);
  assert.match(script, /stickyPromptTarget\.scrollIntoView/);
  assert.match(script, /function markUserScrollIntent/);
  assert.match(script, /function finishPointerInteraction/);
  assert.match(script, /function setOutputSticky/);
  assert.match(script, /function updateScrollButton/);
  assert.match(script, /scrollBottom\.addEventListener\('click', scrollToLatestOutput\)/);
  assert.match(script, /function scrollToLatestOutput[\s\S]*behavior: 'smooth'/);
  assert.match(script, /stickyPromptJump\.addEventListener[\s\S]*setOutputSticky\(true\)[\s\S]*scrollIntoView/);
  assert.match(script, /output\.contains\(selection\.anchorNode\)/);
  assert.match(script, /output\.scrollHeight - output\.scrollTop - output\.clientHeight < 32/);
  assert.match(script, /scrollMode = nearBottom \? 'follow' : 'sticky'/);
  assert.match(script, /scrollMode === 'sticky' && nearBottom && !bottomLatchSuppressed/);
  assert.match(script, /scrollMode !== 'follow' \|\| userScrollIntent \|\| pointerScrolling/);
  assert.match(script, /output\.addEventListener\('wheel', markUserScrollIntent/);
  assert.match(script, /message\.type === 'userCommitted'/);
  assert.match(script, /message\.type === 'submissionObserved'/);
  assert.match(script, /event\.key !== 'Escape'/);
  assert.match(script, /Usage \$\{compactTokens\(total\)\} tok/);
  assert.match(script, /Number\(usage\.reasoningTokens\) > 0/);
  assert.match(style, /grid-template-rows: minmax\(0, 1fr\) auto auto auto/);
  assert.match(style, /html,[\s\S]*body \{[\s\S]*padding: 0;[\s\S]*overflow: hidden/);
  assert.match(style, /\.turn-process/);
  assert.match(style, /\.turn-process-static/);
  assert.match(style, /\.message\.assistant pre/);
  assert.match(style, /#output \{[\s\S]*padding: 24px 20px/);
  assert.match(style, /#sticky-prompt \{[\s\S]*position: absolute/);
  assert.match(style, /#sticky-prompt-jump \{[\s\S]*border-radius: 50%/);
  assert.match(style, /#scroll-bottom \{[\s\S]*position: absolute/);
  assert.match(style, /#scroll-bottom \{[\s\S]*background: var\(--vscode-button-background\)/);
  assert.match(style, /#sticky-prompt-jump svg,[\s\S]*#scroll-bottom svg/);
  assert.match(style, /\.message\.assistant blockquote \{[\s\S]*border-radius: 6px/);
  assert.match(style, /\.stat-panel/);
  assert.match(style, /\.stat-trigger \{[\s\S]*background: transparent/);
  assert.match(style, /\.stat-icon \{[\s\S]*width: 14px/);
  assert.match(style, /#prompt \{[\s\S]*max-height: 200px/);
  assert.match(style, /#model-picker \{/);
  assert.match(style, /#effort-menu \{/);
  assert.match(style, /#context-panel \{/);
  assert.match(style, /\.compaction-activity/);
  assert.match(style, /#status\[data-running='true'\]::before/);
  assert.match(extension, /rows="1"/);
  assert.match(extension, /id="sticky-prompt-jump"[\s\S]*<svg[^>]+><path d="M3\.5 10/);
  assert.match(extension, /id="scroll-bottom"[\s\S]*<svg[^>]+><path d="m3\.5 6/);
  assert.match(extension, /Ask DSH Companion… \(Enter sends, Shift\+Enter = newline\)/);
  assert.match(extension, /isSelectModelMessage/);
  assert.match(extension, /runtime\.clientModule/);
  assert.match(extension, /if \(runtime === undefined\) \{[\s\S]*runtime = await connectRuntime\(context\)/);
  assert.match(extension, /Managed DSH runtime is unavailable/);
  assert.match(extension, /runtime\?\.runtimeId !== 'source' \|\| runtime\.origin !== DSH_ORIGIN/);
  assert.match(extension, /vscode\.env\.openExternal\(vscode\.Uri\.parse\(await runtime\.bootstrapUrl\(\)\)\)/);
  assert.doesNotMatch(extension, /showInputBox|Paste the launch URL/);
  assert.match(dshClient, /connectCanonical/);
  assert.match(dshClient, /mountCompanionProviderRemotes/);
  assert.match(dshClient, /connection\.state\.subscribe/);
  assert.doesNotMatch(dshClient, /remote\.mux|new WebSocket|Handwritten DSH/);
});

test('the development connection is fixed to the running DSH origin', () => {
  assert.equal(DSH_ORIGIN, 'http://127.0.0.1:3081');
});

test('the packaged runtime owns a separate loopback origin', async () => {
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  const installer = await readFile(new URL('../vscode/src/runtimeInstaller.ts', import.meta.url), 'utf8');
  const smoke = await readFile(new URL('../scripts/smoke-managed-runtime.mjs', import.meta.url), 'utf8');
  assert.equal(PACKAGED_DSH_ORIGIN, 'http://127.0.0.1:3082');
  assert.match(extension, /runtime\.origin !== DSH_ORIGIN && runtime\.origin !== PACKAGED_DSH_ORIGIN/);
  assert.match(installer, /'--port', new URL\(PACKAGED_DSH_ORIGIN\)\.port/);
  assert.match(installer, /origin: PACKAGED_DSH_ORIGIN/);
  assert.match(smoke, /PACKAGED_DSH_ORIGIN\)/);
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

test('the DSH model catalog preserves provider-owned effort metadata and order', () => {
  const catalog = parseModelCatalog({
    default: { provider: 'alpha', model: 'reasoner', reasoningEffort: 'high' },
    routableProviders: ['alpha'],
    groups: [{
      id: 'alpha',
      name: 'Alpha Provider',
      models: [{
        id: 'reasoner',
        name: 'Reasoner',
        description: 'Complex work',
        inputModalities: ['text', 'image'],
        context: { contextWindow: 262_144 },
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High', description: 'More reasoning' },
          ],
          defaultEffort: 'high',
        },
      }],
    }],
    failures: [{ id: 'broken', name: 'Broken Provider', message: 'Unavailable' }],
  });

  assert.deepEqual(catalog.groups[0].models[0].reasoning, {
    efforts: [
      { id: 'off', name: 'Off' },
      { id: 'high', name: 'High', description: 'More reasoning' },
    ],
    defaultEffort: 'high',
  });
  assert.deepEqual(catalog.groups[0].models[0].inputModalities, ['text', 'image']);
  assert.deepEqual(catalog.groups[0].models[0].context, { contextWindow: 262_144 });
  assert.deepEqual(catalog.failures, [{ id: 'broken', name: 'Broken Provider', message: 'Unavailable' }]);
});

test('model selection restores from DSH projections and rejects stale cross-stream baselines', () => {
  const fallback = { provider: 'alpha', model: 'default' };
  const restored = advanceModelSelection({ watermark: -1, current: fallback }, {
    lastUsed: { provider: 'alpha', model: 'reasoner', reasoningEffort: 'high' },
    next: { provider: 'alpha', model: 'reasoner', reasoningEffort: 'max' },
  }, 12, fallback);
  assert.deepEqual(restored, {
    watermark: 12,
    current: { provider: 'alpha', model: 'reasoner', reasoningEffort: 'max' },
  });

  const stale = advanceModelSelection(restored, {
    lastUsed: { provider: 'alpha', model: 'old' },
    next: null,
  }, 11, fallback);
  assert.equal(stale, restored);
});

test('an empty DSH model projection uses the catalog default', () => {
  const fallback = { provider: 'alpha', model: 'default', reasoningEffort: 'provider-choice' };
  assert.deepEqual(
    advanceModelSelection({ watermark: -1, current: fallback }, { lastUsed: null, next: null }, 0, fallback),
    { watermark: 0, current: fallback },
  );
});

test('context pressure restores from DSH and ignores stale live-stream projections', () => {
  const restored = advanceContextPressure({ watermark: -1 }, {
    pressureTokens: 40_000,
    projectedTokens: 44_000,
    contextWindow: 128_000,
  }, 20);
  assert.deepEqual(restored, {
    watermark: 20,
    current: { pressureTokens: 40_000, projectedTokens: 44_000, contextWindow: 128_000 },
  });
  assert.equal(advanceContextPressure(restored, { pressureTokens: 1, contextWindow: 2 }, 19), restored);
});

test('context pressure rejects invented zero capacities and negative token counts', () => {
  assert.throws(() => advanceContextPressure({ watermark: -1 }, { contextWindow: 0 }, 0), /contextWindow/);
  assert.throws(() => advanceContextPressure({ watermark: -1 }, { pressureTokens: -1 }, 0), /pressureTokens/);
});

test('model selection immediately replaces stale request capacity from the DSH catalog', () => {
  const catalog = parseModelCatalog({
    default: { provider: 'alpha', model: 'small' },
    routableProviders: ['alpha'],
    groups: [{
      id: 'alpha',
      name: 'Alpha',
      models: [
        { id: 'small', name: 'Small', context: { contextWindow: 100_000 } },
        { id: 'large', name: 'Large', context: { contextWindow: 500_000 } },
        { id: 'unknown', name: 'Unknown' },
      ],
    }],
    failures: [],
  });
  const pressure = { pressureTokens: 25_000, projectedTokens: 30_000, contextWindow: 100_000 };
  assert.deepEqual(contextPressureForModel(
    pressure, { provider: 'alpha', model: 'large' }, catalog,
  ), { pressureTokens: 25_000, projectedTokens: 30_000, contextWindow: 500_000 });
  assert.deepEqual(contextPressureForModel(
    pressure, { provider: 'alpha', model: 'unknown' }, catalog,
  ), { pressureTokens: 25_000, projectedTokens: 30_000 });
});

test('durable compaction events project running, summary, and completed session activity', () => {
  assert.deepEqual(parseCompactionEvent({
    type: 'compaction/start', time: 100, data: { compactionId: 'compact-1', turn: null },
  }), { type: 'start', id: 'compact-1', time: 100 });
  assert.deepEqual(parseCompactionEvent({
    type: 'compaction/summary', time: 200,
    data: { compactionId: 'compact-1', shadowedSeqs: [1, 2, 3], shadowedTokenCount: 42_000 },
  }), { type: 'summary', id: 'compact-1', itemCount: 3, tokenCount: 42_000 });
  assert.deepEqual(parseCompactionEvent({
    type: 'compaction/end', time: 300, data: { compactionId: 'compact-1', turn: null },
  }), { type: 'end', id: 'compact-1', time: 300 });
});

test('tabs restore through the serializer and Stop uses DSH session cancellation', async () => {
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  const client = await readFile(new URL('../vscode/src/dshClient.ts', import.meta.url), 'utf8');
  assert.match(extension, /registerWebviewPanelSerializer\(CHAT_EDITOR_VIEW_TYPE/);
  assert.match(extension, /restoredSessionId/);
  assert.match(client, /restoredSessionId \?\?/);
  assert.match(client, /reasoningDisclosureId/);
  assert.match(client, /context:\$\{String\(event\.seq\)\}/);
  assert.match(client, /callCanonicalRemote\(graph, 'session', 'modelCatalog'/);
  assert.match(client, /binding\.session\.beginSubmission/);
  assert.match(client, /binding\.session\.loadOlder/);
  assert.match(client, /callCanonicalRemote\(this\.requireCanonical\(\)\.graph, 'session', 'selectModel'/);
  assert.match(client, /projections\.faceOf\('modelSelection'\)/);
  assert.match(client, /projections\.faceOf\('contextPressure'\)/);
  assert.match(client, /function modelLabelMap/);
  assert.match(client, /binding\.session\.cancel/);
  assert.match(client, /retaining pending DSH inbox work/);
});

test('managed launch authentication rejects another origin before connecting', async () => {
  await assert.rejects(
    exchangeLaunchUrl('http://127.0.0.1:9999/?token=wrong'),
    /Expected the launch URL printed by DSH/,
  );
});
