import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Reuses a verified immutable payload or publishes a newly built one under its input digest. */
export async function reuseOrBuildRuntime(cacheRoot, runtimeId, verify, build) {
  if (!/^[0-9a-f]{64}$/u.test(runtimeId)) throw new Error('Invalid runtime cache identity');
  const directory = join(cacheRoot, runtimeId);
  const payload = join(directory, 'linux-x64');
  try {
    await verify(payload, runtimeId);
    return { payload, reused: true };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  mkdirSync(cacheRoot, { recursive: true });
  const staging = join(cacheRoot, `.building-${randomUUID()}`);
  try {
    mkdirSync(staging);
    const stagedPayload = join(staging, 'linux-x64');
    await build(stagedPayload, runtimeId);
    await verify(stagedPayload, runtimeId);
    try {
      renameSync(staging, directory);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await verify(payload, runtimeId);
    }
    return { payload, reused: false };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
