import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function allowedBuildOutput(path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\')
    || path.split('/').some(part => !part || part === '.' || part === '..'
      || ['node_modules', '.git', '.dev'].includes(part) || part === '.env' || part.startsWith('.env.'))) return false;
  return /^(?:lib\/|vendor\/[^/]+\/lib\/|packages\/[^/]+\/[^/]+\/lib\/|apps\/[^/]+\/lib\/|apps\/web\/dist\/|native\/system\/packages\/[^/]+\/(?:lib|bin)\/)/.test(path)
    || /(?:^|\/)(?:[^/]*\.tsbuildinfo|\.tsbuildinfo)$/.test(path)
    || path === '.dsh-build/client-build-environment.json';
}

async function safeParents(root, path) {
  const parts = path.split('/');
  let directory = resolve(root);
  const rootInfo = await lstat(directory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Cache root must be a real directory');
  for (const part of parts.slice(0, -1)) {
    directory = join(directory, part);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Cache path has an unsafe ancestor');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function inventory(root) {
  const paths = execFileSync('git', ['ls-files', '--others', '-z',
    '--exclude=node_modules/**', '--exclude=**/node_modules/**', '--exclude=.git/**'],
  { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString().split('\0').filter(Boolean).sort();
  const files = {};
  for (const path of paths) {
    const info = await lstat(join(root, path));
    if (!info.isFile()) throw new Error(`Build inventory rejects non-regular file: ${path}`);
    files[path] = digest(await readFile(join(root, path)));
  }
  const tracked = digest(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }));
  return { files, tracked };
}

/** Captures patch-added source/provenance after installation, before any build outputs exist. */
export async function captureBaseline(root, path) {
  const baseline = await inventory(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(baseline));
}

/** Stores only successful build outputs; patched source, dependencies and private files are never cached. */
export async function collectBuildOutputs(root, baselinePath, destination, key) {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  const after = await inventory(root);
  if (after.tracked !== baseline.tracked) throw new Error('DSH build modified tracked prepared source');
  for (const [path, hash] of Object.entries(baseline.files)) {
    if (after.files[path] !== hash) throw new Error('DSH build modified baseline source or provenance');
  }
  const entries = [];
  for (const path of Object.keys(after.files).filter(path => !Object.hasOwn(baseline.files, path))) {
    if (!allowedBuildOutput(path)) throw new Error(`Unreviewed DSH build output: ${path}`);
    const mode = (await lstat(join(root, path))).mode & 0o777;
    await mkdir(dirname(join(destination, 'files', path)), { recursive: true });
    await copyFile(join(root, path), join(destination, 'files', path));
    entries.push({ path, sha256: after.files[path], mode });
  }
  if (!entries.length) throw new Error('DSH build produced no cacheable outputs');
  await writeFile(join(destination, 'manifest.json'), JSON.stringify({ format: 1, key, entries }));
}

/** Verifies the complete manifest before restoring any generated files into a newly prepared tree. */
export async function restoreBuildOutputs(root, cache, key) {
  const manifest = JSON.parse(await readFile(join(cache, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || manifest.key !== key || !Array.isArray(manifest.entries) || !manifest.entries.length) {
    throw new Error('Invalid DSH build cache identity');
  }
  const paths = new Set();
  for (const entry of manifest.entries) {
    if (!allowedBuildOutput(entry.path) || paths.has(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error('Invalid DSH build cache entry');
    paths.add(entry.path);
    await safeParents(cache, `files/${entry.path}`);
    await safeParents(root, entry.path);
    const source = join(cache, 'files', entry.path);
    if (!(await lstat(source)).isFile() || digest(await readFile(source)) !== entry.sha256) throw new Error('Corrupt DSH build cache');
    try {
      await lstat(join(root, entry.path));
      throw new Error('DSH cache refuses to overwrite prepared files');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const entry of manifest.entries) {
    const destination = join(root, entry.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(cache, 'files', entry.path), destination);
    await chmod(destination, entry.mode);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, root, path, key] = process.argv.slice(2);
  if (!root || !path) throw new Error('Expected operation, prepared source and cache/baseline path');
  if (operation === 'baseline') await captureBaseline(resolve(root), resolve(path));
  else if (operation === 'collect' && key && process.argv[6]) {
    await collectBuildOutputs(resolve(root), resolve(path), resolve(key), process.argv[6]);
  } else if (operation === 'restore' && key) await restoreBuildOutputs(resolve(root), resolve(path), key);
  else throw new Error('Invalid DSH build cache operation');
}
