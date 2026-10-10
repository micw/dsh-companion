# Empty Enhanced SEA Assets Patch Assessment

## Requirement

The compressed `@yao-pkg/pkg` enhanced-SEA VFS passes each asset's declared plaintext size as `maxOutputLength` to Node's Zstd decoder. Node 24 rejects zero, so reading an empty packaged file fails with `ERR_OUT_OF_RANGE`. The DSH Companion runtime rebuilt for the title-tool update exposed this while resuming every Session; the Session logs themselves decoded successfully outside the executable.

## Scope

The patch updates DSH's pinned `@yao-pkg/pkg@6.21.0` dependency patch and lockfile. It gives Node a one-byte minimum decode cap for an empty asset and checks the decoded length against the manifest before caching it. The same change is present in the main and Worker SEA bootstrap copies and their source. It does not change Session data, asset contents, provider requests, or tool behavior.

## Alternatives

Dropping empty assets would change the packaged file tree, and disabling compression would return the runtime to the injector-size failure that required the existing Zstd patch. A one-byte minimum with exact decoded-length validation preserves both the asset and the decompression limit.

## Security assessment

The VFS still validates a finite nonnegative manifest size and bounds decompression. For an empty file the decoder may produce at most one byte, but any nonzero decoded length is rejected before the asset is exposed or cached. Nonempty assets must also match their declared size. Corrupt or inconsistent archives fail closed.

## Compatibility and maintenance

The patch is tied to DSH `dsh-v0.1.7-rc.2` and the exact `@yao-pkg/pkg@6.21.0` dependency patch. A real compressed Node 24 SEA fixture reading both empty and nonempty assets passes. Companion's managed-runtime and Session-resume smokes must run on every runtime upgrade. Retire this patch when the pinned pkg release handles zero-length assets with an equivalent bound and length check.

## Upstream discussion

Before a public Companion release, report the reproducible zero-length-asset failure to the pkg maintainer and record a DSH upgrade/patch-removal discussion or PR in `runtime/dsh/upstream.json`. Internal builds retain `null` while that link remains open.
