# Compressed Enhanced SEA Assets Patch Assessment

## Requirement

DSH Companion adds its bundle and external provider packages to DSH's complete enhanced-SEA runtime closure. The resulting uncompressed Node 24 preparation blob exceeds the practical large-resource range of `postject@1.0.0-alpha.6`, whose WebAssembly/LIEF injection aborts without a diagnostic before an executable is produced.

## Scope

The patch makes DSH's existing `@yao-pkg/pkg --sea` builder use its supported Zstd asset compression and updates the executable-builder test and owning bilingual Agent Note. It does not change the selected Node target, runtime package closure, files visible through pkg's VFS, application bootstrap, Session data, model behavior, or Companion transport.

## Alternatives

- Keeping the uncompressed archive reproduces the injector abort once the closed runtime grows beyond its practical limit.
- Companion could own a second executable builder or distribute an external Node runtime directory, but either choice would diverge from DSH's canonical packaged runtime.
- Node's native `--build-sea` is preferred after DSH adopts and qualifies it with equivalent VFS, native-addon, resource, and multi-target behavior; Companion does not independently advance that runtime contract.

## Security assessment

Compression does not add inputs or expand the package closure. The builder still selects assets from DSH's verified deployment, and Companion still records and verifies every final payload file digest before installation. Decompression is performed by the exact-pinned pkg bootstrap already trusted to expose the VFS. Build failure remains fail-closed.

## Compatibility and maintenance

Node 22.15 and newer provide the Zstd support required by the exact-pinned pkg version; DSH requires Node 22.19 or newer. Every DSH upgrade runs the executable-builder tests and a packaged-runtime smoke that exercises module loading, native addons, Web resources, Office resources, and provider bundles. Remove this patch when DSH enables compression upstream or migrates its supported executable builder to native Node SEA without the external injector limit.

## Upstream discussion

Before a public Companion release, report the reproducible Postject large-resource abort and propose enabling supported enhanced-SEA compression in DSH's executable builder. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`. Internal builds retain `null` to show that this action remains open.
