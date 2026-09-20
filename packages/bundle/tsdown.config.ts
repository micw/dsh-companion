import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['lib/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2023',
  fixedExtension: false,
  dts: false,
  clean: false,
})
