#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { stageInputAllowed } from './fingerprint.mjs';
import { loadUpstreamManifest, patchSetSha256 } from './manifest.mjs';

const TARGET = 'linux-x64';
const EXPECTED_PROVIDER_BUNDLES = [
  '@dsh-companion/provider-openrouter',
  '@dsh-companion/provider-claude-wrapper-advanced',
  '@dsh-companion/provider-codex-wrapper-advanced',
];
const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    output: { type: 'string' },
    'runtime-id': { type: 'string' },
  },
  strict: true,
});
if (values.source === undefined || values.output === undefined || values['runtime-id'] === undefined) {
  throw new Error('Usage: build-linux.mjs --source <dsh-checkout> --output <absent-directory> --runtime-id <sha256>');
}
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(`Linux runtime build requires linux-x64, got ${process.platform}-${process.arch}`);
}
const runtimeId = values['runtime-id'];
if (!/^[0-9a-f]{64}$/u.test(runtimeId)) {
  throw new Error(`Invalid Runtime id ${JSON.stringify(runtimeId)}`);
}
const source = resolve(values.source);
const output = resolve(values.output);
const providerPackageRoots = parseProviderPackageRoots(process.env.DSH_COMPANION_PROVIDER_BUNDLES);
const buildEnvironment = { ...process.env, CI: '1' };
await requireAbsent(output, 'Runtime payload output');
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const prepared = join(dirname(output), '.dsh-companion-dsh-source-linux-x64');
await requireAbsent(prepared, 'Prepared DSH build directory');
const manifest = await loadUpstreamManifest();
try {
  await run(process.execPath, [
    resolve(import.meta.dirname, 'prepare.mjs'),
    '--source', source,
    '--output', prepared,
  ]);
  await run('pnpm', ['install', '--frozen-lockfile'], { cwd: prepared, env: buildEnvironment });
  await run('pnpm', ['run', 'build'], { cwd: prepared, env: buildEnvironment });
  const profileBundles = await stageCompanionPackages(prepared, providerPackageRoots);
  await run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: prepared, env: buildEnvironment });
  const clientBundle = join(prepared, 'dist-exe', 'dsh-companion-client-runtime.js');
  await bundleClientRuntime(prepared, clientBundle);
  await run('pnpm', [
    'exec', 'tsx', 'scripts/build-exe-for-python-sdk.ts',
    '--targets', 'node24-linux-x64',
    '--skip-build',
  ], { cwd: prepared, env: buildEnvironment });

  await mkdir(output, { recursive: true, mode: 0o700 });
  const executableName = 'dsh';
  const sourceExecutable = join(prepared, 'dist-exe', 'deepseek-harness-sdk-runtime-linux-x64');
  const sourceRipgrep = `${sourceExecutable}-rg`;
  const sourceOffice = `${sourceExecutable}-office`;
  const sourceResources = join(prepared, 'dist-exe', 'linux-x64');
  await removeCaseInsensitiveTerminfoAliases(sourceResources);
  const artifacts = [
    await copyArtifact(sourceExecutable, join(output, executableName), true),
    await copyArtifact(sourceRipgrep, join(output, 'dsh-rg'), true),
    ...await copyArtifactTree(sourceOffice, join(output, 'dsh-office'), output),
    ...await copyArtifactTree(sourceResources, join(output, 'linux-x64'), output),
    await copyArtifact(clientBundle, join(output, 'client-runtime.js'), false),
    await copyArtifact(
      resolve(import.meta.dirname, '../../../vscode/runtime/supervisor.mjs'),
      join(output, 'supervisor.mjs'),
      false,
    ),
    await copyArtifact(join(prepared, 'LICENSE'), join(output, 'DSH-LICENSE'), false),
    await copyArtifact(
      join(prepared, 'THIRD_PARTY_NOTICES.md'),
      join(output, 'DSH-THIRD_PARTY-NOTICES.md'),
      false,
    ),
  ];
  const runtimeManifest = {
    formatVersion: 2,
    runtimeId,
    target: TARGET,
    dsh: {
      upstreamRepository: manifest.upstream.repository,
      upstreamVersion: manifest.upstream.version,
      upstreamTag: manifest.upstream.tag,
      upstreamCommit: manifest.upstream.commit,
      upstreamTree: manifest.upstream.tree,
      modified: manifest.patches.length > 0,
      patchSetSha256: patchSetSha256(manifest),
      patches: manifest.patches.map((patch) => ({
        id: patch.id,
        sha256: patch.sha256,
        affectedModules: patch.affectedModules,
        upstreamDiscussion: patch.upstreamDiscussion,
      })),
    },
    launch: {
      executable: executableName,
      args: ['--profile', 'dsh-companion', '--no-open'],
      profileBundles,
    },
    artifacts,
  };
  await writeFile(join(output, 'runtime-manifest.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`, { mode: 0o600 });
  await healthCheck(join(output, executableName), profileBundles);
  console.log(`Built DSH Companion runtime ${runtimeId} at ${output}`);
} catch (error) {
  await rm(output, { recursive: true, force: true });
  throw error;
} finally {
  await rm(prepared, { recursive: true, force: true });
}

async function copyArtifact(from, to, executable) {
  await copyFile(from, to);
  await chmod(to, executable ? 0o755 : 0o600);
  const bytes = await readFile(to);
  return {
    file: basename(to),
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    executable,
  };
}

async function copyArtifactTree(from, to, payloadRoot) {
  await cp(from, to, { recursive: true, errorOnExist: true, force: false });
  const artifacts = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Runtime sidecar contains an unsupported entry: ${path}`);
      const info = await stat(path);
      const bytes = await readFile(path);
      artifacts.push({
        file: relative(payloadRoot, path).split('\\').join('/'),
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        executable: (info.mode & 0o111) !== 0,
      });
    }
  };
  await visit(to);
  return artifacts;
}

async function removeCaseInsensitiveTerminfoAliases(resources) {
  const root = join(resources, 'primary-runtime', 'dependencies', 'python', 'share', 'terminfo');
  try {
    if (!(await stat(root)).isDirectory()) return;
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Terminfo tree contains an unsupported entry: ${path}`);
    }
  };
  await visit(root);
  const groups = new Map();
  for (const path of files) {
    const key = relative(root, path).toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  for (const paths of groups.values()) {
    if (paths.length < 2) continue;
    paths.sort((left, right) => {
      const leftRelative = relative(root, left);
      const rightRelative = relative(root, right);
      const leftLower = leftRelative === leftRelative.toLowerCase();
      const rightLower = rightRelative === rightRelative.toLowerCase();
      return Number(rightLower) - Number(leftLower) || leftRelative.localeCompare(rightRelative);
    });
    for (const duplicate of paths.slice(1)) {
      // VSIX paths are case-insensitive even for a Linux-only target; keep the conventional lowercase terminfo name.
      await rm(duplicate);
    }
  }
}

