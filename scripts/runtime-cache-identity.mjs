/** Binds CI restore/save identity to the payload actually packaged, never an independently drifting key. */
export function assertRuntimeCacheIdentity(actual, expected) {
  if (!/^[a-f0-9]{64}$/.test(actual ?? '')) throw new Error('Invalid calculated runtime identity');
  if (expected !== undefined && (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual)) {
    throw new Error(`Runtime inputs changed after cache lookup: expected ${expected}, calculated ${actual}`);
  }
  return actual;
}
