import assert from 'node:assert/strict';
import test from 'node:test';

import { isOpenFileMessage, resolveLocalFilePath, uriForLocalFile } from '../vscode/out/fileLinks.js';

test('Webview file requests admit clicked local paths and reject URI schemes and invalid lines', () => {
  assert.equal(isOpenFileMessage({ type: 'openFile', path: '/etc/hosts', line: 2 }), true);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: 'src/01_leds', line: 117, endLine: 122 }), true);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: 'src/01_leds', line: 117, endLine: 122, action: 'openBeside' }), true);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: '../other/file.ts', action: 'copyPath' }), true);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: '../other/file.ts' }), true);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: 'command:workbench.action.files.openFile' }), false);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: 'https://example.com/a' }), false);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: 'src/a.ts', line: 0 }), false);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: 'src/a.ts', line: '1' }), false);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: 'src/a.ts', endLine: 12 }), false);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: 'src/a.ts', line: 12, endLine: 11 }), false);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: 'src/a.ts', action: 'executeCommand' }), false);
  assert.equal(isOpenFileMessage({ type: 'openFile', path: 'src/\u0000a.ts' }), false);
});

test('file paths resolve against the DSH Session directory, including outside the workspace', () => {
  assert.equal(resolveLocalFilePath('src/a.ts', '/home/user/project'), '/home/user/project/src/a.ts');
  assert.equal(resolveLocalFilePath('../other/a.ts', '/home/user/project'), '/home/user/other/a.ts');
  assert.equal(resolveLocalFilePath('/etc/hosts', '/home/user/project'), '/etc/hosts');
  assert.equal(resolveLocalFilePath('src/a.ts', undefined), undefined);
});

test('workspace files keep the deepest matching Remote-SSH authority; outside files remain local host paths', () => {
  const roots = [
    { scheme: 'vscode-remote', authority: 'ssh-remote+server', fsPath: '/work' },
    { scheme: 'vscode-remote', authority: 'ssh-remote+server', fsPath: '/work/project' },
  ];
  const join = (root, relative) => ({ ...root, fsPath: `${root.fsPath}/${relative}` });
  const local = fsPath => ({ scheme: 'file', authority: '', fsPath });
  assert.deepEqual(uriForLocalFile('/work/project/src/app.ts', roots, join, local),
    { scheme: 'vscode-remote', authority: 'ssh-remote+server', fsPath: '/work/project/src/app.ts' });
  assert.deepEqual(uriForLocalFile('/etc/hosts', roots, join, local), local('/etc/hosts'));
});
