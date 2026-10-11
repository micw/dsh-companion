/** VS Code adapter: preserve URI objects so remote command RPC targets the workspace Extension Host. */
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { UpdateService } from './updateService';
import { validateUpdatePackage } from './updatePackage';
import { VersionController } from './versionController';
import { acquireUpdateLock } from './updateLock';
import { companionLifecycleRoot } from './runtimeInstaller';
import type { VersionSnapshot } from './versionProtocol';

export function createVersionController(context: vscode.ExtensionContext,
  publish: (snapshot: VersionSnapshot) => void, isDirty: () => boolean): VersionController {
  const service = new UpdateService();
  const installedVersion = String(context.extension?.packageJSON.version ?? '0.0.0');
  const remote = vscode.env.remoteName;
  const target = `${remote ? remote === 'ssh-remote' ? 'SSH' : 'Remote' : 'Local'} · ${hostname()} · ${process.platform} ${process.arch}`;
  const targetOverridden = () => {
    const override = vscode.workspace.getConfiguration('remote').get<unknown>('extensionKind');
    return typeof override === 'object' && override !== null
      && Object.hasOwn(override, 'dsh-companion.dsh-companion-vscode');
  };
  const overridden = targetOverridden();
  const blockedReason = context.extensionMode !== vscode.ExtensionMode.Production || installedVersion === '0.0.0'
    ? 'Update installation is unavailable in an Extension Development Host.'
    : process.platform !== 'linux' || process.arch !== 'x64'
      ? 'Update installation currently supports Linux x64 Extension Hosts only.'
      : remote && overridden ? 'Remove the remote.extensionKind override for DSH Companion before updating.' : null;
  const saved = context.globalState.get<string>('dshCompanion.updateChannel');
  return new VersionController({ installedVersion, target, blockedReason,
    check: (channel, signal) => service.check(channel, signal),
    download: (candidate, path, signal, progress) => service.download(candidate, path, signal, progress),
    acquire: () => acquireUpdateLock(join(companionLifecycleRoot(), 'extension-update.lock')),
    confirm: async candidate => {
      if (isDirty()) {
        await vscode.window.showWarningMessage('Save or discard unsaved Settings changes before installing an update.'); return false;
      }
      const accepted = await vscode.window.showWarningMessage(
        `Install DSH Companion ${candidate.version} on ${target} and restart this window? Finish running Agent, Tool and background work in all windows first. A changed Runtime may stop and replace the shared backend.`,
        { modal: true, detail: `Download: ${(candidate.size / 1024 / 1024).toFixed(1)} MiB. Settings, Sessions and credentials remain in their existing storage. This is an unsigned GitHub package verified against release checksums.` },
        'Install update and restart');
      return accepted === 'Install update and restart' && !isDirty();
    },
    temporary: async () => {
      // globalStorageUri may retain a remote/provider scheme even in a Node Extension Host.
      // Use this process's private OS temporary directory, never a UI-side URI filesystem path.
      const directory = await mkdtemp(join(tmpdir(), 'dsh-companion-update-'));
      return { path: join(directory, 'update.vsix'), remove: () => rm(directory, { recursive: true, force: true }) };
    },
    validate: validateUpdatePackage,
    install: async path => {
      if (isDirty()) throw new Error('Settings draft changed during update');
      if (remote && targetOverridden()) throw new Error('Remote installation target changed');
      await vscode.commands.executeCommand<void>('workbench.extensions.installExtension', vscode.Uri.file(path));
    },
    restart: async () => {
      if (isDirty()) throw new Error('Settings draft changed before restart');
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
    saveChannel: async channel => { await context.globalState.update('dshCompanion.updateChannel', channel); },
  }, saved === 'stable' ? 'stable' : 'master', publish);
}
