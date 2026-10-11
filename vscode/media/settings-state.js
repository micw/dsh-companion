/* Secret-free editor state and validation; persisted state contains navigation only. */
(() => {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const text = (value, max = 300) => typeof value === 'string' && value.length > 0 && value.length <= max;
  function modelsValid(value) {
    return record(value) && keys(value, ['writable', 'modelPolicyRevision', 'families', 'providers'])
      && typeof value.writable === 'boolean' && integer(value.modelPolicyRevision)
      && Array.isArray(value.families) && value.families.length <= 1000
      && value.families.every(f => record(f) && keys(f, ['id', 'name', 'maxInstances', 'instanceCount']) && text(f.id) && text(f.name)
        && (f.maxInstances === null || (integer(f.maxInstances) && f.maxInstances > 0)) && integer(f.instanceCount))
      && new Set(value.families.map(f => f.id)).size === value.families.length
      && Array.isArray(value.providers) && value.providers.length <= 1000
      && new Set(value.providers.map(p => p?.id)).size === value.providers.length
      && value.providers.every(p => record(p) && keys(p, ['id', 'name', 'familyId', 'instanceId', 'kind', 'active', 'enabled', 'baseURL', 'credential', 'revision', 'models'])
        && text(p.id) && text(p.name) && ['native', 'catalog', 'dynamic', 'wrapper'].includes(p.kind)
        && (p.familyId === undefined || value.families.some(f => f.id === p.familyId)) && (p.instanceId === undefined || text(p.instanceId))
        && typeof p.active === 'boolean' && typeof p.enabled === 'boolean' && integer(p.revision)
        && (p.baseURL === undefined || (typeof p.baseURL === 'string' && p.baseURL.length <= 4096))
        && record(p.credential) && keys(p.credential, ['ref', 'configured', 'writable', 'source'])
        && typeof p.credential.ref === 'string' && typeof p.credential.configured === 'boolean' && typeof p.credential.writable === 'boolean'
        && (p.credential.source === undefined || text(p.credential.source))
        && Array.isArray(p.models) && p.models.length <= 1000 && new Set(p.models.map(m => m?.id)).size === p.models.length
        && p.models.every(m => record(m) && keys(m, ['id', 'name', 'description', 'enabled']) && text(m.id) && text(m.name)
          && typeof m.enabled === 'boolean' && (m.description === undefined || (typeof m.description === 'string' && m.description.length <= 10000))));
  }
  function searchValid(value) {
    return record(value) && keys(value, ['revision', 'cooldownMs', 'entries']) && integer(value.revision)
      && integer(value.cooldownMs) && value.cooldownMs >= 1000 && value.cooldownMs <= 30 * 86400000
      && Array.isArray(value.entries) && value.entries.length <= 32 && new Set(value.entries.map(e => e?.id)).size === value.entries.length
      && value.entries.every(e => record(e) && keys(e, ['id', 'family', 'displayName', 'enabled', 'configured', 'writable', 'checking', 'failure'])
        && typeof e.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(e.id) && ['brave', 'exa'].includes(e.family) && text(e.displayName, 100)
        && ['enabled', 'configured', 'writable', 'checking'].every(k => typeof e[k] === 'boolean')
        && (e.failure === null || (record(e.failure) && keys(e.failure, ['reason', 'message', 'failedAt', 'blockedUntil', 'retrySource'])
          && ['credentials', 'quota', 'rate-limit', 'transport', 'timeout', 'server', 'response', 'access'].includes(e.failure.reason)
          && text(e.failure.message, 200) && integer(e.failure.failedAt) && (e.failure.blockedUntil === null || integer(e.failure.blockedUntil))
          && ['provider', 'default', 'manual'].includes(e.failure.retrySource))));
  }
  function versionValid(value) {
    return record(value) && keys(value, ['installedVersion', 'target', 'channel', 'phase', 'available', 'canInstall', 'blockedReason', 'progress', 'message'])
      && text(value.installedVersion) && text(value.target) && ['master', 'stable'].includes(value.channel)
      && ['idle', 'checking', 'available', 'current', 'no-release', 'downloading', 'installing', 'error'].includes(value.phase)
      && typeof value.canInstall === 'boolean' && (value.blockedReason === null || text(value.blockedReason, 2000))
      && (value.progress === null || (integer(value.progress) && value.progress <= 100))
      && typeof value.message === 'string' && value.message.length <= 2000
      && (value.available === null || (record(value.available) && keys(value.available, ['version', 'size', 'publishedAt', 'releaseUrl'])
        && text(value.available.version) && integer(value.available.size) && text(value.available.publishedAt, 100)
        && text(value.available.releaseUrl, 2048)));
  }
  function restoredView(value) {
    if (!record(value) || !['models', 'search', 'version'].includes(value.category)) return { category: 'models' };
    return { category: value.category, ...(value.category !== 'version' && text(value.id) ? { id: value.id } : {}),
      ...(Number.isFinite(value.scroll) && value.scroll >= 0 ? { scroll: Math.min(value.scroll, 1000000) } : {}) };
  }
  function searchSummary(entry, now = Date.now()) {
    if (!entry.enabled) return 'Disabled';
    if (entry.checking) return 'Checking…';
    if (!entry.failure) return entry.configured ? 'Ready' : 'API key missing';
    const reason = { credentials: 'Invalid or missing key', quota: 'Budget exhausted', 'rate-limit': 'Rate limited', transport: 'Connection failed', timeout: 'Timed out', server: 'Provider unavailable', response: 'Invalid response', access: 'Access denied' }[entry.failure.reason];
    const until = entry.failure.blockedUntil;
    return `${reason} · ${until === null ? 'manual retry required' : until <= now ? 'eligible for retry' : `retry in ${Math.ceil((until - now) / 60000)} min`}`;
  }
  globalThis.dshCompanionSettingsState = { modelsValid, searchValid, versionValid, restoredView, searchSummary };
})();
