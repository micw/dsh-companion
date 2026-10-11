import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadUpstreamManifest, patchSetSha256 } from '../../runtime/dsh/scripts/manifest.mjs';

const version = process.env.DSH_COMPANION_VERSION;
const runtimeId = process.env.DSH_COMPANION_RUNTIME_ID;
const channel = process.env.DSH_COMPANION_BUILD_CHANNEL;
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !/^[a-f0-9]{64}$/.test(runtimeId ?? '')
  || !['master', 'release'].includes(channel)) throw new Error('Invalid release build metadata');
const source = join('dist', `dsh-companion-${version}.vsix`);
const output = resolve('dist', 'release');
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('Release output directory must be empty');
const asset = `dsh-companion-${version}-linux-x64.vsix`;
await copyFile(source, join(output, asset));
const bytes = await readFile(join(output, asset));
const sha256 = createHash('sha256').update(bytes).digest('hex');
const manifest = await loadUpstreamManifest();
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const info = { format: 1, version, channel, commit, runtimeId, target: 'linux-x64',
  dsh: { ...manifest.upstream, patchSetSha256: patchSetSha256(manifest) },
  runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  assets: [{ name: asset, sha256, size: bytes.length }] };
await writeFile(join(output, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
const infoHash = createHash('sha256').update(await readFile(join(output, 'build-info.json'))).digest('hex');
await writeFile(join(output, 'SHA256SUMS'), `${sha256}  ${asset}\n${infoHash}  build-info.json\n`);
console.log(`Prepared release assets for ${version} (${commit})`);
