import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DSH_RUNTIME_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UPSTREAM_MANIFEST_PATH = join(DSH_RUNTIME_ROOT, 'upstream.json');

/** Reads and validates the pinned DSH source and ordered patch declarations. */
export async function loadUpstreamManifest() {
  const value = JSON.parse(await readFile(UPSTREAM_MANIFEST_PATH, 'utf8'));
  if (!isRecord(value) || value.formatVersion !== 1 || !isRecord(value.upstream)
    || value.upstream.repository !== 'https://github.com/deepseek-ai/deepseek-harness.git'
    || typeof value.upstream.version !== 'string' || typeof value.upstream.tag !== 'string'
    || !isGitObject(value.upstream.commit) || !isGitObject(value.upstream.tree)
    || !Array.isArray(value.patches)) {
    throw new Error('Invalid DSH upstream manifest');
  }
  const ids = new Set();
  const files = new Set();
  const patches = value.patches.map((patch) => {
    if (!isRecord(patch) || typeof patch.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(patch.id)
      || typeof patch.file !== 'string' || !isSafeRelativePath(patch.file)
      || typeof patch.assessment !== 'string' || !isSafeRelativePath(patch.assessment)
      || !isSha256(patch.sha256) || !Array.isArray(patch.affectedModules)
      || patch.affectedModules.length === 0
      || patch.affectedModules.some((item) => typeof item !== 'string' || item.length === 0)
      || (patch.upstreamDiscussion !== null
        && (typeof patch.upstreamDiscussion !== 'string' || !isGitHubUrl(patch.upstreamDiscussion)))) {
      throw new Error('Invalid DSH patch declaration');
    }
    if (ids.has(patch.id) || files.has(patch.file)) throw new Error(`Duplicate DSH patch ${patch.id}`);
    ids.add(patch.id);
    files.add(patch.file);
    return {
      id: patch.id,
      file: patch.file,
      sha256: patch.sha256,
      assessment: patch.assessment,
      upstreamDiscussion: patch.upstreamDiscussion,
      affectedModules: [...patch.affectedModules],
    };
  });
  return {
    formatVersion: 1,
    upstream: {
      repository: value.upstream.repository,
      version: value.upstream.version,
      tag: value.upstream.tag,
      commit: value.upstream.commit,
      tree: value.upstream.tree,
    },
    patches,
  };
}

/** Verifies the series file, patch digests, and assessment documents. */
export async function verifyPatchFiles(manifest) {
  const seriesPath = join(DSH_RUNTIME_ROOT, 'patches', 'series');
  const series = (await readFile(seriesPath, 'utf8')).split(/\r?\n/u).filter(Boolean);
  const declared = manifest.patches.map((patch) => patch.file.replace(/^patches\//u, ''));
  if (JSON.stringify(series) !== JSON.stringify(declared)) {
    throw new Error('DSH patch series does not match upstream.json order');
  }
  for (const patch of manifest.patches) {
    const patchPath = join(DSH_RUNTIME_ROOT, patch.file);
    const bytes = await readFile(patchPath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== patch.sha256) throw new Error(`DSH patch digest mismatch for ${patch.file}`);
    const assessment = await readFile(join(DSH_RUNTIME_ROOT, patch.assessment), 'utf8');
    for (const heading of [
      '# ', '## Requirement', '## Scope', '## Alternatives', '## Security assessment',
      '## Compatibility and maintenance', '## Upstream discussion',
    ]) {
      if (!assessment.includes(heading)) {
        throw new Error(`DSH patch assessment ${patch.assessment} is missing ${heading.trim()}`);
      }
    }
  }
}

export function patchSetSha256(manifest) {
  const hash = createHash('sha256');
  for (const patch of manifest.patches) hash.update(`${patch.id}\0${patch.sha256}\n`);
  return hash.digest('hex');
}

function isGitObject(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isSafeRelativePath(value) {
  return !value.startsWith('/') && !value.startsWith('\\')
    && !value.split(/[\\/]/u).some((part) => part === '' || part === '.' || part === '..');
}

function isGitHubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
