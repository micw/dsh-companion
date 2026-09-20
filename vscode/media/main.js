const {
  activityStatusText,
  mergePrependedTurnState,
  placeTurnProcessAfterMessage,
  placeUserMessageBeforeTurn,
  reattachTranscriptTail,
} = globalThis.dshCompanionTranscriptState;
const vscode = acquireVsCodeApi();
const output = document.getElementById('output');
const stickyPrompt = document.getElementById('sticky-prompt');
const stickyPromptJump = document.getElementById('sticky-prompt-jump');
const stickyPromptText = document.getElementById('sticky-prompt-text');
const stickyPromptTime = document.getElementById('sticky-prompt-time');
const scrollBottom = document.getElementById('scroll-bottom');
const queue = document.getElementById('queue');
const composer = document.getElementById('composer');
const prompt = document.getElementById('prompt');
const modelControls = document.getElementById('model-controls');
const modelTrigger = document.getElementById('model-trigger');
const modelPicker = document.getElementById('model-picker');
const modelSearch = document.getElementById('model-search');
const modelList = document.getElementById('model-list');
const effortMenu = document.getElementById('effort-menu');
const providerSettingsTrigger = document.getElementById('provider-settings-trigger');
const providerSettingsModal = document.getElementById('provider-settings-modal');
const providerSettingsBackdrop = document.getElementById('provider-settings-backdrop');
const providerSettingsClose = document.getElementById('provider-settings-close');
const providerSettingsSearch = document.getElementById('provider-settings-search');
const providerSettingsFilter = document.getElementById('provider-settings-filter');
const providerSettingsStatus = document.getElementById('provider-settings-status');
const providerSettingsList = document.getElementById('provider-settings-list');
const permissionControl = document.getElementById('permission-control');
const permissionSelect = document.getElementById('permission-select');
const contextMeter = document.getElementById('context-meter');
const contextTrigger = document.getElementById('context-trigger');
const contextFill = contextMeter.querySelector('.context-fill');
const contextPanel = document.getElementById('context-panel');
const contextReading = document.getElementById('context-reading');
const contextFigures = document.getElementById('context-figures');
const compactButton = document.getElementById('compact');
const compactResult = document.getElementById('compact-result');
const providerUsage = document.getElementById('provider-usage');
const providerUsageTrigger = document.getElementById('provider-usage-trigger');
const providerUsagePanel = document.getElementById('provider-usage-panel');
const sessionInfo = document.getElementById('session-info');
const sessionInfoTrigger = document.getElementById('session-info-trigger');
const sessionInfoPanel = document.getElementById('session-info-panel');
const sessionInfoId = document.getElementById('session-info-id');
const sessionInfoCopy = document.getElementById('session-info-copy');
const sessionInfoCompanionVersion = document.getElementById('session-info-companion-version');
const sessionInfoBackendVersion = document.getElementById('session-info-backend-version');
const sessionCostRow = document.getElementById('session-cost-row');
const sessionCostControl = document.getElementById('session-cost-control');
const sessionCostSummary = document.getElementById('session-cost-summary');
const sessionCostBreakdown = document.getElementById('session-cost-breakdown');
const sessionInfoStatus = document.getElementById('session-info-status');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
const status = document.getElementById('status');
const restored = vscode.getState() ?? {};
const restoredSessionId = typeof restored.sessionId === 'string' ? restored.sessionId : undefined;
const restoredDisclosures = isRecord(restored.disclosures) ? { ...restored.disclosures } : {};
if (isRecord(restored.processOpenByTurn)) {
  for (const [turn, open] of Object.entries(restored.processOpenByTurn)) {
    if (typeof open === 'boolean') restoredDisclosures[`turn:${turn}`] = open;
  }
}
const state = {
  version: 2,
  sessionId: restoredSessionId,
  draft: typeof restored.draft === 'string' ? restored.draft : '',
  scrollTop: 0,
  disclosures: { ...restoredDisclosures },
};
let turns = new Map();
let tools = new Map();
let compactions = new Map();
const pendingSubmissions = new Map();
const committedRequestIds = new Set();
let hostQueue = [];
let activeAssistant;
let activeAssistantMessage;
let activeTurn;
let running = false;
let stickyPromptTarget;
let stickyPromptFrame;
let scrollMode = 'follow';
let scrollFrame;
let scrollGeneration = 0;
let userScrollIntent = false;
let userScrollTimer;
let pointerScrolling = false;
let bottomLatchSuppressed = false;
let renderTarget = output;
let prependState;
let historyHasMore = false;
let historyLoading = false;
let modelCatalog;
let modelSelection;
let modelSelecting = false;
let openEffortRoute;
let providerSettingsSnapshot;
let providerSettingsLoading = false;
let providerSettingsReturnFocus;
const providerSettingsDrafts = new Map();
const providerSettingsSaving = new Set();
const providerModelSaving = new Set();
const providerModelsSaving = new Set();
const providerSettingsErrors = new Map();
const providerSettingsSuccess = new Map();
let permissionSelection;
let permissionSelecting = false;
let contextPressure;
let compactAvailable = false;
let compacting = false;
let contextPinned = false;
let providerUsagePinned = false;
let providerUsageRendering = false;
let providerAccounts = [];
let sessionInformation;
let sessionCost;
let sessionInfoPinned = false;
let sessionInfoStatusTimer;
const providerUsageErrors = new Map();
const providerUsageRefreshing = new Set();
let sessionReady = false;
let sending = false;
let stopping = false;
let hostStatus = 'Connecting…';

prompt.value = state.draft;
requestAnimationFrame(autoGrowPrompt);

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (text.length === 0) return;
  setOutputFollow();
  const requestId = crypto.randomUUID();
  pendingSubmissions.set(requestId, { requestId, text, submittedAt: Date.now() });
  renderQueue();
  prompt.value = '';
  autoGrowPrompt();
  state.draft = '';
  saveState();
  activeAssistant = undefined;
  activeAssistantMessage = undefined;
  vscode.postMessage({ type: 'submit', requestId, text });
});

prompt.addEventListener('input', () => {
  autoGrowPrompt();
  state.draft = prompt.value;
  saveState();
});

prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

stop.addEventListener('click', () => {
  if (running || compacting) vscode.postMessage({ type: 'stop' });
});

modelTrigger.addEventListener('click', () => {
  if (modelTrigger.disabled) return;
  if (modelTrigger.dataset.configure === 'true') {
    openProviderSettings();
    return;
  }
  if (modelPicker.hidden) openModelPicker();
  else closeModelPicker(true);
});

modelSearch.addEventListener('input', renderModelPicker);

providerSettingsTrigger.addEventListener('click', openProviderSettings);
providerSettingsClose.addEventListener('click', closeProviderSettings);
providerSettingsBackdrop.addEventListener('click', closeProviderSettings);
providerSettingsSearch.addEventListener('input', renderProviderSettings);
providerSettingsFilter.addEventListener('change', renderProviderSettings);

permissionSelect.addEventListener('change', () => {
  const preset = permissionSelect.value;
  if (permissionSelecting || preset === 'custom' || preset === permissionSelection?.currentValue) return;
  permissionSelecting = true;
  renderPermissionSelect();
  vscode.postMessage({ type: 'selectPermission', preset });
});

contextMeter.addEventListener('pointerenter', () => setContextOpen(true));
contextMeter.addEventListener('pointerleave', () => {
  if (!contextPinned) setContextOpen(false);
});
contextMeter.addEventListener('focusin', () => setContextOpen(true));
contextMeter.addEventListener('focusout', (event) => {
  if (!contextPinned && !contextMeter.contains(event.relatedTarget)) setContextOpen(false);
});
contextTrigger.addEventListener('click', () => {
  contextPinned = !contextPinned;
  setContextOpen(contextPinned);
});
providerUsage.addEventListener('pointerenter', () => setProviderUsageOpen(true));
providerUsage.addEventListener('pointerleave', () => {
  if (!providerUsagePinned) setProviderUsageOpen(false);
});
providerUsage.addEventListener('focusin', () => setProviderUsageOpen(true));
providerUsage.addEventListener('focusout', (event) => {
  if (!providerUsageRendering && !providerUsagePinned && !providerUsage.contains(event.relatedTarget)) {
    setProviderUsageOpen(false);
  }
});
providerUsageTrigger.addEventListener('click', () => {
  providerUsagePinned = !providerUsagePinned;
  setProviderUsageOpen(providerUsagePinned);
});
sessionInfo.addEventListener('pointerenter', () => setSessionInfoOpen(true));
sessionInfo.addEventListener('pointerleave', () => {
  if (!sessionInfoPinned) setSessionInfoOpen(false);
});
sessionInfo.addEventListener('focusin', () => setSessionInfoOpen(true));
sessionInfo.addEventListener('focusout', (event) => {
  if (!sessionInfoPinned && !sessionInfo.contains(event.relatedTarget)) setSessionInfoOpen(false);
});
sessionInfoTrigger.addEventListener('click', () => {
  sessionInfoPinned = !sessionInfoPinned;
  setSessionInfoOpen(sessionInfoPinned);
});
sessionInfoCopy.addEventListener('click', (event) => {
  event.stopPropagation();
  sessionInfoCopy.disabled = true;
  vscode.postMessage({ type: 'copySessionId' });
});
compactButton.addEventListener('click', () => {
  if (running || compacting || !compactAvailable) return;
  compactResult.hidden = true;
  closeContextPanel();
  setCompacting(true);
  vscode.postMessage({ type: 'compact' });
});

