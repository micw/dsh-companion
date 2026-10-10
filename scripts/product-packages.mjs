import { join } from 'node:path';

/** Optional provider bundles shipped from the same product commit, in profile load order. */
export const PRODUCT_PROVIDERS = Object.freeze([
  { name: '@dsh-companion/provider-openrouter', directory: 'openrouter' },
  { name: '@dsh-companion/provider-claude-wrapper-advanced', directory: 'claude-wrapper-advanced' },
  { name: '@dsh-companion/provider-codex-wrapper-advanced', directory: 'codex-wrapper-advanced' },
].map(provider => Object.freeze(provider)));

/** Resolves only in-repository provider packages; releases never depend on sibling provider checkouts. */
export function productProviderRoots(root) {
  return PRODUCT_PROVIDERS.map(provider => join(root, 'packages', 'providers', provider.directory));
}
