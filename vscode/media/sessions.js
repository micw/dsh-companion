const vscode = acquireVsCodeApi();
const search = document.getElementById('search');
const status = document.getElementById('status');
const sessions = document.getElementById('sessions');

let snapshot;
let searchResults;
let searchTimer;

window.addEventListener('message', ({ data }) => {
  if (!isRecord(data) || typeof data.type !== 'string') return;
  if (data.type === 'status') {
    if (!['connecting', 'refreshing', 'error'].includes(data.phase) || typeof data.text !== 'string') return;
    renderStatus(data.phase, data.text);
    return;
  }
  if (data.type === 'sessions') {
    if (!isSessionsMessage(data)) return;
    snapshot = data;
    if (data.phase === 'pending') renderStatus('connecting', 'Connecting to DSH…');
    else if (search.value.trim() !== '' && searchResults?.query === search.value.trim()) updateActiveRows();
    else render();
    return;
  }
  if (data.type === 'searching') {
    if (typeof data.query !== 'string' || data.query !== search.value.trim()) return;
    renderStatus('searching', 'Searching questions and answers…');
    return;
  }
  if (data.type === 'searchResults') {
    if (!isSearchResultsMessage(data) || data.query !== search.value.trim()) return;
    searchResults = data;
    render();
    return;
  }
  if (data.type === 'searchFailed') {
    if (typeof data.query !== 'string' || data.query !== search.value.trim() || typeof data.text !== 'string') return;
    renderStatus('error', data.text);
    return;
  }
  if (data.type === 'focusSearch') search.focus();
});

search.addEventListener('input', () => {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  const query = search.value.trim();
  if (query === '') {
    searchResults = undefined;
    vscode.postMessage({ type: 'search', query: '' });
    render();
    return;
  }
  renderStatus('searching', 'Searching questions and answers…');
  searchTimer = setTimeout(() => vscode.postMessage({ type: 'search', query }), 200);
});

function render() {
  sessions.replaceChildren();
  status.replaceChildren();
  status.hidden = true;
  const query = search.value.trim();
  if (query !== '') {
    if (searchResults === undefined || searchResults.query !== query) {
      renderStatus('searching', 'Searching questions and answers…');
      return;
    }
    renderRows(searchResults.items, true);
    if (searchResults.items.length === 0) renderEmpty('No matching questions or answers.');
    if (searchResults.hasMore) {
      const more = document.createElement('p');
      more.className = 'more';
      more.textContent = 'More matches exist. Refine the search to narrow the results.';
      sessions.append(more);
    }
    return;
  }
  if (snapshot === undefined || snapshot.phase !== 'ready') {
    renderStatus('connecting', 'Connecting to DSH…');
    return;
  }
  renderRows(snapshot.sessions, false);
  if (snapshot.sessions.length === 0) renderEmpty('No sessions yet.', true);
}

function renderRows(items, searching) {
  for (const item of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.dataset.sessionId = item.sessionId;
    row.className = `session${item.sessionId === snapshot?.activeSessionId ? ' active' : ''}`;
    row.title = [item.title, item.cwd, new Date(item.updatedAt).toLocaleString(), item.sessionId]
      .filter(value => value !== undefined).join('\n');
    row.addEventListener('click', () => vscode.postMessage({ type: 'openSession', sessionId: item.sessionId }));
    const head = document.createElement('span');
    head.className = 'session-head';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = item.running ? 'Running' : formatTime(item.updatedAt);
    meta.title = new Date(item.updatedAt).toLocaleString();
    head.append(title, meta);
    row.append(head);
    if (searching) {
      const snippet = document.createElement('span');
      snippet.className = 'session-snippet';
      snippet.textContent = item.snippet.replace(/\s+/gu, ' ').trim();
      row.append(snippet);
    }
    sessions.append(row);
  }
}

function updateActiveRows() {
  for (const row of sessions.querySelectorAll('.session')) {
    row.classList.toggle('active', row.dataset.sessionId === snapshot?.activeSessionId);
  }
}

function renderStatus(kind, text) {
  sessions.replaceChildren();
  status.replaceChildren();
  status.hidden = false;
  status.dataset.kind = kind;
  const label = document.createElement('span');
  label.textContent = text;
  status.append(label);
  if (kind === 'error') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    status.append(retry);
  }
}

function renderEmpty(text, offerNew = false) {
  const empty = document.createElement('section');
  empty.className = 'empty';
  const label = document.createElement('p');
  label.textContent = text;
  empty.append(label);
  if (offerNew) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'New Chat';
    button.addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
    empty.append(button);
  }
  sessions.append(empty);
}

function formatTime(updatedAt) {
  const deltaSeconds = Math.round((updatedAt - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, 'second');
  const minutes = Math.round(deltaSeconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, 'day');
  return new Date(updatedAt).toLocaleDateString();
}

function isSessionsMessage(value) {
  return (value.phase === 'pending' || value.phase === 'ready')
    && (value.activeSessionId === undefined || typeof value.activeSessionId === 'string')
    && Array.isArray(value.sessions) && value.sessions.every(isSession);
}

function isSearchResultsMessage(value) {
  return typeof value.query === 'string' && typeof value.hasMore === 'boolean'
    && Array.isArray(value.items) && value.items.every(item => isSession(item) && typeof item.snippet === 'string');
}

function isSession(value) {
  return isRecord(value) && typeof value.sessionId === 'string' && typeof value.title === 'string'
    && typeof value.running === 'boolean' && typeof value.completed === 'boolean'
    && typeof value.blank === 'boolean' && Number.isSafeInteger(value.updatedAt)
    && (value.cwd === undefined || typeof value.cwd === 'string');
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

vscode.postMessage({ type: 'ready' });
