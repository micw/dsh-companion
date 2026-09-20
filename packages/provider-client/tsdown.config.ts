import { companionClientBundle } from '../../scripts/client-bundle.ts'

export default [
  ...companionClientBundle('@dsh-companion/provider-client', ['index'], ['zod']),
  {
    name: '@dsh-companion/provider-client/runtime',
    entry: { runtime: 'lib/types/runtime.js' },
    outDir: 'lib',
    format: 'cjs' as const,
    platform: 'node' as const,
    target: 'es2022',
    dts: false,
    clean: false,
    deps: { alwaysBundle: () => true, onlyBundle: ['zod'] },
    outputOptions: { entryFileNames: 'runtime.cjs' },
  },
]
