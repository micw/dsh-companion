/** Bounded Settings Version messages; browser input never supplies URLs, paths or commands. */
export type UpdateChannel = 'master' | 'stable';
export interface VersionRequest {
  readonly type: 'versionRequest'; readonly requestId: number;
  readonly action: 'load' | 'check' | 'install'; readonly channel: UpdateChannel;
}
export interface VersionSnapshot {
  readonly installedVersion: string; readonly target: string; readonly channel: UpdateChannel;
  readonly phase: 'idle' | 'checking' | 'available' | 'current' | 'no-release' | 'downloading' | 'installing' | 'error';
  readonly available: { readonly version: string; readonly size: number; readonly publishedAt: string; readonly releaseUrl: string } | null;
  readonly canInstall: boolean; readonly blockedReason: string | null;
  readonly progress: number | null; readonly message: string;
}
export function parseVersionRequest(value: unknown): VersionRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const request = value as Record<string, unknown>;
  if (Object.keys(request).length !== 4 || request.type !== 'versionRequest'
    || !Number.isSafeInteger(request.requestId) || (request.requestId as number) < 1
    || typeof request.action !== 'string' || !['load', 'check', 'install'].includes(request.action)
    || typeof request.channel !== 'string' || !['master', 'stable'].includes(request.channel)) return;
  return request as unknown as VersionRequest;
}
