import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DSH_ORIGIN,
  DshClient,
  PACKAGED_DSH_ORIGIN,
  TurnStats,
  advanceContextPressure,
  advanceModelSelection,
  contextPressureForModel,
  exchangeLaunchUrl,
  parseInboxQueue,
  parseCompactionEvent,
  parseCostSummary,
  parseModelCatalog,
  parsePermissionCatalog,
  parsePermissionSelection,
  permissionDefaultSelection,
  parseProviderAccountSnapshot,
  parseSessionListSnapshot,
  parseSettingsDescribe,
  reconcileSettlementAccounting,
} from '../vscode/out/dshClient.js';

test('Session Information explicitly refreshes the DSH-owned title for its bound editor', async () => {
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  const client = await readFile(new URL('../vscode/src/dshClient.ts', import.meta.url), 'utf8');
  const script = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
  assert.match(extension, /id="session-info-refresh-title"/);
  assert.match(extension, /isRefreshSessionTitleMessage\(message\).*refreshSessionTitle\(panel, ready\)/);
  assert.match(extension, /const title = await \(await ready\)\.refreshTitle\(\)/);
  assert.match(client, /'companionSessionTitle', 'refreshTitle', this\.requireSessionId\(\)/);
  assert.match(script, /vscode\.postMessage\(\{ type: 'refreshSessionTitle' \}\)/);
  assert.match(script, /sessionInfoTitle\.textContent = message\.title/);
  assert.match(script, /sessionInfoRefreshTitle\.disabled = false/);
});

