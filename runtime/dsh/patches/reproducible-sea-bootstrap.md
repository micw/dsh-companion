# Reproducible SEA bootstrap and exact Node target

## Requirement

Independent builds with the same backend input identity must produce the same immutable payload. A random SEA main filename and floating target Node patch version violate that property and make frontend-only upgrades fail the installed-manifest comparison.

## Scope

Pinned to DSH 0.2.0-rc.2 commit `639ed015397290b3745d163aafe02ffee4aa3f84`. The patch changes the reviewed pnpm patch for `@yao-pkg/pkg@6.21.0` so enhanced SEA uses the relative bootstrap filename `sea-main.js` while its working directory remains its securely created temporary directory. It updates the corresponding lockfile hash. The DSH executable-builder parser admits exact three-component Node targets, with focused CLI tests; Companion selects one exact Node version. Browser CSS virtual IDs and Lightning CSS hash filenames use repository-relative paths while physical file reads, watching and ownership checks retain absolute resolution. The SEA closure excludes pnpm's `.modules.yaml` installation index, whose pruning timestamp is not a runtime input.

## Alternatives

A fixed global temporary directory would create concurrency and ownership hazards. Disabling manifest equality or using Extension versions as Runtime identities would discard integrity or reintroduce unnecessary backend restarts. Bytecode flags do not affect this source-based enhanced-SEA route. Package-level hooks do not expose its reconstructed main filename.

## Security assessment

Secure temporary-directory allocation, source/asset integrity, archive bounds, and authenticated Runtime ownership are unchanged. Only the embedded filename becomes relative; the existing pkg working-directory setup selects the same bootstrap file. Exact Node targeting removes an unrecorded floating toolchain input. No Session, credential, network authorization or Agent loop behavior changes.

## Compatibility and maintenance

Recheck the exact patched sea.js working-directory behavior and Node's relative-main handling at every pkg/DSH upgrade. Frozen installation must accept the new dependency patch digest. Two independent full Runtime builds must compare every declared artifact before release; a cache hit alone is not reproducibility evidence. Companion's builder/script inputs change the semantic Runtime ID once, avoiding collisions with previously published non-reproducible payloads.

## Upstream discussion

No upstream discussion has been opened yet. This is an internal reviewed build-tooling patch; publish an upstream issue/PR about canonical SEA main filenames and exact SDK target versions before a public upstream-patch qualification claim.
