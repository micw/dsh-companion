import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod, cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type * as vscode from 'vscode';
import { PACKAGED_DSH_ORIGIN } from './dshClient';
import { RuntimeControl } from './runtimeControl';

const TARGET = 'linux-x64';
const MANAGER_LOCK_WAIT_MS = 60_000;
const SUPERVISOR_READY_MS = 70_000;
const MANAGED_PROFILE = 'dsh-companion';
const DEFAULT_PROFILE_BUNDLES = ['@dsh-companion/bundle'] as const;
const PRODUCT_PROFILE_BUNDLES = [
  '@dsh-companion/bundle',
  '@dsh-companion/provider-claude-wrapper-advanced',
  '@dsh-companion/provider-codex-wrapper-advanced',
] as const;

interface RuntimeArtifact {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly executable: boolean;
}

interface RuntimeManifest {
  readonly formatVersion: 1;
  readonly companionVersion: string;
  readonly target: typeof TARGET;
  readonly dsh: DshProvenance;
  readonly launch: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly profileBundles: readonly string[];
  };
  readonly artifacts: readonly RuntimeArtifact[];
}

interface DshProvenance {
  readonly upstreamRepository: 'https://github.com/deepseek-ai/deepseek-harness.git';
  readonly upstreamVersion: string;
  readonly upstreamTag: string;
  readonly upstreamCommit: string;
  readonly upstreamTree: string;
  readonly modified: boolean;
  readonly patchSetSha256: string;
  readonly patches: readonly {
    readonly id: string;
    readonly sha256: string;
    readonly affectedModules: readonly string[];
    readonly upstreamDiscussion: string | null;
  }[];
}

interface ActiveRuntime {
  readonly formatVersion: 1;
  readonly directory: string;
}

/** Installs and starts the packaged Linux runtime, while source development may supply its own supervisor. */
export async function connectRuntime(context: vscode.ExtensionContext): Promise<RuntimeControl | undefined> {
  const lifecycleRoot = companionLifecycleRoot();
  const shared = await RuntimeControl.fromStateFile(join(lifecycleRoot, 'runtime.json'));
  if (shared?.runtimeId === 'source') return shared;
  if (context.extensionUri.scheme !== 'file') return undefined;
  const globalStorage = runtimeStoragePath(context.globalStorageUri);
  if (globalStorage === undefined) {
    throw new Error(`Managed DSH runtime requires local extension storage, not ${context.globalStorageUri.scheme}:`);
  }
  const payload = join(context.extensionUri.fsPath, 'runtime', 'payload', TARGET);
  try {
    await stat(join(payload, 'runtime-manifest.json'));
  } catch (error) {
    if (isFileNotFound(error)) return shared ?? RuntimeControl.discover(context.extensionUri);
    throw error;
  }
  shared?.dispose();
  return activatePayload(
    payload,
    globalStorage,
    context.extension.packageJSON.version,
    lifecycleRoot,
    companionDataHome(),
  );
}

/** Installs, activates, and connects one already verified packaged payload. */
export function activatePayload(
  payload: string,
  globalStorage: string,
  extensionVersion: unknown,
  lifecycleRoot = companionLifecycleRoot(),
  dataHome = companionDataHome(),
  origin = PACKAGED_DSH_ORIGIN,
): Promise<RuntimeControl> {
  return withManagerLock(lifecycleRoot, async () => {
    const installed = await installPayload(payload, globalStorage, extensionVersion);
    return activateInstalledRuntime(installed, globalStorage, lifecycleRoot, dataHome, origin);
  });
}

