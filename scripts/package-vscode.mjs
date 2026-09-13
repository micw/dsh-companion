#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(root, 'vscode');
const stage = join(root, 'build', 'vscode-package');
const dist = join(root, 'dist');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
}

const workspaceManifest = readJson(join(root, 'package.json'));
const extensionManifestPath = join(extensionRoot, 'package.json');
const extensionManifest = readJson(extensionManifestPath);
if (workspaceManifest.version !== '0.0.0' || extensionManifest.version !== '0.0.0') {
  throw new Error('source manifests must keep the neutral version 0.0.0');
}

run('pnpm', ['run', 'build']);
const version = execFileSync(process.execPath, [join(root, 'scripts', 'version.mjs')], {
  cwd: root,
  encoding: 'utf8',
}).trim();

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
mkdirSync(dist, { recursive: true });

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
const extensionReadme = readFileSync(join(extensionRoot, 'README.md'), 'utf8')
  .replace('(../features.md)', '(features.md)');
writeFileSync(join(stage, 'README.md'), extensionReadme);
cpSync(join(root, 'features.md'), join(stage, 'features.md'));

const executable = process.platform === 'win32' ? 'vsce.cmd' : 'vsce';
const vsce = join(extensionRoot, 'node_modules', '.bin', executable);
run(vsce, [
  'package',
  '--no-dependencies',
  '--out',
  join(dist, `dsh-companion-${version}.vsix`),
], { cwd: stage });
