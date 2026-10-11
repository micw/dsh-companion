#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.0(?![\s\S])/;

/**
 * Resolves an exact release tag or a timestamped development version based on the nearest release.
 *
 * @param {string[]} exactTags Tags pointing at the commit being packaged.
 * @param {string} nearestTag Nearest reachable release tag, or an empty string before the first release.
 * @param {string} buildId Positive numeric development-build identifier.
 * @param {{channel?: 'auto'|'master'|'release', releaseTag?: string}} [options]
 * @returns {string} VS Code Marketplace-compatible version.
 */
export function resolveVersion(exactTags, nearestTag, buildId, options = {}) {
  if (options === null || typeof options !== 'object'
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Reflect.ownKeys(options).some((key) => !['channel', 'releaseTag'].includes(key))) {
    throw new Error('invalid version resolution options');
  }
  const { channel = 'auto', releaseTag } = options;
  if (!['auto', 'master', 'release'].includes(channel)) {
    throw new Error(`invalid build channel ${JSON.stringify(channel)}`);
  }
  if (typeof buildId !== 'string' || !/^[1-9]\d*(?![\s\S])/.test(buildId)) {
    throw new Error(`invalid development build id ${JSON.stringify(buildId)}`);
  }
  if (releaseTag !== undefined && (typeof releaseTag !== 'string' || !RELEASE_TAG.test(releaseTag))) {
    throw new Error(`invalid release tag ${JSON.stringify(releaseTag)}`);
  }
  if (releaseTag !== undefined && channel !== 'release') {
    throw new Error('releaseTag requires the release build channel');
  }
  if (channel === 'release') {
    if (releaseTag === undefined) throw new Error('release build channel requires an explicit releaseTag');
    if (!exactTags.includes(releaseTag)) {
      throw new Error(`release tag ${JSON.stringify(releaseTag)} does not point at HEAD`);
    }
    return releaseTag.slice(1);
  }
  const releases = exactTags.filter((tag) => RELEASE_TAG.test(tag));
  if (channel === 'auto') {
    if (releases.length > 1) throw new Error('HEAD has more than one release tag');
    if (releases.length === 1) return releases[0].slice(1);
  }
  if (nearestTag === '') return `0.0.${buildId}`;
  const nearest = RELEASE_TAG.exec(nearestTag);
  if (!nearest) {
    throw new Error(`no valid release tag found (got ${JSON.stringify(nearestTag)})`);
  }
  return `${nearest[1]}.${nearest[2]}.${buildId}`;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function utcBuildId() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function main() {
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new Error('refusing to package a dirty working tree');
  }

  const exactTags = git('tag', '--points-at', 'HEAD').split('\n').filter(Boolean);
  const releaseTags = git('tag', '--list', 'v*').split('\n').filter((tag) => RELEASE_TAG.test(tag));
  let nearestTag = '';
  if (releaseTags.length > 0) {
    try {
      // Filter before describing: a closer unsupported tag must not hide a valid release.
      nearestTag = git('describe', '--tags', ...releaseTags.flatMap((tag) => ['--match', tag]), '--abbrev=0');
    } catch (error) {
      // Valid tags can exist only on unreachable branches, leaving the implicit 0.0 base.
      if (error.status !== 128) throw error;
    }
  }
  console.log(resolveVersion(exactTags, nearestTag,
    process.env.DSH_COMPANION_BUILD_ID ?? utcBuildId(), {
      channel: process.env.DSH_COMPANION_BUILD_CHANNEL ?? 'auto',
      releaseTag: process.env.DSH_COMPANION_RELEASE_TAG,
    }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