stickyPromptJump.addEventListener('click', () => {
  if (stickyPromptTarget === undefined) return;
  setOutputSticky(true);
  stickyPromptTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

scrollBottom.addEventListener('click', scrollToLatestOutput);

output.addEventListener('scroll', () => {
  const nearBottom = isNearOutputBottom();
  if (bottomLatchSuppressed && !nearBottom) bottomLatchSuppressed = false;
  if (scrollMode === 'sticky' && nearBottom && !bottomLatchSuppressed) {
    scrollMode = 'follow';
    userScrollIntent = false;
    if (userScrollTimer !== undefined) clearTimeout(userScrollTimer);
    userScrollTimer = undefined;
    updateScrollButton();
    if (!pointerScrolling) followOutput();
  } else if (userScrollIntent || pointerScrolling) {
    scrollMode = nearBottom ? 'follow' : 'sticky';
    userScrollIntent = false;
    if (userScrollTimer !== undefined) clearTimeout(userScrollTimer);
    userScrollTimer = undefined;
    if (scrollMode === 'sticky') cancelScheduledOutputScroll();
    else if (!pointerScrolling) followOutput();
    updateScrollButton();
  }
  state.scrollTop = output.scrollTop;
  saveState();
  scheduleStickyPrompt();
  requestOlderHistory();
}, { passive: true });

output.addEventListener('wheel', markUserScrollIntent, { passive: true });
output.addEventListener('touchmove', markUserScrollIntent, { passive: true });

window.addEventListener('resize', () => {
  scheduleStickyPrompt();
  positionContextPanel();
  positionProviderUsagePanel();
  positionSessionInfoPanel();
  positionScrollButton();
});

output.addEventListener('click', (event) => {
  const anchor = event.target.closest?.('a[href]');
  if (anchor === undefined || anchor === null) return;
  const href = anchor.getAttribute('href');
  if (!/^https?:\/\//i.test(href ?? '')) return;
  event.preventDefault();
  vscode.postMessage({ type: 'openLink', href });
});

document.addEventListener('pointerdown', (event) => {
  if (event.button === 0 && output.contains(event.target)) {
    pointerScrolling = true;
    markUserScrollIntent();
  }
  const targetControl = event.target.closest?.('.stat-control');
  closeStatControls(targetControl);
  if (!modelControls.contains(event.target)) closeModelPicker();
  if (!contextMeter.contains(event.target)) closeContextPanel();
  if (!providerUsage.contains(event.target)) closeProviderUsagePanel();
  if (!sessionInfo.contains(event.target)) closeSessionInfoPanel();
});

document.addEventListener('pointerup', finishPointerInteraction);
document.addEventListener('pointercancel', finishPointerInteraction);

document.addEventListener('keydown', (event) => {
  if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
    && !event.target.closest?.('textarea, input, select, button')) {
    markUserScrollIntent();
  }
  if (event.key !== 'Escape') return;
  if (!providerSettingsModal.hidden) {
    closeProviderSettings();
    return;
  }
  if (!effortMenu.hidden) {
    closeEffortMenu(true);
    return;
  }
  if (!modelPicker.hidden) closeModelPicker(true);
  if (!contextPanel.hidden) closeContextPanel(true);
  if (!providerUsagePanel.hidden) closeProviderUsagePanel(true);
  if (!sessionInfoPanel.hidden) closeSessionInfoPanel(true);
  closeStatControls();
});

window.addEventListener('message', (event) => {
  applyHostMessage(event.data);
});

function applyHostMessage(message) {
  if (!isRecord(message)) return;
  if (message.type === 'openProviderSettings' && Object.keys(message).length === 1) {
    openProviderSettings();
    return;
  }
  if (message.type === 'batch') {
    if (!Array.isArray(message.messages) || message.messages.length > 64) return;
    for (const item of message.messages) {
      if (isRecord(item) && item.type !== 'batch') applyHostMessage(item);
    }
    return;
  }
  if (message.type === 'resetTranscript') {
    resetTranscript();
    return;
  }
  if (message.type === 'session') {
    state.sessionId = message.sessionId;
    sessionReady = true;
    updateInputAvailability();
    if (message.sessionId === restoredSessionId) {
      requestAnimationFrame(setOutputFollow);
    }
    saveState();
    return;
  }
  if (message.type === 'sessionInformation') {
    if (!isSessionInformation(message)) return;
    sessionInformation = {
      sessionId: message.sessionId,
      companionVersion: message.companionVersion,
      backendVersion: message.backendVersion,
    };
    renderSessionInformation();
    return;
  }
  if (message.type === 'sessionIdCopied') {
    showSessionInfoStatus('Copied');
    sessionInfoCopy.disabled = false;
    return;
  }
  if (message.type === 'sessionIdCopyFailed') {
    if (typeof message.text !== 'string') return;
    showSessionInfoStatus(message.text, true);
    sessionInfoCopy.disabled = false;
    return;
  }
  if (message.type === 'message') {
    appendMessage(message.role, message.text, message.html, message.time);
    return;
  }
  if (message.type === 'historyPrependStart') {
    beginHistoryPrepend();
    return;
  }
  if (message.type === 'historyPrependEnd') {
    endHistoryPrepend();
    return;
  }
  if (message.type === 'historyState') {
    historyHasMore = message.hasMore === true;
    historyLoading = false;
    if (!running) status.textContent = 'Connected';
    requestAnimationFrame(() => requestOlderHistory(true));
    return;
  }
  if (message.type === 'historyLoadFailed') {
    historyLoading = false;
    status.textContent = typeof message.text === 'string' ? message.text : 'Could not load earlier history';
    return;
  }
  if (message.type === 'modelCatalog') {
    if (!isModelCatalog(message.catalog)) return;
    modelCatalog = message.catalog;
    renderModelTrigger();
    if (!modelPicker.hidden) renderModelPicker();
    return;
  }
  if (message.type === 'modelSelection') {
    if (!isModelSelection(message.selection)) return;
    modelSelection = message.selection;
    renderModelTrigger();
    renderProviderUsage();
    if (!modelPicker.hidden) renderModelPicker();
    return;
  }
  if (message.type === 'modelSelecting') {
    modelSelecting = message.value === true;
    renderModelTrigger();
    return;
  }
  if (message.type === 'modelSelectionFailed') {
    status.textContent = typeof message.text === 'string' ? message.text : 'Could not select model';
    return;
  }
  if (message.type === 'providerSettings') {
    if (!isProviderSettingsSnapshot(message.snapshot)) return;
    providerSettingsSnapshot = message.snapshot;
    providerSettingsErrors.clear();
    for (const provider of message.snapshot.providers) {
      providerSettingsDrafts.set(provider.id, {
        enabled: provider.enabled,
        baseURL: provider.baseURL ?? '',
        apiKey: '',
      });
    }
    renderProviderSettings();
    renderModelTrigger();
    updateInputAvailability();
    if (!modelPicker.hidden) renderModelPicker();
    return;
  }
  if (message.type === 'providerSettingsLoading') {
    providerSettingsLoading = message.value === true;
    renderProviderSettings();
    return;
  }
  if (message.type === 'providerSettingsFailed') {
    providerSettingsLoading = false;
    providerSettingsStatus.textContent = typeof message.text === 'string'
      ? message.text
      : 'Provider settings are unavailable.';
    providerSettingsStatus.dataset.kind = 'error';
    return;
  }
  if (message.type === 'providerSettingsSaving') {
    if (typeof message.provider !== 'string') return;
    if (message.value === true) providerSettingsSaving.add(message.provider);
    else providerSettingsSaving.delete(message.provider);
    renderProviderSettings();
    return;
  }
  if (message.type === 'providerModelSaving') {
    if (typeof message.provider !== 'string' || typeof message.model !== 'string') return;
    const key = `${message.provider}\0${message.model}`;
    if (message.value === true) providerModelSaving.add(key);
    else providerModelSaving.delete(key);
    renderProviderSettings();
    return;
  }
  if (message.type === 'providerModelsSaving') {
    if (typeof message.provider !== 'string') return;
    if (message.value === true) providerModelsSaving.add(message.provider);
    else providerModelsSaving.delete(message.provider);
    renderProviderSettings();
    return;
  }
  if (message.type === 'providerSettingsSaveFailed') {
    if (typeof message.provider !== 'string' || typeof message.text !== 'string') return;
    providerSettingsErrors.set(message.provider, message.text);
    renderProviderSettings();
    return;
  }
  if (message.type === 'providerSettingsTested') {
    if (typeof message.provider !== 'string' || !Number.isSafeInteger(message.modelCount)
      || message.modelCount < 0) return;
    providerSettingsSuccess.set(
      message.provider,
      `Connection verified · ${String(message.modelCount)} models loaded.`,
    );
    renderProviderSettings();
    return;
  }
  if (message.type === 'permissionSelection') {
    if (message.selection !== undefined && !isPermissionSelection(message.selection)) return;
    permissionSelection = message.selection;
    renderPermissionSelect();
    return;
  }
  if (message.type === 'permissionSelecting') {
    permissionSelecting = message.value === true;
    renderPermissionSelect();
    return;
  }
  if (message.type === 'permissionSelectionFailed') {
    status.textContent = typeof message.text === 'string' ? message.text : 'Could not select permission';
    return;
  }
  if (message.type === 'contextPressure') {
    if (message.pressure !== undefined && !isContextPressure(message.pressure)) return;
    contextPressure = message.pressure;
    renderContextMeter();
    return;
  }
  if (message.type === 'sessionCost') {
    if (message.cost !== undefined && !isCostSummary(message.cost)) return;
    sessionCost = message.cost;
    renderSessionCost();
    return;
  }
  if (message.type === 'providerAccounts') {
    if (!Array.isArray(message.snapshots) || !message.snapshots.every(isProviderAccountSnapshot)) return;
    providerAccounts = message.snapshots;
    for (const snapshot of providerAccounts) {
      if (snapshot.error === undefined) providerUsageErrors.delete(snapshot.provider);
    }
    renderProviderUsage();
    return;
  }
  if (message.type === 'providerUsageRefreshing') {
    if (typeof message.provider !== 'string') return;
    if (message.value === true) providerUsageRefreshing.add(message.provider);
    else providerUsageRefreshing.delete(message.provider);
    renderProviderUsage();
    return;
  }
  if (message.type === 'providerUsageFailed') {
    if (typeof message.provider !== 'string' || typeof message.text !== 'string') return;
    providerUsageErrors.set(message.provider, message.text);
    renderProviderUsage();
    return;
  }
  if (message.type === 'compactAvailable') {
    compactAvailable = message.value === true;
    renderContextMeter();
    return;
  }
  if (message.type === 'compacting') {
    setCompacting(message.value === true);
    return;
  }
  if (message.type === 'compaction') {
    if (!isCompactionEvent(message.event)) return;
    applyCompactionEvent(message.event);
    return;
  }
  if (message.type === 'compactResult') {
    if (!['success', 'error'].includes(message.kind)
      || (message.text !== undefined && typeof message.text !== 'string')) return;
    compactResult.hidden = message.text === undefined;
    compactResult.dataset.kind = message.kind;
    compactResult.textContent = message.text ?? '';
    return;
  }
  if (message.type === 'assistantStart') {
    activeAssistant = undefined;
    activeAssistantMessage = undefined;
    return;
  }
  if (message.type === 'assistantRender') {
    renderAssistant(message.html);
    return;
  }
  if (message.type === 'assistantTime') {
    setMessageTime(activeAssistantMessage, message.time);
    return;
  }
  if (message.type === 'process') {
    applyProcessEvent(message.event);
    return;
  }
  if (message.type === 'queue') {
    hostQueue = Array.isArray(message.items) ? message.items : [];
    renderQueue();
    return;
  }
  if (message.type === 'userCommitted') {
    if (typeof message.requestId === 'string') {
      pendingSubmissions.delete(message.requestId);
      committedRequestIds.add(message.requestId);
    }
    hostQueue = hostQueue.filter((item) => item.requestId !== message.requestId);
    renderQueue();
    activeTurn = message.turn;
    appendMessage('user', message.text, undefined, message.time);
    return;
  }
  if (message.type === 'submissionFailed') {
    pendingSubmissions.delete(message.requestId);
    renderQueue();
    return;
  }
  if (message.type === 'submissionObserved') {
    pendingSubmissions.delete(message.requestId);
    renderQueue();
    return;
  }
  if (message.type === 'running') {
    setRunning(message.value);
    return;
  }
  if (message.type === 'status') {
    if (typeof message.text !== 'string') return;
    hostStatus = message.text;
    renderActivityStatus();
    return;
  }
  if (message.type === 'sending') {
    sending = message.value === true;
    updateInputAvailability();
    return;
  }
  if (message.type === 'stopping') {
    stopping = message.value === true;
    updateInputAvailability();
    return;
  }
  if (message.type === 'error') appendMessage('error', message.text);
}

function resetTranscript() {
  output.replaceChildren();
  turns = new Map();
  tools = new Map();
  compactions = new Map();
  activeAssistant = undefined;
  activeAssistantMessage = undefined;
  activeTurn = undefined;
  stickyPromptTarget = undefined;
  renderTarget = output;
  prependState = undefined;
  stickyPrompt.hidden = true;
  scheduleStickyPrompt();
}

function appendMessage(role, text, html, time = Date.now()) {
  const article = document.createElement('article');
  article.className = `message ${role}`;
  const label = document.createElement('div');
  label.className = 'role';
  label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'DSH' : 'Error';
  const body = document.createElement('div');
  body.className = 'body';
  if (role === 'assistant' && typeof html === 'string') body.innerHTML = html;
  else body.textContent = text;
  article.append(label, body);
  setMessageTime(article, time);
  const turn = activeTurn === undefined ? undefined : turns.get(activeTurn);
  if (role !== 'user' || turn === undefined || !placeUserMessageBeforeTurn(turn, article)) {
    renderTarget.append(article);
  }
  if (role === 'assistant') {
    activeAssistant = body;
    activeAssistantMessage = article;
    if (turn !== undefined) {
      turn.firstAssistantMessage ??= article;
      turn.latestAssistantMessage = article;
    }
  }
  scheduleStickyPrompt();
  followOutput();
}

function renderQueue() {
  queue.replaceChildren();
  const visibleHostQueue = hostQueue.filter(
    (item) => typeof item.requestId !== 'string' || !committedRequestIds.has(item.requestId),
  );
  const represented = new Set(visibleHostQueue.map((item) => item.requestId).filter(Boolean));
  const items = [
    ...visibleHostQueue.map((item) => ({ ...item, state: queueLabel(item.placement) })),
    ...[...pendingSubmissions.values()]
      .filter((item) => !represented.has(item.requestId))
      .map((item) => ({ ...item, state: 'Submitting' })),
  ];
  queue.hidden = items.length === 0;
  for (const item of items) {
    const row = document.createElement('article');
    row.className = 'queue-item';
    const label = document.createElement('span');
    label.className = 'queue-label';
    label.textContent = item.state;
    const text = document.createElement('span');
    text.className = 'queue-text';
    text.textContent = item.text;
    row.append(label, text);
    queue.append(row);
  }
}

function queueLabel(placement) {
  if (placement === 'steering') return 'Steering';
  if (placement === 'context') return 'Next step';
  return 'Queued';
}

function applyCompactionEvent(event) {
  let item = compactions.get(event.id);
  if (item === undefined) {
    const root = document.createElement('div');
    root.className = 'compaction-activity';
    root.dataset.compactionId = event.id;
    const indicator = document.createElement('span');
    indicator.className = 'compaction-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'compaction-label';
    root.append(indicator, label);
    renderTarget.append(root);
    item = { root, label };
    compactions.set(event.id, item);
  }
  if (event.type === 'start') {
    item.root.dataset.state = 'running';
    item.label.textContent = 'Compacting context…';
  } else if (event.type === 'summary') {
    item.itemCount = event.itemCount;
    item.tokenCount = event.tokenCount;
    item.label.textContent = `Compacting ${String(event.itemCount)} history ${event.itemCount === 1 ? 'item' : 'items'}…`;
  } else {
    item.root.dataset.state = event.error === undefined ? 'completed' : 'error';
    if (event.error !== undefined) {
      item.label.textContent = `Context compaction failed: ${event.error}`;
    } else if (item.itemCount !== undefined && item.tokenCount !== undefined) {
      item.label.textContent = `Context compacted · ${String(item.itemCount)} history ${item.itemCount === 1 ? 'item' : 'items'} · ~${compactTokens(item.tokenCount)} tokens`;
    } else {
      item.label.textContent = 'Context compaction completed';
    }
  }
  followOutput();
}

function renderAssistant(html) {
  if (activeAssistant === undefined) appendMessage('assistant', '', '', undefined);
  activeAssistant.innerHTML = html;
  followOutput();
}

function applyProcessEvent(event) {
  if (!isRecord(event) || typeof event.turn !== 'number') return;
  if (event.type === 'turn-start') {
    activeTurn = event.turn;
    activeAssistant = undefined;
    activeAssistantMessage = undefined;
    ensureTurn(event.turn, event.time);
    return;
  }
  activeTurn = event.turn;
  const turn = ensureTurn(event.turn);
  if (event.type === 'turn-end') {
    completeTurn(turn, event.time, event.reason);
    const key = `turn:${String(event.turn)}`;
    if (event.replay !== true || !Object.hasOwn(restoredDisclosures, key)) {
      turn.root.open = false;
      state.disclosures[key] = false;
      saveState();
    }
    followOutput();
    return;
  }
  if (event.type === 'turn-incomplete') {
    markTurnIncomplete(turn);
    followOutput();
    return;
  }
  if (event.type === 'reasoning' && typeof event.text === 'string') {
    appendReasoning(turn, event);
    return;
  }
  if (event.type === 'status') {
    appendModelStatus(turn, event);
    return;
  }
  if (event.type === 'tool-call') {
    appendToolCall(turn, event);
    return;
  }
  if (event.type === 'tool-result') {
    appendToolResult(event);
    return;
  }
  if (event.type === 'turn-summary') {
    appendTurnSummary(event.turn, event.summary);
    return;
  }
  if (event.type === 'context') appendContext(turn, event);
}

function ensureTurn(number, startedAt) {
  const existing = turns.get(number);
  if (existing !== undefined) return existing;
  const root = document.createElement('details');
  root.className = 'turn-process';
  root.dataset.turn = String(number);
  const disclosureId = `turn:${String(number)}`;
  root.open = disclosureState(disclosureId, true);
  const summary = document.createElement('summary');
  const label = document.createElement('span');
  label.textContent = 'Working…';
  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  summary.append(chevron, label);
  const rows = document.createElement('div');
  rows.className = 'process-rows';
  root.append(summary, rows);
  root.addEventListener('toggle', () => {
    state.disclosures[disclosureId] = root.open;
    saveState();
    scheduleStickyPrompt();
  });
  renderTarget.append(root);
  const turn = {
    root,
    label,
    rows,
    disclosureRoot: root,
    disclosureLabel: label,
    toolCount: 0,
    contextCount: 0,
    reasoning: new Map(),
    statuses: new Map(),
    toolCallIds: new Set(),
    contextIds: new Set(),
    startedAt,
    firstAssistantMessage: undefined,
    latestAssistantMessage: undefined,
    completed: false,
  };
  turns.set(number, turn);
  return turn;
}

function completeTurn(turn, completedAt, reason) {
  if (!Number.isFinite(completedAt)) return;
  turn.completed = true;
  const measuredRunMs = Number.isFinite(turn.runMs)
    ? turn.runMs
    : Number.isFinite(turn.startedAt) ? Math.max(0, completedAt - turn.startedAt) : undefined;
  if (turn.rows.childElementCount > 0) {
    updateTurnProcessLabel(turn, false);
    return;
  }
  turn.label.textContent = measuredRunMs === undefined ? 'Thought' : `Thought for ${formatDuration(measuredRunMs)}`;
  const root = document.createElement('div');
  root.className = 'turn-process turn-process-static';
  root.dataset.turn = turn.root.dataset.turn;
  const label = document.createElement('span');
  label.className = 'turn-process-static-label';
  label.textContent = turn.label.textContent;
  root.append(label);
  turn.root.replaceWith(root);
  turn.root = root;
  turn.label = label;
}

function markTurnIncomplete(turn) {
  turn.completed = true;
  turn.incomplete = true;
  turn.root.dataset.state = 'incomplete';
  updateTurnProcessLabel(turn, false);
}

function appendReasoning(turn, event) {
  let row = turn.reasoning.get(event.id);
  if (row === undefined || event.append !== true) {
    row = disclosureRow('think', event.id, 'Think', firstLine(event.text), event.text);
    turn.rows.append(row.root);
    turn.reasoning.set(event.id, row);
  } else {
    row.detail.textContent += event.text;
    row.summary.textContent = latestLine(row.detail.textContent);
  }
  updateTurnProcessLabel(turn, true);
  followOutput();
}

function appendModelStatus(turn, event) {
  if (event.kind !== 'reasoning-token-progress' || typeof event.id !== 'string'
    || !['reported', 'estimated'].includes(event.basis)
    || (event.deltaTokens === undefined && event.totalTokens === undefined)) return;
  const delta = Number.isSafeInteger(event.deltaTokens) && event.deltaTokens >= 0 ? event.deltaTokens : undefined;
  const total = Number.isSafeInteger(event.totalTokens) && event.totalTokens >= 0 ? event.totalTokens : undefined;
  if (delta === undefined && total === undefined) return;
  let row = turn.statuses.get(event.id);
  if (row === undefined) {
    const root = document.createElement('div');
    root.className = 'process-status-row';
    root.dataset.statusId = event.id;
    const icon = document.createElement('span');
    icon.className = 'row-icon';
    icon.textContent = '◌';
    const title = document.createElement('span');
    title.className = 'row-title';
    title.textContent = 'Thinking';
    const separator = document.createElement('span');
    separator.className = 'separator';
    separator.textContent = '·';
    const summary = document.createElement('span');
    summary.className = 'row-summary';
    root.append(icon, title, separator, summary);
    turn.rows.append(root);
    row = { root, summary, tokens: 0, estimated: true };
    turn.statuses.set(event.id, row);
  }
  const nextTokens = total ?? row.tokens + (delta ?? 0);
  if (!Number.isSafeInteger(nextTokens) || nextTokens < 0) return;
  row.tokens = nextTokens;
  row.estimated = event.basis === 'estimated' && total === undefined;
  row.summary.textContent = `${row.estimated ? '~' : ''}${exactTokens(row.tokens)} reasoning tokens`;
  updateTurnProcessLabel(turn, true);
  followOutput();
}

function appendToolCall(turn, event) {
  if (typeof event.callId !== 'string' || typeof event.name !== 'string') return;
  if (turn.toolCallIds.has(event.callId)) return;
  placeTurnProcessAfterMessage(turn);
  const row = disclosureRow(
    'tool',
    `turn:${String(event.turn)}:tool:${event.callId}`,
    titleCase(event.name),
    event.summary ?? '',
    event.detail ?? '',
  );
  row.root.dataset.callId = event.callId;
  turn.rows.append(row.root);
  turn.toolCallIds.add(event.callId);
  turn.toolCount += 1;
  updateTurnProcessLabel(turn, true);
  tools.set(event.callId, row);
  followOutput();
}

function appendToolResult(event) {
  const row = tools.get(event.callId);
  if (row === undefined) return;
  row.root.dataset.state = event.isError ? 'error' : 'ok';
  if (event.detail) {
    const result = document.createElement('pre');
    result.className = 'tool-result';
    result.textContent = event.detail;
    row.detail.append(result);
  }
}

function appendContext(turn, event) {
  if (turn.contextIds.has(event.id)) return;
  const row = disclosureRow(
    'context', event.id, 'Context injection', event.label ?? '', event.detail ?? '',
  );
  turn.rows.append(row.root);
  turn.contextIds.add(event.id);
  turn.contextCount += 1;
  updateTurnProcessLabel(turn, true);
  followOutput();
}

function updateTurnProcessLabel(turn, active) {
  const labels = [];
  if (turn.reasoning.size > 0) labels.push('Reasoning');
  else if (turn.statuses.size > 0) labels.push('Thinking');
  if (turn.toolCount > 0) labels.push(`${turn.toolCount} tool ${turn.toolCount === 1 ? 'call' : 'calls'}`);
  if (turn.contextCount > 0) {
    labels.push(`${turn.contextCount} context ${turn.contextCount === 1 ? 'injection' : 'injections'}`);
  }
  const detail = labels.length === 0 ? undefined : labels.join(' · ');
  turn.label.textContent = turn.incomplete
    ? `Interrupted${detail === undefined ? '' : ` · ${detail}`}`
    : detail === undefined ? 'Working…' : `${detail}${active ? '…' : ''}`;
}

function disclosureRow(kind, disclosureId, title, summaryText, detailText) {
  const root = document.createElement('details');
  root.className = `process-row ${kind}`;
  root.dataset.disclosureId = disclosureId;
  root.open = disclosureState(disclosureId, false);
  root.addEventListener('toggle', () => {
    state.disclosures[disclosureId] = root.open;
    saveState();
    scheduleStickyPrompt();
  });
  const summary = document.createElement('summary');
  const icon = document.createElement('span');
  icon.className = 'row-icon';
  icon.textContent = kind === 'think' ? '⌘' : kind === 'context' ? '↧' : '○';
  const titleNode = document.createElement('span');
  titleNode.className = 'row-title';
  titleNode.textContent = title;
  const separator = document.createElement('span');
  separator.className = 'separator';
  separator.textContent = '·';
  const summaryNode = document.createElement('span');
  summaryNode.className = 'row-summary';
  summaryNode.textContent = summaryText;
  summary.append(icon, titleNode, separator, summaryNode);
  const detail = document.createElement('pre');
  detail.className = 'row-detail';
  detail.textContent = detailText;
  root.append(summary, detail);
  return { root, summary: summaryNode, detail };
}

function disclosureState(id, fallback) {
  const value = state.disclosures[id];
  return typeof value === 'boolean' ? value : fallback;
}

function appendTurnSummary(turn, summary) {
  if (!isRecord(summary)) return;
  const turnState = turns.get(turn);
  if (turnState !== undefined && Number.isFinite(summary.runMs)) turnState.runMs = summary.runMs;
  const footer = document.createElement('div');
  footer.className = 'turn-footer';
  if (isRecord(summary.usage)) footer.append(usageControl(turn, summary.usage));
  if (isCostSummary(summary.cost)) footer.append(costControl(turn, summary.cost));
  footer.append(timingControl(turn, summary));
  const previousTime = activeAssistantMessage?.querySelector('.message-time');
  previousTime?.remove();
  const clock = document.createElement('time');
  clock.className = 'turn-footer-clock';
  setTime(clock, summary.completedAt);
  footer.append(clock);
  if (activeAssistantMessage === undefined) renderTarget.append(footer);
  else activeAssistantMessage.append(footer);
  followOutput();
}

function usageControl(turn, usage) {
  const total = Number(usage.totalTokens);
  const details = statControl(
    `turn:${String(turn)}:usage`,
    'usage',
    `Usage ${compactTokens(total)} tok`,
    'Turn usage',
    `${exactTokens(total)} tok`,
  );
  const rows = [];
  if (Array.isArray(usage.routes) && usage.routes.length > 0) {
    rows.push(['Provider / model', usage.routes.join(', ')]);
  }
  const promptTokens = total - Number(usage.outputTokens);
  if (Number.isFinite(usage.cacheReadTokens) && promptTokens > 0) {
    rows.push(['Cache hit', `${(Number(usage.cacheReadTokens) / promptTokens * 100).toFixed(1)}%`]);
  }
  rows.push(['Uncached input', `${exactTokens(usage.uncachedInputTokens)} tok`]);
  if (Number.isFinite(usage.cacheReadTokens)) {
    rows.push(['Cached input', `${exactTokens(usage.cacheReadTokens)} tok`]);
  }
  if (Number.isFinite(usage.cacheWriteTokens)) {
    rows.push(['Cache write', `${exactTokens(usage.cacheWriteTokens)} tok`]);
  }
  rows.push(['Output', `${exactTokens(usage.outputTokens)} tok`]);
  if (Number(usage.reasoningTokens) > 0) {
    rows.push(['Reasoning', `${exactTokens(usage.reasoningTokens)} tok`]);
  }
  appendStatRows(details.panel, rows);
  return details.root;
}

function costControl(turn, cost) {
  const label = compactCostSummary(cost);
  const details = statControl(
    `turn:${String(turn)}:cost`,
    'cost',
    label,
    'Turn cost',
    label,
  );
  appendCostBreakdown(details.panel, cost);
  return details.root;
}

function appendCostBreakdown(panel, cost) {
  const rows = [];
  for (const total of cost.totals) rows.push([`Total (${total.currency})`, formatMoney(total)]);
  if (isRecord(cost.coverage)) {
    rows.push(['Accounted turns', String(cost.coverage.accountedTurns)]);
    if (cost.coverage.unaccountedTurns > 0) {
      rows.push(['Unaccounted turns', String(cost.coverage.unaccountedTurns)]);
    }
  }
  for (const bucket of cost.breakdown) {
    rows.push([
      `${titleCase(bucket.kind)} · ${String(bucket.calls)} call${bucket.calls === 1 ? '' : 's'}`,
      formatMoney(bucket),
    ]);
  }
  for (const detail of cost.details ?? []) {
    rows.push([`${titleCase(detail.kind)} detail`, formatMoney(detail)]);
    rows.push(['Coverage', detail.scope === 'turn' ? 'Complete turn snapshot' : 'Model call']);
    if (Array.isArray(detail.routes) && detail.routes.length > 0) {
      rows.push(['Provider / model', detail.routes.join(', ')]);
    }
    if (Array.isArray(detail.sources) && detail.sources.length > 0) {
      rows.push(['Source', detail.sources.join(', ')]);
    }
    if (Array.isArray(detail.tariffVersions) && detail.tariffVersions.length > 0) {
      rows.push(['Tariff', detail.tariffVersions.join(', ')]);
    }
    if (isRecord(detail.components)) {
      for (const [key, title] of [
        ['inputNanos', 'Input'],
        ['outputNanos', 'Output'],
        ['cacheReadNanos', 'Cache read'],
        ['cacheWriteNanos', 'Cache write'],
      ]) {
        if (Number.isSafeInteger(detail.components[key])) {
          rows.push([title, formatMoney({ currency: detail.currency, nanos: detail.components[key] })]);
        }
      }
    }
  }
  appendStatRows(panel, rows);
}

function compactCostSummary(cost) {
  if (cost.totals.length !== 1) {
    const suffix = cost.coverage?.unaccountedTurns > 0 ? ' · known subtotal' : '';
    return `${String(cost.totals.length)} currencies${suffix}`;
  }
  const amount = formatMoney(cost.totals[0]);
  if (cost.coverage?.unaccountedTurns > 0) return `≥${amount} known`;
  const kinds = new Set(cost.breakdown.map((bucket) => bucket.kind));
  if (kinds.size > 1) return `Σ ${amount}`;
  if (kinds.has('estimated')) return `~${amount}`;
  if (kinds.has('virtual')) return `${amount} equivalent`;
  return amount;
}

function formatMoney(amount) {
  const value = amount.nanos / 1_000_000_000;
  const digits = value > 0 && value < 0.000001 ? 9 : value < 0.01 ? 6 : 4;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: amount.currency,
      minimumFractionDigits: value === 0 ? 2 : value < 0.01 ? Math.min(4, digits) : 2,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${amount.currency}`;
  }
}

function timingControl(turn, summary) {
  const details = statControl(
    `turn:${String(turn)}:timing`,
    'time',
    `Ran for ${formatDuration(summary.runMs)}`,
    'Turn time',
    formatDuration(summary.runMs),
  );
  const rows = [['Duration', formatDuration(summary.runMs)]];
  if (Number.isFinite(summary.tokensPerSecond)) {
    rows.push(['Speed', `${summary.tokensPerSecond.toFixed(1)} tok/s`]);
  }
  if (Number.isFinite(summary.ttftMs)) {
    rows.push(['TTFT', formatDuration(summary.ttftMs)]);
  }
  appendStatRows(details.panel, rows);
  return details.root;
}

function statControl(id, iconKind, labelText, titleText, valueText) {
  const root = document.createElement('details');
  root.className = 'stat-control';
  root.open = disclosureState(id, false);
  root.addEventListener('toggle', () => {
    state.disclosures[id] = root.open;
    saveState();
  });
  const trigger = document.createElement('summary');
  trigger.className = 'stat-trigger';
  const icon = statIcon(iconKind);
  const label = document.createElement('span');
  label.textContent = labelText;
  trigger.append(icon, label);
  const panel = document.createElement('div');
  panel.className = 'stat-panel';
  const title = document.createElement('div');
  title.className = 'stat-title';
  const titleLabel = document.createElement('span');
  titleLabel.textContent = titleText;
  const titleValue = document.createElement('strong');
  titleValue.textContent = valueText;
  title.append(titleLabel, titleValue);
  panel.append(title);
  root.append(trigger, panel);
  return { root, panel };
}

function closeStatControls(except) {
  for (const control of document.querySelectorAll('.stat-control[open]')) {
    if (control !== except) control.open = false;
  }
}

function statIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('stat-icon');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  if (kind === 'usage') {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2.5 3.5C2.5 2.1 4.9 1 8 1s5.5 1.1 5.5 2.5v9C13.5 13.9 11.1 15 8 15s-5.5-1.1-5.5-2.5v-9Zm1 0C3.5 4.2 5.3 5 8 5s4.5-.8 4.5-1.5S10.7 2 8 2s-4.5.8-4.5 1.5Zm0 3v2C3.5 9.2 5.3 10 8 10s4.5-.8 4.5-1.5v-2C11.5 7.2 9.9 8 8 8s-3.5-.8-4.5-1.5Zm9 4C11.5 11.2 9.9 12 8 12s-3.5-.8-4.5-1.5v2C3.5 13.2 5.3 14 8 14s4.5-.8 4.5-1.5v-2Z');
    svg.append(path);
  } else if (kind === 'cost') {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M2.5 5C2.5 3.9 4.9 3 8 3s5.5.9 5.5 2v6c0 1.1-2.4 2-5.5 2s-5.5-.9-5.5-2V5Zm1 0c0 .4 1.6 1 4.5 1s4.5-.6 4.5-1S10.9 4 8 4s-4.5.6-4.5 1Zm0 2v1c0 .4 1.6 1 4.5 1s4.5-.6 4.5-1V7c-1 .6-2.7 1-4.5 1s-3.5-.4-4.5-1Zm0 3v1c0 .4 1.6 1 4.5 1s4.5-.6 4.5-1v-1c-1 .6-2.7 1-4.5 1s-3.5-.4-4.5-1Z');
    svg.append(path);
  } else {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '8');
    circle.setAttribute('cy', '8');
    circle.setAttribute('r', '6');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '1.3');
    const hand = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hand.setAttribute('d', 'M8 4.5V8l2.5 1.5');
    hand.setAttribute('fill', 'none');
    hand.setAttribute('stroke', 'currentColor');
    hand.setAttribute('stroke-width', '1.3');
    hand.setAttribute('stroke-linecap', 'round');
    svg.append(circle, hand);
  }
  return svg;
}

function appendStatRows(panel, rows) {
  const list = document.createElement('dl');
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    list.append(term, detail);
  }
  panel.append(list);
}

function compactTokens(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${Math.round(value / 1000)}K`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function exactTokens(value) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString() : '—';
}

function findCatalogModel(providerId, modelId) {
  for (const group of modelCatalog?.groups ?? []) {
    if (group.id !== providerId) continue;
    const model = group.models.find((candidate) => candidate.id === modelId);
    if (model !== undefined) return { group, model };
  }
  return undefined;
}

function effortLabel(model, effort) {
  if (!isRecord(model?.reasoning)) return undefined;
  if (effort === undefined) return 'Provider default';
  return model.reasoning.efforts.find((candidate) => candidate.id === effort)?.name ?? effort;
}

function openProviderSettings() {
  providerSettingsReturnFocus = document.activeElement;
  closeModelPicker();
  closeContextPanel();
  closeProviderUsagePanel();
  closeSessionInfoPanel();
  providerSettingsModal.hidden = false;
  renderProviderSettings();
  providerSettingsSearch.focus();
  vscode.postMessage({ type: 'loadProviderSettings' });
}

function closeProviderSettings() {
  if (providerSettingsModal.hidden) return;
  providerSettingsModal.hidden = true;
  const target = providerSettingsReturnFocus;
  providerSettingsReturnFocus = undefined;
  if (target?.isConnected) target.focus();
}

function renderProviderSettings() {
  if (providerSettingsModal.hidden) return;
  const previousScrollTop = providerSettingsList.scrollTop;
  providerSettingsList.replaceChildren();
  providerSettingsStatus.dataset.kind = '';
  if (providerSettingsLoading && providerSettingsSnapshot === undefined) {
    providerSettingsStatus.textContent = 'Loading providers…';
    return;
  }
  if (providerSettingsSnapshot === undefined) {
    if (!providerSettingsStatus.textContent) providerSettingsStatus.textContent = 'Provider settings are unavailable.';
    return;
  }
  providerSettingsStatus.textContent = providerSettingsSnapshot.writable
    ? 'Credentials are stored by DSH and are never read back.'
    : 'The current DSH settings provider is read-only.';
  providerSettingsStatus.dataset.kind = providerSettingsSnapshot.writable ? '' : 'warning';
  const query = providerSettingsSearch.value.trim().toLocaleLowerCase();
  const filter = providerSettingsFilter.value;
  for (const provider of providerSettingsSnapshot.providers) {
    const providerEnabled = providerSettingsDrafts.get(provider.id)?.enabled ?? provider.enabled;
    const providerMatches = query === '' || `${provider.name}\n${provider.id}`.toLocaleLowerCase().includes(query);
    const models = providerEnabled ? provider.models.filter((model) => {
      const stateMatches = filter === 'all' || (filter === 'enabled' ? model.enabled : !model.enabled);
      const textMatches = query === '' || providerMatches
        || `${model.name}\n${model.id}\n${model.description ?? ''}`.toLocaleLowerCase().includes(query);
      return stateMatches && textMatches;
    }) : [];
    providerSettingsList.append(providerSettingsCard(provider, models));
  }
  providerSettingsList.scrollTop = previousScrollTop;
}

function providerSettingsCard(provider, visibleModels) {
  const draft = providerSettingsDrafts.get(provider.id) ?? {
    enabled: provider.enabled, baseURL: provider.baseURL ?? '', apiKey: '',
  };
  providerSettingsDrafts.set(provider.id, draft);
  const saving = providerSettingsSaving.has(provider.id);
  const disabled = !providerSettingsSnapshot.writable || saving;
  const card = document.createElement('article');
  card.className = 'provider-settings-card';
  const head = document.createElement('div');
  head.className = 'provider-settings-card-head';
  const identity = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = provider.name;
  const route = document.createElement('code');
  route.textContent = provider.id;
  identity.append(title, route);
  const stateLabel = document.createElement('span');
  stateLabel.className = `provider-settings-state ${provider.active ? 'active' : ''}`;
  stateLabel.textContent = provider.active ? 'Active' : draft.enabled ? 'Configured' : 'Disabled';
  head.append(identity, stateLabel);
  const form = document.createElement('form');
  form.className = 'provider-settings-form';
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'provider-settings-toggle';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = draft.enabled;
  enabled.disabled = disabled;
  let serviceUrlInput;
  enabled.addEventListener('change', () => {
    draft.enabled = enabled.checked;
    providerSettingsSuccess.delete(provider.id);
    if (serviceUrlInput !== undefined && serviceUrlInput !== null) serviceUrlInput.required = enabled.checked;
    renderProviderSettings();
  });
  enabledLabel.append(enabled, document.createTextNode(' Provider enabled'));
  form.append(enabledLabel);
  if (provider.kind === 'wrapper') {
    const serviceUrlField = providerSettingsField('Service URL', 'url', draft.baseURL, disabled, (value) => {
      draft.baseURL = value;
      providerSettingsSuccess.delete(provider.id);
    }, draft.enabled);
    serviceUrlInput = serviceUrlField.querySelector('input');
    form.append(serviceUrlField);
  }
  const credentialLabel = provider.credential.configured
    ? `API key · configured${provider.credential.source === undefined ? '' : ` via ${provider.credential.source}`}`
    : 'API key · not configured';
  form.append(providerSettingsField(
    credentialLabel,
    'password',
    draft.apiKey,
    disabled || !provider.credential.writable,
    (value) => { draft.apiKey = value; providerSettingsSuccess.delete(provider.id); },
    false,
    provider.credential.configured ? 'Enter a new key to replace it' : 'Enter API key',
  ));
  const actions = document.createElement('div');
  actions.className = 'provider-settings-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.disabled = disabled;
  const testsConnection = provider.kind === 'wrapper' && draft.enabled;
  save.textContent = saving
    ? testsConnection ? 'Saving & testing…' : 'Saving…'
    : testsConnection ? 'Save & Test' : 'Save';
  actions.append(save);
  form.append(actions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    providerSettingsErrors.delete(provider.id);
    providerSettingsSuccess.delete(provider.id);
    vscode.postMessage({
      type: 'saveProviderSettings',
      provider: provider.id,
      enabled: draft.enabled,
      ...(provider.kind === 'wrapper' ? { baseURL: draft.baseURL } : {}),
      ...(draft.apiKey.trim() === '' ? {} : { apiKey: draft.apiKey }),
      ...(testsConnection ? { test: true } : {}),
      revision: provider.revision,
    });
  });
  card.append(head, form);
  const error = providerSettingsErrors.get(provider.id);
  if (error !== undefined) {
    const failure = document.createElement('p');
    failure.className = 'provider-settings-error';
    failure.setAttribute('role', 'alert');
    failure.textContent = error;
    card.append(failure);
  }
  const success = providerSettingsSuccess.get(provider.id);
  if (success !== undefined) {
    const confirmation = document.createElement('p');
    confirmation.className = 'provider-settings-success';
    confirmation.setAttribute('role', 'status');
    confirmation.textContent = success;
    card.append(confirmation);
  }
  const models = document.createElement('details');
  models.className = 'provider-settings-models';
  const summary = document.createElement('summary');
  summary.textContent = !draft.enabled
    ? `Models (${String(provider.models.length)}) · provider disabled`
    : visibleModels.length === provider.models.length
      ? `Models (${String(provider.models.length)})`
      : `Models (${String(visibleModels.length)} of ${String(provider.models.length)})`;
  models.append(summary);
  if (!draft.enabled) {
    models.classList.add('disabled');
    summary.setAttribute('aria-disabled', 'true');
    summary.addEventListener('click', event => { event.preventDefault(); });
  } else if (provider.models.length > 0) {
    const bulk = document.createElement('div');
    bulk.className = 'provider-settings-model-actions';
    const bulkSaving = providerModelsSaving.has(provider.id);
    for (const [label, value] of [['Enable all', true], ['Disable all', false]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = bulkSaving ? 'Saving…' : label;
      button.disabled = !providerSettingsSnapshot.writable || bulkSaving
        || provider.models.every(model => model.enabled === value);
      button.addEventListener('click', () => vscode.postMessage({
        type: 'setProviderModelsEnabled',
        provider: provider.id,
        models: provider.models.map(model => model.id),
        enabled: value,
        revision: providerSettingsSnapshot.modelPolicyRevision,
      }));
      bulk.append(button);
    }
    models.append(bulk);
  }
  if (!draft.enabled) {
    // A disabled provider contributes no searchable or editable model rows.
  } else if (provider.models.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = provider.active
      ? 'No models are currently available.'
      : 'Enable and save this provider to load its models.';
    models.append(empty);
  } else if (visibleModels.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No models in this provider match the current filter.';
    models.append(empty);
  } else {
    const list = document.createElement('ul');
    for (const model of visibleModels) {
      const item = document.createElement('li');
      const label = document.createElement('label');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = model.enabled;
      toggle.disabled = !providerSettingsSnapshot.writable
        || providerModelsSaving.has(provider.id)
        || providerModelSaving.has(`${provider.id}\0${model.id}`);
      toggle.addEventListener('change', () => vscode.postMessage({
        type: 'setProviderModelEnabled',
        provider: provider.id,
        model: model.id,
        enabled: toggle.checked,
        revision: providerSettingsSnapshot.modelPolicyRevision,
      }));
      const copy = document.createElement('span');
      copy.textContent = model.name;
      const id = document.createElement('code');
      id.textContent = model.id;
      label.append(toggle, copy, id);
      item.append(label);
      list.append(item);
    }
    models.append(list);
  }
  const disclosureId = `provider-settings:${provider.id}:models`;
  const forcedOpen = draft.enabled
    && (providerSettingsSearch.value.trim() !== '' || providerSettingsFilter.value !== 'all');
  models.open = draft.enabled && (forcedOpen || state.disclosures[disclosureId] === true);
  models.addEventListener('toggle', () => {
    if (!draft.enabled || forcedOpen) return;
    state.disclosures[disclosureId] = models.open;
    saveState();
  });
  card.append(models);
  return card;
}

function providerSettingsField(labelText, type, value, disabled, onInput, required, placeholder = '') {
  const label = document.createElement('label');
  label.className = 'provider-settings-field';
  const caption = document.createElement('span');
  caption.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  input.disabled = disabled;
  input.required = required;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value));
  label.append(caption, input);
  return label;
}

