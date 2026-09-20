# SEA-Compatible Preset Directory Scan Patch Assessment

## Requirement

The pinned DSH Linux single executable boots after its dependency closure is complete, but creating a Session fails while discovering packaged presets. The SEA virtual filesystem returns directory entries without callable `Dirent` methods, so `child.isDirectory()` throws before DSH can compose an Agent preset.

## Scope

The patch changes `scanRoot()` to request entry names and validates each candidate directory with the existing filesystem `stat` API. It preserves preset-id filtering, ordering, metadata, broken-composition reporting, trust, and all Session and Agent contracts. The change affects preset discovery only.

## Alternatives

- Shipping the development Node carrier would add a much larger mutable dependency tree and a separate Node runtime instead of using DSH's supported single-executable build.
- Disabling packaged presets would prevent normal Session creation.
- Treating every matching name as a directory would admit regular files and weaken existing discovery behavior.

## Security assessment

Each matching name is joined beneath the configured root and checked by `stat` before metadata or composition reads. The patch does not broaden accepted preset ids, trust, plugin resolution, executable inputs, network access, or credentials. A disappearing, inaccessible, or non-directory candidate remains excluded.

## Compatibility and maintenance

Normal Node filesystems and the SEA virtual filesystem both expose `readdir()` names and `stat()`. Focused preset discovery tests, the complete DSH build, single-executable packaging, isolated Web health check, and packaged Session-creation smoke cover the change. Remove the patch when DSH or its executable carrier provides callable `Dirent` methods consistently, or when upstream adopts name-plus-stat discovery.

## Upstream discussion

Before a public Companion release, report the `child.isDirectory is not a function` Session-creation failure from the `dsh-v0.1.5-rc.2` Linux SEA and propose filesystem-neutral preset discovery. Include the exact executable build route and a packaged Session-create reproduction, then record the resulting issue or PR URL in `runtime/dsh/upstream.json`. Internal builds retain `null` while that report remains open.
