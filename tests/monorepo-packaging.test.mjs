import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PRODUCT_PROVIDERS, productProviderRoots } from '../scripts/product-packages.mjs';
import { stageCompanionPackages } from '../runtime/dsh/scripts/stage-companion.mjs';
import { runtimeTreeFingerprint } from '../runtime/dsh/scripts/fingerprint.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('provider packages are optional workspace plugins at the same product revision', async () => {
  const workspace = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(workspace, /packages\/providers\/\*/);
  const roots = productProviderRoots(root);
  assert.equal(roots.length, 3);
  for (const [index, providerRoot] of roots.entries()) {
    const manifest = JSON.parse(await readFile(join(providerRoot, 'package.json'), 'utf8'));
    assert.equal(manifest.name, PRODUCT_PROVIDERS[index].name);
    assert.equal(manifest.version, '0.0.0');
    assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      if (name.startsWith('@dsh-companion/')) assert.equal(version, 'workspace:*');
    }
    await assert.rejects(access(join(providerRoot, 'pnpm-lock.yaml')), { code: 'ENOENT' });
    await assert.rejects(access(join(providerRoot, 'pnpm-workspace.yaml')), { code: 'ENOENT' });
  }
  const bundle = JSON.parse(await readFile(join(root, 'packages', 'bundle', 'package.json'), 'utf8'));
  for (const provider of PRODUCT_PROVIDERS) assert.equal(bundle.dependencies[provider.name], undefined);
});

test('runtime staging flattens all optional providers and preserves profile load order without sibling inputs', async () => {
  const prepared = await mkdtemp(join(tmpdir(), 'companion-monorepo-stage-'));
  try {
    await mkdir(join(prepared, 'apps', 'cli'), { recursive: true });
    await writeFile(join(prepared, 'apps', 'cli', 'package.json'), JSON.stringify({ dependencies: {} }));
    const profile = await stageCompanionPackages(prepared, root);
    assert.deepEqual(profile, ['@dsh-companion/bundle', ...PRODUCT_PROVIDERS.map(provider => provider.name)]);
    const destination = join(prepared, 'packages', 'dsh-companion');
    const entries = await readdir(destination);
    assert.equal(entries.includes('providers'), false);
    assert.equal(entries.includes('web-search'), true);
    assert.equal(entries.includes('web-search-brave'), true);
    for (const provider of PRODUCT_PROVIDERS) {
      const dir = join(destination, provider.name.split('/')[1]);
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      assert.equal(manifest.name, provider.name);
      assert.equal(manifest.version, '0.0.0');
      assert.equal(manifest.devDependencies, undefined);
      assert.equal(manifest.scripts, undefined);
      assert.equal(manifest.dependencies['@dsh-companion/model-policy'], 'workspace:*');
      assert.equal(manifest.dependencies['@deepseek-ai/schemastery'], 'workspace:*');
      await access(join(dir, manifest.main));
      await access(join(dir, 'cordis.patch.yml'));
      await assert.rejects(access(join(dir, 'src')), { code: 'ENOENT' });
      await assert.rejects(access(join(dir, 'tests')), { code: 'ENOENT' });
      await assert.rejects(access(join(dir, 'node_modules')), { code: 'ENOENT' });
    }
    const cli = JSON.parse(await readFile(join(prepared, 'apps', 'cli', 'package.json'), 'utf8'));
    for (const name of profile) assert.equal(cli.dependencies[name], 'workspace:*');
  } finally {
    await rm(prepared, { recursive: true, force: true });
  }
});

test('nested provider content is hashed once with the product packages tree', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'companion-provider-hash-'));
  try {
    const provider = join(fixture, 'providers', 'openrouter');
    await mkdir(provider, { recursive: true });
    await writeFile(join(provider, 'package.json'), '{"version":"0.0.0"}\n');
    const before = await runtimeTreeFingerprint(fixture);
    await writeFile(join(provider, 'package.json'), '{"version":"0.0.0","changed":true}\n');
    assert.notEqual(await runtimeTreeFingerprint(fixture), before);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
