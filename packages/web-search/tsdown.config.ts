import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

export default defineConfig({
  entry: ['lib/index.js', 'lib/protocol.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2023',
  fixedExtension: false, dts: false, clean: false,
  plugins: [typertPlugin({ mode: 'package', faces: ['host'] })],
})
