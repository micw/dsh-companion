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
import type { RuntimePhase } from './runtimeProgress';

type ReportProgress = (phase: RuntimePhase) => void;
const noProgress: ReportProgress = () => {};

const TARGET = 'linux-x64';
const MANAGER_LOCK_WAIT_MS = 60_000;
const SUPERVISOR_READY_MS = 70_000;
const MANAGED_PROFILE = 'dsh-companion';
const DEFAULT_PROFILE_BUNDLES = ['@dsh-companion/bundle'] as const;
const PRODUCT_PROFILE_BUNDLES = [
  '@dsh-companion/bundle',
  '@dsh-companion/provider-openrouter',
  '@dsh-companion/provider-claude-wrapper-advanced',
  '@dsh-companion/provider-codex-wrapper-advanced',
] as const;

interface RuntimeArtifact {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly executable: boolean;
}

interface RuntimeManifestBase {
  readonly target: typeof TARGET;
  readonly dsh: DshProvenance;
  readonly launch: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly profileBundles: readonly string[];
  };
  readonly artifacts: readonly RuntimeArtifact[];
}

type RuntimeManifest = RuntimeManifestBase & (
  | { readonly formatVersion: 1; readonly companionVersion: string }
  | { readonly formatVersion: 2; readonly runtimeId: string }
);

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
export async function connectRuntime(context: vscode.ExtensionContext, report: ReportProgress = noProgress): Promise<RuntimeControl | undefined> {
  report('checking');
  const lifecycleRoot = companionLifecycleRoot();
  const shared = await RuntimeControl.fromStateFile(join(lifecycleRoot, 'runtime.json'));
  if (shouldReuseSourceRuntime(shared?.runtimeId, context.extensionMode)) return shared;
  if (context.extensionUri.scheme !== 'file') return undefined;
  const globalStorage = runtimeStoragePath(context.globalStorageUri);
  if (globalStorage === undefined) {
    throw new Error(`Managed DSH runtime requires local extension storage, not ${context.globalStorageUri.scheme}:`);
  }
  const payload = join(context.extensionUri.fsPath, 'runtime', 'payload', TARGET);
  try {
    await stat(join(payload, 'runtime-manifest.json'));
  } catch (error) {
    if (isFileNotFound(error)) {
      if (shared?.runtimeId === 'source') {
        shared.dispose();
        return undefined;
      }
      return shared ?? RuntimeControl.discover(context.extensionUri);
    }
    throw error;
  }
  shared?.dispose();
  return activatePayload(
    payload,
    globalStorage,
    context.extension.packageJSON.version,
    lifecycleRoot,
    companionDataHome(),
    PACKAGED_DSH_ORIGIN,
    report,
  );
}

/** Source ownership is valid only for an Extension Development Host; packaged activation replaces it. */
export function shouldReuseSourceRuntime(runtimeId: string | undefined, extensionMode: number): boolean {
  // VS Code's stable ExtensionMode.Development enum value is 2; keep vscode a type-only dependency for Node tests.
  return runtimeId === 'source' && extensionMode === 2;
}

/** Installs, activates, and connects one already verified packaged payload. */
export function activatePayload(
  payload: string,
  globalStorage: string,
  extensionVersion: unknown,
  lifecycleRoot = companionLifecycleRoot(),
  dataHome = companionDataHome(),
  origin = PACKAGED_DSH_ORIGIN,
  report: ReportProgress = noProgress,
): Promise<RuntimeControl> {
  return withManagerLock(lifecycleRoot, async () => {
    const installed = await installPayload(payload, globalStorage, extensionVersion, report);
    return activateInstalledRuntime(installed, globalStorage, lifecycleRoot, dataHome, origin, report);
  });
}

