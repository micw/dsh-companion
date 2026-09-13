const vscode = acquireVsCodeApi();
const output = document.getElementById('output');
const stickyPrompt = document.getElementById('sticky-prompt');
const stickyPromptJump = document.getElementById('sticky-prompt-jump');
const stickyPromptText = document.getElementById('sticky-prompt-text');
const stickyPromptTime = document.getElementById('sticky-prompt-time');
const queue = document.getElementById('queue');
const composer = document.getElementById('composer');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const stop = document.getElementById('stop');
const status = document.getElementById('status');
const restored = vscode.getState() ?? {};
const restoredSessionId = typeof restored.sessionId === 'string' ? restored.sessionId : undefined;
const restoredScrollTop = typeof restored.scrollTop === 'number' ? restored.scrollTop : 0;
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
  scrollTop: restoredScrollTop,
  disclosures: { ...restoredDisclosures },
};
let turns = new Map();
let tools = new Map();
const pendingSubmissions = new Map();
const committedRequestIds = new Set();
let hostQueue = [];
let activeAssistant;
let activeAssistantMessage;
let activeTurn;
let running = false;
let stickyPromptTarget;
let stickyPromptFrame;
let renderTarget = output;
let prependState;
let historyHasMore = false;
let historyLoading = false;

prompt.value = state.draft;
requestAnimationFrame(autoGrowPrompt);

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = prompt.value.trim();
  if (text.length === 0) return;
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
  if (running) vscode.postMessage({ type: 'stop' });
});

stickyPromptJump.addEventListener('click', () => {
  if (stickyPromptTarget === undefined) return;
  stickyPromptTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

output.addEventListener('scroll', () => {
  state.scrollTop = output.scrollTop;
  saveState();
  scheduleStickyPrompt();
  requestOlderHistory();
}, { passive: true });

window.addEventListener('resize', scheduleStickyPrompt);

output.addEventListener('click', (event) => {
  const anchor = event.target.closest?.('a[href]');
  if (anchor === undefined || anchor === null) return;
  const href = anchor.getAttribute('href');
  if (!/^https?:\/\//i.test(href ?? '')) return;
  event.preventDefault();
  vscode.postMessage({ type: 'openLink', href });
});

document.addEventListener('pointerdown', (event) => {
  const targetControl = event.target.closest?.('.stat-control');
  closeStatControls(targetControl);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeStatControls();
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'session') {
    state.sessionId = message.sessionId;
    send.disabled = false;
    if (message.sessionId === restoredSessionId) {
      requestAnimationFrame(() => {
        output.scrollTop = restoredScrollTop;
        state.scrollTop = restoredScrollTop;
        saveState();
        scheduleStickyPrompt();
      });
    }
    saveState();
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
    requestAnimationFrame(requestOlderHistory);
    return;
  }
  if (message.type === 'historyLoadFailed') {
    historyLoading = false;
    status.textContent = typeof message.text === 'string' ? message.text : 'Could not load earlier history';
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
  if (message.type === 'running') {
    setRunning(message.value);
    return;
  }
  if (message.type === 'status') {
    status.textContent = message.text;
    return;
  }
  if (message.type === 'sending') {
    send.disabled = message.value;
    return;
  }
  if (message.type === 'stopping') {
    stop.disabled = message.value;
    return;
  }
  if (message.type === 'error') appendMessage('error', message.text);
});

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
  if (role === 'user' && turn?.root.parentNode === renderTarget && turn.rows.childElementCount === 0) {
    renderTarget.insertBefore(article, turn.root);
  } else {
    renderTarget.append(article);
  }
  if (role === 'assistant') {
    activeAssistant = body;
    activeAssistantMessage = article;
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
  const turn = ensureTurn(event.turn);
  if (event.type === 'turn-end') {
    completeTurn(turn, event.time, event.reason);
    const key = `turn:${String(event.turn)}`;
    if (event.replay !== true || !Object.hasOwn(restoredDisclosures, key)) {
      turn.root.open = false;
      state.disclosures[key] = false;
      saveState();
    }
    return;
  }
  if (event.type === 'reasoning' && typeof event.text === 'string') {
    appendReasoning(turn, event);
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
    toolCount: 0,
    contextCount: 0,
    reasoning: new Map(),
    toolCallIds: new Set(),
    contextIds: new Set(),
    startedAt,
  };
  turns.set(number, turn);
  return turn;
}

function completeTurn(turn, completedAt, reason) {
  if (!Number.isFinite(completedAt)) return;
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

function appendToolCall(turn, event) {
  if (typeof event.callId !== 'string' || typeof event.name !== 'string') return;
  if (turn.toolCallIds.has(event.callId)) return;
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
  if (turn.toolCount > 0) labels.push(`${turn.toolCount} tool ${turn.toolCount === 1 ? 'call' : 'calls'}`);
  if (turn.contextCount > 0) {
    labels.push(`${turn.contextCount} context ${turn.contextCount === 1 ? 'injection' : 'injections'}`);
  }
  turn.label.textContent = labels.length === 0 ? 'Working…' : `${labels.join(' · ')}${active ? '…' : ''}`;
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
  footer.append(timingControl(turn, summary));
  const previousTime = activeAssistantMessage?.querySelector('.message-time');
  previousTime?.remove();
  const clock = document.createElement('time');
  clock.className = 'turn-footer-clock';
  setTime(clock, summary.completedAt);
  footer.append(clock);
  if (activeAssistantMessage === undefined) renderTarget.append(footer);
  else activeAssistantMessage.append(footer);
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

function setRunning(value) {
  running = value;
  stop.hidden = !value;
  stop.disabled = false;
  composer.dataset.running = value ? 'true' : 'false';
  status.dataset.running = value ? 'true' : 'false';
  status.textContent = value ? 'Running…' : 'Connected';
}

function saveState() {
  vscode.setState(state);
}

function followOutput() {
  if (prependState !== undefined) return;
  output.scrollTop = output.scrollHeight;
  state.scrollTop = output.scrollTop;
  saveState();
  scheduleStickyPrompt();
}

function requestOlderHistory() {
  if (!historyHasMore || historyLoading || prependState !== undefined || output.scrollTop > 480) return;
  historyLoading = true;
  vscode.postMessage({ type: 'loadOlder' });
}

function beginHistoryPrepend() {
  if (prependState !== undefined) return;
  prependState = {
    turns,
    tools,
    activeAssistant,
    activeAssistantMessage,
    activeTurn,
    scrollTop: output.scrollTop,
    scrollHeight: output.scrollHeight,
  };
  renderTarget = document.createDocumentFragment();
  turns = new Map();
  tools = new Map();
  activeAssistant = undefined;
  activeAssistantMessage = undefined;
  activeTurn = undefined;
}

function endHistoryPrepend() {
  if (prependState === undefined) return;
  const previous = prependState;
  const prependedTurns = turns;
  const prependedTools = tools;
  const fragment = renderTarget;
  renderTarget = output;
  output.prepend(fragment);
  turns = new Map([...prependedTurns, ...previous.turns]);
  tools = new Map([...prependedTools, ...previous.tools]);
  activeAssistant = previous.activeAssistant;
  activeAssistantMessage = previous.activeAssistantMessage;
  activeTurn = previous.activeTurn;
  prependState = undefined;
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

stop.hidden = true;
send.disabled = true;
saveState();
