import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { pendingSessionForRoots, sessionWorkspaceKind } from '../vscode/out/sessionWorkspace.js';

test('workspace matching uses exact paths across all VS Code roots', () => {
  assert.equal(sessionWorkspaceKind('/project/b/', ['/project/a', '/project/b']), 'local');
  assert.equal(sessionWorkspaceKind('/project/b/src', ['/project/b']), 'foreign');
  assert.equal(sessionWorkspaceKind('/project/b', []), 'foreign');
  assert.equal(sessionWorkspaceKind(undefined, ['/project/b']), 'unknown');
});

test('a pending window handoff opens only at the matching root before expiration', () => {
  const pending = { sessionId: 'session-1', cwd: '/project/b', expiresAt: 1000 };
  assert.equal(pendingSessionForRoots(pending, ['/project/a', '/project/b'], 999), 'session-1');
  assert.equal(pendingSessionForRoots(pending, ['/project/a'], 999), undefined);
  assert.equal(pendingSessionForRoots(pending, ['/project/b'], 1000), undefined);
});

test('sidebar filters list and content search under the same checkbox', async () => {
  const sidebar = await readFile(new URL('../vscode/media/sessions.js', import.meta.url), 'utf8');
  const provider = await readFile(new URL('../vscode/src/sessionTree.ts', import.meta.url), 'utf8');
  assert.match(sidebar, /allWorkspaces\.addEventListener\('change', render\)/);
  assert.match(sidebar, /visibleSessions\(searchResults\.items\)/);
  assert.match(sidebar, /visibleSessions\(snapshot\.sessions\)/);
  assert.match(sidebar, /items\.filter\(item => item\.workspaceKind === 'local'\)/);
  assert.match(provider, /items: merged\.items\.map\(item => this\.withWorkspace\(item\)\)/);
});
