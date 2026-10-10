#!/usr/bin/env node

import { build } from '../vscode/node_modules/esbuild/lib/main.js';

await build({
  stdin: {
    contents: "import mermaid from 'mermaid'; globalThis.dshCompanionMermaid = mermaid;",
    resolveDir: new URL('../vscode', import.meta.url).pathname,
  },
  outfile: new URL('../vscode/media/mermaid-bundle.js', import.meta.url).pathname,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  logLevel: 'info',
});