function selectedModelEnabled() {
  if (modelSelection === undefined || modelCatalog === undefined
    || !modelCatalog.routableProviders.includes(modelSelection.provider)) return false;
  const provider = providerSettingsSnapshot?.providers.find(candidate => candidate.id === modelSelection.provider);
  const model = provider?.models.find(candidate => candidate.id === modelSelection.model);
  return model?.enabled !== false;
}

function renderModelTrigger() {
  const found = modelSelection === undefined
    ? undefined
    : findCatalogModel(modelSelection.provider, modelSelection.model);
  const usable = selectedModelEnabled();
  const modelName = modelCatalog !== undefined && modelCatalog.routableProviders.length === 0
    ? 'Configure a provider'
    : (found === undefined
      ? modelSelection === undefined ? 'Loading models…' : `${modelSelection.provider}/${modelSelection.model}`
      : `${found.group.name} / ${found.model.name}`);
  const selectedEffort = found === undefined ? undefined : effortLabel(found.model, modelSelection?.reasoningEffort);
  modelTrigger.replaceChildren();
  const name = document.createElement('span');
  name.className = 'model-trigger-name';
  name.textContent = modelName;
  modelTrigger.append(name);
  if (selectedEffort !== undefined) {
    const effort = document.createElement('span');
    effort.className = 'model-trigger-effort';
    effort.textContent = `· ${selectedEffort}`;
    modelTrigger.append(effort);
  }
  const label = selectedEffort === undefined ? modelName : `${modelName} · ${selectedEffort}`;
  modelTrigger.title = running || compacting
    ? 'Model and effort can be changed after the current activity finishes.'
    : label;
  modelTrigger.setAttribute('aria-label', `Select model, current ${label}`);
  modelTrigger.disabled = running || compacting || modelSelecting || modelCatalog === undefined;
  modelTrigger.dataset.configure = usable ? 'false' : 'true';
}

