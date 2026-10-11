import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { channelForRef } from './build-metadata.mjs';

/** Validates downloaded build artifacts before the write-enabled job can publish anything. */
export async function readReleaseAssets(directory, expectedCommit, ref) {
  const info = JSON.parse(await readFile(join(directory, 'build-info.json'), 'utf8'));
  const { channel, releaseTag } = channelForRef(ref);
  if (info.format !== 1 || info.commit !== expectedCommit || info.channel !== channel
    || !/^[a-f0-9]{40}$/.test(info.commit) || !/^\d+\.\d+\.\d+$/.test(info.version)
    || !/^[a-f0-9]{64}$/.test(info.runtimeId) || info.target !== 'linux-x64'
    || !Array.isArray(info.assets) || info.assets.length !== 1) throw new Error('Artifact build identity mismatch');
  if (channel === 'release' && info.version !== releaseTag.slice(1)) throw new Error('Release tag/version mismatch');
  const asset = info.assets[0];
  if (asset.name !== `dsh-companion-${info.version}-linux-x64.vsix` || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error('Invalid VSIX artifact name or checksum');
  }
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(['SHA256SUMS', 'build-info.json', asset.name].sort())) {
    throw new Error('Unexpected release assets');
  }
  const bytes = await readFile(join(directory, asset.name));
  const digest = value => createHash('sha256').update(value).digest('hex');
  if (bytes.length !== asset.size || digest(bytes) !== asset.sha256) throw new Error('VSIX artifact integrity mismatch');
  const metadataHash = digest(await readFile(join(directory, 'build-info.json')));
  const sums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  if (sums !== `${asset.sha256}  ${asset.name}\n${metadataHash}  build-info.json\n`) throw new Error('Checksum manifest mismatch');
  return { info, names, releaseTag };
}

async function tagCommit(api, tag) {
  const ref = await api('GET', `git/ref/tags/${encodeURIComponent(tag)}`, undefined, true);
  if (ref === null) return null;
  let object = ref.object;
  for (let depth = 0; object.type === 'tag' && depth < 8; depth += 1) {
    object = (await api('GET', `git/tags/${object.sha}`)).object;
  }
  if (object.type !== 'commit') throw new Error('Release tag does not resolve to a commit');
  return object.sha;
}

/** GitHub DELETE-ref reports a missing reference as 422, not necessarily 404. */
export async function deleteTagIfExists(api, tag) {
  const lookup = `git/ref/tags/${encodeURIComponent(tag)}`;
  if (await api('GET', lookup, undefined, true) === null) return;
  try {
    await api('DELETE', `git/refs/tags/${tag}`);
  } catch (error) {
    // Tolerate a concurrent deletion only after confirming absence; protected refs still fail.
    if (![404, 422].includes(error.status) || await api('GET', lookup, undefined, true) !== null) throw error;
  }
}

const BUILD_MARKER = '<!-- dsh-companion-build:1 -->';

const JOURNAL_MARKER = '<!-- dsh-companion-rolling-journal:1 -->';