async function bundleClientRuntime(prepared, outfile) {
  const esbuild = await import(pathToFileURL(resolve(
    import.meta.dirname,
    '../../../vscode/node_modules/esbuild/lib/main.js',
  )).href);
  await esbuild.build({
    entryPoints: [join(prepared, 'packages/api/client-runtime/lib/index.js')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    define: { 'import.meta.env': '{"MODE":"production"}' },
  });
}

async function stageCompanionPackages(prepared, providerRoots) {
  const companionRoot = resolve(import.meta.dirname, '../../..');
  const sourcePackages = join(companionRoot, 'packages');
  const destinationRoot = join(prepared, 'packages', 'dsh-companion');
  await mkdir(destinationRoot, { recursive: true });
  for (const entry of await readdir(sourcePackages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await stagePackage(join(sourcePackages, entry.name), join(destinationRoot, entry.name));
  }
  const profileBundles = ['@dsh-companion/bundle'];
  for (const [index, providerRoot] of providerRoots.entries()) {
    const sourceManifest = JSON.parse(await readFile(join(providerRoot, 'package.json'), 'utf8'));
    if (sourceManifest.name !== EXPECTED_PROVIDER_BUNDLES[index]) {
      throw new Error(`Invalid Companion provider bundle at ${providerRoot}`);
    }
    await stagePackage(providerRoot, join(destinationRoot, sourceManifest.name.split('/')[1]));
    profileBundles.push(sourceManifest.name);
  }
  for (const entry of await readdir(destinationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(destinationRoot, entry.name, 'package.json');
    const packageManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    let changed = false;
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(packageManifest[section] ?? {})) {
        if (!name.startsWith('@dsh-companion/')) continue;
        packageManifest[section][name] = 'workspace:*';
        changed = true;
      }
    }
    if (changed) await writeFile(manifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`);
  }
  const cliManifestPath = join(prepared, 'apps', 'cli', 'package.json');
  const cliManifest = JSON.parse(await readFile(cliManifestPath, 'utf8'));
  for (const packageName of profileBundles) cliManifest.dependencies[packageName] = 'workspace:*';
  await writeFile(cliManifestPath, `${JSON.stringify(cliManifest, null, 2)}\n`);
  return profileBundles;
}

async function stagePackage(from, to) {
  const sourceNodeModules = join(from, 'node_modules');
  await cp(from, to, {
    recursive: true,
    filter: path => path !== sourceNodeModules && !path.startsWith(`${sourceNodeModules}/`)
      && stageInputAllowed(path, from),
  });
  await Promise.all([
    rm(join(to, 'src'), { recursive: true, force: true }),
    rm(join(to, 'tests'), { recursive: true, force: true }),
    rm(join(to, 'tsconfig.json'), { force: true }),
    rm(join(to, 'tsdown.config.ts'), { force: true }),
  ]);
  const manifestPath = join(to, 'package.json');
  const packageManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  rewriteLinkDependencies(packageManifest);
  delete packageManifest.devDependencies;
  delete packageManifest.scripts;
  await writeFile(manifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`);
}

function rewriteLinkDependencies(packageManifest) {
  for (const section of ['dependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(packageManifest[section] ?? {})) {
      if (typeof version === 'string' && version.startsWith('link:')) {
        packageManifest[section][name] = 'workspace:*';
      }
    }
  }
}

async function healthCheck(executable, profileBundles) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-companion-health-'));
  const dshHome = join(home, 'dsh-home');
  await writeManagedProfile(dshHome, profileBundles);
  const port = await freePort();
  const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)
  )));
  const child = spawn(executable, [
    '--profile', 'dsh-companion', '--no-open', '--port', String(port),
  ], {
    cwd: home,
    env: { ...cleanEnvironment, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    await new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error === undefined) resolveReady();
        else rejectReady(error);
      };
      const timeout = setTimeout(() => {
        finish(new Error(`DSH runtime health check timed out:\n${redact(output)}`));
      }, 60_000);
      const consume = (chunk) => {
        output = `${output}${String(chunk)}`.slice(-32_768);
        if (/dsh web:\s+http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/u.test(output)) finish();
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.once('error', finish);
      child.once('exit', (code, signal) => {
        finish(new Error(`DSH runtime health check exited (${signal ?? String(code)}):\n${redact(output)}`));
      });
    });
  } finally {
    await stopChild(child);
    await rm(home, { recursive: true, force: true });
  }
}