function renderPermissionSelect() {
  permissionControl.hidden = permissionSelection === undefined;
  permissionSelect.replaceChildren();
  if (permissionSelection === undefined) return;
  for (const item of permissionSelection.options) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = displayPermissionName(item);
    option.title = item.description ?? item.name;
    option.disabled = item.value === 'custom';
    permissionSelect.append(option);
  }
  permissionSelect.value = permissionSelection.currentValue;
  const current = permissionSelection.options.find(item => item.value === permissionSelection.currentValue);
  permissionSelect.title = current?.description
    ?? `Session permission: ${current?.name ?? permissionSelection.currentValue}`;
  permissionSelect.disabled = running || compacting || permissionSelecting;
}

function displayPermissionName(item) {
  if (item.name !== item.value) return item.name;
  if (item.value === 'read-only') return 'Read Only';
  if (item.value === 'workspace-write') return 'Workspace Write';
  if (item.value === 'danger-full-access') return 'Full access';
  return item.name.split('-').map(titleCase).join(' ');
}

function openModelPicker() {
  closeStatControls();
  closeContextPanel();
  closeProviderUsagePanel();
  closeSessionInfoPanel();
  modelSearch.value = '';
  modelPicker.hidden = false;
  modelTrigger.setAttribute('aria-expanded', 'true');
  renderModelPicker();
  modelSearch.focus();
}

