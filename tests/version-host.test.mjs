import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { acquireUpdateLock } from '../vscode/out/updateLock.js';

const source = await readFile(new URL('../vscode/out/versionHost.js', import.meta.url), 'utf8');
const require = createRequire(new URL('../vscode/out/versionHost.js', import.meta.url));
function fixture({ remoteName, extensionMode = 1, dirty = false, storageScheme = 'file' } = {}) {
  const commands = []; const warnings = []; let host; let override;
  class Uri {
    constructor(path) { this.fsPath = path; this.scheme = 'file'; }
    static file(path) { return new Uri(path); }
    static joinPath(root, ...parts) { return new Uri(join(root.fsPath, ...parts)); }
  }
  const vscode = { env: { remoteName }, ExtensionMode: { Production: 1 }, Uri,
    workspace: { getConfiguration: () => ({ get: () => override }), fs: { createDirectory: async () => {} } },
    window: { showWarningMessage: async (...args) => { warnings.push(args); return 'Install update and restart'; } },
    commands: { executeCommand: async (...args) => { commands.push(args); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, process, require: name => {
    if (name === 'vscode') return vscode;
    if (name === './versionController') return { VersionController: class { constructor(value) { host = value; } } };
    if (name === './runtimeInstaller') return { companionLifecycleRoot: () => '/fixture/lifecycle' };
    return require(name);
  } });
  const globalStorageUri = new Uri('/fixture/global'); globalStorageUri.scheme = storageScheme;
  module.exports.createVersionController({ extensionMode, extension: { packageJSON: { version: '0.2.0' } },
    globalStorageUri, globalState: { get() {}, update: async () => {} } }, () => {}, () => dirty);
  return { host, commands, warnings, Uri, vscode, setOverride: value => { override = value; } };
}

test('local and SSH installations pass actual URI objects and await install before the explicit window restart', async () => {
  for (const remoteName of [undefined, 'ssh-remote']) {
    const f = fixture({ remoteName });
    assert.match(f.host.target, remoteName ? /^SSH/ : /^Local/);
    assert.equal(f.host.blockedReason, null);
    await f.host.install('/fixture/update.vsix');
    assert.equal(f.commands[0][0], 'workbench.extensions.installExtension');
    assert.ok(f.commands[0][1] instanceof f.Uri);
    assert.equal(f.commands[0][1].fsPath, '/fixture/update.vsix');
    assert.equal(f.commands.length, 1);
    await f.host.restart(); assert.equal(f.commands[1][0], 'workbench.action.reloadWindow');
  }
});

test('remote storage URI schemes do not block private host-local update downloads', async () => {
  for (const storageScheme of ['vscode-remote', 'vscode-userdata']) {
    const f = fixture({ remoteName: 'ssh-remote', storageScheme });
    assert.equal(f.host.blockedReason, null);
    f.vscode.workspace.fs.createDirectory = async () => { throw Error('Must not treat storage URI as a local download path'); };
    const temporary = await f.host.temporary();
    try {
      assert.ok(temporary.path.startsWith(join(tmpdir(), 'dsh-companion-update-')));
      assert.equal((await stat(join(temporary.path, '..'))).mode & 0o777, 0o700);
      await writeFile(temporary.path, 'download fixture');
      await f.host.install(temporary.path);
      assert.ok(f.commands[0][1] instanceof f.Uri);
      assert.equal(f.commands[0][1].fsPath, temporary.path);
    } finally { await temporary.remove(); }
    await assert.rejects(stat(temporary.path), { code: 'ENOENT' });
  }
});

test('remote target overrides added after Settings opens are rejected before installation', async () => {
  const f = fixture({ remoteName: 'ssh-remote' }); assert.equal(f.host.blockedReason, null);
  f.setOverride({ 'dsh-companion.dsh-companion-vscode': ['ui'] });
  await assert.rejects(f.host.install('/fixture/update.vsix'), /target changed/);
  assert.equal(f.commands.length, 0);
});

test('development hosts and dirty drafts cannot silently install or restart', async () => {
  const development = fixture({ extensionMode: 2 }); assert.match(development.host.blockedReason, /Development/);
  const dirty = fixture({ dirty: true });
  assert.equal(await dirty.host.confirm({ version: '0.3.0', size: 1 }), false);
  await assert.rejects(dirty.host.install('/fixture/update.vsix'), /draft/);
  await assert.rejects(dirty.host.restart(), /draft/); assert.equal(dirty.commands.length, 0);
});

test('host-wide update lock covers another controller/window until installation settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-update-lock-'));
  const path = join(root, 'update.lock');
  try {
    const release = await acquireUpdateLock(path);
    await assert.rejects(acquireUpdateLock(path), /already updating/);
    await release(); const second = await acquireUpdateLock(path); await second();
    const module = new URL('../vscode/out/updateLock.js', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import {acquireUpdateLock} from ${JSON.stringify(module)};await acquireUpdateLock(${JSON.stringify(path)});console.log('locked');setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
      await assert.rejects(acquireUpdateLock(path), /already updating/);
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
      const recovered = await acquireUpdateLock(path); await recovered();
    } finally { child.kill('SIGKILL'); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