/** Installs one verified payload as an immutable version directory. */
export async function installPayload(payload: string, globalStorage: string, extensionVersion: unknown): Promise<string> {
  const manifest = await verifyPayload(payload);
  if (manifest.companionVersion !== extensionVersion) {
    throw new Error('Packaged runtime version does not match the DSH Companion extension');
  }
  const runtimeRoot = join(globalStorage, 'runtime');
  const versions = join(runtimeRoot, 'versions');
  const directory = `${manifest.companionVersion}-${manifest.target}`;
  const destination = join(versions, directory);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  await chmod(versions, 0o700);
  if (await exists(destination)) {
    const installedManifest = await verifyPayload(destination);
    if (JSON.stringify(installedManifest) !== JSON.stringify(manifest)) {
      throw new Error(`Installed immutable runtime ${directory} differs from the packaged payload`);
    }
    return destination;
  }
  const stagingRoot = join(runtimeRoot, 'staging');
  const staging = join(stagingRoot, randomUUID());
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await chmod(stagingRoot, 0o700);
  try {
    await cp(payload, staging, { recursive: true, errorOnExist: true, force: false });
    await chmod(staging, 0o700);
    for (const artifact of manifest.artifacts) {
      await chmod(join(staging, artifact.file), artifact.executable ? 0o700 : 0o600);
    }
    await chmod(join(staging, 'runtime-manifest.json'), 0o600);
    await verifyPayload(staging);
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return destination;
}

async function activateInstalledRuntime(
  installed: string,
  globalStorage: string,
  lifecycleRoot: string,
  dataHome: string,
  origin: string,
): Promise<RuntimeControl> {
  const runtimeRoot = join(globalStorage, 'runtime');
  const stateFile = join(lifecycleRoot, 'runtime.json');
  const activeFile = join(runtimeRoot, 'active.json');
  const rollbackFile = join(runtimeRoot, 'rollback.json');
  const desired = { formatVersion: 1, directory: installed } satisfies ActiveRuntime;
  const versionsRoot = join(runtimeRoot, 'versions');
  const active = await readActiveRuntime(activeFile, versionsRoot);
  const retainedRollback = await readActiveRuntime(rollbackFile, versionsRoot);

  const current = await connectExisting(stateFile);
  if (active?.directory === installed && current !== undefined) return current;
  if (current !== undefined) {
    await current.stop();
    current.dispose();
    await waitUntilAbsent(stateFile, 15_000);
  }

  await mkdir(lifecycleRoot, { recursive: true, mode: 0o700 });
  await chmod(lifecycleRoot, 0o700);
  await mkdir(dataHome, { recursive: true, mode: 0o700 });
  await chmod(dataHome, 0o700);
  let candidate: RuntimeControl | undefined;
  let activePublished = false;
  try {
    candidate = await startSupervisor(installed, globalStorage, dataHome, stateFile, lifecycleRoot, origin);
    if (active !== undefined && active.directory !== installed) {
      await writeJsonAtomic(rollbackFile, active);
    }
    await writeJsonAtomic(activeFile, desired);
    activePublished = true;
    await cleanupVersions(
      runtimeRoot,
      desired,
      active !== undefined && active.directory !== installed ? active : retainedRollback,
    );
    return candidate;
  } catch (error) {
    if (candidate !== undefined) {
      await candidate.stop().catch(() => undefined);
      candidate.dispose();
      await waitUntilAbsent(stateFile, 15_000).catch(() => undefined);
    }
    if (active !== undefined && await exists(active.directory)) {
      if (activePublished) await writeJsonAtomic(activeFile, active);
      await startSupervisor(active.directory, globalStorage, dataHome, stateFile, lifecycleRoot, origin)
        .catch(() => undefined);
    } else if (activePublished) {
      await rm(activeFile, { force: true });
    }
    throw error;
  }
}

async function startSupervisor(
  installed: string,
  globalStorage: string,
  dataHome: string,
  stateFile: string,
  ownerRoot: string,
  origin: string,
): Promise<RuntimeControl> {
  const manifest = await verifyPayload(installed);
  await ensureManagedProfile(dataHome, manifest.launch.profileBundles);
  const configFile = join(ownerRoot, 'supervisor-config.json');
  const config = {
    version: 1,
    stateFile,
    command: join(installed, manifest.launch.executable),
    args: [...manifest.launch.args, '--port', new URL(origin).port],
    cwd: globalStorage,
    origin,
    backendVersion: `${manifest.dsh.upstreamVersion} (${manifest.dsh.upstreamCommit.slice(0, 8)}${
      manifest.dsh.modified ? ` + patches ${manifest.dsh.patchSetSha256.slice(0, 8)}` : ''
    })`,
    environment: {
      DSH_HOME: dataHome,
      DSH_TELEMETRY_DISABLED: '1',
    },
    clientModule: join(installed, 'client-runtime.js'),
    runtimeId: `${manifest.companionVersion}-${manifest.target}`,
  };
  await writeJsonAtomic(configFile, config);
  const child = spawn(process.execPath, [join(installed, 'supervisor.mjs'), configFile], {
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
  });
  child.unref();
  const deadline = Date.now() + SUPERVISOR_READY_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const control = await RuntimeControl.fromStateFile(stateFile);
      if (control !== undefined) return control;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error('Managed DSH runtime did not become ready', { cause: lastError });
}

async function ensureManagedProfile(dataHome: string, profileBundles: readonly string[]): Promise<void> {
  const profile = join(dataHome, 'profiles', MANAGED_PROFILE);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(profile, 'package.json'), {
    name: 'dsh-profile-dsh-companion',
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...profileBundles],
        patchReload: 'startup',
      },
    },
  });
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', { mode: 0o600 });
}

