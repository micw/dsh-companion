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
  parseCostSummary,
  parseModelCatalog,
  parsePermissionSelection,
  parseProviderAccountSnapshot,
  parseSessionListSnapshot,
  parseSettingsDescribe,
  reconcileSettlementAccounting,
} from '../vscode/out/dshClient.js';

test('the editor has output, process, persistent state, composer, send, and stop support', async () => {
  const script = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
  const style = await readFile(new URL('../vscode/media/style.css', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  const dshClient = await readFile(new URL('../vscode/src/dshClient.ts', import.meta.url), 'utf8');
  const sessionTree = await readFile(new URL('../vscode/src/sessionTree.ts', import.meta.url), 'utf8');
  const sessionsScript = await readFile(new URL('../vscode/media/sessions.js', import.meta.url), 'utf8');
  const sessionsStyle = await readFile(new URL('../vscode/media/sessions.css', import.meta.url), 'utf8');
  assert.match(script, /getElementById\('output'\)/);
  assert.match(script, /getElementById\('sticky-prompt'\)/);
  assert.match(script, /getElementById\('queue'\)/);
  assert.match(script, /getElementById\('composer'\)/);
  assert.match(script, /getElementById\('prompt'\)/);
  assert.match(script, /getElementById\('model-trigger'\)/);
  assert.match(script, /getElementById\('permission-select'\)/);
  assert.match(script, /function renderPermissionSelect/);
  assert.match(script, /if \(item\.value === 'workspace-write'\) return 'Workspace Write'/);
  assert.match(script, /if \(item\.value === 'danger-full-access'\) return 'Full access'/);
  assert.match(script, /type: 'selectPermission'/);
  assert.match(script, /getElementById\('context-trigger'\)/);
  assert.match(script, /function renderModelPicker/);
  assert.match(script, /function renderEffortMenu/);
  assert.match(script, /getElementById\('provider-settings-trigger'\)/);
  assert.match(script, /function openProviderSettings/);
  assert.match(script, /message\.type === 'openProviderSettings'[\s\S]*openProviderSettings\(\)/);
  assert.match(script, /function renderProviderSettings/);
  assert.match(script, /type: 'saveProviderSettings'/);
  assert.match(script, /provider\.kind === 'dynamic' \? 'API URL' : 'Service URL'/);
  assert.match(script, /\['native', 'catalog', 'dynamic', 'wrapper'\]\.includes\(provider\.kind\)/);
  assert.doesNotMatch(script, /value\.providers\.length !== 5/);
  assert.match(script, /providerSettingsStatus\.textContent === 'Loading providers…'/);
  assert.match(script, /Provider settings request timed out before the Extension returned a result/);
  assert.match(script, /Provider settings response rejected: \$\{validationError\}/);
  assert.match(script, /type: 'loadProviderSettings', requestId/);
  assert.match(dshClient, /callCanonicalRemote\(graph, 'llm', 'listProviderFamilies'\)/);
  assert.match(dshClient, /'llm',\s*'saveProviderInstance'/);
  assert.match(dshClient, /current\.instanceId === undefined/);
  assert.doesNotMatch(dshClient, /removeLegacyOpenRouterProfile|restoreLegacyOpenRouterProfile/);
  assert.match(script, /testsConnection \? 'Save & Test' : 'Save'/);
  assert.match(script, /Connection verified · \$\{String\(message\.modelCount\)\} models loaded/);
  assert.match(script, /`\$\{found\.group\.name\} \/ \$\{found\.model\.name\}`/);
  assert.match(script, /type: 'setProviderModelEnabled'/);
  assert.match(script, /type: 'setProviderModelsEnabled'/);
  assert.match(script, /getElementById\('provider-settings-search'\)/);
  assert.match(script, /getElementById\('provider-settings-filter'\)/);
  assert.match(script, /\['Enable all', true\], \['Disable all', false\]/);
  assert.match(script, /providerSettingsList\.append\(providerSettingsCard\(provider, models\)\)/);
  assert.doesNotMatch(script, /if \(!providerMatches && models\.length === 0\) continue/);
  assert.match(script, /const models = providerEnabled \? provider\.models\.filter/);
  assert.match(script, /Models \(\$\{String\(provider\.models\.length\)\}\) · provider disabled/);
  assert.match(script, /models\.open = draft\.enabled &&/);
  assert.match(script, /const previousScrollTop = providerSettingsList\.scrollTop/);
  assert.match(script, /providerSettingsList\.scrollTop = previousScrollTop/);
  assert.match(script, /`provider-settings:\$\{provider\.id\}:models`/);
  assert.match(script, /state\.disclosures\[disclosureId\] = models\.open/);
  assert.match(script, /Credentials are stored by DSH and are never read back/);
  assert.match(script, /send\.disabled = [^;]+!selectedModelEnabled\(\)/);
  assert.match(script, /if \(effort === undefined\) return 'Provider default'/);
  assert.match(script, /const efforts = \[\s*\{ id: undefined, name: 'Provider default' \}/);
  assert.doesNotMatch(script, /reasoningEffort \?\? model\.reasoning\.defaultEffort/);
  assert.match(script, /function renderContextMeter/);
  assert.match(script, /getElementById\('provider-usage-trigger'\)/);
  assert.match(script, /getElementById\('session-info-trigger'\)/);
  assert.match(script, /getElementById\('session-info-copy'\)/);
  assert.match(script, /function renderSessionInformation/);
  assert.match(script, /function setSessionInfoOpen/);
  assert.match(script, /sessionInfoPinned = !sessionInfoPinned;\s*setSessionInfoOpen\(sessionInfoPinned\)/);
  assert.match(script, /type: 'copySessionId'/);
  assert.match(script, /function renderProviderUsagePanel/);
  assert.match(script, /function allowanceTimeMarkerPercent/);
  assert.match(script, /className = 'provider-usage-time-marker'/);
  assert.match(script, /aria-valuenow', String\(width\)/);
  assert.match(script, /providerUsageRendering/);
  assert.match(script, /compactCostSummary\(sessionCost, 3\)/);
  assert.match(script, /amount\.currency === 'USD' \? 'en-US' : undefined/);
  assert.match(script, /money\.remainingNanos \}\)\} remaining/);
  assert.match(script, /money\.usedNanos \}\)\}`\s*\+ ` of/);
  assert.doesNotMatch(script, /setInterval\(renderProviderUsage/);
  assert.match(script, /type: 'refreshProviderUsage'/);
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
  assert.match(script, /function appendModelStatus/);
  assert.match(script, /reasoning-token-progress/);
  assert.match(script, /reasoning tokens/);
  assert.match(script, /function setMessageTime/);
  assert.match(script, /function completeTurn/);
  assert.match(script, /function markTurnIncomplete/);
  assert.match(script, /Interrupted/);
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
  assert.match(script, /function costControl/);
  assert.match(script, /function compactCostSummary/);
  assert.match(script, /known subtotal/);
  assert.match(script, /return `≥\$\{amount\} known`/);
  assert.match(script, /return `\$\{amount\} equivalent`/);
  assert.match(script, /return `Σ \$\{amount\}`/);
  assert.match(script, /function renderSessionCost/);
  assert.match(dshClient, /`\/compact --provider \$\{selection\.provider\} --model \$\{selection\.model\}`/);
  assert.match(dshClient, /snapshots\.filter\(snapshot => snapshot\.refreshing\)/);
  assert.match(dshClient, /companionProviderAccounts', 'refresh'/);
  assert.match(dshClient, /publishProviderAccounts\(false\)/);
  assert.doesNotMatch(dshClient, /providerAccountsTimer/);
  assert.doesNotMatch(script, /sessionCostControl\.open/);
  assert.match(extension, /<div id="session-cost-control">[\s\S]*<strong id="session-cost-summary">/);
  assert.match(script, /function timingControl/);
  assert.match(script, /function closeStatControls/);
  assert.match(script, /function renderQueue/);
  assert.match(script, /function requestOlderHistory/);
  assert.match(script, /requestOlderHistory\(true\)/);
  assert.match(script, /initial && output\.querySelector\('\.message\.user'\)/);
  assert.match(script, /function resetTranscript/);
  assert.match(script, /function beginHistoryPrepend/);
  assert.match(script, /mergePrependedTurnState/);
  assert.match(script, /placeTurnProcessAfterMessage/);
  assert.match(script, /following: scrollMode === 'follow'/);
  assert.match(script, /if \(previous\.following\) \{[\s\S]*followOutput\(\)/);
  assert.match(script, /reattachTranscriptTail\(output, \[\.\.\.fragment\.childNodes\], previous\.nodes\)/);
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
  assert.match(style, /#provider-settings-modal \{/);
  assert.match(style, /#provider-settings-surface \{/);
  assert.match(style, /#provider-settings-toolbar \{/);
  assert.match(style, /\.provider-settings-actions \{[^}]*grid-column: 1 \/ -1/);
  assert.match(style, /\.provider-settings-model-actions \{/);
  assert.match(style, /#permission-select \{/);
  assert.match(style, /#permission-select \{[\s\S]*appearance: none;[\s\S]*background: transparent/);
  assert.match(style, /#permission-control::after \{/);
  assert.match(style, /#effort-menu \{/);
  assert.match(style, /#context-panel \{/);
  assert.match(style, /#provider-usage-panel \{/);
  assert.match(style, /#session-info-panel \{/);
  assert.match(style, /#session-cost-control/);
  assert.match(style, /#session-cost-breakdown/);
  assert.match(style, /\.session-info-session:hover #session-info-copy/);
  assert.match(style, /\.session-info-session:focus-within #session-info-copy/);
  assert.match(style, /\.provider-usage-time-marker \{/);
  assert.match(style, /\.compaction-activity/);
  assert.match(style, /#status\[data-running='true'\]::before/);
  assert.match(extension, /rows="1"/);
  assert.match(extension, /id="sticky-prompt-jump"[\s\S]*<svg[^>]+><path d="M3\.5 10/);
  assert.match(extension, /id="scroll-bottom"[\s\S]*<svg[^>]+><path d="m3\.5 6/);
  assert.match(extension, /Ask DSH Companion… \(Enter sends, Shift\+Enter = newline\)/);
  assert.match(extension, /isSelectModelMessage/);
  assert.match(extension, /isLoadProviderSettingsMessage/);
  assert.match(extension, /isSaveProviderSettingsMessage/);
  assert.match(extension, /client\.testProviderConnection\(message\.provider\)/);
  assert.match(extension, /type: 'providerSettingsTested'/);
  assert.match(extension, /isSetProviderModelEnabledMessage/);
  assert.match(extension, /isSetProviderModelsEnabledMessage/);
  assert.match(extension, /id="provider-settings-modal"/);
  assert.match(extension, /id="provider-settings-trigger"/);
  assert.match(extension, /id="provider-settings-search"/);
  assert.match(extension, /id="provider-settings-filter"/);
  assert.match(extension, /isSelectPermissionMessage/);
  assert.match(extension, /Full access disables filesystem sandboxing/);
  assert.match(extension, /id="permission-select" aria-label="Session permission"/);
  assert.match(extension, /isRefreshProviderUsageMessage/);
  assert.match(extension, /id="provider-usage" hidden/);
  assert.match(extension, /id="session-info" hidden/);
  assert.match(extension, /id="session-cost-row"[\s\S]*id="session-cost-summary"/);
  assert.match(extension, /isReadyMessage/);
  assert.match(extension, /new WebviewMessenger/);
  assert.match(extension, /transcript-state\.js/);
  assert.match(script, /message\.type === 'batch'/);
  assert.match(script, /vscode\.postMessage\(\{ type: 'ready' \}\)/);
  assert.match(extension, /type: 'sessionInformation'/);
  assert.match(extension, /type: 'sessionCost'/);
  assert.match(extension, /context\.extension\.packageJSON\.version/);
  assert.match(extension, /runtime\.backendVersion\(\)/);
  assert.match(extension, /Send the first prompt before copying a Session id/);
  assert.match(extension, /Object\.keys\(value\)\.length === 1[\s\S]*copySessionId/);
  assert.doesNotMatch(extension, /copySessionId[\s\S]{0,200}message\.sessionId/);
  assert.match(extension, /runtime\.clientModule/);
  assert.match(extension, /registerWebviewViewProvider\('dshCompanion\.sessions'/);
  assert.match(extension, /registerCommand\('dshCompanion\.openProviderSettings'/);
  assert.match(extension, /post\(panel, \{ type: 'openProviderSettings' \}\)/);
  assert.match(extension, /panelsBySessionId\.get\(sessionId\)/);
  assert.match(extension, /DshSessionBrowser\.connect/);
  assert.match(sessionTree, /placeholder="Search questions and answers…"/);
  assert.match(sessionTree, /class SessionSidebarProvider/);
  assert.match(sessionTree, /parseSidebarMessage/);
  assert.match(sessionsScript, /search\.addEventListener\('input'/);
  assert.match(sessionsScript, /setTimeout\(\(\) => vscode\.postMessage\(\{ type: 'search', query \}\), 200\)/);
  assert.match(sessionsScript, /Connecting to DSH…/);
  assert.match(sessionsScript, /row\.title = \[item\.title, item\.cwd, new Date\(item\.updatedAt\)\.toLocaleString\(\), item\.sessionId\]/);
  assert.match(sessionsStyle, /#status\[hidden\] \{ display: none; \}/);
  assert.doesNotMatch(sessionsStyle, /session-spin/);
  assert.match(dshClient, /graph\.sessions\.search\(normalized, signal\)/);
  assert.match(sessionTree, /withProgress\(\{ location: \{ viewId: 'dshCompanion\.sessions' \} \}/);
  assert.match(sessionTree, /session\.title\.toLocaleLowerCase\(\)\.includes\(normalized\)/);
  assert.doesNotMatch(sessionTree, /if \(this\.query\.length > 0\) await this\.search/);
  assert.match(sessionsScript, /function updateActiveRows\(\)/);
  assert.match(sessionsScript, /searchResults\?\.query === search\.value\.trim\(\)/);
  assert.match(extension, /sessionCreated: \(sessionId: string\)/);
  assert.match(extension, /post\(panel, \{ type: 'connected' \}\)/);
  assert.match(dshClient, /await this\.ensureSession\(\);[\s\S]*beginSubmission/);
  assert.match(dshClient, /const sessionId = await graph\.sessions\.create/);
  assert.match(dshClient, /this\.pendingModelSelection = \{ \.\.\.selection \}/);
  assert.doesNotMatch(dshClient, /restoredSessionId \?\? await graph\.sessions\.create/);
  assert.match(extension, /running: \(value: boolean\)[\s\S]*onSessionListChange\?\.\(\)/);
  assert.match(sessionTree, /requestRefresh\(\): void/);
  assert.match(sessionTree, /this\.browser \?\? this\.browserPromise/);
  assert.match(extension, /if \(runtime === undefined\) \{[\s\S]*runtime = await connectRuntime\(context\)/);
  assert.match(extension, /Managed DSH runtime is unavailable/);
  assert.match(extension, /runtime\.origin !== DSH_ORIGIN && runtime\.origin !== PACKAGED_DSH_ORIGIN/);
  assert.match(extension, /vscode\.env\.openExternal\(vscode\.Uri\.parse\(await runtime\.bootstrapUrl\(\)\)\)/);
  assert.doesNotMatch(extension, /showInputBox|Paste the launch URL/);
  assert.match(dshClient, /connectCanonical/);
  assert.match(dshClient, /mountCompanionProviderRemotes/);
  assert.match(dshClient, /faceOf\('modelCost'\)/);
  assert.match(dshClient, /faceOf\('permissions'\)/);
  assert.match(dshClient, /`\/permission \$\{preset\}`/);
  assert.match(dshClient, /accountingFromStream/);
  assert.match(dshClient, /reasoningStatusId/);
  assert.match(dshClient, /status\.kind === 'reasoning-token-progress'/);
  assert.match(dshClient, /emitFinalReasoningStatus/);
  assert.match(dshClient, /await client\.publishProviderAccounts\(\)/);
  assert.match(dshClient, /callCanonicalRemote\(graph, 'settings', 'describe'\)/);
  assert.match(dshClient, /callCanonicalRemote\(graph, 'credentials', 'describe', refs\)/);
  assert.match(dshClient, /callCanonicalRemote\(graph, 'credentials', 'set', credentialRef, apiKey\)/);
  assert.match(dshClient, /companionProviderCatalog', 'refresh', provider/);
  assert.match(dshClient, /companionProviderAccounts', 'refresh', provider/);
  assert.match(dshClient, /credentials', 'set', credentialRef, apiKey[\s\S]*await this\.refreshModelCatalog\(\)/);
  assert.match(dshClient, /models\.map\(model => \(\{[\s\S]*value: enabled \? 'enabled' : 'disabled'/);
  assert.match(dshClient, /definition\.kind === 'wrapper'[\s\S]*wrapperCatalog\?\.models\.filter[\s\S]*catalogGroup\?\.models/);
  assert.doesNotMatch(dshClient, /credentials', 'get'/);
  assert.match(dshClient, /const request = \+\+this\.providerAccountsRequest/);
  assert.match(dshClient, /if \(this\.connectionInterrupted\)[\s\S]*this\.publishProviderAccounts\(\)/);
  assert.match(dshClient, /gateway\/invocation-unavailable/);
  assert.match(dshClient, /!older && !fromSnapshot[\s\S]*this\.publishProviderAccounts\(\)/);
  assert.match(dshClient, /connection\.state\.subscribe/);
  assert.doesNotMatch(dshClient, /remote\.mux|new WebSocket|Handwritten DSH/);
});

test('the canonical Session list retains root order and excludes subagent rows', () => {
  const snapshot = parseSessionListSnapshot({
    phase: 'ready',
    ids: ['session-b', 'child', 'session-a'],
    byId: {
      'session-a': {
        id: 'session-a', displayTitle: 'Alpha', running: false, completed: false,
        blank: false, updatedAt: 100, cwd: '/workspace/a',
      },
      'session-b': {
        id: 'session-b', displayTitle: 'Beta', running: true, completed: false,
        blank: false, updatedAt: 200,
      },
      child: {
        id: 'child', displayTitle: 'Child', running: false, completed: true,
        blank: false, updatedAt: 150, origin: 'subagent',
      },
    },
  });
  assert.deepEqual(snapshot, {
    phase: 'ready',
    sessions: [
      {
        sessionId: 'session-b', title: 'Beta', running: true, completed: false,
        blank: false, updatedAt: 200,
      },
      {
        sessionId: 'session-a', title: 'Alpha', running: false, completed: false,
        blank: false, updatedAt: 100, cwd: '/workspace/a',
      },
    ],
  });
});

test('the canonical Session list rejects duplicate and malformed identities', () => {
  assert.throws(() => parseSessionListSnapshot({
    phase: 'ready',
    ids: ['same', 'same'],
    byId: { same: { id: 'same', displayTitle: 'Same', running: false, blank: false, updatedAt: 1 } },
  }), /invalid Session list entry/);
  assert.throws(() => parseSessionListSnapshot({
    phase: 'ready',
    ids: ['expected'],
    byId: { expected: { id: 'other', displayTitle: 'Other', running: false, blank: false, updatedAt: 1 } },
  }), /invalid Session list entry/);
});

test('provider settings descriptions retain only redacted namespace values', () => {
  const parsed = parseSettingsDescribe({
    writable: true,
    hasDocument: true,
    namespaces: [{
      ns: 'llm-deepseek',
      schema: {},
      value: { enabled: false, apiKeyEnv: 'DEEPSEEK_API_KEY' },
      applies: 'live',
      secrets: [{ path: ['secret'], set: true }],
      revision: 7,
    }],
  });
  assert.equal(parsed.writable, true);
  assert.deepEqual(parsed.namespaces.get('llm-deepseek'), {
    value: { enabled: false, apiKeyEnv: 'DEEPSEEK_API_KEY' },
    revision: 7,
  });
  assert.throws(() => parseSettingsDescribe({
    writable: true,
    namespaces: [{ ns: 'llm-deepseek', value: {}, revision: -1 }],
  }), /invalid settings namespace/u);
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
  assert.match(installer, /origin = PACKAGED_DSH_ORIGIN/);
  assert.match(installer, /'--port', new URL\(origin\)\.port/);
  assert.match(smoke, /server\.listen\(0, '127\.0\.0\.1'/);
  assert.match(smoke, /unauthenticated\.status !== 401/);
  assert.match(smoke, /Managed DSH Web UI omitted its dynamic client bootstrap/);
  assert.match(smoke, /permissionSelection: \(\) => \{ projected\.permissionSelections \+= 1/);
});

test('provider account snapshots retain validated allowance and reset facts', () => {
  assert.deepEqual(parseProviderAccountSnapshot({
    provider: 'wrapper',
    status: 'ready',
    observedAt: 1_000,
    refreshing: false,
    value: {
      provider: 'wrapper',
      accountStatus: 'ready',
      plan: { id: 'plus', name: 'Plus' },
      credits: { balance: '12.25', unlimited: false },
      activeAllowance: 'global',
      allowances: [{
        id: 'global',
        name: 'Overall',
        observedAt: 900,
        ageSeconds: 100,
        primary: {
          usedPercent: 24.5,
          monetary: { currency: 'USD', limitNanos: 20_000_000_000, remainingNanos: 15_100_000_000 },
          windowSeconds: 18_000,
          resetsAt: 20_000,
        },
        secondary: { usedPercent: 70, resetsInSeconds: 300 },
      }],
    },
  }), {
    provider: 'wrapper',
    status: 'ready',
    observedAt: 1_000,
    refreshing: false,
    value: {
      accountStatus: 'ready',
      plan: { id: 'plus', name: 'Plus' },
      credits: { balance: '12.25', unlimited: false },
      activeAllowance: 'global',
      allowances: [{
        id: 'global',
        name: 'Overall',
        observedAt: 900,
        ageSeconds: 100,
        primary: {
          usedPercent: 24.5,
          monetary: { currency: 'USD', limitNanos: 20_000_000_000, remainingNanos: 15_100_000_000 },
          windowSeconds: 18_000,
          resetsAt: 20_000,
        },
        secondary: { usedPercent: 70, resetsInSeconds: 300 },
      }],
    },
  });
  assert.equal(parseProviderAccountSnapshot({
    provider: 'wrapper', status: 'ready', refreshing: false,
    value: {
      provider: 'wrapper', accountStatus: 'ready',
      allowances: [{ id: 'global', primary: { usedPercent: 100, resetsInSeconds: -1 } }],
    },
  }).value.allowances[0].primary.resetsInSeconds, -1);
  assert.throws(() => parseProviderAccountSnapshot({
    provider: 'wrapper', status: 'ready', refreshing: false,
    value: { provider: 'other', accountStatus: 'ready', allowances: [] },
  }), /invalid provider-account value/u);
  assert.throws(() => parseProviderAccountSnapshot({
    provider: 'wrapper', status: 'ready', refreshing: false,
    value: {
      provider: 'wrapper', accountStatus: 'ready',
      allowances: [{
        id: 'global',
        primary: {
          usedPercent: 10,
          monetary: { currency: 'USD', limitNanos: 1, remainingNanos: 2 },
        },
      }],
    },
  }), /invalid provider allowance money/u);
});

test('session cost projections validate currencies, kinds, and safe integer nanos', () => {
  assert.deepEqual(parseCostSummary({
    totals: [{ currency: 'USD', nanos: 300_000_000 }],
    coverage: { accountedTurns: 2, unaccountedTurns: 1 },
    breakdown: [
      { kind: 'reported', currency: 'USD', nanos: 100_000_000, calls: 1 },
      { kind: 'virtual', currency: 'USD', nanos: 200_000_000, calls: 1 },
    ],
  }), {
    totals: [{ currency: 'USD', nanos: 300_000_000 }],
    coverage: { accountedTurns: 2, unaccountedTurns: 1 },
    breakdown: [
      { kind: 'reported', currency: 'USD', nanos: 100_000_000, calls: 1 },
      { kind: 'virtual', currency: 'USD', nanos: 200_000_000, calls: 1 },
    ],
  });
  assert.throws(() => parseCostSummary({
    totals: [{ currency: 'USD', nanos: Number.MAX_SAFE_INTEGER + 1 }],
    coverage: { accountedTurns: 0, unaccountedTurns: 0 },
    breakdown: [],
  }), /invalid model-cost total/u);
});

test('settlement accounting rejects direct and stream disagreement', () => {
  const direct = {
    scope: 'call',
    costs: [{ kind: 'reported', amount: { currency: 'USD', nanos: 1 }, source: 'provider' }],
  };
  assert.equal(reconcileSettlementAccounting(direct, structuredClone(direct)), direct);
  assert.equal(reconcileSettlementAccounting(direct, {
    scope: 'call',
    costs: [{ kind: 'reported', amount: { currency: 'USD', nanos: 2 }, source: 'provider' }],
  }), undefined);
  assert.equal(reconcileSettlementAccounting({ ...direct, extra: true }, undefined), undefined);
});

test('turn statistics omit a partial cost when any settled attempt lacks accounting', () => {
  const stats = new TurnStats(0);
  stats.addAttempt(1, 1, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, undefined, {
    costs: [{ kind: 'reported', amount: { currency: 'USD', nanos: 1 }, source: 'provider' }],
  });
  stats.addAttempt(2, 2, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  assert.equal(stats.finish(3, 'completed').cost, undefined);
});

test('turn statistics accept one final cumulative turn-cost snapshot', () => {
  const stats = new TurnStats(0);
  stats.addAttempt(1, 1, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
  stats.addAttempt(2, 2, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, undefined, {
    scope: 'turn',
    costs: [{ kind: 'virtual', amount: { currency: 'USD', nanos: 500 }, source: 'wrapper delta' }],
  });
  assert.deepEqual(stats.finish(3, 'completed').cost, {
    totals: [{ currency: 'USD', nanos: 500 }],
    breakdown: [{ kind: 'virtual', currency: 'USD', nanos: 500, calls: 2 }],
    details: [{
      scope: 'turn',
      kind: 'virtual',
      currency: 'USD',
      nanos: 500,
      calls: 2,
      sources: ['wrapper delta'],
    }],
  });
});

test('turn statistics aggregate usage, cost, and timing across attempts', () => {
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
  }, undefined, { scope: 'call', costs: [{
    kind: 'reported',
    amount: { currency: 'USD', nanos: 100_000_000 },
    source: 'provider response',
    breakdown: { inputNanos: 60_000_000 },
  }] });
  stats.startStep(2, 1_600);
  stats.firstToken(2, 1_700);
  stats.addAttempt(2, 1_900, {
    inputTokens: 20,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    outputTokens: 10,
    reasoningTokens: 2,
    totalTokens: 110,
  }, undefined, { scope: 'call', costs: [{
    kind: 'virtual',
    amount: { currency: 'USD', nanos: 200_000_000 },
    source: 'reference tariff',
    tariffVersion: '2026-09',
  }] });

  assert.deepEqual(stats.finish(2_000, 'completed'), {
    completedAt: 2_000,
    runMs: 1_000,
    reason: 'completed',
    cost: {
      totals: [{ currency: 'USD', nanos: 300_000_000 }],
      breakdown: [{
        kind: 'reported', currency: 'USD', nanos: 100_000_000, calls: 1,
      }, {
        kind: 'virtual', currency: 'USD', nanos: 200_000_000, calls: 1,
      }],
      details: [{
        scope: 'call',
        kind: 'reported',
        currency: 'USD',
        nanos: 100_000_000,
        calls: 1,
        routes: ['gpt/model-a'],
        sources: ['provider response'],
        components: { inputNanos: 60_000_000 },
      }, {
        scope: 'call',
        kind: 'virtual',
        currency: 'USD',
        nanos: 200_000_000,
        calls: 1,
        routes: ['gpt/model-a'],
        sources: ['reference tariff'],
        tariffVersions: ['2026-09'],
      }],
    },
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

test('permission projections retain the DSH-owned options and current preset', () => {
  assert.deepEqual(parsePermissionSelection({
    options: [
      { value: 'workspace-write', name: 'Workspace Write', description: 'Confined writes.' },
      { value: 'danger-full-access', name: 'Full Access', description: 'Unconfined access.' },
    ],
    currentValue: 'workspace-write',
  }), {
    options: [
      { value: 'workspace-write', name: 'Workspace Write', description: 'Confined writes.' },
      { value: 'danger-full-access', name: 'Full Access', description: 'Unconfined access.' },
    ],
    currentValue: 'workspace-write',
  });
  assert.throws(() => parsePermissionSelection({
    options: [{ value: 'workspace-write', name: 'Workspace Write' }],
    currentValue: 'danger-full-access',
  }), /does not contain its current value/u);
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
  assert.match(client, /if \(restoredSessionId !== undefined\)[\s\S]*await client\.attachSession\(restoredSessionId\)/);
  assert.match(client, /reasoningDisclosureId/);
  assert.match(client, /context:\$\{String\(event\.seq\)\}/);
  assert.match(client, /callCanonicalRemote\(graph, 'session', 'modelCatalog'/);
  assert.match(client, /binding\.session\.beginSubmission/);
  assert.match(client, /this\.requireBinding\(\)\.session\.loadOlder/);
  assert.match(client, /selectModelForSession/);
  assert.match(client, /projections\.faceOf\('modelSelection'\)/);
  assert.match(client, /projections\.faceOf\('contextPressure'\)/);
  assert.match(client, /function modelLabelMap/);
  assert.match(client, /this\.requireBinding\(\)\.session\.cancel/);
  assert.match(client, /retaining pending DSH inbox work/);
});

test('managed launch authentication rejects another origin before connecting', async () => {
  await assert.rejects(
    exchangeLaunchUrl('http://127.0.0.1:9999/?token=wrong'),
    /Expected the launch URL printed by DSH/,
  );
});
