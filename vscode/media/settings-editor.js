/* Standalone settings presentation. Runtime values are read-only snapshots; drafts remain ephemeral. */
(() => {
  const vscode = acquireVsCodeApi();
  const { modelsValid, searchValid, versionValid, restoredView, searchSummary } = globalThis.dshCompanionSettingsState;
  const content = document.getElementById('content');
  const connection = document.getElementById('connection');
  let view = restoredView(vscode.getState());
  let version; let versionChannel = 'master'; let versionPending; let versionChannelPending = false; let versionNeedsCheck = false;
  const versionBusy = () => !!versionPending || ['checking', 'downloading', 'installing'].includes(version?.phase);
  function versionRequest(action) {
    if (versionBusy() || (action === 'install' && (versionNeedsCheck || !version?.canInstall || version.phase !== 'available' || version.channel !== versionChannel))) return;
    if (action === 'check') versionNeedsCheck = false;
    versionPending = action;
    vscode.postMessage({ type: 'versionRequest', requestId: ++nextRequest, action, channel: versionChannel });
    if (view.category === 'version') render();
  }
  let models; let search; let phase = 'connecting'; let generation = 0; let loaded = false;
  let dirty = false; let nextRequest = 0; let saveDraft; let form; let formBusy = false;
  let notice; let rows = new Map(); let modelRows = new Map();
  let list; let filterInput; let filterSelect; let loadingRequest; let statusPending = false;
  const requests = new Map(); const rowBusy = new Set();
  const probing = new Set();
  const scrolls = new Map(); let discardTarget;
  const element = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
  const button = (text, action, className) => { const e = element('button', text, className); e.type = 'button'; e.addEventListener('click', action); return e; };
  const online = () => phase === 'connected' && loaded;
  function setDirty(value) { if (dirty === value) return; dirty = value; vscode.postMessage({ type: 'settingsDirty', dirty }); }
  function persist() { vscode.setState({ category: view.category, ...(view.id ? { id: view.id } : {}), scroll: content.scrollTop }); }
  function request(operation, success, failure, background = false) {
    if (phase !== 'connected') { failure?.(); return; }
    const requestId = ++nextRequest;
    const timer = setTimeout(() => {
      if (!requests.has(requestId)) return;
      requests.delete(requestId); if (!background) showError('The request timed out. Close and reopen settings before repeating a save or test.'); failure?.();
    }, 30000);
    requests.set(requestId, { generation, kind: operation.kind, timer, success, failure, background });
    vscode.postMessage({ type: 'settingsRequest', requestId, operation });
    return requestId;
  }
  function showError(text) { if (notice) { notice.textContent = text; notice.setAttribute('role', 'alert'); } }
  function navigate(target) {
    if (dirty) {
      if (discardTarget) return;
      const requestId = ++nextRequest; discardTarget = { target, requestId };
      vscode.postMessage({ type: 'settingsDiscardRequest', requestId }); return;
    }
    changeView(target);
  }
  function changeView(target) {
    scrolls.set(view.category + ':' + (view.id ?? ''), content.scrollTop);
    setDirty(false); view = target; render();
    content.scrollTop = scrolls.get(view.category + ':' + (view.id ?? '')) ?? target.scroll ?? 0;
    persist();
    if (view.category === 'version') versionRequest('load');
  }
  for (const tab of document.querySelectorAll('[data-category]')) tab.addEventListener('click', () => navigate({ category: tab.dataset.category }));
  content.addEventListener('scroll', persist);
  function render() {
    rows = new Map(); modelRows = new Map(); form = undefined; saveDraft = undefined; filterInput = undefined; filterSelect = undefined;
    content.replaceChildren();
    for (const tab of document.querySelectorAll('[data-category]')) tab.setAttribute('aria-current', tab.dataset.category === view.category ? 'page' : 'false');
    const head = element('div', undefined, 'section-heading'); head.append(element('h2', view.category === 'models' ? 'Models' : view.category === 'version' ? 'Version' : 'Web Search'));
    if (view.category === 'models') head.append(button('Refresh', () => {
      if (phase !== 'connected') { vscode.postMessage({ type: 'settingsReconnect' }); return; }
      if (dirty) { navigate({ ...view }); return; }
      load();
    })); content.append(head);
    notice = element('p', '', 'notice'); notice.setAttribute('role', 'status'); content.append(notice);
    if (view.category === 'version') { renderVersion(); return; }
    if (!loaded) { notice.textContent = phase === 'connected' ? 'Loading settings…' : 'Connecting to DSH…'; return; }
    if (view.category === 'models') renderModels(); else renderSearch();
    controls();
  }
  function renderVersion() {
    const tools = element('div', undefined, 'toolbar');
    const channel = element('select'); channel.setAttribute('aria-label', 'Update channel');
    for (const name of ['master', 'stable']) { const option = element('option', name === 'master' ? 'Master' : 'Stable'); option.value = name; channel.append(option); }
    channel.value = versionChannel; channel.disabled = versionBusy();
    channel.addEventListener('change', () => {
      if (versionBusy() || !['master', 'stable'].includes(channel.value) || channel.value === versionChannel) return;
      versionChannel = channel.value; version = undefined; versionChannelPending = true; versionNeedsCheck = true; versionRequest('load');
    });
    const check = button('Check for Updates', () => versionRequest('check')); check.disabled = versionBusy() || !version;
    const install = button('Install update and restart', () => versionRequest('install'));
    install.disabled = versionBusy() || versionNeedsCheck || !version?.canInstall || version.phase !== 'available' || version.channel !== versionChannel;
    tools.append(channel, check, install); content.append(tools);
    notice.textContent = version?.message || (versionPending === 'load' || !version ? 'Loading version information…' : '');
    if (version?.phase === 'error') notice.setAttribute('role', 'alert');
    const details = element('dl', undefined, 'version-details');
    for (const [label, value] of [['Installed version', version?.installedVersion], ['Target', version?.target], ['Available version', version?.available?.version], ['Size', version?.available ? `${version.available.size} bytes` : undefined], ['Published', version?.available?.publishedAt]]) {
      details.append(element('dt', label), element('dd', value ?? '—'));
    }
    content.append(details);
    if (version?.blockedReason) content.append(element('p', version.blockedReason, 'notice'));
    // Release URLs are intentionally not actionable in this editor.
    if (version?.progress !== null && version?.progress !== undefined) {
      const progress = element('progress'); progress.max = 100; progress.value = version.progress; progress.setAttribute('aria-label', 'Update progress');
      content.append(progress, element('p', `${version.progress}%`));
    }
  }
  function controls() {
    content.querySelectorAll('[data-mutate]').forEach(e => { e.disabled = !online() || e.dataset.readonly === 'true' || rowBusy.has(e.dataset.row); });
    if (form) for (const e of form.querySelectorAll('input, select, button')) e.disabled = !online() || formBusy || form.dataset.readonly === 'true' || e.dataset.readonly === 'true';
    patchModelRows();
  }
  function mutateButton(label, operation, row) {
    const e = button(label, () => {
      if (!online() || rowBusy.has(row)) return;
      const op = operation();
      if (op.kind === 'search' && op.command.kind === 'retry') probing.add(row);
      rowBusy.add(row); controls(); patch();
      const settle = () => { rowBusy.delete(row); probing.delete(row); controls(); patch(); };
      request(op, result => {
        settle();
        if (op.kind === 'deleteProvider' && !result.cancelled) changeView({ category: 'models' });
      }, settle);
    }); e.dataset.mutate = 'true'; e.dataset.row = row; return e;
  }
  function load() {
    if (loadingRequest !== undefined || phase !== 'connected') return;
    if (!loaded && view.category !== 'version') render();
    loadingRequest = request({ kind: 'load' }, () => {
      loadingRequest = undefined;
      if (!loaded && models && search) { loaded = true; if (view.category !== 'version') { render(); content.scrollTop = view.scroll ?? 0; } }
      else patch();
    }, () => { loadingRequest = undefined; });
  }
  function listRow(id) {
    let row = rows.get(id);
    if (!row) {
      const root = element('article', undefined, 'summary-row'); root.dataset.id = id;
      const info = element('div'); const title = element('strong'); const status = element('p');
      const actions = element('div', undefined, 'row-actions'); info.append(title, status); root.append(info, actions);
      row = { root, title, status, actions }; rows.set(id, row);
    }
    return row;
  }
  function place(row, index) { if (list.children[index] !== row.root) list.insertBefore(row.root, list.children[index] ?? null); }
  function reconcile(ids) { for (const [id, row] of rows) if (!ids.includes(id)) { row.root.remove(); rows.delete(id); } }
  function renderModels() {
    if (view.form === 'create') { providerForm(undefined, models.families.find(f => f.id === view.family)); return; }
    if (view.id) {
      const provider = models.providers.find(p => p.id === view.id);
      if (!provider) { notice.textContent = 'This provider is no longer available.'; content.append(button('Back to providers', () => navigate({ category: 'models' }))); return; }
      content.append(button('← All providers', () => navigate({ category: 'models' })));
      providerForm(provider); modelSection(provider); return;
    }
    const actions = element('div', undefined, 'toolbar');
    const families = element('select'); families.setAttribute('aria-label', 'Provider family');
    for (const f of models.families) { const option = element('option', f.name); option.value = f.id; option.disabled = f.maxInstances !== null && f.instanceCount >= f.maxInstances; families.append(option); }
    const add = button('Add provider', () => navigate({ category: 'models', form: 'create', family: families.value }));
    add.disabled = !models.writable || !models.families.some(f => f.maxInstances === null || f.instanceCount < f.maxInstances);
    add.dataset.mutate = 'true'; add.dataset.readonly = String(add.disabled);
    actions.append(families, add); content.append(actions);
    list = element('div'); content.append(list); patchModels();
  }
  function patchModels() {
    if (view.category !== 'models' || view.id || view.form) { patchModelRows(); return; }
    reconcile(models.providers.map(p => p.id));
    models.providers.forEach((p, index) => {
      const row = listRow(p.id); row.title.textContent = p.name;
      row.status.textContent = `${p.active ? 'Active' : p.enabled ? 'Configured' : 'Disabled'} · ${p.models.filter(m => m.enabled).length} enabled models`;
      if (!row.actions.children.length) row.actions.append(button('Manage', () => navigate({ category: 'models', id: p.id })));
      place(row, index);
    });
    if (!models.providers.length) notice.textContent = 'No provider configured. Add a provider to get started.';
  }
  function beginForm(title) {
    content.append(element('h3', title)); form = element('form'); form.className = 'edit-form'; content.append(form);
    form.addEventListener('input', () => setDirty(true)); form.addEventListener('change', () => setDirty(true));
    return form;
  }
  function field(label, type, value = '', required = false, readonly = false) {
    const wrapper = element('label', undefined, 'field'); wrapper.append(element('span', label));
    const input = element('input'); input.type = type; input.required = required;
    if (type === 'checkbox') input.checked = value === true; else input.value = value;
    input.maxLength = type === 'password' ? 4096 : type === 'url' ? 4096 : 100;
    if (type === 'password') { input.autocomplete = 'new-password'; input.placeholder = 'Enter a new key; stored keys cannot be read back'; }
    input.dataset.readonly = String(readonly); input.disabled = readonly;
    wrapper.append(input); form.append(wrapper); return input;
  }
  function formActions(operation, back) {
    const actions = element('div', undefined, 'toolbar'); const save = element('button', 'Save'); save.type = 'submit';
    actions.append(save, button('Cancel', () => navigate(back))); form.append(actions);
    const submit = () => {
      if (!online() || formBusy || !form.reportValidity()) { vscode.postMessage({ type: 'settingsSaveRejected' }); return; }
      const op = operation(); if (!op) { vscode.postMessage({ type: 'settingsSaveRejected' }); return; }
      // No password is retained in a draft object, editor state, or pending-request metadata.
      form.querySelectorAll('input[type="password"]').forEach(e => { e.value = ''; });
      formBusy = true; controls(); notice.textContent = 'Saving…';
      request(op, result => {
        formBusy = false;
        if (result.cancelled) { controls(); return; }
        setDirty(false); changeView(back);
      }, () => { formBusy = false; controls(); vscode.postMessage({ type: 'settingsSaveRejected' }); });
    };
    form.addEventListener('submit', e => { e.preventDefault(); submit(); }); saveDraft = submit;
  }
  function providerForm(provider, family) {
    if (!provider && !family) { notice.textContent = 'This provider family is no longer available.'; return; }
    const readonly = !models.writable;
    beginForm(provider ? provider.name : `New ${family.name} provider`);
    form.dataset.readonly = String(readonly);
    const enabled = field('Provider enabled', 'checkbox', provider?.enabled ?? true, false, readonly);
    const name = !provider || provider.instanceId ? field('Display name', 'text', provider?.name ?? family.name, true, readonly) : undefined;
    const url = !provider || ['dynamic', 'wrapper'].includes(provider.kind) ? field(provider?.kind === 'wrapper' ? 'Service URL' : 'API URL · optional', 'url', provider?.baseURL ?? '', provider?.kind === 'wrapper' && provider.enabled, readonly) : undefined;
    const key = field(provider?.credential.configured ? 'API key · configured' : 'API key · not configured', 'password', '', !provider, readonly || provider?.credential.writable === false);
    formActions(() => {
      const values = { enabled: enabled.checked, ...(name ? { displayName: name.value.trim() } : {}),
        ...(url && (provider || url.value.trim()) ? { baseURL: url.value.trim() } : {}), ...(key.value.trim() ? { apiKey: key.value } : {}) };
      return provider ? { kind: 'saveProvider', provider: provider.id, revision: provider.revision, ...values,
        ...(['dynamic', 'wrapper'].includes(provider.kind) && enabled.checked ? { test: true } : {}) }
        : { kind: 'createProvider', family: family.id, ...values };
    }, { category: 'models' });
    if (provider?.instanceId && provider.familyId) {
      const remove = mutateButton('Remove provider', () => ({ kind: 'deleteProvider', family: provider.familyId, instance: provider.instanceId, provider: provider.id, displayName: provider.name }), provider.id);
      remove.dataset.readonly = String(readonly); content.append(remove);
    }
  }
  function modelSection(provider) {
    content.append(element('h3', 'Models'));
    const tools = element('div', undefined, 'toolbar');
    filterInput = element('input'); filterInput.type = 'search'; filterInput.placeholder = 'Search models'; filterInput.setAttribute('aria-label', 'Search models');
    filterSelect = element('select'); filterSelect.setAttribute('aria-label', 'Filter models');
    for (const [value, label] of [['all', 'All models'], ['enabled', 'Enabled'], ['disabled', 'Disabled']]) { const o = element('option', label); o.value = value; filterSelect.append(o); }
    filterInput.addEventListener('input', patchModelRows); filterSelect.addEventListener('change', patchModelRows);
    tools.append(filterInput, filterSelect);
    for (const [label, enabled] of [['Enable all', true], ['Disable all', false]]) {
      const b = mutateButton(label, () => ({ kind: 'models', provider: provider.id, models: models.providers.find(p => p.id === provider.id).models.map(m => m.id), enabled, revision: models.modelPolicyRevision }), provider.id);
      b.dataset.readonly = String(!models.writable || !provider.models.length); tools.append(b);
    }
    content.append(tools); const host = element('div'); host.id = 'model-list'; content.append(host); patchModelRows();
  }
  function patchModelRows() {
    if (view.category !== 'models' || !view.id || !filterInput) return;
    const provider = models.providers.find(p => p.id === view.id); const host = document.getElementById('model-list'); if (!provider || !host) return;
    const query = filterInput.value.trim().toLocaleLowerCase(); const filter = filterSelect.value || 'all';
    for (const [index, model] of provider.models.entries()) {
      let row = modelRows.get(model.id);
      if (!row) {
        const label = element('label', undefined, 'model-row'); const input = element('input'); input.type = 'checkbox';
        input.addEventListener('change', () => {
          const wanted = input.checked; input.checked = models.providers.find(p => p.id === provider.id).models.find(m => m.id === model.id).enabled;
          rowBusy.add(model.id); controls(); patchModelRows();
          request({ kind: 'models', provider: provider.id, models: [model.id], enabled: wanted, revision: models.modelPolicyRevision },
            () => { rowBusy.delete(model.id); patchModelRows(); }, () => { rowBusy.delete(model.id); patchModelRows(); });
        });
        label.append(input, element('span', model.name)); row = { root: label, input }; modelRows.set(model.id, row);
      }
      row.input.checked = model.enabled; row.input.disabled = !online() || !models.writable || !provider.enabled || rowBusy.has(model.id) || rowBusy.has(provider.id);
      row.root.hidden = !(filter === 'all' || (filter === 'enabled' ? model.enabled : !model.enabled)) || !`${model.name} ${model.id} ${model.description ?? ''}`.toLocaleLowerCase().includes(query);
      if (host.children[index] !== row.root) host.insertBefore(row.root, host.children[index] ?? null);
    }
    for (const [id, row] of modelRows) if (!provider.models.some(m => m.id === id)) { row.root.remove(); modelRows.delete(id); }
  }
  function renderSearch() {
    if (view.form === 'failover') {
      content.append(button('← All accesses', () => navigate({ category: 'search' })));
      beginForm('Failover settings'); const hours = field('Default cooldown (hours)', 'number', String(search.cooldownMs / 3600000)); hours.step = 'any'; hours.min = '0.000278'; hours.max = '720';
      form.append(element('p', 'Accesses are tried in priority order. Fallback may charge another account. Retry performs one potentially billed test search on the selected access only. Provider-enforced spending caps may be required.'));
      const revision = search.revision;
      formActions(() => ({ kind: 'search', command: { kind: 'cooldown', revision, cooldownMs: Math.round(Number(hours.value) * 3600000) } }), { category: 'search' }); return;
    }
    if (view.id || view.form === 'create') { searchForm(); return; }
    const tools = element('div', undefined, 'toolbar'); tools.append(button('Add access', () => navigate({ category: 'search', form: 'create' })), button('Failover settings', () => navigate({ category: 'search', form: 'failover' }))); content.append(tools);
    list = element('div'); content.append(list); patchSearch();
  }
  function searchForm() {
    const entry = view.id ? search.entries.find(e => e.id === view.id) : undefined;
    content.append(button('← All accesses', () => navigate({ category: 'search' })));
    if (view.id && !entry) { notice.textContent = 'This access is no longer available.'; return; }
    beginForm(entry ? entry.displayName : 'New search access');
    const family = element('select'); family.setAttribute('aria-label', 'Search provider');
    for (const [value, label] of [['brave', 'Brave'], ['exa', 'Exa']]) { const o = element('option', label); o.value = value; family.append(o); }
    family.value = entry?.family ?? 'brave'; family.dataset.readonly = String(!!entry); form.append(family);
    const name = field('Display name', 'text', entry?.displayName ?? '', true);
    const enabled = field('Access enabled', 'checkbox', entry?.enabled ?? true);
    const key = field(entry?.configured ? 'API key · configured' : 'API key', 'password', '', !entry, entry?.writable === false);
    if (entry?.writable === false) form.append(element('p', 'The Runtime environment supplies this key. Change it there and restart the Runtime.'));
    const revision = search.revision;
    formActions(() => ({ kind: 'search', command: { kind: 'save', revision, ...(entry ? { id: entry.id } : {}), family: family.value,
      displayName: name.value.trim(), enabled: enabled.checked, ...(key.value.trim() ? { apiKey: key.value } : {}) } }), { category: 'search' });
  }
  function patchSearch() {
    if (view.category !== 'search' || view.id || view.form) return;
    reconcile(search.entries.map(e => e.id));
    search.entries.forEach((entry, index) => {
      const row = listRow(entry.id); row.title.textContent = `${index + 1}. ${entry.displayName} · ${entry.family === 'brave' ? 'Brave' : 'Exa'}`;
      row.status.textContent = probing.has(entry.id) ? 'Checking…' : rowBusy.has(entry.id) ? 'Updating…' : searchSummary(entry);
      // Menus retain their open state across status refreshes; no row is detached merely to update a countdown.
      if (!row.actions.children.length) {
        const retry = mutateButton('Retry', () => ({ kind: 'search', command: { kind: 'retry', id: entry.id } }), entry.id);
        retry.dataset.retry = 'true'; row.actions.append(retry);
        const menu = element('details', undefined, 'action-menu'); const summary = element('summary', '⋯'); summary.setAttribute('aria-label', `Actions for ${entry.displayName}`); menu.append(summary);
        const items = element('div', undefined, 'menu-items'); menu.append(items);
        items.append(button('Edit', () => navigate({ category: 'search', id: entry.id })));
        const toggle = mutateButton('Disable', () => {
          const current = search.entries.find(e => e.id === entry.id);
          return { kind: 'search', command: { kind: 'save', revision: search.revision, id: current.id, family: current.family, displayName: current.displayName, enabled: !current.enabled } };
        }, entry.id);
        toggle.dataset.toggle = 'true'; items.append(toggle);
        for (const [label, direction] of [['Move up', 'up'], ['Move down', 'down']]) {
          const move = mutateButton(label, () => ({ kind: 'search', command: { kind: 'move', revision: search.revision, id: entry.id, direction } }), entry.id);
          move.dataset.direction = direction; items.append(move);
        }
        items.append(mutateButton('Remove', () => ({ kind: 'search', command: { kind: 'remove', revision: search.revision, id: entry.id } }), entry.id));
        row.actions.append(menu);
      }
      row.actions.querySelector('[data-retry]').hidden = entry.failure === null && !entry.checking && !probing.has(entry.id);
      row.actions.querySelector('[data-retry]').dataset.readonly = String(entry.checking);
      row.actions.querySelector('[data-toggle]').textContent = entry.enabled ? 'Disable' : 'Enable';
      for (const b of row.actions.querySelectorAll('[data-direction]')) b.dataset.readonly = String(b.dataset.direction === 'up' ? index === 0 : index === search.entries.length - 1);
      if (entry.failure) {
        if (!row.details) { row.details = element('details', undefined, 'failure-details'); row.details.append(element('summary', 'Failure details'), element('p')); row.root.children[0].append(row.details); }
        const f = entry.failure; row.details.children[1].textContent = `${f.message}. Failed: ${new Date(f.failedAt).toLocaleString()}. ${f.blockedUntil === null ? 'Manual retry required' : `Retry time: ${new Date(f.blockedUntil).toLocaleString()}`}. ${f.retrySource === 'provider' ? 'Provider retry time' : f.retrySource === 'default' ? 'Default cooldown' : 'Key replacement or successful Retry required'}.`;
      } else if (row.details) { row.details.remove(); row.details = undefined; }
      place(row, index);
    });
    if (!search.entries.length) notice.textContent = 'No search access configured. Add a Brave or Exa access.';
    controls();
  }
  function patch() { if (view.category === 'version' || !loaded) return; if (view.category === 'models') patchModels(); else patchSearch(); controls(); }
  window.addEventListener('message', ({ data: message }) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'versionState') {
      if (!versionValid(message.snapshot) || (versionChannelPending && message.snapshot.channel !== versionChannel)) return;
      version = message.snapshot; versionChannel = version.channel; versionPending = undefined;
      if (view.category === 'version') { const scroll = content.scrollTop; render(); content.scrollTop = scroll; }
      return;
    }
    if (message.type === 'settingsConnection') {
      if (!['connected', 'connecting', 'disconnected'].includes(message.phase) || !Number.isSafeInteger(message.generation) || typeof message.authority !== 'string' || message.authority.length > 200) return;
      const changed = generation !== message.generation; phase = message.phase; generation = message.generation;
      connection.textContent = `${message.authority} · ${phase === 'connected' ? 'Connected' : phase === 'connecting' ? 'Connecting…' : 'Disconnected · showing last loaded settings'}`;
      if (phase !== 'connected' || changed) {
        for (const r of requests.values()) { clearTimeout(r.timer); r.failure?.(); } requests.clear(); loadingRequest = undefined; statusPending = false;
      }
      controls(); if (phase === 'connected' && (changed || !loaded)) load(); else if (!loaded && view.category !== 'version') render(); return;
    }
    if (message.type === 'settingsDiscardResult') {
      if (typeof message.accepted !== 'boolean' || !discardTarget || message.requestId !== discardTarget.requestId) return;
      const { target } = discardTarget; discardTarget = undefined; if (message.accepted) changeView(target); return;
    }
    if (message.type === 'settingsDiscarded') { changeView({ category: view.category }); return; }
    if (message.type === 'settingsSaveDraft') { if (saveDraft && dirty) saveDraft(); else vscode.postMessage({ type: 'settingsSaveRejected' }); return; }
    if (!['settingsResult', 'settingsFailed'].includes(message.type) || message.generation !== generation) return;
    const pending = requests.get(message.requestId); if (!pending || pending.generation !== generation) return;
    clearTimeout(pending.timer); requests.delete(message.requestId);
    if (message.type === 'settingsFailed' || (pending.kind === 'load' && (!modelsValid(message.models) || !searchValid(message.search)))
      || (message.models !== undefined && !modelsValid(message.models)) || (message.search !== undefined && !searchValid(message.search))) {
      if (!pending.background) showError('The operation failed. Close and reopen settings, then retry; another window may have changed these settings.'); pending.failure?.(); return;
    }
    if (message.models) models = message.models; if (message.search) search = message.search;
    patch(); pending.success?.(message);
  });
  setInterval(() => {
    if (!online() || document.visibilityState === 'hidden' || view.category !== 'search' || statusPending) return;
    statusPending = true; request({ kind: 'status' }, () => { statusPending = false; }, () => { statusPending = false; }, true);
  }, 5000);
  render(); content.scrollTop = view.scroll ?? 0; vscode.postMessage({ type: 'settingsReady' });
})();