async function allReleases(api) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = await api('GET', `releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

async function releaseAssets(api, id) {
  const assets = [];
  for (let page = 1; ; page += 1) {
    const batch = await api('GET', `releases/${id}/assets?per_page=100&page=${page}`);
    assets.push(...batch);
    if (batch.length < 100) return assets;
  }
}

/** The draft body is the durable journal; draft creation does not create a Git ref. */
export async function reconcileRollingJournal(api, draft) {
  const journal = JSON.parse(draft.body.slice(JOURNAL_MARKER.length).trim());
  const invalid = () => { throw new Error('Invalid rolling release journal ownership'); };
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
  const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  const id = value => Number.isSafeInteger(value) && value > 0;
  const safeName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
  const bodySHA = body => typeof body === 'string' && body.startsWith(`${BUILD_MARKER}\n`)
    ? /^Commit: ([a-f0-9]{40})$/m.exec(body)?.[1] : undefined;
  const identity = /^build-staging-(\d+)-(\d+)$/.exec(draft.tag_name ?? '');
  if (!exactKeys(journal, ['format', 'releaseId', 'oldBody', 'oldSHA', 'newSHA', 'newBody', 'prefix', 'phase', 'oldAssets', 'newAssets'])
    || journal.format !== 1 || !identity || !draft.draft || !draft.prerelease || !id(draft.id)
    || draft.target_commitish !== journal.newSHA
    || journal.prefix !== `dsh-stage-${identity[1]}-${identity[2]}-`
    || !sha(journal.oldSHA) || !sha(journal.newSHA) || journal.oldSHA === journal.newSHA
    || bodySHA(journal.oldBody) !== journal.oldSHA || bodySHA(journal.newBody) !== journal.newSHA
    || !id(journal.releaseId) || draft.id === journal.releaseId || !['upload', 'switch'].includes(journal.phase)
    || !Array.isArray(journal.oldAssets) || !Array.isArray(journal.newAssets) || !journal.newAssets.length) invalid();
  const ids = new Set();
  const oldNames = new Set();
  const newNames = new Set();
  for (const asset of journal.oldAssets) {
    if (!exactKeys(asset, ['id', 'name']) || !id(asset.id) || ids.has(asset.id)
      || !safeName(asset.name) || asset.name.startsWith('dsh-stage-') || oldNames.has(asset.name)) invalid();
    ids.add(asset.id); oldNames.add(asset.name);
  }
  for (const [index, asset] of journal.newAssets.entries()) {
    if (!exactKeys(asset, asset.id === undefined ? ['name', 'stagedName'] : ['id', 'name', 'stagedName'])
      || !safeName(asset.name) || asset.name.startsWith('dsh-stage-') || newNames.has(asset.name)
      || asset.stagedName !== `${journal.prefix}new-${index}-${asset.name}`
      || (asset.id !== undefined && (!id(asset.id) || ids.has(asset.id)))
      || (journal.phase === 'switch' && !id(asset.id))) invalid();
    if (asset.id !== undefined) ids.add(asset.id);
    newNames.add(asset.name);
  }
  const live = await api('GET', `releases/${journal.releaseId}`);
  if (!live || live.id !== journal.releaseId || live.draft || !live.prerelease || live.tag_name !== 'master-build'
    || ![journal.oldSHA, journal.newSHA].includes(bodySHA(live.body))) invalid();
  const rollingSHA = await tagCommit(api, 'master-build');
  if (![journal.oldSHA, journal.newSHA].includes(rollingSHA)) invalid();
  const committed = rollingSHA === journal.newSHA;
  if (committed && journal.phase !== 'switch') invalid();
  const assets = await releaseAssets(api, journal.releaseId);
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  if (byId.size !== assets.length || new Set(assets.map(asset => asset.name)).size !== assets.length) invalid();
  // All ownership checks precede mutations, including IDs absent after partial cleanup.
  for (const asset of journal.oldAssets) {
    const present = byId.get(asset.id);
    if (present && ![asset.name, `${journal.prefix}old-${asset.id}`].includes(present.name)) invalid();
    if (!present && (!committed || await api('GET', `releases/assets/${asset.id}`, undefined, true) !== null)) invalid();
  }
  for (const asset of journal.newAssets) {
    const present = asset.id === undefined ? assets.find(candidate => candidate.name === asset.stagedName) : byId.get(asset.id);
    if (present && ![asset.name, asset.stagedName].includes(present.name)) invalid();
    if (!present && (committed || (asset.id !== undefined
      && await api('GET', `releases/assets/${asset.id}`, undefined, true) !== null))) invalid();
  }
  for (const asset of assets) {
    if (!id(asset.id) || !safeName(asset.name)) invalid();
    if (!ids.has(asset.id) && !journal.newAssets.some(candidate => candidate.id === undefined && candidate.stagedName === asset.name)) invalid();
  }
  const rename = async (id, name) => {
    if (byId.has(id) && byId.get(id).name !== name) {
      await api('PATCH', `releases/assets/${id}`, { name });
      byId.get(id).name = name;
    }
  };
  const remove = async id => {
    if (byId.has(id)) {
      await api('DELETE', `releases/assets/${id}`);
      byId.delete(id);
    }
  };
  // Prefix scanning also finds uploads accepted before their IDs were journaled.
  const oldIds = new Set(journal.oldAssets.map(asset => asset.id));
  if (committed) {
    for (const asset of journal.oldAssets) await rename(asset.id, `${journal.prefix}old-${asset.id}`);
    for (const asset of journal.newAssets) {
      const live = assets.find(candidate => candidate.id === asset.id || candidate.name === asset.stagedName);
      if (!live) throw new Error('Committed rolling release is missing a new asset');
      await rename(live.id, asset.name);
    }
    await api('PATCH', `releases/${journal.releaseId}`, { body: journal.newBody });
    for (const asset of journal.oldAssets) await remove(asset.id);
    const newIds = new Set(journal.newAssets.map(asset => asset.id));
    for (const asset of assets) if (asset.name.startsWith(journal.prefix) && !newIds.has(asset.id)) await remove(asset.id);
  } else {
    for (const asset of assets) {
      if (!oldIds.has(asset.id) && (asset.name.startsWith(journal.prefix)
        || journal.newAssets.some(candidate => candidate.id === asset.id))) await remove(asset.id);
    }
    for (const asset of journal.oldAssets) await rename(asset.id, asset.name);
    await api('PATCH', `releases/${journal.releaseId}`, { body: journal.oldBody });
  }
  await api('DELETE', `releases/${draft.id}`);
  return committed;
}

/** Serialized recovery never creates or moves a ref to an earlier commit. */
export async function reconcileRollingRelease(api) {
  const releases = await allReleases(api);
  for (const draft of releases.filter(release => release.draft && release.body?.startsWith(JOURNAL_MARKER))) {
    await reconcileRollingJournal(api, draft);
  }
  let current = await api('GET', 'releases/tags/master-build', undefined, true);
  const backups = releases.filter(release => /^build-previous-\d+-\d+$/.test(release.tag_name)
    && release.prerelease && release.body?.includes(BUILD_MARKER));
  if (!current && backups.length) {
    if (backups.length !== 1) throw new Error('Ambiguous legacy recovery releases');
    const backup = backups[0];
    const recorded = /^Commit: ([a-f0-9]{40})$/m.exec(backup.body)?.[1];
    if (await tagCommit(api, 'master-build') !== recorded) {
      throw new Error('Legacy recovery requires manual intervention; refusing to move a ref to an old commit');
    }
    current = await api('PATCH', `releases/${backup.id}`, { tag_name: 'master-build', make_latest: 'false' });
  }
  if (current) for (const backup of backups) {
    if (backup.id !== current.id) await api('DELETE', `releases/${backup.id}`);
    await deleteTagIfExists(api, backup.tag_name);
  }
  for (const draft of releases.filter(release => release.draft
    && /^build-staging-\d+-\d+$/.test(release.tag_name) && release.body?.startsWith(BUILD_MARKER))) {
    await api('DELETE', `releases/${draft.id}`);
    await deleteTagIfExists(api, draft.tag_name);
  }
  if (current) for (const ref of await api('GET', 'git/matching-refs/tags/build-')) {
    const name = ref.ref.replace(/^refs\/tags\//, '');
    if (/^build-(?:previous|staging)-\d+-\d+$/.test(name)
      && await api('GET', `releases/tags/${name}`, undefined, true) === null) await deleteTagIfExists(api, name);
  }
}

/** Rolling updates retain the release ID; the only ref write is the final current-commit switch. */
export async function publishRelease({ info, names, releaseTag }, { api, upload, runId, attempt }) {
  if (!/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(attempt))) throw new Error('Invalid publication run identity');
  const rolling = info.channel === 'master';
  const tag = rolling ? 'master-build' : releaseTag;
  const current = rolling ? (await api('GET', 'git/ref/heads/master')).object.sha : await tagCommit(api, tag);
  if (current !== info.commit) {
    if (rolling) return { skipped: true, reason: 'master advanced before publication' };
    throw new Error('Remote release tag moved since the build');
  }
  if (rolling) await reconcileRollingRelease(api);
  let old = await api('GET', `releases/tags/${tag}`, undefined, true);
  if (!rolling && !old) {
    const drafts = (await allReleases(api)).filter(release => release.tag_name === tag);
    if (drafts.length > 1) throw new Error('Multiple releases exist for this tag');
    old = drafts[0] ?? null;
  }
  if (!rolling && old) {
    if (!old.draft || !old.body?.includes(BUILD_MARKER) || !old.body.includes(`Commit: ${info.commit}\n`)) {
      throw new Error('A release already exists for this tag; refusing to replace it');
    }
    await api('DELETE', `releases/${old.id}`);
    old = null;
  }
  const body = `${BUILD_MARKER}\nVersion: ${info.version}\nCommit: ${info.commit}\nRuntime: ${info.runtimeId}\nDSH: ${info.dsh.version} (${info.dsh.commit})\nPatch set: ${info.dsh.patchSetSha256}\n\n[Build log](${info.runUrl})\n`;
  const stagingTag = `build-staging-${runId}-${attempt}`;
  if (rolling && old) {
    const oldSHA = await tagCommit(api, tag);
    if (!oldSHA) throw new Error('Rolling release is missing its tag');
    if (old.draft || !old.prerelease || !old.body?.startsWith(`${BUILD_MARKER}\n`)
      || /^Commit: ([a-f0-9]{40})$/m.exec(old.body)?.[1] !== oldSHA) {
      throw new Error('Rolling release ownership or provenance mismatch');
    }
    // Distinct old/new SHAs make the live tag an unambiguous durable commit marker.
    if (oldSHA === info.commit) return { skipped: true, reason: 'master commit already published' };
    const prefix = `dsh-stage-${runId}-${attempt}-`;
    const journal = { format: 1, releaseId: old.id, oldBody: old.body ?? '', oldSHA,
      newSHA: info.commit, newBody: body, prefix, phase: 'upload',
      oldAssets: (await releaseAssets(api, old.id)).map(({ id, name }) => ({ id, name })),
      newAssets: names.map((name, index) => ({ name, stagedName: `${prefix}new-${index}-${name}` })) };
    const draft = await api('POST', 'releases', { tag_name: stagingTag, target_commitish: info.commit,
      name: 'Rolling publication journal', body: `${JOURNAL_MARKER}\n${JSON.stringify(journal)}`,
      draft: true, prerelease: true, make_latest: 'false' });
    const save = async () => {
      draft.body = `${JOURNAL_MARKER}\n${JSON.stringify(journal)}`;
      await api('PATCH', `releases/${draft.id}`, { body: draft.body });
    };
    try {
      for (const asset of journal.newAssets) {
        const uploaded = await upload(old.upload_url, asset.name, asset.stagedName);
        if (!Number.isInteger(uploaded?.id)) throw new Error('Asset upload did not return an ID');
        asset.id = uploaded.id;
        await save();
      }
      if ((await api('GET', 'git/ref/heads/master')).object.sha !== info.commit) {
        await reconcileRollingJournal(api, draft);
        return { skipped: true, reason: 'master advanced while assets were uploading' };
      }
      journal.phase = 'switch';
      await save(); // Durable intent precedes every rename.
      for (const asset of journal.oldAssets) await api('PATCH', `releases/assets/${asset.id}`, { name: `${prefix}old-${asset.id}` });
      for (const asset of journal.newAssets) await api('PATCH', `releases/assets/${asset.id}`, { name: asset.name });
      await api('PATCH', `releases/${old.id}`, { body });
      await api('PATCH', 'git/refs/tags/master-build', { sha: info.commit, force: true });
    } catch (error) {
      // An ambiguous ref response is resolved by reading the live tag, never by rolling it back.
      try { await reconcileRollingJournal(api, draft); }
      catch (recovery) { throw new AggregateError([error, recovery], 'Publication failed; journal retained for recovery'); }
      throw error;
    }
    await reconcileRollingJournal(api, draft);
    return { skipped: false, tag, releaseId: old.id };
  }
  const draft = await api('POST', 'releases', { tag_name: rolling ? stagingTag : tag,
    target_commitish: info.commit, name: rolling ? 'Master build' : tag,
    body, draft: true, prerelease: rolling, make_latest: 'false' });
  let published = false;
  try {
    for (const name of names) await upload(draft.upload_url, name);
    if (rolling && (await api('GET', 'git/ref/heads/master')).object.sha !== info.commit) {
      await api('DELETE', `releases/${draft.id}`);
      return { skipped: true, reason: 'master advanced while assets were uploading' };
    }
    if (rolling) {
      const existing = await tagCommit(api, tag);
      await api(existing ? 'PATCH' : 'POST', existing ? `git/refs/tags/${tag}` : 'git/refs',
        existing ? { sha: info.commit, force: true } : { ref: `refs/tags/${tag}`, sha: info.commit });
    }
    await api('PATCH', `releases/${draft.id}`, { tag_name: tag, target_commitish: info.commit,
      draft: false, prerelease: rolling, make_latest: rolling ? 'false' : 'true' });
    published = true;
  } catch (error) {
    // A lost publish response must not delete a release that GitHub already published.
    const live = await api('GET', `releases/tags/${tag}`, undefined, true);
    if (live?.id !== draft.id) await api('DELETE', `releases/${draft.id}`);
    throw error;
  }
  if (published && rolling) await deleteTagIfExists(api, stagingTag);
  return { skipped: false, tag, releaseId: draft.id };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = process.argv[2];
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!directory || !token || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Release publication context is required');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const api = async (method, path, body, missing = false) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method, headers: { ...headers, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${path} failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
  const upload = async (template, name, publishedName = name) => {
    const url = new URL(template.split('{')[0]);
    if (url.origin !== 'https://uploads.github.com') throw new Error('Unexpected asset upload authority');
    url.searchParams.set('name', publishedName);
    const response = await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: await readFile(join(directory, name)) });
    if (!response.ok) throw new Error(`GitHub asset upload failed (${response.status})`);
    return response.json();
  };
  const assets = await readReleaseAssets(directory, process.env.GITHUB_SHA, process.env.GITHUB_REF);
  console.log(JSON.stringify(await publishRelease(assets, { api, upload,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT })));
}
