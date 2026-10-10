import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { DSH_RUNTIME_ROOT, loadUpstreamManifest, verifyPatchFiles } from './manifest.mjs';

const COMPANION_ROOT = resolve(DSH_RUNTIME_ROOT, '../..');
const EXCLUDED_NAMES = new Set(['.git', '.dev', 'node_modules', 'build', 'dist']);
const EXPECTED_PROVIDERS = [
  '@dsh-companion/provider-openrouter',
  '@dsh-companion/provider-claude-wrapper-advanced',
  '@dsh-companion/provider-codex-wrapper-advanced',
];

/** Excludes fetched dependencies, VCS metadata, and private development files from packaged provider trees. */
export function stageInputAllowed(path, root) {
  const parts = relative(root, path).split(sep);
  return !parts.some(part => EXCLUDED_NAMES.has(part) || part === '.env' || part.startsWith('.env.'));
}

/** Hashes the staged file content of one package tree in stable path order. */
export async function runtimeTreeFingerprint(root) {
  const hash = createHash('sha256');
  await addTree(hash, 'tree', root, path => stageInputAllowed(path, root));
  return hash.digest('hex');
}

/** Hashes host inputs used to build or launch the managed runtime, excluding Extension client code. */
export async function runtimeHostFingerprint(root) {
  const hash = createHash('sha256');
  await addFile(hash, 'vscode/runtime/supervisor.mjs', join(root, 'vscode', 'runtime', 'supervisor.mjs'));
  await addFile(hash, 'vscode/package.json', join(root, 'vscode', 'package.json'));
  await addFile(hash, 'pnpm-lock.yaml', join(root, 'pnpm-lock.yaml'));
  await addFile(hash, 'package.json', join(root, 'package.json'));
  return hash.digest('hex');
}

/** Derives one content-addressed runtime input identity before a costly DSH build. */
export async function runtimeFingerprint(dshSource, providerRoots, options = {}) {
  if (!Array.isArray(providerRoots) || providerRoots.length !== EXPECTED_PROVIDERS.length) {
    throw new Error('Runtime fingerprint requires every provider bundle in product order');
  }
  const manifest = await loadUpstreamManifest();
  await verifyPatchFiles(manifest);
  const source = resolve(dshSource);
  for (const [revision, expected] of [
    [manifest.upstream.commit, manifest.upstream.commit],
    [`${manifest.upstream.tag}^{commit}`, manifest.upstream.commit],
    [`${manifest.upstream.commit}^{tree}`, manifest.upstream.tree],
  ]) {
    const observed = git(source, 'rev-parse', revision);
    if (observed !== expected) throw new Error('Runtime fingerprint DSH upstream identity mismatch');
  }
  const hash = createHash('sha256');
  hash.update('dsh-companion-runtime-input-v1\0');
  hash.update(`target\0linux-x64\0node\0${options.nodeVersion ?? process.version}\0`);
  hash.update(`pnpm\0${options.pnpmVersion ?? execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()}\0`);
  hash.update(`upstream\0${manifest.upstream.commit}\0${manifest.upstream.tree}\0`);
  await addTree(hash, 'runtime/dsh', DSH_RUNTIME_ROOT, (path) => {
    const name = basename(path);
    return name !== 'upgrades' && stageInputAllowed(path, DSH_RUNTIME_ROOT);
  });
  await addTree(hash, 'packages', join(COMPANION_ROOT, 'packages'), path =>
    stageInputAllowed(path, join(COMPANION_ROOT, 'packages')));
  hash.update(`host\0${await runtimeHostFingerprint(COMPANION_ROOT)}\0`);
  for (const [index, root] of providerRoots.entries()) {
    const providerRoot = resolve(root);
    const provider = JSON.parse(await readFile(join(providerRoot, 'package.json'), 'utf8'));
    if (provider.name !== EXPECTED_PROVIDERS[index]) throw new Error('Runtime fingerprint provider order mismatch');
    await addTree(hash, `providers/${String(index)}-${provider.name}`, providerRoot,
      path => stageInputAllowed(path, providerRoot));
  }
  return hash.digest('hex');
}

async function addTree(hash, label, root, include) {
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (!include(path)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) await addFile(hash, `${label}/${relative(root, path).split(sep).join('/')}`, path);
      else throw new Error(`Runtime input contains an unsupported filesystem entry: ${path}`);
    }
  };
  if (!(await stat(root)).isDirectory()) throw new Error(`Runtime input is not a directory: ${root}`);
  await walk(root);
}

async function addFile(hash, label, path) {
  const bytes = await readFile(path);
  hash.update(`file\0${label}\0${String(bytes.byteLength)}\0`);
  hash.update(bytes);
  hash.update('\0');
}

function git(source, ...args) {
  return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
}
