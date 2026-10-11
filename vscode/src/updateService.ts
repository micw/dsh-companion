/** Public GitHub release validation and bounded downloads; no DSH or model credentials are used. */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { UpdateChannel } from './versionProtocol';

const API = 'https://api.github.com/repos/micw/dsh-companion';
const MAX_METADATA = 1024 * 1024;
export const MAX_VSIX = 1024 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export interface UpdateCandidate {
  readonly version: string; readonly channel: UpdateChannel; readonly commit: string;
  readonly assetId: number; readonly name: string; readonly size: number; readonly sha256: string;
  readonly publishedAt: string; readonly releaseUrl: string;
}
export function compareVersions(left: string, right: string): number {
  if (!VERSION.test(left) || !VERSION.test(right)) throw new Error('Invalid Companion version');
  const a = left.split('.').map(BigInt); const b = right.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
interface ReleaseAsset { id: number; name: string; size: number; digest?: string }
function asset(value: unknown): ReleaseAsset {
  if (!record(value) || !Number.isSafeInteger(value.id) || (value.id as number) < 1
    || typeof value.name !== 'string' || value.name.length > 200
    || !Number.isSafeInteger(value.size) || (value.size as number) < 1 || (value.size as number) > MAX_VSIX
    || value.state !== 'uploaded' || (value.digest !== undefined && value.digest !== null && typeof value.digest !== 'string')) {
    throw new Error('Invalid GitHub release asset');
  }
  return { id: value.id as number, name: value.name, size: value.size as number,
    ...(typeof value.digest === 'string' ? { digest: value.digest } : {}) };
}

export class UpdateService {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async response(url: string, accept: string, signal: AbortSignal): Promise<Response> {
    for (let count = 0; count < 6; count++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password || target.port
        || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) {
        throw new Error('Unexpected update download authority');
      }
      const response = await this.fetcher(target.href, { headers: { accept, 'user-agent': 'DSH-Companion-update' }, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error('Update redirect has no destination');
        url = new URL(location, target).href; continue;
      }
      return response;
    }
    throw new Error('Too many update redirects');
  }
  private async metadata(url: string, accept: string, signal: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.response(url, accept, signal);
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error('GitHub update request failed'); }
    if (!response.body) throw new Error('Update metadata has no body');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength; if (size > MAX_METADATA) throw new Error('Update metadata is too large');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks, size);
  }
  async check(channel: UpdateChannel, signal: AbortSignal): Promise<UpdateCandidate | null> {
    const bytes = await this.metadata(`${API}/releases/${channel === 'master' ? 'tags/master-build' : 'latest'}`, 'application/vnd.github+json', signal);
    if (bytes === null) return null;
    const release: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!record(release) || release.draft !== false || release.prerelease !== (channel === 'master')
      || typeof release.tag_name !== 'string' || !Array.isArray(release.assets) || release.assets.length > 100
      || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) throw new Error('Invalid GitHub release');
    if (channel === 'master' ? release.tag_name !== 'master-build' : !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.0$/.test(release.tag_name)) {
      throw new Error('Unexpected Companion release tag');
    }
    const assets = release.assets.map(asset);
    if (new Set(assets.map(entry => entry.id)).size !== assets.length || new Set(assets.map(entry => entry.name)).size !== assets.length) {
      throw new Error('Duplicate release assets');
    }
    const metadata = assets.find(entry => entry.name === 'build-info.json');
    const checksums = assets.find(entry => entry.name === 'SHA256SUMS');
    if (!metadata || !checksums || metadata.size > MAX_METADATA || checksums.size > MAX_METADATA) throw new Error('Update integrity metadata is missing');
    const infoBytes = await this.metadata(`${API}/releases/assets/${metadata.id}`, 'application/octet-stream', signal);
    const sumsBytes = await this.metadata(`${API}/releases/assets/${checksums.id}`, 'application/octet-stream', signal);
    if (!infoBytes || !sumsBytes || infoBytes.length !== metadata.size || sumsBytes.length !== checksums.size) throw new Error('Update metadata changed');
    const info: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(infoBytes));
    if (!record(info) || info.format !== 1 || info.channel !== (channel === 'master' ? 'master' : 'release')
      || typeof info.version !== 'string' || !VERSION.test(info.version) || info.target !== 'linux-x64'
      || typeof info.commit !== 'string' || !/^[a-f0-9]{40}$/.test(info.commit)
      || typeof info.runtimeId !== 'string' || !SHA.test(info.runtimeId) || !Array.isArray(info.assets) || info.assets.length !== 1) {
      throw new Error('Invalid update build identity');
    }
    if (channel === 'stable' && release.tag_name.slice(1) !== info.version) throw new Error('Release version mismatch');
    const declared = info.assets[0];
    if (!record(declared) || declared.name !== `dsh-companion-${info.version}-linux-x64.vsix`
      || typeof declared.sha256 !== 'string' || !SHA.test(declared.sha256)) throw new Error('Invalid update checksum');
    const vsix = assets.find(entry => entry.name === declared.name);
    if (!vsix || vsix.size !== declared.size || vsix.digest && vsix.digest !== `sha256:${declared.sha256}`) throw new Error('VSIX asset identity mismatch');
    const infoHash = createHash('sha256').update(infoBytes).digest('hex');
    const sums = new TextDecoder('utf-8', { fatal: true }).decode(sumsBytes);
    if (sums !== `${declared.sha256}  ${vsix.name}\n${infoHash}  build-info.json\n`) throw new Error('Update checksum manifest mismatch');
    if (channel === 'master') {
      const refBytes = await this.metadata(`${API}/git/ref/tags/master-build`, 'application/vnd.github+json', signal);
      if (!refBytes) throw new Error('Master release has no committed ref');
      const ref: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(refBytes));
      if (!record(ref) || !record(ref.object) || ref.object.type !== 'commit' || ref.object.sha !== info.commit) {
        throw new Error('Master release is being updated. Check again after publication completes');
      }
    }
    return { version: info.version, channel, commit: info.commit, assetId: vsix.id, name: vsix.name,
      size: vsix.size, sha256: declared.sha256, publishedAt: release.published_at,
      releaseUrl: `https://github.com/micw/dsh-companion/releases/tag/${release.tag_name}` };
  }
  async download(candidate: UpdateCandidate, path: string, signal: AbortSignal, progress: (percent: number) => void): Promise<void> {
    if (!Number.isSafeInteger(candidate.assetId) || candidate.assetId < 1 || !SHA.test(candidate.sha256)
      || !Number.isSafeInteger(candidate.size) || candidate.size < 1 || candidate.size > MAX_VSIX) throw new Error('Invalid download candidate');
    const response = await this.response(`${API}/releases/assets/${candidate.assetId}`, 'application/octet-stream', signal);
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Update download failed'); }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== candidate.size) { await response.body.cancel(); throw new Error('Update download size changed'); }
    const reader = response.body.getReader();
    let file;
    try { file = await open(path, 'wx', 0o600); }
    catch (error) { await reader.cancel().catch(() => {}); throw error; }
    let size = 0; let last = -1; const hash = createHash('sha256');
    try {
      while (true) {
        signal.throwIfAborted();
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength; if (size > candidate.size) throw new Error('Update exceeds declared size');
        hash.update(next.value);
        let offset = 0;
        while (offset < next.value.byteLength) offset += (await file.write(next.value, offset, next.value.byteLength - offset)).bytesWritten;
        const percent = Math.floor(size / candidate.size * 100); if (percent !== last) { last = percent; progress(percent); }
      }
      if (size !== candidate.size || hash.digest('hex') !== candidate.sha256) throw new Error('Update integrity check failed');
      await file.sync();
    } finally { await reader.cancel().catch(() => {}); await file.close(); }
  }
}
