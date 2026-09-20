#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/;

/**
 * Resolves an exact release tag or a timestamped development version based on the nearest release.
 *
 * @param {string[]} exactTags Tags pointing at the commit being packaged.
 * @param {string} nearestTag Nearest reachable release tag, or an empty string before the first release.
 * @param {string} buildId Positive numeric development-build identifier.
 * @returns {string} VS Code Marketplace-compatible version.
 */
export function resolveVersion(exactTags, nearestTag, buildId) {
  const releases = exactTags.filter((tag) => RELEASE_TAG.test(tag));
  if (releases.length > 1) {
    throw new Error('HEAD has more than one release tag');
  }
  if (releases.length === 1) {
    return releases[0].slice(1);
  }

  if (!/^[1-9]\d*$/.test(buildId)) {
    throw new Error(`invalid development build id ${JSON.stringify(buildId)}`);
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
  let nearestTag;
  try {
    nearestTag = git('describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0');
  } catch {
    nearestTag = '';
  }
  console.log(resolveVersion(exactTags, nearestTag, utcBuildId()));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
