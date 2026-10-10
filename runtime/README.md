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

The internal Linux build reuses DSH's supported single-executable runtime builder. It produces the normal `dsh` launcher with the Web profile and its required native sidecars, plus the patched Node Client Runtime artifact consumed by the Extension bundle. The build stages the separately maintained OpenRouter, Claude Wrapper Advanced, and Codex Wrapper Advanced provider packages into the executable closure and records their ordered profile bundles in the payload manifest; wrapper services and all credentials remain external. The version-2 manifest binds the payload to a SHA-256 runtime-input identity, Linux target, upstream DSH identity, patch digests, and every artifact digest, independently of the Extension's product version.

Packaging computes the runtime-input identity before preparing DSH. It hashes the pinned upstream commit/tree, checked patch files and runtime build scripts, staged Companion and external provider package files, the supervisor, lockfile, package manifests, Node and pnpm versions, and the Linux target. The Extension's DSH Client adapter and UI media are not runtime build inputs; changing their presentation logic leaves the runtime identity unchanged. Fetched dependencies, Git metadata, and private development files are excluded. A matching payload under `build/runtime-cache/<runtime-id>/linux-x64` is fully verified before reuse; a miss builds in a disposable staging directory and publishes only a verified result. A corrupted cache fails closed. The managed-runtime smoke runs for every VSIX, including cache hits.

## Installation

The packaged Extension installs its payload under `ExtensionContext.globalStorageUri`:

```text
runtime/versions/runtime-<runtime-id>-linux-x64/
runtime/staging/<transaction-id>/
runtime/active.json
runtime/rollback.json
```

The Linux product-data and lifecycle roots are independent of VS Code profiles and Extension versions:

```text
${XDG_DATA_HOME:-~/.local/share}/dsh-companion/dsh-home/
${XDG_DATA_HOME:-~/.local/share}/dsh-companion/runtime-owner/
```

Installed runtime directories are immutable. The release build health-checks the completed payload with an isolated DSH home. The private authenticated supervisor exposes a compact DSH backend build identity from the verified payload manifest: upstream version and commit plus the patch-set digest when modified. A version-1 supervisor config without this newer field remains valid and reports the identity as unavailable. Packaged activation validates the packaged manifest and compares it with the installed manifest. It hashes artifact bytes only when installing a new runtime, checking both the packaged payload and staged copy before publication; a matching installed version is reused without an artifact scan. Local changes to installed artifact bytes are not detected at startup; reinstall the Extension to replace that runtime. An active matching supervisor is reused across Extension-version changes; a changed runtime stops the old owner, starts the new supervisor, waits for readiness, and only then publishes the active record. A version-1 payload remains readable for rollback and the first version-2 installation performs one migration restart. An Extension Development Host instead reuses its task-owned source runtime. A failed packaged activation restores and restarts the rollback version. Cleanup retains the active and rollback runtimes and removes only unreferenced runtime and staging directories; it never removes the separate product-data home.

The supervisor serializes rendezvous publications. Shutdown immediately rejects new publications, waits for initialization and in-flight writes to settle, then removes only its owned state and temporary file. A failed ready-state publication stops the child rather than advertising an undiscoverable Runtime.

F5 source development runs DSH directly from the configured checkout. It still participates in the same exclusive runtime ownership protocol before using the shared Companion DSH home.

## Upgrade policy

Complete [the DSH upgrade checklist](../docs/dsh-upgrade-checklist.md) for every upstream change. An internal build may retain a `null` upstream Discussion URL when its patch assessment documents the topic that remains to be raised. A public release requires the policy decision and upstream reference to be resolved outside this internal packaging work.
