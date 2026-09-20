/** Minimal out-of-tree DSH Web Client bundle preset for Companion infrastructure plugins. */

import type { UserConfig } from 'tsdown'

/**
 * Build one Node Loader entry and one lazy-CJS browser factory. The generated
 * Remote contributions and their Zod codecs inline; Cordis remains the shared
 * platform module supplied by the DSH Web shell.
 */
export function companionClientBundle(
  id: string,
  nodeEntries: readonly string[] = ['index'],
  bundledDependencies: readonly string[] = [],
): UserConfig[] {
  const shared = new Set(['@deepseek-ai/cordis', 'react', 'react/jsx-runtime'])
  return [
    ...nodeEntries.map((entry): UserConfig => ({
      name: id,
      entry: { [entry]: `lib/types/${entry}.js` },
      outDir: 'lib',
      format: ['esm'],
      platform: 'node',
      target: 'es2023',
      fixedExtension: false,
      dts: false,
      clean: false,
      deps: { neverBundle: () => true },
    })),
    {
      name: `${id}/client`,
      entry: { client: 'lib/types/client/index.js' },
      outDir: 'lib',
      format: 'cjs',
      platform: 'browser',
      target: 'es2023',
      dts: false,
      sourcemap: true,
      clean: false,
      deps: {
        neverBundle: specifier => shared.has(specifier),
        alwaysBundle: specifier => !shared.has(specifier),
        ...(bundledDependencies.length > 0 ? { onlyBundle: [...bundledDependencies] } : {}),
      },
      define: {
        'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
        'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
        'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
      },
      outputOptions: {
        entryFileNames: 'client.js',
        sourcemapExcludeSources: false,
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  ]
}
