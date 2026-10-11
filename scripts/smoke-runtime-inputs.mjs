/** Cold/warm bundle regression without changing tracked sources or the caller's build outputs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeTreeFingerprint } from '../runtime/dsh/scripts/fingerprint.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const original = join(root, 'packages', 'provider-catalog');
// A sibling package directory preserves package-relative DSH links and generated TypeScript paths.
const fixture = await mkdtemp(join(root, 'packages', '.provider-catalog-build-check-'));
try {
  await cp(original, fixture, { recursive: true, filter: path => {
    const relative = path.slice(original.length).split(/[\\/]/);
    return !relative.some(part => ['lib', 'node_modules'].includes(part) || part.endsWith('.tsbuildinfo'));
  } });
  await cp(join(original, 'node_modules'), join(fixture, 'node_modules'), { recursive: true, dereference: false });
  const manifest = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts.build, 'tsc -b tsconfig.json --force && tsdown');
  const build = () => execFileSync('pnpm', ['run', 'build'], { cwd: fixture, stdio: 'inherit' });
  build();
  const first = await runtimeTreeFingerprint(join(fixture, 'lib'));
  build();
  const second = await runtimeTreeFingerprint(join(fixture, 'lib'));
  assert.equal(second, first, 'Cold and warm provider-catalog output bytes must match before Runtime cache lookup');
  console.log(`Cold/warm provider-catalog bundle identity passed: ${first}`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
