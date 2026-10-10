import * as path from 'node:path';

/** Match a Session's working directory to an exact VS Code workspace root. */
export function sessionWorkspaceKind(cwd: string | undefined, roots: readonly string[]): 'local' | 'foreign' | 'unknown' {
  if (cwd === undefined || !path.isAbsolute(cwd)) return 'unknown';
  const normalized = path.resolve(cwd);
  return roots.some(root => path.resolve(root) === normalized) ? 'local' : 'foreign';
}

/** Session ids handed to another VS Code window expire rather than reopening on a later launch. */
export interface PendingSessionOpen {
  readonly sessionId: string;
  readonly cwd: string;
  readonly expiresAt: number;
}

export function pendingSessionForRoots(
  pending: PendingSessionOpen | undefined,
  roots: readonly string[],
  now: number,
): string | undefined {
  return pending !== undefined && pending.expiresAt > now
    && sessionWorkspaceKind(pending.cwd, roots) === 'local' ? pending.sessionId : undefined;
}
