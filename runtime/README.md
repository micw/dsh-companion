# DSH Companion Runtime

DSH Companion packages a Linux Managed Runtime from an exact official DSH source revision plus the reviewed patch series under `dsh/`. Published DSH modules and external `dsh-companion/*` plugins remain preferred; patches exist only where the pinned release cannot provide a required module boundary.

Release preparation happens on the build machine. A user installation receives built, integrity-recorded artifacts and never downloads DSH source, applies patches, invokes pnpm, or compiles the runtime.

## Source preparation

`dsh/upstream.json` records the upstream version, tag, commit, tree, ordered patches, patch hashes, assessments, affected modules, and upstream discussion status. `dsh/patches/series` is the application order. Preparation creates a disposable shared-object Git clone at the exact commit from a supplied DSH checkout, verifies every patch and assessment, applies each patch with `git apply`, and writes provenance into the prepared tree. Keeping Git metadata lets DSH's own build and package lifecycle run unchanged.

Run from the Companion repository:

```bash
node runtime/dsh/scripts/prepare.mjs \
  --source ../deepseek-harness \
  --output build/runtime/dsh-source
```

The output is disposable. Never edit it or use it as the source of a patch.

## Linux payload

The internal Linux build reuses DSH's supported single-executable runtime builder. It produces the normal `dsh` launcher with the Web profile and its required native sidecars, plus the patched Node Client Runtime artifact consumed by the Extension bundle. The final payload manifest binds these files to the derived Companion build version, Linux target, upstream DSH identity, and patch digests.

## Installation

The packaged Extension installs its payload under `ExtensionContext.globalStorageUri`:

```text
runtime/versions/<companion-version>-linux-x64/
runtime/staging/<transaction-id>/
runtime/active.json
runtime/rollback.json
```

The Linux product-data and lifecycle roots are independent of VS Code profiles and Extension versions:

```text
${XDG_DATA_HOME:-~/.local/share}/dsh-companion/dsh-home/
${XDG_DATA_HOME:-~/.local/share}/dsh-companion/runtime-owner/
```

Installed version directories are immutable. The release build health-checks the completed payload with an isolated DSH home. The private authenticated supervisor exposes a compact DSH backend build identity from the verified payload manifest: upstream version and commit plus the patch-set digest when modified. A version-1 supervisor config without this newer field remains valid and reports the identity as unavailable. Activation copies and verifies a new version in staging, stops the previous runtime owner, starts the new supervisor, waits for readiness, and only then publishes the active record. A failed activation restores and restarts the rollback version. Cleanup retains the active and rollback versions and removes only unreferenced runtime and staging directories; it never removes the separate product-data home.

F5 source development runs DSH directly from the configured checkout. It still participates in the same exclusive runtime ownership protocol before using the shared Companion DSH home.

## Upgrade policy

Complete [the DSH upgrade checklist](../docs/dsh-upgrade-checklist.md) for every upstream change. An internal build may retain a `null` upstream Discussion URL when its patch assessment documents the topic that remains to be raised. A public release requires the policy decision and upstream reference to be resolved outside this internal packaging work.