test('the first canonical event window replays its full snapshot before subscribing to deltas', async () => {
  const client = await readFile(new URL('../vscode/src/dshClient.ts', import.meta.url), 'utf8');
  assert.match(client, /let eventWindowInitialized = false/);
  assert.match(client, /receiveCanonicalWindow\(binding\.eventSource\.getSnapshot\(\), !eventWindowInitialized\)/);
  assert.match(client, /if \(initial\) \{[\s\S]*?replaceCanonicalWindow\(value\.entries, value\.hasMore\)/);
});

test('an orphan Tool result does not create a Webview Turn placeholder', async () => {
  const script = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
  const processEvent = script.slice(script.indexOf('function applyProcessEvent(event) {'),
    script.indexOf('function createProcessSegment('));
  assert.match(processEvent,
    /if \(event\.type === 'tool-result'\) \{\s*appendToolResult\(event\);\s*return;\s*\}[\s\S]*?activeTurn = event\.turn;\s*const turn = ensureTurn\(event\.turn\)/);
  assert.match(script, /function appendToolResult\(event\) \{\s*const row = tools\.get\(event\.callId\);\s*if \(row === undefined\) return;/);
});

test('tab titles and activity are derived from canonical Session and Turn events', async () => {
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  const client = await readFile(new URL('../vscode/src/dshClient.ts', import.meta.url), 'utf8');
  const sidebar = await readFile(new URL('../vscode/media/sessions.js', import.meta.url), 'utf8');
  assert.match(client, /graph\.sessions\.list\.subscribe\(publishSummary\)/);
  assert.match(client, /sink\.sessionSummary\(parseSessionListSnapshot/);
  assert.match(extension, /panel\.title = summary\.title/);
  assert.match(extension, /tabStatus\.end\(time, reason\)/);
  assert.match(extension, /context\.globalState\.update\(seenKey\(sessionId\), watermark\)/);
  assert.match(sidebar, /title\.textContent = item\.title/);
});

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
  assert.match(dshClient, /'llm', 'deleteProviderInstance', familyId, instanceId/);
  assert.match(dshClient, /families: families\.map\(family =>/);
  assert.match(script, /`Add \$\{family\.name\} instance`/);
  assert.match(script, /type: 'createProviderInstance'/);
  assert.match(script, /type: 'deleteProviderInstance'/);
  assert.match(script, /provider\.instanceId === undefined \? \{\} : \{ displayName: draft\.displayName \}/);
  assert.match(extension, /isCreateProviderInstanceMessage/);
  assert.match(extension, /isDeleteProviderInstanceMessage/);
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
  assert.match(script, /modelTrigger\.dataset\.configure = modelCatalog\?\.routableProviders\.length === 0/);
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
  assert.match(script, /item\.contextLabel \?\? 'Context update'/);
  assert.match(script, /event\.summary \?\? 'Delivered'/);
  assert.match(script, /compactCostSummary\(sessionCost, 3\)/);
  assert.match(script, /amount\.currency === 'USD' \? 'en-US' : undefined/);
  assert.match(script, /money\.remainingNanos \}\)\} remaining/);
  assert.match(script, /money\.usedNanos \}\)\}`\s*\+ ` of/);
  assert.doesNotMatch(script, /setInterval\(renderProviderUsage/);
  assert.match(script, /type: 'refreshProviderUsage'/);
  assert.match(script, /function applyCompactionEvent/);
  assert.match(script, /compactionSubmitGate\.request\(\);\s*setCompacting\(true\)/);
  assert.match(script, /compactionSubmitGate\.observe\(message\.event\)/);
  assert.match(script, /if \(compactionSubmitGate\.settle\(\)\) updateInputAvailability\(\)/);
  assert.match(script, /prompt\.disabled = compactionSubmitGate\.locked/);
  assert.match(script, /send\.disabled = [^;]*compactionSubmitGate\.locked/);
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
  assert.match(script, /advanceTurnProcessSegment/);
  assert.match(script, /placeEmptyTurnProcessAfterMessage/);
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
  assert.match(script, /document\.addEventListener\('selectionchange', flushAssistantRenders\)/);
  assert.match(script, /pendingAssistantRenders\.set\(activeAssistant, html\)/);
  assert.match(script, /reconcileTranscriptNodes\(body, template\.content\)/);
  assert.match(script, /captureAssistantSelection\(body, selection\)/);
  assert.match(script, /restoreAssistantSelection\(body, selection, savedSelection\)/);
  assert.match(script, /mermaid\.render\(/);
  assert.match(script, /new Blob\(\[svg\], \{ type: 'image\/svg\+xml' \}\)/);
  assert.match(script, /type: 'copyText', format, text: markdown/);
  assert.match(extension, /renderTimer \?\?= setTimeout\(flushRender, 32\)/);
  assert.doesNotMatch(script, /activeAssistant\.innerHTML = html/);
  assert.match(script, /function setOutputSticky/);
  assert.match(script, /function updateScrollButton/);
  assert.match(script, /scrollBottom\.addEventListener\('click', scrollToLatestOutput\)/);
  assert.match(script, /function scrollToLatestOutput\(\) \{\s*setOutputFollow\(\)/);
  assert.match(script, /stickyPromptJump\.addEventListener[\s\S]*setOutputSticky\(\)[\s\S]*scrollIntoView/);
  assert.match(script, /output\.contains\(selection\.anchorNode\)/);
  assert.match(script, /output\.scrollHeight - output\.scrollTop - output\.clientHeight < 32/);
  assert.match(script, /scrollModeAfterScroll\(scrollMode, nearBottom, userGesture, userScrollAwayIntent, recentDown\)/);
  assert.match(script, /const wasPointerScrolling = pointerScrolling/);
  assert.match(script, /const refreshScrollBounds = createScrollBoundsRefresher\(output, requestAnimationFrame,/);
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
  assert.match(style, /#output \{[\s\S]*overflow-anchor: none/);
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
  assert.match(style, /\.message-time, \.message \.role, \.turn-footer/);
  assert.match(style, /#sticky-prompt \{ user-select: none; \}/);
  assert.match(style, /\.compaction-activity/);
  assert.match(style, /#status\[data-running='true'\]::before/);
  assert.match(extension, /rows="1"/);
  assert.match(extension, /id="sticky-prompt-jump"[\s\S]*<svg[^>]+><path d="M3\.5 10/);
  assert.match(extension, /id="scroll-bottom"[\s\S]*<svg[^>]+><path d="m3\.5 6/);
  assert.match(extension, /Ask DSH Companion… \(Enter sends, Ctrl\+Enter = steer, Shift\+Enter = newline\)/);
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

test('provider settings descriptions retain only redacted values and their public schemas', () => {
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
    schema: {},
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
  assert.match(smoke, /sessionId: randomUUID\(\), cwd: storage, agentPreset: 'dsh-companion'/);
  assert.match(smoke, /providerSettings\.families\.some\(family => family\.id === 'openrouter'\)/);
  assert.match(smoke, /for \(let index = 0; index < 2; index \+= 1\)/);
  assert.match(smoke, /restored\[0\]\.dispose\(\);\s*await restored\[1\]\.loadOlder\(\)/);
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

test('permission catalogs provide the default draft selection', () => {
  assert.deepEqual(parsePermissionCatalog({
    options: [
      { value: 'auto', name: 'Auto' },
      { value: 'workspace-write', name: 'Workspace Write', description: 'Confined writes.' },
      { value: 'danger-full-access', name: 'Full Access', description: 'Unconfined access.' },
    ],
    defaultOptions: [
      { value: 'workspace-write', name: 'Workspace Write', description: 'Confined writes.' },
      { value: 'danger-full-access', name: 'Full Access', description: 'Unconfined access.' },
    ],
    defaultPreset: 'workspace-write',
  }), {
    options: [
      { value: 'auto', name: 'Auto' },
      { value: 'workspace-write', name: 'Workspace Write', description: 'Confined writes.' },
      { value: 'danger-full-access', name: 'Full Access', description: 'Unconfined access.' },
    ],
    currentValue: 'workspace-write',
  });
});

test('permission selector recovers after a missing restore projection without losing catalog options', () => {
  const selections = [];
  const catalog = {
    options: [
      { value: 'workspace-write', name: 'Workspace Write' },
      { value: 'danger-full-access', name: 'Full Access' },
    ],
    currentValue: 'workspace-write',
  };
  const client = new DshClient(undefined, {
    permissionSelection(value) { selections.push(value); },
  }, {
    default: { provider: 'provider', model: 'model' },
    routableProviders: ['provider'],
    groups: [],
    failures: [],
  }, {}, catalog);

  client.acceptPermissionProjection(undefined, 'connected');
  client.acceptPermissionProjection({ currentValue: 'workspace-write' }, 'connected');
  client.acceptPermissionProjection({ currentValue: 'custom' }, 'connected');
  client.acceptPermissionProjection({ currentValue: 'danger-full-access' }, 'connected');

  assert.deepEqual(selections, [
    undefined,
    catalog,
    { options: [...catalog.options, { value: 'custom', name: 'Custom' }], currentValue: 'custom' },
    { options: catalog.options, currentValue: 'danger-full-access' },
  ]);
});

test('Inbox projections retain authoritative queue order and request identities', () => {
  const value = {
    'next-turn': [{
      id: 'queued', source: { kind: 'user', rpcId: 'remote-queued' },
      content: [{ type: 'text', text: 'queued text' }],
    }],
    'next-step': [{
      id: 'steering', source: { kind: 'user', rpcId: 'remote-steering' },
      content: [{ type: 'text', text: 'steering text' }],
    }],
  };
  assert.deepEqual(parseInboxQueue(value, true, new Map([
    ['remote-queued', 'local-queued'], ['remote-steering', 'local-steering'],
  ])), [{
    id: 'steering', requestId: 'local-steering', sourceKind: 'user', text: 'steering text', textOnly: true,
    images: [], takeBackAvailable: true, placement: 'steering',
  }, {
    id: 'queued', requestId: 'local-queued', sourceKind: 'user', text: 'queued text', textOnly: true,
    images: [], takeBackAvailable: true, placement: 'queued',
  }]);
  assert.deepEqual(parseInboxQueue(value, false, new Map())[0], {
    id: 'steering', requestId: 'remote-steering', sourceKind: 'user', text: 'steering text', textOnly: true,
    images: [], takeBackAvailable: true, placement: 'context',
  });
});

test('composer and queue dock keep steering, removal, and take-back in the DSH Session flow', async () => {
  const script = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
  const style = await readFile(new URL('../vscode/media/style.css', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(script, /nextSubmitMode = submitModeForGesture\(running, controlKey, prompt\.value, compacting\)/);
  assert.match(script, /send\.addEventListener\('click', \(event\) => \{\s*event\.preventDefault\(\);\s*requestSubmission\(event\.ctrlKey\)/);
  assert.match(script, /prompt\.addEventListener\('keydown',[\s\S]*requestSubmission\(event\.ctrlKey\)/);
  assert.match(script, /try \{ composer\.requestSubmit\(\); \}\s*finally \{ nextSubmitMode = 'queue'; \}/);
  assert.match(script, /document\.addEventListener\('keydown', event => setControlHeld\(event\.ctrlKey\)\)/);
  assert.match(script, /document\.addEventListener\('keyup', event => setControlHeld\(event\.ctrlKey\)\)/);
  assert.match(script, /window\.addEventListener\('blur', \(\) => setControlHeld\(false\)\)/);
  assert.match(script, /send\.dataset\.mode = action\.mode/);
  assert.match(script, /sendLabel\.textContent = action\.label/);
  assert.match(script, /send\.setAttribute\('aria-label', action\.title\)/);
  assert.match(script, /type: 'submit', requestId, text, mode,\s*images: pendingImages\.map/);
  assert.match(script, /vscode\.postMessage\(\{ type: 'queueAction', itemId, action \}\)/);
  assert.match(script, /typeof item\.id === 'string' && item\.sourceKind === 'user'/);
  assert.match(script, /appendPendingAgentRows\(turn, activeTurn, hostQueue, pendingAgentRows, committedAgentIds/);
  assert.match(script, /settleAgentMessageRow\(pendingAgentRows, committedAgentIds, messageId, turn\.rows/);
  assert.match(script, /if \(item\.placement === 'queued'\) \{\s*const steer = document\.createElement\('button'\)/);
  assert.match(script, /steer\.disabled = !canSteerQueued\(item, running\) \|\| stopping/);
  assert.match(script, /requestQueueAction\(item\.id, 'steer'\)/);
  assert.match(script, /if \(message\.type === 'queueItemSteered'\)/);
  assert.match(script, /pendingQueueActions\.set\(itemId, action\)/);
  assert.match(script, /prompt\.readOnly = sending \|\| \[\.\.\.pendingQueueActions\.values\(\)\]\.includes\('takeBack'\)/);
  assert.match(script, /stop\.hidden = !running && !compacting && !hasWaitingQueue\(\)/);
  assert.match(script, /send\.disabled = [^;]*stopping/);
  assert.match(script, /appendMessage\('user', message\.text, undefined, message\.time, message\.step, message\.images\)/);
  assert.match(extension, /isQueueActionMessage\(message\).*queueAction\(panel, ready, message\)/);
  assert.match(extension, /await client\.steerQueued\(message\.itemId\)/);
  assert.match(extension, /post\(panel, \{ type: 'queueItemSteered', itemId: message\.itemId \}\)/);
  assert.match(extension, /stopAndClearQueue\(\)/);
  assert.match(extension, /id="send"[^>]*data-mode="send"[\s\S]*id="send-label"/);
  assert.match(style, /#send\[data-mode='steer'\] \.send-icon-steer/);
  assert.match(style, /\.queue-text \{[\s\S]*white-space: pre-wrap/);
});

test('pasted user images remain in the composer on failure and use DSH for queue and transcript restore', async () => {
  const script = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
  const style = await readFile(new URL('../vscode/media/style.css', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /img-src blob:/);
  assert.match(extension, /id="image-tray"/);
  assert.match(script, /prompt\.addEventListener\('paste'/);
  assert.match(script, /URL\.createObjectURL\(file\)/);
  assert.match(script, /remove\.setAttribute\('aria-label', `Remove \$\{image\.name\}`\)/);
  assert.match(script, /if \(message\.type === 'submissionAccepted'\)/);
  assert.match(script, /if \(message\.type === 'submissionFailed'\)/);
  assert.match(script, /if \(message\.type === 'imageLoaded'\)/);
  assert.match(script, /appendImageGallery\(article, images\)/);
  assert.match(script, /appendImageGallery\(content, item\.images\)/);
  assert.match(extension, /await \(await ready\)\.readImage\(message\.attachmentId\)/);
  assert.match(extension, /images: item\.restoredImages \?\? \[\]/);
  assert.doesNotMatch(script, /state\.draft|restored\.draft/);
  assert.match(style, /#image-tray \{/);
  assert.match(style, /\.queue-content \.message-images img/);
});

test('a fresh draft derives its pending permission from the DSH settings schema', () => {
  const settings = parseSettingsDescribe({
    writable: true,
    namespaces: [{
      ns: 'permission', revision: 2, value: { defaultPreset: 'workspace-write' },
      schema: {
        uid: 6,
        refs: {
          1: { type: 'const', value: 'read-only' },
          2: { type: 'const', meta: { description: 'Workspace' }, value: 'workspace-write' },
          3: { type: 'const', value: 'danger-full-access' },
          4: { type: 'union', list: [1, 2, 3] },
          6: { type: 'object', dict: { defaultPreset: 4 } },
        },
      },
    }],
  });
  assert.deepEqual(permissionDefaultSelection(settings), {
    options: [
      { value: 'read-only', name: 'read-only' },
      { value: 'workspace-write', name: 'Workspace', description: 'Workspace' },
      { value: 'danger-full-access', name: 'danger-full-access' },
    ],
    currentValue: 'workspace-write',
  });
});

test('a fresh draft stages a selected permission without creating a Session', async () => {
  const selections = [];
  const selection = {
    options: [
      { value: 'read-only', name: 'Read Only' },
      { value: 'workspace-write', name: 'Workspace Write' },
    ],
    currentValue: 'workspace-write',
  };
  const client = new DshClient(undefined, {
    permissionSelection(value) { selections.push(value); },
  }, {
    default: { provider: 'provider', model: 'model' },
    routableProviders: ['provider'],
    groups: [],
    failures: [],
  }, {}, selection);
  await client.selectPermission('read-only');
  assert.equal(client.sessionId, undefined);
  assert.deepEqual(selections, [{ ...selection, currentValue: 'read-only' }]);
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

test('only a live compaction start releases the composer gate; restore keeps activity but no local gate', () => {
  const projected = [];
  const activity = [];
  const client = new DshClient(undefined, {
    compaction(event) { projected.push(event); },
    compacting(value) { activity.push(value); },
  }, {
    default: { provider: 'provider', model: 'model' },
    routableProviders: ['provider'], groups: [], failures: [],
  }, { requestAliases: new Map() });
  const record = (id, seq) => ({ type: 'event', event: {
    type: 'compaction/start', seq, time: seq * 100,
    data: { compactionId: id, turn: null },
  } });

  client.receiveHistoryRecord(record('restored', 1), false, true);
  client.receiveHistoryRecord(record('older', 2), true, true);
  client.receiveHistoryRecord(record('live', 3), false, false);

  assert.deepEqual(projected, [
    { type: 'start', id: 'restored', time: 100 },
    { type: 'start', id: 'older', time: 200 },
    { type: 'start', id: 'live', time: 300, live: true },
  ]);
  assert.deepEqual(activity, [true]);
  assert.equal(client.compactionActive(), true);
});

test('a restore seed retires an interrupted compaction without changing DSH history', async () => {
  const projected = [];
  const activity = [];
  const client = new DshClient(undefined, {
    reset() {},
    compaction(event) { projected.push(event); },
    compacting(value) { activity.push(value); },
    historyState() {},
  }, {
    default: { provider: 'provider', model: 'model' },
    routableProviders: ['provider'], groups: [], failures: [],
  }, { requestAliases: new Map() });
  const start = { type: 'event', event: {
    type: 'compaction/start', seq: 1, time: 100,
    data: { compactionId: 'compact-1', sourceCommandId: 'command-1', turn: null },
  } };
  const seed = { type: 'event', event: { type: 'session/end-seed', seq: 2, time: 200, data: {} } };

  client.replaceCanonicalWindow([start, seed], false);

  assert.deepEqual(projected, [
    { type: 'start', id: 'compact-1', time: 100 },
    { type: 'interrupted', id: 'compact-1' },
  ]);
  assert.deepEqual(activity, [false]);
  assert.equal(client.compactionActive(), false);
  const script = await readFile(new URL('../vscode/media/main.js', import.meta.url), 'utf8');
  assert.match(script, /if \(value\.type === 'interrupted'\) return true/u);
  assert.match(script, /item\.label\.textContent = 'Context compaction interrupted'/u);
});

test('live seed retires only the prior compaction and does not stop a later one', () => {
  const projected = [];
  const activity = [];
  const client = new DshClient(undefined, {
    compaction(event) { projected.push(event); },
    compacting(value) { activity.push(value); },
  }, {
    default: { provider: 'provider', model: 'model' },
    routableProviders: ['provider'], groups: [], failures: [],
  }, { requestAliases: new Map() });
  const append = (type, seq, data) => {
    const entry = { type: 'event', event: { type, seq, time: seq * 100, data } };
    client.receiveCanonicalWindow({ entries: [entry], change: { kind: 'append', entries: [entry] }, hasMore: false });
  };

  append('compaction/start', 1, { compactionId: 'compact-1', turn: null });
  append('session/end-seed', 2, {});
  append('compaction/start', 3, { compactionId: 'compact-2', turn: null });
  client.receiveHistoryRecord({ type: 'event', event: {
    type: 'session/end-seed', seq: 0, time: 50, data: {},
  } }, true, true);
  assert.equal(client.compactionActive(), true);
  append('compaction/end', 4, { compactionId: 'compact-2', turn: null });
  append('session/end-seed', 5, {});

  assert.deepEqual(activity, [true, false, true, false]);
  assert.deepEqual(projected.map(event => event.type), ['start', 'interrupted', 'start', 'end']);
  assert.equal(client.compactionActive(), false);
});

test('tabs restore through the serializer and Stop uses DSH cancellation plus queue removal', async () => {
  const extension = await readFile(new URL('../vscode/src/extension.ts', import.meta.url), 'utf8');
  const client = await readFile(new URL('../vscode/src/dshClient.ts', import.meta.url), 'utf8');
  assert.match(extension, /registerWebviewPanelSerializer\(CHAT_EDITOR_VIEW_TYPE/);
  assert.match(extension, /restoredSessionId/);
  assert.match(client, /if \(restoredSessionId !== undefined\)[\s\S]*await client\.attachSession\(restoredSessionId\)/);
  assert.match(client, /graph\.sessions\.create\(\{\s*sessionId: randomUUID\(\),/);
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
  assert.match(client, /stopAndClearQueue\(\)/);
  assert.match(client, /binding\.session\.updateQueue\(item\.id, \{ kind: 'remove' \}\)/);
  assert.match(extension, /\.stopAndClearQueue\(\)/);
});

test('managed launch authentication rejects another origin before connecting', async () => {
  await assert.rejects(
    exchangeLaunchUrl('http://127.0.0.1:9999/?token=wrong'),
    /Expected the launch URL printed by DSH/,
  );
});