/** Validates one closed runtime payload and every declared artifact digest. */
export async function verifyPayload(root: string): Promise<RuntimeManifest> {
  const value: unknown = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8'));
  if (!isRecord(value) || value.formatVersion !== 1 || typeof value.companionVersion !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(value.companionVersion) || value.target !== TARGET
    || !isRecord(value.dsh)
    || !isRecord(value.launch) || typeof value.launch.executable !== 'string'
    || !isSafeFileName(value.launch.executable) || !Array.isArray(value.launch.args)
    || value.launch.args.some((item) => typeof item !== 'string')
    || (value.launch.profileBundles !== undefined && !Array.isArray(value.launch.profileBundles))
    || !Array.isArray(value.artifacts)) {
    throw new Error('Invalid DSH Companion runtime manifest');
  }
  const rawProfileBundles: unknown[] = value.launch.profileBundles === undefined
    ? [...DEFAULT_PROFILE_BUNDLES]
    : [...value.launch.profileBundles];
  const legacy = sameStrings(rawProfileBundles, DEFAULT_PROFILE_BUNDLES);
  const product = sameStrings(rawProfileBundles, PRODUCT_PROFILE_BUNDLES);
  if (!legacy && !product) {
    throw new Error('Invalid DSH Companion runtime profile bundle list');
  }
  const profileBundles = rawProfileBundles as string[];
  const names = new Set<string>();
  const dsh = parseDshProvenance(value.dsh);
  const artifacts: RuntimeArtifact[] = [];
  for (const item of value.artifacts) {
    if (!isRecord(item) || typeof item.file !== 'string' || !isSafeFileName(item.file)
      || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0
      || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.sha256)
      || typeof item.executable !== 'boolean' || names.has(item.file)) {
      throw new Error('Invalid DSH Companion runtime artifact declaration');
    }
    names.add(item.file);
    const bytes = await readFile(join(root, item.file));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== item.bytes || digest !== item.sha256) {
      throw new Error(`DSH Companion runtime artifact integrity failed: ${item.file}`);
    }
    artifacts.push({ file: item.file, bytes: item.bytes, sha256: item.sha256, executable: item.executable });
  }
  for (const required of [value.launch.executable, 'supervisor.mjs', 'client-runtime.js']) {
    if (!names.has(required)) throw new Error(`DSH Companion runtime omits ${required}`);
  }
  const entries = await readdir(root, { withFileTypes: true });
  const expected = new Set(['runtime-manifest.json', ...names]);
  if (entries.some((entry) => !entry.isFile() || !expected.has(entry.name)) || entries.length !== expected.size) {
    throw new Error('DSH Companion runtime payload contains undeclared files');
  }
  return {
    formatVersion: 1,
    companionVersion: value.companionVersion,
    target: TARGET,
    dsh,
    launch: { executable: value.launch.executable, args: [...value.launch.args], profileBundles },
    artifacts,
  };
}

function sameStrings(value: readonly unknown[], expected: readonly string[]): boolean {
  return value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function parseDshProvenance(value: Record<string, unknown>): DshProvenance {
  if (value.upstreamRepository !== 'https://github.com/deepseek-ai/deepseek-harness.git'
    || typeof value.upstreamVersion !== 'string' || value.upstreamVersion.length === 0
    || typeof value.upstreamTag !== 'string' || value.upstreamTag.length === 0
    || typeof value.upstreamCommit !== 'string' || !/^[0-9a-f]{40}$/u.test(value.upstreamCommit)
    || typeof value.upstreamTree !== 'string' || !/^[0-9a-f]{40}$/u.test(value.upstreamTree)
    || typeof value.modified !== 'boolean' || typeof value.patchSetSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.patchSetSha256) || !Array.isArray(value.patches)) {
    throw new Error('Invalid DSH runtime provenance');
  }
  const ids = new Set<string>();
  const patches = value.patches.map((patch) => {
    if (!isRecord(patch) || typeof patch.id !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(patch.id) || ids.has(patch.id)
      || typeof patch.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(patch.sha256)
      || !Array.isArray(patch.affectedModules) || patch.affectedModules.length === 0
      || patch.affectedModules.some((item) => typeof item !== 'string' || item.length === 0)
      || (patch.upstreamDiscussion !== null
        && (typeof patch.upstreamDiscussion !== 'string' || !isGitHubUrl(patch.upstreamDiscussion)))) {
      throw new Error('Invalid DSH runtime patch provenance');
    }
    ids.add(patch.id);
    return {
      id: patch.id,
      sha256: patch.sha256,
      affectedModules: [...patch.affectedModules] as string[],
      upstreamDiscussion: patch.upstreamDiscussion,
    };
  });
  if (value.modified !== (patches.length > 0)) throw new Error('Invalid DSH runtime modification status');
  const patchSet = createHash('sha256');
  for (const patch of patches) patchSet.update(`${patch.id}\0${patch.sha256}\n`);
  if (patchSet.digest('hex') !== value.patchSetSha256) {
    throw new Error('Invalid DSH runtime patch-set digest');
  }
  return {
    upstreamRepository: value.upstreamRepository,
    upstreamVersion: value.upstreamVersion,
    upstreamTag: value.upstreamTag,
    upstreamCommit: value.upstreamCommit,
    upstreamTree: value.upstreamTree,
    modified: value.modified,
    patchSetSha256: value.patchSetSha256,
    patches,
  };
}

