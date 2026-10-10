import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pendingSessionForRoots, type PendingSessionOpen } from './sessionWorkspace';

const HANDOFF_TTL_MS = 5 * 60_000;

/** Publish one short-lived, non-secret Session target for existing or new VS Code windows. */
export async function publishSessionHandoff(root: string, sessionId: string, cwd: string): Promise<() => Promise<void>> {
  const directory = join(root, 'session-handoffs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const staging = join(directory, `staging-${id}.json`);
  const pending = join(directory, `pending-${id}.json`);
  const value: PendingSessionOpen = { sessionId, cwd, expiresAt: Date.now() + HANDOFF_TTL_MS };
  try {
    await writeFile(staging, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(staging, pending);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
  return () => rm(pending, { force: true });
}

/** Subscribe a window to handoffs, including those published before it started. */
export async function receiveSessionHandoffs(
  root: string,
  roots: () => readonly string[],
  openSession: (sessionId: string) => void,
  onError: (error: unknown) => void,
): Promise<() => void> {
  const directory = join(root, 'session-handoffs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let disposed = false;
  let scanning = false;
  let rescan = false;
  const scan = async (): Promise<void> => {
    if (disposed) return;
    if (scanning) { rescan = true; return; }
    scanning = true;
    try {
      do {
        rescan = false;
        for (const name of await readdir(directory)) {
          if (!/^pending-[0-9a-f-]{36}\.json$/u.test(name)) continue;
          const source = join(directory, name);
          let value: unknown;
          try { value = JSON.parse(await readFile(source, 'utf8')); }
          catch (error) { if (!isNotFound(error)) onError(error); continue; }
          if (!isPending(value)) continue;
          if (value.expiresAt <= Date.now()) { await rm(source, { force: true }); continue; }
          const sessionId = pendingSessionForRoots(value, roots(), Date.now());
          if (sessionId === undefined) continue;
          const claimed = join(directory, `claimed-${randomUUID()}.json`);
          try { await rename(source, claimed); }
          catch (error) { if (!isNotFound(error)) throw error; continue; }
          try { openSession(sessionId); }
          finally { await rm(claimed, { force: true }); }
        }
      } while (rescan && !disposed);
    } catch (error) {
      onError(error);
    } finally {
      scanning = false;
    }
  };
  const watcher = watch(directory, () => { void scan(); });
  watcher.on('error', onError);
  const fallback = setInterval(() => { void scan(); }, 5_000);
  fallback.unref();
  void scan();
  return () => { disposed = true; clearInterval(fallback); watcher.close(); };
}

function isPending(value: unknown): value is PendingSessionOpen {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.sessionId === 'string' && item.sessionId.length > 0
    && typeof item.cwd === 'string' && Number.isSafeInteger(item.expiresAt);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