async function writeManagedProfile(dshHome, profileBundles) {
  const profile = join(dshHome, 'profiles', 'dsh-companion');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-dsh-companion',
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...profileBundles],
        patchReload: 'startup',
      },
    },
  }, null, 2)}\n`);
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n');
}

function parseProviderPackageRoots(value) {
  if (value === undefined || value === '') {
    throw new Error('DSH_COMPANION_PROVIDER_BUNDLES must name the packaged provider bundles');
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error('DSH_COMPANION_PROVIDER_BUNDLES must be a JSON array', { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.length !== EXPECTED_PROVIDER_BUNDLES.length
    || parsed.some(path => typeof path !== 'string' || path.length === 0)
    || new Set(parsed).size !== parsed.length) {
    throw new Error('DSH_COMPANION_PROVIDER_BUNDLES must contain every provider package directory in product order');
  }
  return parsed.map(path => resolve(path));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => { server.off('error', rejectListen); resolveListen(); });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Unable to reserve a health-check port');
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => { if (error === undefined) resolveClose(); else rejectClose(error); });
  });
  return address.port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => { child.once('exit', resolveExit); });
  child.kill('SIGTERM');
  const forced = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
  forced.unref();
  await exited;
  clearTimeout(forced);
}

async function requireAbsent(path, label) {
  try {
    await stat(path);
    throw new Error(`${label} already exists: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} already exists:`)) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, { ...options, stdio: 'inherit' });
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (value, signal) => {
      if (signal !== null) rejectExit(new Error(`${command} terminated by ${signal}`));
      else resolveExit(value);
    });
  });
  if (code !== 0) throw new Error(`${command} exited with status ${String(code)}`);
}

function redact(value) {
  return value.replaceAll(/([?&]token=)[^\s)]+/gu, '$1[redacted]');
}
