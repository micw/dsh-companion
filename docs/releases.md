# Automated builds and GitHub Releases

The `Build and release` workflow builds the Linux x64 product on `master` pushes, supported version-tag pushes, and manual runs on those exact refs. One product revision contains Companion and all optional providers. CI never needs model, wrapper, or search credentials.

## Channels

| Ref | Version | GitHub publication |
|---|---|---|
| `master` | `<nearest-major>.<nearest-minor>.<UTC build timestamp>` | Rolling `master-build` prerelease |
| `v<major>.<minor>.0` | Exact tag version | Durable stable release |

A master build always uses a timestamp version, even when its commit also carries a release tag. The workflow chooses one timestamp before building and passes it unchanged to version resolution and packaging. Unsupported tags such as `v0.2.1` or `v0.2.0-rc.1` fail channel validation; the current product version scheme reserves the patch component for development timestamps. The moving `master-build` tag is not a version tag and does not affect version resolution.

Local packaging keeps automatic version selection unless explicitly configured:

```bash
DSH_COMPANION_BUILD_CHANNEL=master \
DSH_COMPANION_BUILD_ID=20261010120000 \
DSH_COMPANION_DSH_SOURCE=../deepseek-harness pnpm run vscode:package
```

For release builds, set `DSH_COMPANION_BUILD_CHANNEL=release` and `DSH_COMPANION_RELEASE_TAG=v0.2.0`; that exact supported tag must point at HEAD. Checked-in package versions remain `0.0.0` and tracked working trees must be clean.

## Publication

The build job has `contents: read`, checks out the exact commit with credentials disabled, builds/tests/packages, and uploads a short-lived Actions artifact. Only the separate publishing job has `contents: write`. It verifies downloaded asset inventory, hashes, commit, channel and tag/version identity before making changes through GitHub's API.

Assets are a versioned `dsh-companion-<version>-linux-x64.vsix`, `SHA256SUMS` and `build-info.json`. Build information records product commit, target, Runtime fingerprint, pinned DSH revision, patch digest and Actions run URL.

The rolling release retains one public Release object. New assets are uploaded there under run-owned staging names while old assets remain available; a marked unpublished draft records asset IDs/names and old/new release metadata as a recovery journal. After all uploads and a fresh master check, assets/body are switched and the final `master-build` ref update to the current built commit is the commit point. Old assets are removed only after that point. A lost API response or interrupted runner is resolved from the live tag: the next serialized publication restores old names/body before commit or finishes new metadata/cleanup after commit. It never creates or moves refs to old commits, which avoids GITHUB_TOKEN's workflow-permission restriction. Same-commit master reruns leave the existing successful publication unchanged. Ambiguous legacy recovery states fail closed for manual inspection. GitHub does not provide an atomic multi-object release transaction.

New pushes cancel obsolete master **build jobs**, not a publishing job already performing a swap. Publishing is serialized without cancellation. Builds whose commit is no longer current master are skipped before publication. The master prerelease is never marked Latest. Stable tag releases remain available and existing releases are never overwritten by reruns; if one already exists, publication fails closed. Stable releases are marked Latest.

The repository must allow Actions to create Releases and update the reserved `master-build` and `build-*` tags. Tag protection or immutable-release settings must not prevent the rolling prerelease swap. No personal access token is required: publication uses the job-scoped `GITHUB_TOKEN`. No action pushes the product master branch or a release version tag. Token-created staging tags do not recursively trigger Actions workflows.

## Caching

1. **pnpm store:** package downloads are shared using platform, pnpm, root lockfile and DSH pin keys. A broad store fallback is safe because frozen installation still resolves the exact committed lockfiles. Installed `node_modules` is never cached.
2. **DSH build outputs:** CI clones the exact upstream tag/commit, verifies the tree and ordered patch series, and installs dependencies before restoring generated output. The exact key includes upstream identity, patch digest, Node/pnpm, runner image/compiler identity and preparation/cache-helper bytes. No partial-key restore is used. On a miss, a baseline taken after preparation/install distinguishes patch-added source/provenance from build outputs. Only reviewed output families are copied with path/mode/SHA-256 metadata; modified source, unsafe paths, symlinks and corrupt bytes fail closed. Restoration never overwrites prepared files.
3. **Managed Runtime:** the existing content fingerprint selects precisely one cached payload. Packaging verifies its manifest, identity and artifact bytes, and always runs the managed-runtime smoke before reuse. Misses build a new pinned Runtime and save it only after successful packaging. CI passes the selected identity into packaging as `DSH_COMPANION_EXPECTED_RUNTIME_ID`; packaging fails immediately if rebuilding changes those inputs, and a required manifest check confirms that the exact cache-save directory exists before Actions saves it.

The provider-catalog TypeScript build deliberately re-emits its inputs before bundling (`tsc -b --force`). Its bundle shares the emitted entry path; an incremental compiler skip would otherwise feed the previous bundle back into the bundler and change cold/warm output bytes. `pnpm run test:runtime-inputs` validates identical first and second build outputs in an isolated fixture.

Cache entries are expendable and subject to GitHub quota/eviction. Cache misses affect build time, not product selection. The VSIX is generated on every run; transient staging directories, credentials, Session data and private profiles are not cached. The toolchain and referenced Actions are pinned; review updates deliberately.

## Releasing

After reviewing and testing master, create a supported tag and push it:

```bash
git tag -a v0.2.0 -m 'DSH Companion 0.2.0'
git push gh master
git push gh v0.2.0
```

The master push produces the rolling development build; the tag push produces the stable release. Once the workflow is present on GitHub, `workflow_dispatch` can retry a build on master or a supported tag. A published stable tag/release should not be moved or replaced. Artifact retention is seven days; published GitHub release assets are independent of that retention.

The workflow configuration and mocked publication tests can be validated locally, but actual GitHub permissions, cache availability and hosted-runner behavior are only established by a successful Actions run after pushing the workflow.
