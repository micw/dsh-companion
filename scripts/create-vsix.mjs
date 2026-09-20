#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(root, 'vscode');

/** Stages and creates one platform-specific VSIX from an already verified runtime payload. */
export async function createVsix({ version, runtimePayload, output }) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`Invalid VSIX version ${JSON.stringify(version)}`);
  const workspaceManifest = readJson(join(root, 'package.json'));
  const extensionManifest = readJson(join(extensionRoot, 'package.json'));
  if (workspaceManifest.version !== '0.0.0' || extensionManifest.version !== '0.0.0') {
    throw new Error('source manifests must keep the neutral version 0.0.0');
  }
  const runtimeManifest = readJson(join(runtimePayload, 'runtime-manifest.json'));
  if (runtimeManifest.companionVersion !== version || runtimeManifest.target !== 'linux-x64') {
    throw new Error('Runtime payload identity does not match the Linux VSIX');
  }

  const stage = join(root, 'build', 'vscode-package');
  const destination = output ?? join(root, 'dist', `dsh-companion-${version}.vsix`);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  mkdirSync(dirname(destination), { recursive: true });

  extensionManifest.version = version;
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(extensionManifest, null, 2)}\n`);
  mkdirSync(join(stage, 'out'), { recursive: true });
  const { build } = await import(pathToFileURL(
    join(extensionRoot, 'node_modules', 'esbuild', 'lib', 'main.js'),
  ).href);
  await build({
    entryPoints: [join(extensionRoot, 'src', 'extension.ts')],
    bundle: true,
    platform: 'node',
    external: ['vscode'],
    sourcemap: true,
    outfile: join(stage, 'out', 'extension.js'),
  });
  cpSync(join(extensionRoot, 'media'), join(stage, 'media'), { recursive: true });
  cpSync(runtimePayload, join(stage, 'runtime', 'payload', 'linux-x64'), { recursive: true });
  const extensionReadme = readFileSync(join(extensionRoot, 'README.md'), 'utf8')
    .replace('[the feature reference](../features.md)', '`features.md`');
  writeFileSync(join(stage, 'README.md'), extensionReadme);
  cpSync(join(root, 'features.md'), join(stage, 'features.md'));
  cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

  const executable = process.platform === 'win32' ? 'vsce.cmd' : 'vsce';
  run(join(extensionRoot, 'node_modules', '.bin', executable), [
    'package',
    '--no-dependencies',
    '--allow-missing-repository',
    '--target',
    'linux-x64',
    '--out',
    destination,
  ], { cwd: stage });
  return destination;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      payload: { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
  });
  if (values.version === undefined || values.payload === undefined) {
    throw new Error('Usage: create-vsix.mjs --version <x.y.z> --payload <runtime-directory> [--output <vsix>]');
  }
  const destination = await createVsix({
    version: values.version,
    runtimePayload: resolve(values.payload),
    output: values.output === undefined ? undefined : resolve(values.output),
  });
  console.log(`Created ${destination}`);
}
