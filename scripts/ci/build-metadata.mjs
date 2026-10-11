import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadUpstreamManifest, patchSetSha256, verifyPatchFiles } from '../../runtime/dsh/scripts/manifest.mjs';

/** Accepts only the public product build channels, including manual runs on those exact refs. */
export function channelForRef(ref) {
  if (ref === 'refs/heads/master') return { channel: 'master', releaseTag: '' };
  const tag = /^refs\/tags\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.0)$/.exec(ref ?? '');
  if (tag !== null) return { channel: 'release', releaseTag: tag[1] };
  throw new Error('Builds must target master or a supported v<major>.<minor>.0 release tag');
}

export async function buildMetadata(env = process.env) {
  const channel = channelForRef(env.GITHUB_REF);
  const manifest = await loadUpstreamManifest();
  await verifyPatchFiles(manifest);
  const compiler = execFileSync('cc', ['--version'], { encoding: 'utf8' });
  const pnpmVersion = execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim();
  if (pnpmVersion !== '11.7.0') throw new Error('CI requires pnpm 11.7.0');
  const key = createHash('sha256');
  key.update(JSON.stringify({ schema: 1, upstream: manifest.upstream,
    patchSet: patchSetSha256(manifest), node: process.version, pnpmVersion,
    os: process.platform, arch: process.arch, image: env.ImageOS ?? '', imageVersion: env.ImageVersion ?? '', compiler }));
  for (const file of ['scripts/ci/build-metadata.mjs', 'scripts/ci/dsh-build-cache.mjs', 'runtime/dsh/scripts/prepare.mjs',
    '.github/workflows/build-release.yml']) {
    key.update(await readFile(file));
  }
  return { ...channel, buildId: new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
    upstreamCommit: manifest.upstream.commit, upstreamTag: manifest.upstream.tag,
    upstreamRepository: manifest.upstream.repository, patchSet: patchSetSha256(manifest),
    dshCacheKey: `dsh-build-v1-${key.digest('hex')}` };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildMetadata();
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
}