function closeModelPicker(restoreFocus = false) {
  if (modelPicker.hidden) return;
  closeEffortMenu();
  modelPicker.hidden = true;
  modelTrigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) modelTrigger.focus();
}

function renderModelPicker() {
  closeEffortMenu();
  modelList.replaceChildren();
  if (modelCatalog === undefined) return;
  const query = modelSearch.value.trim().toLocaleLowerCase();
  let visible = 0;
  for (const group of modelCatalog.groups) {
    const settingsProvider = providerSettingsSnapshot?.providers.find(provider => provider.id === group.id);
    const models = group.models.filter((model) => {
      const enabled = settingsProvider?.models.find(candidate => candidate.id === model.id)?.enabled !== false;
      return enabled && (!query || [
        group.id, group.name, model.id, model.name, model.description,
      ].filter(Boolean).join('\n').toLocaleLowerCase().includes(query));
    });
    if (models.length === 0) continue;
    const section = document.createElement('section');
    section.className = 'model-group';
    const heading = document.createElement('div');
    heading.className = 'model-group-title';
    heading.textContent = group.name;
    section.append(heading);
    for (const model of models) section.append(modelRow(group, model));
    modelList.append(section);
    visible += models.length;
  }
  for (const failure of modelCatalog.failures) {
    const warning = document.createElement('div');
    warning.className = 'model-warning';
    warning.textContent = `${failure.name}: ${failure.message}`;
    modelList.append(warning);
  }
  if (visible === 0 && modelCatalog.failures.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = query ? 'No models match this search.' : 'No models available.';
    modelList.append(empty);
  }
}

function modelRow(group, model) {
  const row = document.createElement('div');
  row.className = 'model-row';
  const selected = modelSelection?.provider === group.id && modelSelection.model === model.id;
  const mark = document.createElement('span');
  mark.className = selected ? 'model-current' : 'model-current-placeholder';
  mark.setAttribute('aria-hidden', 'true');
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'model-choice';
  choose.disabled = modelSelecting;
  choose.setAttribute('aria-pressed', String(selected));
  choose.title = `${group.id}/${model.id}`;
  const name = document.createElement('span');
  name.className = 'model-name';
  name.textContent = model.name;
  choose.append(name);
  if (typeof model.description === 'string') {
    const description = document.createElement('span');
    description.className = 'model-description';
    description.textContent = model.description;
    choose.append(description);
  }
  choose.addEventListener('click', () => submitModelSelection(group.id, model.id));
  row.append(mark, choose);
  if (isRecord(model.reasoning)) {
    const effort = document.createElement('button');
    effort.type = 'button';
    effort.className = 'model-effort';
    effort.disabled = modelSelecting;
    effort.textContent = effortLabel(model, selected ? modelSelection.reasoningEffort : undefined);
    effort.title = `Choose reasoning effort for ${model.name}`;
    effort.setAttribute('aria-haspopup', 'menu');
    effort.addEventListener('click', () => renderEffortMenu(group, model, effort));
    row.append(effort);
  }
  return row;
}