/** Installs one verified payload under its immutable runtime identity. */
export async function installPayload(payload: string, globalStorage: string, extensionVersion: unknown, report: ReportProgress = noProgress): Promise<string> {
  const manifest = await readRuntimeManifest(payload);
  if (typeof extensionVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(extensionVersion)) {
    throw new Error('Invalid DSH Companion extension version');
  }
  if (manifest.formatVersion === 1 && manifest.companionVersion !== extensionVersion) {
    throw new Error('Packaged runtime version does not match the DSH Companion extension');
  }
  const runtimeRoot = join(globalStorage, 'runtime');
  const versions = join(runtimeRoot, 'versions');
  const directory = runtimeIdentity(manifest);
  const destination = join(versions, directory);
  await mkdir(versions, { recursive: true, mode: 0o700 });
  await chmod(versions, 0o700);
  if (await exists(destination)) {
    const installedManifest = await readRuntimeManifest(destination);
    if (JSON.stringify(installedManifest) !== JSON.stringify(manifest)) {
      throw new Error(`Installed immutable runtime ${directory} differs from the packaged payload`);
    }
    return destination;
  }
  report('installing');
  await verifyPayload(payload);
  const stagingRoot = join(runtimeRoot, 'staging');
  const staging = join(stagingRoot, randomUUID());
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await chmod(stagingRoot, 0o700);
  try {
    await cp(payload, staging, { recursive: true, errorOnExist: true, force: false });
    await chmod(staging, 0o700);
    for (const directory of await listPayloadDirectories(staging)) await chmod(join(staging, ...directory.split('/')), 0o700);
    for (const artifact of manifest.artifacts) {
      await chmod(join(staging, ...artifact.file.split('/')), artifact.executable ? 0o700 : 0o600);
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
  report: ReportProgress,
): Promise<RuntimeControl> {
  const runtimeRoot = join(globalStorage, 'runtime');
  const stateFile = join(lifecycleRoot, 'runtime.json');
  const activeFile = join(runtimeRoot, 'active.json');
  const rollbackFile = join(runtimeRoot, 'rollback.json');
  const desired = { formatVersion: 1, directory: installed } satisfies ActiveRuntime;
  const versionsRoot = join(runtimeRoot, 'versions');
  const active = await readActiveRuntime(activeFile, versionsRoot);
  const retainedRollback = await readActiveRuntime(rollbackFile, versionsRoot);
  const manifest = await readRuntimeManifest(installed);

  const current = await connectExisting(stateFile);
  if (current !== undefined && shouldReuseInstalledRuntime(active?.directory, current.runtimeId, installed, manifest)) return current;
  if (current !== undefined) {
    report('stopping');
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
    report('starting');
    candidate = await startSupervisor(installed, globalStorage, dataHome, stateFile, lifecycleRoot, origin, report);
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
  report: ReportProgress = noProgress,
): Promise<RuntimeControl> {
  const manifest = await readRuntimeManifest(installed);
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
    runtimeId: runtimeIdentity(manifest),
  };
  await writeJsonAtomic(configFile, config);
  const child = spawn(process.execPath, [join(installed, 'supervisor.mjs'), configFile], {
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
  });
  child.unref();
  report('waiting');
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

/** Refreshes managed composition metadata without replacing the user's profile patch. */
export async function ensureManagedProfile(dataHome: string, profileBundles: readonly string[]): Promise<void> {
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
  try {
    await writeFile(join(profile, 'cordis.patch.yml'), '[]\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

/** Reads the installed or packaged runtime identity without scanning artifact bytes. */
export async function readRuntimeManifest(root: string): Promise<RuntimeManifest> {
  const value: unknown = JSON.parse(await readFile(join(root, 'runtime-manifest.json'), 'utf8'));
  return parseRuntimeManifest(value);
}

function parseRuntimeManifest(value: unknown): RuntimeManifest {
  if (!isRecord(value) || (value.formatVersion !== 1 && value.formatVersion !== 2)
    || (value.formatVersion === 1 && (typeof value.companionVersion !== 'string'
      || !/^\d+\.\d+\.\d+$/u.test(value.companionVersion) || value.runtimeId !== undefined))
    || (value.formatVersion === 2 && (typeof value.runtimeId !== 'string'
      || !/^[0-9a-f]{64}$/u.test(value.runtimeId) || value.companionVersion !== undefined))
    || value.target !== TARGET
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
    if (!isRecord(item) || typeof item.file !== 'string' || !isSafeRelativePath(item.file)
      || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0
      || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(item.sha256)
      || typeof item.executable !== 'boolean' || names.has(item.file)) {
      throw new Error('Invalid DSH Companion runtime artifact declaration');
    }
    names.add(item.file);
    artifacts.push({ file: item.file, bytes: Number(item.bytes), sha256: item.sha256, executable: item.executable });
  }
  for (const required of [value.launch.executable, 'supervisor.mjs', 'client-runtime.js']) {
    if (!names.has(required)) throw new Error(`DSH Companion runtime omits ${required}`);
  }
  return {
    ...(value.formatVersion === 1
      ? { formatVersion: 1 as const, companionVersion: value.companionVersion as string }
      : { formatVersion: 2 as const, runtimeId: value.runtimeId as string }),
    target: TARGET,
    dsh,
    launch: { executable: value.launch.executable, args: [...value.launch.args], profileBundles },
    artifacts,
  };
}

/** Validates one new runtime payload and every declared artifact digest before installation. */
export async function verifyPayload(root: string): Promise<RuntimeManifest> {
  const manifest = await readRuntimeManifest(root);
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(join(root, ...artifact.file.split('/')));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== artifact.bytes || digest !== artifact.sha256) {
      throw new Error(`DSH Companion runtime artifact integrity failed: ${artifact.file}`);
    }
  }
  const expected = new Set(['runtime-manifest.json', ...manifest.artifacts.map(artifact => artifact.file)]);
  const files = await listPayloadFiles(root);
  if (files.some(file => !expected.has(file)) || files.length !== expected.size) {
    throw new Error('DSH Companion runtime payload contains undeclared files');
  }
  return manifest;
}

/** Names a runtime independently from the Extension version for content-addressed payloads. */
export function runtimeIdentity(manifest: RuntimeManifest): string {
  return manifest.formatVersion === 1
    ? `${manifest.companionVersion}-${manifest.target}`
    : `runtime-${manifest.runtimeId}-${manifest.target}`;
}

/** Keeps a healthy installed runtime when the Extension changes but its runtime identity does not. */
export function shouldReuseInstalledRuntime(
  activeDirectory: string | undefined,
  currentRuntimeId: string | undefined,
  installed: string,
  manifest: RuntimeManifest,
): boolean {
  return activeDirectory === installed && currentRuntimeId === runtimeIdentity(manifest);
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

export async function withManagerLock<T>(lifecycleRoot: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = join(lifecycleRoot, 'manager.lock');
  const recoveryPath = join(lifecycleRoot, 'manager.recovery.lock');
  await mkdir(lifecycleRoot, { recursive: true, mode: 0o700 });
  await chmod(lifecycleRoot, 0o700);
  const deadline = Date.now() + MANAGER_LOCK_WAIT_MS;
  let lock;
  while (lock === undefined) {
    try {
      lock = await open(lockPath, 'wx', 0o600);
      try {
        await lock.writeFile(`${String(process.pid)}\n`);
      } catch (error) {
        await lock.close();
        await rm(lockPath, { force: true });
        throw error;
      }
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await recoverAbandonedLock(lockPath, recoveryPath);
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

async function recoverAbandonedLock(lockPath: string, recoveryPath: string): Promise<void> {
  let guard;
  try {
    guard = await open(recoveryPath, 'wx', 0o600);
  } catch (error) {
    if (isAlreadyExists(error)) {
      await recoverAbandonedGuard(recoveryPath);
      return;
    }
    throw error;
  }
  try {
    await guard.writeFile(`${String(process.pid)}\n`);
    const owner = await readFile(lockPath, 'utf8').catch((error: unknown) => {
      if (isFileNotFound(error)) return undefined;
      throw error;
    });
    if (owner === undefined) return;
    const pid = /^([1-9]\d*)\n$/u.exec(owner)?.[1];
    // An incomplete or unrecognized record might still be in the middle of creation.
    if (pid === undefined) return;
    try {
      process.kill(Number(pid), 0);
      return;
    } catch (error) {
      if (!isProcessNotFound(error)) return;
    }
    // Only one contender can hold the recovery guard; no new owner can claim
    // manager.lock until its stale inode has been removed.
    await rm(lockPath, { force: true });
  } finally {
    await guard.close();
    await rm(recoveryPath, { force: true });
  }
}

async function recoverAbandonedGuard(path: string): Promise<void> {
  try {
    const file = await stat(path);
    // Give the holder time to write its PID; do not race a new guard creation.
    if (Date.now() - file.mtimeMs < 5_000) return;
    const owner = await readFile(path, 'utf8');
    const pid = /^([1-9]\d*)\n$/u.exec(owner)?.[1];
    if (pid === undefined) return;
    try {
      process.kill(Number(pid), 0);
    } catch (error) {
      if (isProcessNotFound(error)) await rm(path, { force: true });
    }
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

function isProcessNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
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

function isSafeRelativePath(value: string): boolean {
  return !value.includes('\\') && value.split('/').every(isSafeFileName);
}

async function listPayloadFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listPayloadFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error('DSH Companion runtime payload contains an unsupported filesystem entry');
  }
  return files;
}

async function listPayloadDirectories(root: string, prefix = ''): Promise<string[]> {
  const directories: string[] = [];
  for (const entry of await readdir(join(root, ...prefix.split('/').filter(Boolean)), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    directories.push(path, ...await listPayloadDirectories(root, path));
  }
  return directories;
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
