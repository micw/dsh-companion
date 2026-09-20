#!/usr/bin/env node

import { loadUpstreamManifest, patchSetSha256, verifyPatchFiles } from './manifest.mjs';

const manifest = await loadUpstreamManifest();
await verifyPatchFiles(manifest);
console.log(JSON.stringify({
  dshVersion: manifest.upstream.version,
  upstreamCommit: manifest.upstream.commit,
  patches: manifest.patches.length,
  patchSetSha256: patchSetSha256(manifest),
}));