function renderEffortMenu(group, model, anchor) {
  closeEffortMenu();
  const title = document.createElement('div');
  title.className = 'effort-menu-title';
  title.textContent = model.name;
  effortMenu.append(title);
  const efforts = [
    { id: undefined, name: 'Provider default' },
    ...model.reasoning.efforts,
  ];
  const selectedRoute = modelSelection?.provider === group.id && modelSelection.model === model.id;
  const selectedEffort = selectedRoute ? modelSelection.reasoningEffort : undefined;
  if (selectedEffort !== undefined && !efforts.some((candidate) => candidate.id === selectedEffort)) {
    efforts.unshift({ id: selectedEffort, name: selectedEffort, unavailable: true });
  }
  for (const candidate of efforts) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'effort-choice';
    button.disabled = candidate.unavailable === true;
    if (candidate.unavailable === true) button.title = 'This saved effort is no longer offered by the model';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(selectedRoute && selectedEffort === candidate.id));
    const mark = document.createElement('span');
    mark.className = selectedRoute && selectedEffort === candidate.id
      ? 'model-current'
      : 'model-current-placeholder';
    mark.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'effort-copy';
    const name = document.createElement('span');
    name.textContent = candidate.name;
    copy.append(name);
    if (typeof candidate.description === 'string') {
      const description = document.createElement('span');
      description.className = 'model-description';
      description.textContent = candidate.description;
      copy.append(description);
    }
    button.append(mark, copy);
    button.addEventListener('click', () => submitModelSelection(group.id, model.id, candidate.id));
    effortMenu.append(button);
  }
  openEffortRoute = { anchor };
  effortMenu.hidden = false;
  const pickerRect = modelPicker.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const top = Math.min(
    Math.max(8, anchorRect.top - pickerRect.top),
    Math.max(8, pickerRect.height - effortMenu.offsetHeight - 8),
  );
  effortMenu.style.top = `${String(top)}px`;
  effortMenu.style.right = '8px';
  effortMenu.querySelector('button:not(:disabled)')?.focus();
}

function closeEffortMenu(restoreFocus = false) {
  if (effortMenu.hidden) return;
  const anchor = openEffortRoute?.anchor;
  effortMenu.hidden = true;
  effortMenu.replaceChildren();
  openEffortRoute = undefined;
  if (restoreFocus && anchor?.isConnected) anchor.focus();
}

function submitModelSelection(provider, model, reasoningEffort) {
  if (modelSelecting || running) return;
  modelSelecting = true;
  renderModelTrigger();
  closeModelPicker();
  vscode.postMessage({
    type: 'selectModel',
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  });
}

function renderSessionInformation() {
  const available = sessionInformation !== undefined;
  sessionInfo.hidden = !available;
  if (!available) {
    closeSessionInfoPanel();
    return;
  }
  sessionInfoId.textContent = sessionInformation.sessionId;
  sessionInfoId.title = sessionInformation.sessionId;
  sessionInfoCompanionVersion.textContent = sessionInformation.companionVersion;
  sessionInfoBackendVersion.textContent = sessionInformation.backendVersion;
  renderSessionCost();
  if (!sessionInfoPanel.hidden) positionSessionInfoPanel();
}

function renderSessionCost() {
  const available = isCostSummary(sessionCost) && sessionCost.totals.length > 0;
  sessionCostRow.hidden = !available;
  if (!available) {
    sessionCostSummary.textContent = '';
    sessionCostBreakdown.replaceChildren();
    if (!sessionInfoPanel.hidden) positionSessionInfoPanel();
    return;
  }
  sessionCostSummary.textContent = compactCostSummary(sessionCost);
  sessionCostBreakdown.replaceChildren();
  appendCostBreakdown(sessionCostBreakdown, sessionCost);
  if (!sessionInfoPanel.hidden) positionSessionInfoPanel();
}

function showSessionInfoStatus(text, error = false) {
  if (sessionInfoStatusTimer !== undefined) clearTimeout(sessionInfoStatusTimer);
  sessionInfoStatus.hidden = false;
  sessionInfoStatus.dataset.error = error ? 'true' : 'false';
  sessionInfoStatus.textContent = text;
  sessionInfoCopy.textContent = error ? 'Retry' : 'Copied';
  sessionInfoStatusTimer = setTimeout(() => {
    sessionInfoStatus.hidden = true;
    sessionInfoStatus.textContent = '';
    sessionInfoCopy.textContent = 'Copy';
    sessionInfoStatusTimer = undefined;
  }, 1800);
}

function setSessionInfoOpen(open) {
  if (open && sessionInfo.hidden) return;
  if (open) {
    closeStatControls();
    closeModelPicker();
    closeContextPanel();
    closeProviderUsagePanel();
  }
  sessionInfoPanel.hidden = !open;
  sessionInfoTrigger.setAttribute('aria-expanded', String(open));
  if (open) positionSessionInfoPanel();
}

function positionSessionInfoPanel() {
  if (sessionInfoPanel.hidden) return;
  positionComposerPanel(sessionInfoTrigger, sessionInfoPanel);
}

function closeSessionInfoPanel(restoreFocus = false) {
  sessionInfoPinned = false;
  setSessionInfoOpen(false);
  if (restoreFocus && !sessionInfo.hidden) sessionInfoTrigger.focus();
}

function currentProviderAccount() {
  if (typeof modelSelection?.provider !== 'string') return undefined;
  return providerAccounts.find((snapshot) => snapshot.provider === modelSelection.provider);
}

function selectedAllowance(snapshot) {
  const groups = snapshot?.value?.allowances ?? [];
  return groups.find((group) => group.id === snapshot.value.activeAllowance)
    ?? groups.find((group) => group.primary !== undefined || group.secondary !== undefined)
    ?? groups[0];
}

function firstAllowanceWindow(group) {
  return group?.primary ?? group?.secondary;
}

function allowanceResetSeconds(window, observedAt, now = Date.now()) {
  if (Number.isSafeInteger(window?.resetsAt)) return Math.max(0, window.resetsAt - Math.floor(now / 1000));
  if (Number.isSafeInteger(window?.resetsInSeconds)) {
    const elapsed = Number.isSafeInteger(observedAt) ? Math.max(0, Math.floor((now - observedAt) / 1000)) : 0;
    return Math.max(0, window.resetsInSeconds - elapsed);
  }
  return undefined;
}

function allowanceTimeMarkerPercent(window, observedAt, now = Date.now()) {
  const remaining = allowanceResetSeconds(window, observedAt, now);
  if (!Number.isSafeInteger(window?.windowSeconds) || window.windowSeconds <= 0 || remaining === undefined) {
    return undefined;
  }
  return Math.max(0, Math.min(100, (window.windowSeconds - remaining) / window.windowSeconds * 100));
}

function formatAllowanceDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${String(value)}s`;
  const minutes = Math.floor(value / 60);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(value / 3600);
  if (hours < 24) return `${String(Math.max(1, hours))}h`;
  const days = Math.floor(hours / 24);
  const remainder = hours % 24;
  return remainder === 0 ? `${String(days)}d` : `${String(days)}d ${String(remainder)}h`;
}

function formatAllowanceWindow(seconds) {
  if (!Number.isSafeInteger(seconds)) return '';
  if (seconds % 86400 === 0) return `${String(seconds / 86400)}d`;
  if (seconds % 3600 === 0) return `${String(seconds / 3600)}h`;
  if (seconds % 60 === 0) return `${String(seconds / 60)}m`;
  return `${String(seconds)}s`;
}

function formatAllowancePercent(value) {
  if (!Number.isFinite(value)) return 'unknown';
  return `${Number.isInteger(value) ? String(value) : value.toFixed(1)}%`;
}

function providerUsageSummary(snapshot) {
  const group = selectedAllowance(snapshot);
  const window = firstAllowanceWindow(group);
  if (group?.reached === true) {
    const reset = formatAllowanceDuration(allowanceResetSeconds(window, snapshot?.observedAt));
    return { label: `Limit reached${reset === '' ? '' : ` · ${reset}`}`, tone: 'danger' };
  }
  if (window === undefined) {
    return { label: snapshot?.refreshing ? 'Usage…' : 'Usage', tone: snapshot?.status === 'stale' ? 'warning' : 'normal' };
  }
  const reset = formatAllowanceDuration(allowanceResetSeconds(window, snapshot?.observedAt));
  const label = `${formatAllowancePercent(window.usedPercent)} used${reset === '' ? '' : ` · ${reset}`}`;
  const tone = window.usedPercent >= 95 ? 'danger'
    : window.usedPercent >= 80 || snapshot.status === 'stale' ? 'warning' : 'normal';
  return { label, tone };
}

function renderProviderUsage() {
  const snapshot = currentProviderAccount();
  providerUsage.hidden = snapshot === undefined;
  if (snapshot === undefined) {
    closeProviderUsagePanel();
    return;
  }
  const summary = providerUsageSummary(snapshot);
  providerUsageTrigger.textContent = providerUsageRefreshing.has(snapshot.provider) ? 'Usage…' : summary.label;
  providerUsageTrigger.classList.toggle('warning', summary.tone === 'warning');
  providerUsageTrigger.classList.toggle('danger', summary.tone === 'danger');
  providerUsageTrigger.title = summary.label;
  if (!providerUsagePanel.hidden) {
    renderProviderUsagePanel(snapshot);
    positionProviderUsagePanel();
  }
}

function renderProviderUsagePanel(snapshot) {
  const restoreRefreshFocus = document.activeElement === providerUsagePanel.querySelector('.provider-usage-refresh');
  providerUsageRendering = true;
  providerUsagePanel.replaceChildren();
  const head = document.createElement('div');
  head.className = 'provider-usage-head';
  const title = document.createElement('strong');
  const plan = snapshot.value?.plan;
  title.textContent = plan === undefined ? 'Provider usage' : `Plan: ${plan.name ?? plan.id}`;
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'provider-usage-refresh';
  refresh.textContent = providerUsageRefreshing.has(snapshot.provider) || snapshot.refreshing ? 'Refreshing…' : 'Refresh';
  refresh.disabled = providerUsageRefreshing.has(snapshot.provider) || snapshot.refreshing;
  refresh.addEventListener('click', (event) => {
    event.stopPropagation();
    providerUsageErrors.delete(snapshot.provider);
    providerUsageRefreshing.add(snapshot.provider);
    renderProviderUsage();
    vscode.postMessage({ type: 'refreshProviderUsage', provider: snapshot.provider });
  });
  head.append(title, refresh);
  providerUsagePanel.append(head);

  if (snapshot.value?.accountStatus === 'authentication-required') {
    appendProviderUsageMeta('Authentication required', 'provider-usage-error');
  }
  const credits = snapshot.value?.credits;
  if (credits?.unlimited === true) appendProviderUsageMeta('Credits: unlimited');
  else if (typeof credits?.balance === 'string') appendProviderUsageMeta(`Credit balance: ${credits.balance}`);
  if (credits?.overageLimitReached === true) appendProviderUsageMeta('Overage limit reached', 'provider-usage-error');

  const groups = snapshot.value?.allowances ?? [];
  for (const group of groups) {
    const section = document.createElement('section');
    section.className = 'provider-usage-group';
    const groupHead = document.createElement('div');
    groupHead.className = 'provider-usage-group-head';
    const groupName = document.createElement('strong');
    groupName.textContent = group.name ?? group.id;
    const groupState = document.createElement('span');
    groupState.textContent = group.reached === true
      ? 'Limit reached'
      : group.id === snapshot.value?.activeAllowance ? 'Active' : '';
    groupHead.append(groupName, groupState);
    section.append(groupHead);
    if (group.primary !== undefined) {
      section.append(providerUsageWindow('Primary', group.primary, group.reached === true, snapshot.observedAt));
    }
    if (group.secondary !== undefined) {
      section.append(providerUsageWindow('Secondary', group.secondary, group.reached === true, snapshot.observedAt));
    }
    providerUsagePanel.append(section);
  }
  if (groups.length === 0) appendProviderUsageMeta('No allowance data available yet.');
  if (snapshot.observedAt !== undefined && groups.length > 0) {
    const age = formatAllowanceDuration((Date.now() - snapshot.observedAt) / 1000);
    appendProviderUsageMeta(`Updated ${age} ago${snapshot.status === 'stale' ? ' · stale' : ''}`);
  }
  const error = providerUsageErrors.get(snapshot.provider) ?? snapshot.error;
  if (typeof error === 'string' && error !== '') appendProviderUsageMeta(error, 'provider-usage-error');
  if (restoreRefreshFocus) refresh.focus();
  providerUsageRendering = false;
}

function providerUsageWindow(label, window, reached, observedAt) {
  const block = document.createElement('div');
  block.className = 'provider-usage-window';
  const head = document.createElement('div');
  head.className = 'provider-usage-window-head';
  const duration = formatAllowanceWindow(window.windowSeconds);
  const name = document.createElement('span');
  name.textContent = `${label}${duration === '' ? '' : ` (${duration})`}`;
  const value = document.createElement('span');
  value.textContent = formatAllowancePercent(window.usedPercent);
  head.append(name, value);
  const progress = document.createElement('div');
  progress.className = 'provider-usage-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  const width = Math.max(0, Math.min(100, window.usedPercent));
  progress.setAttribute('aria-valuenow', String(width));
  progress.setAttribute('aria-valuetext', `${formatAllowancePercent(window.usedPercent)} used`);
  const fill = document.createElement('span');
  fill.className = 'provider-usage-fill';
  fill.style.width = `${String(width)}%`;
  if (reached || width >= 95) fill.classList.add('danger');
  else if (width >= 80) fill.classList.add('warning');
  progress.append(fill);
  const elapsed = allowanceTimeMarkerPercent(window, observedAt);
  if (elapsed !== undefined) {
    const marker = document.createElement('span');
    marker.className = 'provider-usage-time-marker';
    marker.style.left = `${String(Math.max(1.5, Math.min(98.5, elapsed)))}%`;
    marker.title = `${String(Math.round(elapsed))}% of the allowance window elapsed`;
    progress.append(marker);
  }
  const reset = document.createElement('div');
  reset.className = 'provider-usage-reset';
  const remaining = formatAllowanceDuration(allowanceResetSeconds(window, observedAt));
  reset.textContent = remaining === '' ? 'Reset unknown' : `Resets in ${remaining}`;
  block.append(head, progress, reset);
  return block;
}

function appendProviderUsageMeta(text, className = 'provider-usage-meta') {
  const row = document.createElement('div');
  row.className = className;
  row.textContent = text;
  providerUsagePanel.append(row);
}

function setProviderUsageOpen(open) {
  if (open && providerUsage.hidden) return;
  if (open) {
    closeStatControls();
    closeModelPicker();
    closeContextPanel();
    closeSessionInfoPanel();
    const snapshot = currentProviderAccount();
    if (snapshot !== undefined) renderProviderUsagePanel(snapshot);
  }
  providerUsagePanel.hidden = !open;
  providerUsageTrigger.setAttribute('aria-expanded', String(open));
  if (open) positionProviderUsagePanel();
}

function positionProviderUsagePanel() {
  if (providerUsagePanel.hidden) return;
  positionComposerPanel(providerUsageTrigger, providerUsagePanel);
}

function closeProviderUsagePanel(restoreFocus = false) {
  providerUsagePinned = false;
  setProviderUsageOpen(false);
  if (restoreFocus && !providerUsage.hidden) providerUsageTrigger.focus();
}

function renderContextMeter() {
  const usedTokens = contextPressure?.projectedTokens ?? contextPressure?.pressureTokens;
  const contextWindow = contextPressure?.contextWindow;
  const available = Number.isSafeInteger(usedTokens) && Number.isSafeInteger(contextWindow) && contextWindow > 0;
  contextMeter.hidden = !available;
  if (!available) {
    closeContextPanel();
    return;
  }
  const percent = Math.min(100, Math.round(usedTokens / contextWindow * 100));
  const circumference = 2 * Math.PI * 5.5;
  contextFill.setAttribute('stroke-dasharray', `${String(circumference * percent / 100)} ${String(circumference)}`);
  const label = `${String(percent)}% of context used`;
  contextTrigger.setAttribute('aria-label', label);
  contextTrigger.title = `${label} · ~${compactTokens(usedTokens)} / ${compactTokens(contextWindow)}`;
  contextReading.textContent = label;
  contextFigures.textContent = `~${compactTokens(usedTokens)} / ${compactTokens(contextWindow)}`;
  compactButton.hidden = !compactAvailable;
  compactButton.disabled = running || compacting;
  compactButton.textContent = compacting ? 'Compacting…' : 'Compact';
}

function setContextOpen(open) {
  if (open && contextMeter.hidden) return;
  if (open) {
    closeStatControls();
    closeModelPicker();
    closeProviderUsagePanel();
    closeSessionInfoPanel();
  }
  contextPanel.hidden = !open;
  contextTrigger.setAttribute('aria-expanded', String(open));
  if (open) positionContextPanel();
}

function positionContextPanel() {
  if (contextPanel.hidden) return;
  positionComposerPanel(contextTrigger, contextPanel);
}

function positionComposerPanel(trigger, panel) {
  const margin = 12;
  const gap = 8;
  const triggerRect = trigger.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const centered = triggerRect.left + triggerRect.width / 2 - width / 2;
  const left = Math.min(Math.max(centered, margin), Math.max(margin, window.innerWidth - width - margin));
  const above = triggerRect.top - gap - height;
  const top = above >= margin
    ? above
    : Math.min(triggerRect.bottom + gap, Math.max(margin, window.innerHeight - height - margin));
  panel.style.left = `${String(left)}px`;
  panel.style.top = `${String(top)}px`;
}

function closeContextPanel(restoreFocus = false) {
  contextPinned = false;
  setContextOpen(false);
  if (restoreFocus && !contextMeter.hidden) contextTrigger.focus();
}

function setRunning(value) {
  running = value;
  if (value) closeModelPicker();
  updateInputAvailability();
  renderActivityStatus();
  renderModelTrigger();
  renderPermissionSelect();
  renderContextMeter();
}

function setCompacting(value) {
  compacting = value;
  if (value) closeModelPicker();
  updateInputAvailability();
  renderActivityStatus();
  renderModelTrigger();
  renderPermissionSelect();
  renderContextMeter();
}

function updateInputAvailability() {
  prompt.disabled = compacting;
  send.disabled = !sessionReady || sending || compacting || !selectedModelEnabled();
  stop.hidden = !running && !compacting;
  stop.disabled = stopping;
  composer.dataset.running = running || compacting ? 'true' : 'false';
}

function renderActivityStatus() {
  const active = running || compacting;
  status.dataset.running = active ? 'true' : 'false';
  status.textContent = activityStatusText({ running, compacting, hostStatus });
}

function saveState() {
  vscode.setState(state);
}

function isNearOutputBottom() {
  return output.scrollHeight - output.scrollTop - output.clientHeight < 32;
}

function setOutputFollow() {
  scrollMode = 'follow';
  bottomLatchSuppressed = false;
  userScrollIntent = false;
  if (userScrollTimer !== undefined) clearTimeout(userScrollTimer);
  userScrollTimer = undefined;
  updateScrollButton();
  followOutput();
}

function scrollToLatestOutput() {
  if (isNearOutputBottom()) {
    setOutputFollow();
    return;
  }
  setOutputSticky(true);
  output.scrollTo({ top: output.scrollHeight, behavior: 'smooth' });
}

function setOutputSticky(suppressBottomLatch = false) {
  scrollMode = 'sticky';
  bottomLatchSuppressed = suppressBottomLatch;
  userScrollIntent = false;
  if (userScrollTimer !== undefined) clearTimeout(userScrollTimer);
  userScrollTimer = undefined;
  cancelScheduledOutputScroll();
  updateScrollButton();
}

function updateScrollButton() {
  scrollBottom.hidden = scrollMode !== 'sticky';
  if (!scrollBottom.hidden) positionScrollButton();
}

function positionScrollButton() {
  if (scrollBottom.hidden) return;
  const outputRect = output.getBoundingClientRect();
  scrollBottom.style.top = `${String(Math.max(outputRect.top + 12, outputRect.bottom - 44))}px`;
}

function cancelScheduledOutputScroll() {
  scrollGeneration += 1;
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
  scrollFrame = undefined;
}

function markUserScrollIntent() {
  userScrollIntent = true;
  bottomLatchSuppressed = false;
  cancelScheduledOutputScroll();
  if (userScrollTimer !== undefined) clearTimeout(userScrollTimer);
  userScrollTimer = window.setTimeout(() => {
    userScrollTimer = undefined;
    userScrollIntent = false;
    if (scrollMode === 'follow') followOutput();
  }, 150);
}

function finishPointerInteraction() {
  pointerScrolling = false;
  const selection = window.getSelection();
  const transcriptSelection = selection !== null && !selection.isCollapsed
    && (output.contains(selection.anchorNode) || output.contains(selection.focusNode));
  if (transcriptSelection) {
    setOutputSticky();
    return;
  }
  if (isNearOutputBottom()) {
    scrollMode = 'follow';
    updateScrollButton();
  }
  if (scrollMode === 'follow') followOutput();
}

function followOutput() {
  if (prependState !== undefined) return;
  if (scrollMode !== 'follow' || userScrollIntent || pointerScrolling) {
    if (scrollMode !== 'follow') cancelScheduledOutputScroll();
    return;
  }
  scrollGeneration += 1;
  if (scrollFrame !== undefined) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = undefined;
    if (scrollMode !== 'follow' || userScrollIntent || pointerScrolling) return;
    output.scrollTop = output.scrollHeight;
    state.scrollTop = output.scrollTop;
    saveState();
    scheduleStickyPrompt();
    const renderedGeneration = scrollGeneration;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined;
      if (scrollMode !== 'follow' || userScrollIntent || pointerScrolling) return;
      output.scrollTop = output.scrollHeight;
      state.scrollTop = output.scrollTop;
      saveState();
      scheduleStickyPrompt();
      if (renderedGeneration !== scrollGeneration) followOutput();
    });
  });
}

function requestOlderHistory(initial = false) {
  if (initial && output.querySelector('.message.user') !== null) return;
  if (!historyHasMore || historyLoading || prependState !== undefined || output.scrollTop > 480) return;
  historyLoading = true;
  vscode.postMessage({ type: 'loadOlder' });
}

function beginHistoryPrepend() {
  if (prependState !== undefined) return;
  prependState = {
    turns,
    tools,
    compactions,
    activeAssistant,
    activeAssistantMessage,
    activeTurn,
    nodes: [...output.childNodes],
    scrollTop: output.scrollTop,
    scrollHeight: output.scrollHeight,
    following: scrollMode === 'follow' && !userScrollIntent && !pointerScrolling,
  };
  renderTarget = document.createDocumentFragment();
  turns = new Map();
  tools = new Map();
  compactions = new Map();
  activeAssistant = undefined;
  activeAssistantMessage = undefined;
  activeTurn = undefined;
}

function endHistoryPrepend() {
  if (prependState === undefined) return;
  const previous = prependState;
  const prependedTurns = turns;
  const prependedTools = tools;
  const prependedCompactions = compactions;
  const fragment = renderTarget;
  renderTarget = output;
  for (const [number, older] of prependedTurns) {
    const newer = previous.turns.get(number);
    if (newer === undefined) continue;
    const merged = mergePrependedTurnState(older, newer);
    updateTurnProcessLabel(merged, !merged.completed);
    prependedTurns.set(number, merged);
  }
  reattachTranscriptTail(output, [...fragment.childNodes], previous.nodes);
  turns = new Map([...prependedTurns, ...previous.turns]);
  tools = new Map([...prependedTools, ...previous.tools]);
  compactions = new Map([...prependedCompactions, ...previous.compactions]);
  activeAssistant = previous.activeAssistant;
  activeAssistantMessage = previous.activeAssistantMessage;
  activeTurn = previous.activeTurn;
  prependState = undefined;
  if (previous.following) {
    followOutput();
    return;
  }
  output.scrollTop = previous.scrollTop + output.scrollHeight - previous.scrollHeight;
  state.scrollTop = output.scrollTop;
  saveState();
  scheduleStickyPrompt();
}

function scheduleStickyPrompt() {
  if (stickyPromptFrame !== undefined) return;
  stickyPromptFrame = requestAnimationFrame(() => {
    stickyPromptFrame = undefined;
    updateStickyPrompt();
  });
}

function updateStickyPrompt() {
  const prompts = [...output.querySelectorAll('.message.user')];
  const viewport = output.getBoundingClientRect();
  const promptRects = prompts.map((message) => ({ message, rect: message.getBoundingClientRect() }));
  const visible = promptRects.some(({ rect }) => rect.bottom > viewport.top && rect.top < viewport.bottom);
  if (visible) {
    setStickyPrompt();
    return;
  }
  const target = promptRects.findLast(({ rect }) => rect.bottom <= viewport.top);
  setStickyPrompt(target?.message);
}

function setStickyPrompt(target) {
  stickyPromptTarget = target;
  stickyPrompt.hidden = target === undefined;
  if (target === undefined) return;
  stickyPromptText.textContent = target.querySelector('.body')?.textContent ?? '';
  const sourceTime = target.querySelector('.message-time');
  stickyPromptTime.hidden = sourceTime === null;
  if (sourceTime !== null) {
    stickyPromptTime.textContent = sourceTime.textContent;
    stickyPromptTime.dateTime = sourceTime.dateTime;
    stickyPromptTime.title = sourceTime.title;
  }
}

function autoGrowPrompt() {
  prompt.style.height = 'auto';
  const height = Math.min(prompt.scrollHeight, 200);
  prompt.style.height = `${String(height)}px`;
  prompt.style.overflowY = prompt.scrollHeight > 200 ? 'auto' : 'hidden';
}

function setMessageTime(message, value) {
  if (message === undefined || !Number.isFinite(value)) return;
  let time = message.querySelector('.message-time');
  if (time === null) {
    time = document.createElement('time');
    time.className = 'message-time';
    message.append(time);
  }
  setTime(time, value);
}

function setTime(element, value) {
  if (!Number.isFinite(value)) return;
  const date = new Date(value);
  element.dateTime = date.toISOString();
  element.textContent = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  element.title = `${fullTime(value)}\n${date.toISOString()}`;
}

function fullTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(new Date(value));
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function firstLine(text) {
  return text.split('\n', 1)[0].replaceAll('**', '');
}

function latestLine(text) {
  const lines = text.trimEnd().split('\n');
  return (lines.at(-1) ?? '').replaceAll('**', '');
}

function titleCase(value) {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function isCostSummary(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => (
    !['totals', 'breakdown', 'details', 'coverage'].includes(key)
  )) || (value.coverage !== undefined && (!isRecord(value.coverage)
    || Object.keys(value.coverage).length !== 2
    || !isCount(value.coverage.accountedTurns) || Object.is(value.coverage.accountedTurns, -0)
    || !isCount(value.coverage.unaccountedTurns) || Object.is(value.coverage.unaccountedTurns, -0)))
    || !Array.isArray(value.totals) || !value.totals.every(isMonetaryAmount)
    || !Array.isArray(value.breakdown)) return false;
  const totals = new Map();
  for (const total of value.totals) {
    if (totals.has(total.currency)) return false;
    totals.set(total.currency, total.nanos);
  }
  const buckets = new Set();
  const sums = new Map();
  for (const bucket of value.breakdown) {
    if (!isRecord(bucket) || Object.keys(bucket).length !== 4
      || !['reported', 'estimated', 'virtual'].includes(bucket.kind)
      || typeof bucket.currency !== 'string' || !/^[A-Z]{3,12}$/u.test(bucket.currency)
      || !isCount(bucket.nanos) || Object.is(bucket.nanos, -0)
      || !Number.isSafeInteger(bucket.calls) || bucket.calls <= 0
      || (bucket.routes !== undefined
        && (!Array.isArray(bucket.routes) || !bucket.routes.every((item) => typeof item === 'string')))
      || (bucket.sources !== undefined
        && (!Array.isArray(bucket.sources) || !bucket.sources.every((item) => typeof item === 'string')))
      || (bucket.tariffVersions !== undefined
        && (!Array.isArray(bucket.tariffVersions)
          || !bucket.tariffVersions.every((item) => typeof item === 'string')))
      || (bucket.components !== undefined && (!isRecord(bucket.components)
        || !['inputNanos', 'outputNanos', 'cacheReadNanos', 'cacheWriteNanos']
          .every((key) => bucket.components[key] === undefined || isCount(bucket.components[key]))))) return false;
    const key = `${bucket.currency}\0${bucket.kind}`;
    if (buckets.has(key)) return false;
    buckets.add(key);
    const sum = (sums.get(bucket.currency) ?? 0) + bucket.nanos;
    if (!Number.isSafeInteger(sum)) return false;
    sums.set(bucket.currency, sum);
  }
  if (totals.size !== sums.size) return false;
  for (const [currency, nanos] of sums) if (totals.get(currency) !== nanos) return false;
  return value.details === undefined || (Array.isArray(value.details) && value.details.every(isCostDetail));
}

function isCostDetail(detail) {
  return isRecord(detail) && Object.keys(detail).every((key) => (
    ['scope', 'kind', 'currency', 'nanos', 'calls', 'routes', 'sources', 'tariffVersions', 'components'].includes(key)
  )) && ['call', 'turn'].includes(detail.scope)
    && ['reported', 'estimated', 'virtual'].includes(detail.kind)
    && typeof detail.currency === 'string' && /^[A-Z]{3,12}$/u.test(detail.currency)
    && isCount(detail.nanos) && !Object.is(detail.nanos, -0) && Number.isSafeInteger(detail.calls) && detail.calls > 0
    && (detail.routes === undefined
      || (Array.isArray(detail.routes) && detail.routes.every((item) => typeof item === 'string')))
    && (detail.sources === undefined
      || (Array.isArray(detail.sources) && detail.sources.every((item) => typeof item === 'string')))
    && (detail.tariffVersions === undefined
      || (Array.isArray(detail.tariffVersions)
        && detail.tariffVersions.every((item) => typeof item === 'string')))
    && (detail.components === undefined || (isRecord(detail.components)
      && Object.keys(detail.components).length > 0
      && Object.keys(detail.components).every((key) => (
        ['inputNanos', 'outputNanos', 'cacheReadNanos', 'cacheWriteNanos'].includes(key)
      )) && ['inputNanos', 'outputNanos', 'cacheReadNanos', 'cacheWriteNanos']
        .every((key) => detail.components[key] === undefined
          || (isCount(detail.components[key]) && !Object.is(detail.components[key], -0)))));
}

function isMonetaryAmount(value) {
  return isRecord(value) && Object.keys(value).length === 2
    && typeof value.currency === 'string' && /^[A-Z]{3,12}$/u.test(value.currency)
    && isCount(value.nanos) && !Object.is(value.nanos, -0);
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSessionInformation(value) {
  return isRecord(value) && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && typeof value.companionVersion === 'string' && value.companionVersion.length > 0
    && typeof value.backendVersion === 'string' && value.backendVersion.length > 0;
}

function isProviderSettingsSnapshot(value) {
  if (!isRecord(value) || typeof value.writable !== 'boolean'
    || !Number.isSafeInteger(value.modelPolicyRevision) || value.modelPolicyRevision < 0
    || !Array.isArray(value.providers) || value.providers.length !== 5) return false;
  const ids = new Set();
  return value.providers.every((provider) => {
    if (!isRecord(provider) || typeof provider.id !== 'string' || provider.id.length === 0 || ids.has(provider.id)
      || typeof provider.name !== 'string' || !['native', 'catalog', 'wrapper'].includes(provider.kind)
      || typeof provider.active !== 'boolean' || typeof provider.enabled !== 'boolean'
      || (provider.baseURL !== undefined && typeof provider.baseURL !== 'string')
      || !Number.isSafeInteger(provider.revision) || provider.revision < 0
      || !isRecord(provider.credential)
      || Object.keys(provider.credential).some(key => !['ref', 'configured', 'writable', 'source'].includes(key))
      || typeof provider.credential.ref !== 'string' || provider.credential.ref.length === 0
      || typeof provider.credential.configured !== 'boolean' || typeof provider.credential.writable !== 'boolean'
      || (provider.credential.source !== undefined && typeof provider.credential.source !== 'string')
      || !Array.isArray(provider.models) || !provider.models.every(model => isRecord(model)
        && typeof model.id === 'string' && model.id.length > 0
        && typeof model.name === 'string' && typeof model.enabled === 'boolean'
        && (model.description === undefined || typeof model.description === 'string'))) return false;
    ids.add(provider.id);
    return true;
  });
}

function isModelSelection(value) {
  return isRecord(value) && typeof value.provider === 'string' && value.provider.length > 0
    && typeof value.model === 'string' && value.model.length > 0
    && (value.reasoningEffort === undefined
      || (typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0));
}

function isPermissionSelection(value) {
  return isRecord(value) && typeof value.currentValue === 'string' && value.currentValue.length > 0
    && Array.isArray(value.options) && value.options.some((item) => item?.value === value.currentValue)
    && value.options.every((item) => isRecord(item) && typeof item.value === 'string' && item.value.length > 0
      && typeof item.name === 'string' && item.name.length > 0
      && (item.description === undefined || typeof item.description === 'string'));
}

function isContextPressure(value) {
  return isRecord(value)
    && isOptionalCount(value.pressureTokens)
    && isOptionalCount(value.projectedTokens)
    && (value.contextWindow === undefined
      || (Number.isSafeInteger(value.contextWindow) && value.contextWindow > 0));
}

function isProviderAccountSnapshot(value) {
  if (!isRecord(value) || typeof value.provider !== 'string'
    || !['ready', 'stale', 'unavailable'].includes(value.status)
    || typeof value.refreshing !== 'boolean' || !isOptionalCount(value.observedAt)
    || (value.error !== undefined && typeof value.error !== 'string')) return false;
  if (value.value === undefined) return true;
  if (!isRecord(value.value) || !['ready', 'authentication-required'].includes(value.value.accountStatus)
    || (value.value.activeAllowance !== undefined && typeof value.value.activeAllowance !== 'string')
    || !Array.isArray(value.value.allowances) || !value.value.allowances.every(isAllowanceGroup)) return false;
  const plan = value.value.plan;
  if (plan !== undefined && (!isRecord(plan) || typeof plan.id !== 'string'
    || (plan.name !== undefined && typeof plan.name !== 'string'))) return false;
  const credits = value.value.credits;
  return credits === undefined || (isRecord(credits)
    && (credits.hasCredits === undefined || typeof credits.hasCredits === 'boolean')
    && (credits.unlimited === undefined || typeof credits.unlimited === 'boolean')
    && (credits.balance === undefined || typeof credits.balance === 'string')
    && (credits.overageLimitReached === undefined || typeof credits.overageLimitReached === 'boolean'));
}

function isAllowanceGroup(value) {
  return isRecord(value) && typeof value.id === 'string'
    && (value.name === undefined || typeof value.name === 'string')
    && (value.reached === undefined || typeof value.reached === 'boolean')
    && (value.primary === undefined || isAllowanceWindow(value.primary))
    && (value.secondary === undefined || isAllowanceWindow(value.secondary));
}

function isAllowanceWindow(value) {
  return isRecord(value) && typeof value.usedPercent === 'number' && Number.isFinite(value.usedPercent)
    && value.usedPercent >= 0 && isOptionalCount(value.windowSeconds)
    && isOptionalInteger(value.resetsAt) && isOptionalInteger(value.resetsInSeconds);
}

function isOptionalInteger(value) {
  return value === undefined || Number.isSafeInteger(value);
}

function isOptionalCount(value) {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function isCompactionEvent(value) {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return false;
  if (value.type === 'start') return Number.isFinite(value.time);
  if (value.type === 'summary') return isOptionalCount(value.itemCount) && value.itemCount !== undefined
    && isOptionalCount(value.tokenCount) && value.tokenCount !== undefined;
  return value.type === 'end' && Number.isFinite(value.time)
    && (value.error === undefined || typeof value.error === 'string');
}

function isModelCatalog(value) {
  return isRecord(value) && isModelSelection(value.default)
    && Array.isArray(value.routableProviders) && value.routableProviders.every((item) => typeof item === 'string')
    && Array.isArray(value.failures) && value.failures.every((failure) => (
      isRecord(failure) && typeof failure.id === 'string' && typeof failure.name === 'string'
      && typeof failure.message === 'string'
    ))
    && Array.isArray(value.groups) && value.groups.every((group) => (
      isRecord(group) && typeof group.id === 'string' && typeof group.name === 'string'
      && Array.isArray(group.models) && group.models.every((model) => (
        isRecord(model) && typeof model.id === 'string' && typeof model.name === 'string'
        && (model.description === undefined || typeof model.description === 'string')
        && (model.reasoning === undefined || (
          isRecord(model.reasoning) && Array.isArray(model.reasoning.efforts)
          && (model.reasoning.defaultEffort === undefined || typeof model.reasoning.defaultEffort === 'string')
          && model.reasoning.efforts.every((effort) => (
            isRecord(effort) && typeof effort.id === 'string' && typeof effort.name === 'string'
            && (effort.description === undefined || typeof effort.description === 'string')
          ))
        ))
      ))
    ));
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

updateInputAvailability();
renderModelTrigger();
renderPermissionSelect();
renderProviderUsage();
renderSessionInformation();
renderContextMeter();
updateScrollButton();
saveState();
vscode.postMessage({ type: 'ready' });
