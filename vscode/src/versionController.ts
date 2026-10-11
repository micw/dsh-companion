/** Explicit update lifecycle. Installation and restart happen only after a fresh check and modal consent. */
import { compareVersions } from './updateService';
import type { UpdateCandidate, UpdateService } from './updateService';
import type { UpdateChannel, VersionSnapshot } from './versionProtocol';

export interface UpdateHost {
  readonly installedVersion: string; readonly target: string; readonly blockedReason: string | null;
  readonly check: (channel: UpdateChannel, signal: AbortSignal) => Promise<UpdateCandidate | null>;
  readonly download: UpdateService['download'];
  readonly confirm: (candidate: UpdateCandidate) => Promise<boolean>;
  readonly acquire: () => Promise<() => Promise<void>>;
  readonly temporary: () => Promise<{ path: string; remove: () => Promise<void> }>;
  readonly validate: (path: string, version: string) => Promise<void>;
  readonly install: (path: string) => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly saveChannel: (channel: UpdateChannel) => Promise<void>;
}
export class VersionController {
  private candidate: UpdateCandidate | null = null;
  private phase: VersionSnapshot['phase'] = 'idle';
  private message = 'Check for updates to find an available version.';
  private progress: number | null = null;
  private operation: AbortController | undefined;
  private disposed = false;
  constructor(private readonly host: UpdateHost, private channel: UpdateChannel,
    private readonly publish: (snapshot: VersionSnapshot) => void) {}
  snapshot(): VersionSnapshot {
    let newer = false;
    try { newer = !!this.candidate && compareVersions(this.candidate.version, this.host.installedVersion) > 0; } catch { /* Development versions cannot install. */ }
    return { installedVersion: this.host.installedVersion, target: this.host.target, channel: this.channel,
      phase: this.phase, available: this.candidate ? { version: this.candidate.version, size: this.candidate.size,
        publishedAt: this.candidate.publishedAt, releaseUrl: this.candidate.releaseUrl } : null,
      canInstall: newer && !this.host.blockedReason && this.phase === 'available' && !this.operation, blockedReason: this.host.blockedReason,
      progress: this.progress, message: this.message };
  }
  private emit(): void { if (!this.disposed) this.publish(this.snapshot()); }
  async load(channel: UpdateChannel): Promise<void> {
    if (this.operation || this.disposed) return;
    if (this.channel !== channel) {
      this.channel = channel; this.candidate = null; this.phase = 'idle'; this.message = 'Check for updates to find an available version.';
      await this.host.saveChannel(channel);
    }
    this.emit();
  }
  async check(channel: UpdateChannel): Promise<void> {
    if (this.operation || this.disposed) return;
    await this.load(channel);
    if (this.operation || this.disposed || channel !== this.channel) return;
    const operation = new AbortController(); this.operation = operation;
    this.phase = 'checking'; this.candidate = null; this.message = 'Checking GitHub for updates…'; this.emit();
    const timeout = setTimeout(() => operation.abort(), 30_000);
    try {
      const candidate = await this.host.check(channel, operation.signal);
      operation.signal.throwIfAborted();
      if (!candidate) { this.phase = 'no-release'; this.message = channel === 'stable' ? 'No stable release is available.' : 'No master build is available.'; }
      else {
        this.candidate = candidate;
        const comparison = compareVersions(candidate.version, this.host.installedVersion);
        this.phase = comparison > 0 ? 'available' : 'current';
        this.message = comparison > 0 ? 'An update is available.' : comparison === 0 ? 'You are up to date.' : 'The installed version is newer. Downgrades are not offered.';
      }
    } catch { if (!this.disposed) { this.phase = 'error'; this.message = 'Could not check for updates. GitHub may be unavailable or rate-limited. Try again later.'; } }
    finally { clearTimeout(timeout); this.operation = undefined; this.emit(); }
  }
  async install(channel: UpdateChannel): Promise<void> {
    if (this.operation || this.disposed || channel !== this.channel || !this.snapshot().canInstall || !this.candidate) return;
    const operation = new AbortController(); this.operation = operation;
    this.phase = 'checking'; this.message = 'Waiting for update confirmation…'; this.emit();
    const selected = this.candidate; let temporary: Awaited<ReturnType<UpdateHost['temporary']>> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined; let installed = false;
    let release: (() => Promise<void>) | undefined;
    try {
      if (!await this.host.confirm(selected)) {
        this.phase = 'available'; this.message = 'Installation cancelled.'; return;
      }
      operation.signal.throwIfAborted();
      release = await this.host.acquire();
      operation.signal.throwIfAborted();
      this.phase = 'checking'; this.message = 'Confirming the selected release…'; this.emit();
      timeout = setTimeout(() => operation.abort(), 30_000);
      const fresh = await this.host.check(channel, operation.signal);
      clearTimeout(timeout);
      if (!fresh || fresh.version !== selected.version || fresh.commit !== selected.commit || fresh.assetId !== selected.assetId
        || fresh.sha256 !== selected.sha256 || fresh.size !== selected.size) {
        this.candidate = null; this.phase = 'idle'; this.message = 'The release changed. Check for updates again before installing.'; return;
      }
      temporary = await this.host.temporary(); operation.signal.throwIfAborted();
      this.phase = 'downloading'; this.message = 'Downloading and verifying the update…'; this.progress = 0; this.emit();
      timeout = setTimeout(() => operation.abort(), 15 * 60_000);
      await this.host.download(fresh, temporary.path, operation.signal, percent => { this.progress = percent; this.emit(); });
      clearTimeout(timeout); timeout = undefined;
      await this.host.validate(temporary.path, selected.version); operation.signal.throwIfAborted();
      this.phase = 'installing'; this.message = 'Installing the update on this Extension Host…'; this.progress = null; this.emit();
      await this.host.install(temporary.path); installed = true;
      // Finish essential cleanup before restarting destroys this Extension Host.
      await temporary.remove(); temporary = undefined;
      operation.signal.throwIfAborted();
      this.message = 'Update installed. Restarting this window…'; this.emit();
      await release(); release = undefined;
      await this.host.restart();
    } catch {
      if (!this.disposed) {
        this.phase = 'error'; this.message = installed
          ? 'The update was installed, but this window could not restart. Restart VS Code when your work is finished.'
          : 'The update could not be installed. Nothing was restarted. Check for updates and try again.';
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      await temporary?.remove().catch(() => {});
      await release?.().catch(() => {});
      this.operation = undefined; this.progress = null; this.emit();
    }
  }
  dispose(): void { this.disposed = true; this.operation?.abort(); }
}
