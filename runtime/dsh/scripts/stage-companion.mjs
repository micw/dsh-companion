import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRODUCT_PROVIDERS, productProviderRoots } from '../../../scripts/product-packages.mjs';
import { stageInputAllowed } from './fingerprint.mjs';

/** Stages product packages into DSH's flat workspace without importing the providers container. */
export async function stageCompanionPackages(prepared, companionRoot) {
  const sourcePackages = join(companionRoot, 'packages');
  const destinationRoot = join(prepared, 'packages', 'dsh-companion');
  await mkdir(destinationRoot, { recursive: true });
  for (const entry of await readdir(sourcePackages, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'providers') continue;
    await stagePackage(join(sourcePackages, entry.name), join(destinationRoot, entry.name));
  }
  const profileBundles = ['@dsh-companion/bundle'];
  for (const [index, providerRoot] of productProviderRoots(companionRoot).entries()) {
    const sourceManifest = JSON.parse(await readFile(join(providerRoot, 'package.json'), 'utf8'));
    if (sourceManifest.name !== PRODUCT_PROVIDERS[index].name) {
      throw new Error(`Invalid Companion provider bundle at ${providerRoot}`);
    }
    await stagePackage(providerRoot, join(destinationRoot, sourceManifest.name.split('/')[1]));
    profileBundles.push(sourceManifest.name);
  }
  const cliManifestPath = join(prepared, 'apps', 'cli', 'package.json');
  const cliManifest = JSON.parse(await readFile(cliManifestPath, 'utf8'));
  for (const packageName of profileBundles) cliManifest.dependencies[packageName] = 'workspace:*';
  await writeFile(cliManifestPath, `${JSON.stringify(cliManifest, null, 2)}\n`);
  return profileBundles;
}

async function stagePackage(from, to) {
  await cp(from, to, { recursive: true, filter: path => stageInputAllowed(path, from) });
  await Promise.all([
    rm(join(to, 'src'), { recursive: true, force: true }),
    rm(join(to, 'tests'), { recursive: true, force: true }),
    rm(join(to, 'tsconfig.json'), { force: true }),
    rm(join(to, 'tsdown.config.ts'), { force: true }),
  ]);
  const manifestPath = join(to, 'package.json');
  const packageManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(packageManifest[section] ?? {})) {
      if (name.startsWith('@dsh-companion/') || typeof version === 'string' && version.startsWith('link:')) {
        packageManifest[section][name] = 'workspace:*';
      }
    }
  }
  delete packageManifest.devDependencies;
  delete packageManifest.scripts;
  await writeFile(manifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`);
}