async function withManagerLock<T>(lifecycleRoot: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(lifecycleRoot, 'manager.lock');
  await mkdir(lifecycleRoot, { recursive: true, mode: 0o700 });
  await chmod(lifecycleRoot, 0o700);
  const deadline = Date.now() + MANAGER_LOCK_WAIT_MS;
  let lock;
  while (lock === undefined) {
    try {
      lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(`${String(process.pid)}\n`);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for DSH Companion runtime manager');
      await delay(100);
    }
  }
  try {
    return await operation();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function connectExisting(stateFile: string): Promise<RuntimeControl | undefined> {
  try {
    return await RuntimeControl.fromStateFile(stateFile);
  } catch {
    return undefined;
  }
}

async function readActiveRuntime(path: string, versionsRoot: string): Promise<ActiveRuntime | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(value) || value.formatVersion !== 1 || typeof value.directory !== 'string'
      || dirname(value.directory) !== versionsRoot || !isSafeFileName(value.directory.slice(versionsRoot.length + 1))) {
      throw new Error('Invalid active DSH Companion runtime record');
    }
    return { formatVersion: 1, directory: value.directory };
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

/** Retains the active and rollback versions and removes disposable runtime staging. */
export async function cleanupVersions(
  runtimeRoot: string,
  active: ActiveRuntime,
  previous: ActiveRuntime | undefined,
): Promise<void> {
  const versions = join(runtimeRoot, 'versions');
  const keep = new Set([active.directory, previous?.directory].filter((value): value is string => value !== undefined));
  for (const entry of await readdir(versions, { withFileTypes: true })) {
    const path = join(versions, entry.name);
    if (!keep.has(path)) await rm(path, { recursive: true, force: true });
  }
  const staging = join(runtimeRoot, 'staging');
  for (const entry of await readdir(staging, { withFileTypes: true }).catch(() => [])) {
    await rm(join(staging, entry.name), { recursive: true, force: true });
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function waitUntilAbsent(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (await exists(path)) {
    if (Date.now() >= deadline) throw new Error('Previous DSH Companion runtime owner did not stop');
    await delay(50);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) return false;
    throw error;
  }
}

function isSafeFileName(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') && value !== '.' && value !== '..';
}

function isGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === 'EEXIST';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms); });
}

/** Stable Linux product-data home shared by packaged and source Development Runtimes. */
export function companionDataHome(environment: NodeJS.ProcessEnv = process.env): string {
  const dataRoot = environment.XDG_DATA_HOME?.trim();
  if (dataRoot !== undefined && dataRoot !== '' && !isAbsolute(dataRoot)) {
    throw new Error('XDG_DATA_HOME must be absolute for DSH Companion runtime ownership');
  }
  return join(dataRoot === undefined || dataRoot === '' ? join(homedir(), '.local', 'share') : dataRoot,
    'dsh-companion', 'dsh-home');
}

/** Stable supervisor rendezvous and exclusive lifecycle owner directory. */
export function companionLifecycleRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(companionDataHome(environment)), 'runtime-owner');
}

/** Resolves VS Code's local extension-storage URIs for native runtime installation. */
export function runtimeStoragePath(uri: Pick<vscode.Uri, 'scheme' | 'fsPath'>): string | undefined {
  if (uri.scheme !== 'file' && uri.scheme !== 'vscode-userdata') return undefined;
  if (!isAbsolute(uri.fsPath)) throw new Error('Managed DSH runtime storage path must be absolute');
  return uri.fsPath;
}
