# DSH Companion for VS Code

DSH Companion is an independent VS Code integration built on DeepSeek Harness. It is not affiliated with or endorsed by DeepSeek.

The project is an early proof of concept. It provides a restorable native chat editor, a DSH-backed Session sidebar, and an internal Linux Managed Runtime build. Approvals, queue controls, advanced Session management, and Session Changes remain under development. See [features.md](features.md) for the current product surface and known limits.

## Development

Requirements: Node.js 22 or newer, pnpm 11.7, and the pinned DSH development checkout at `../deepseek-harness`. This monorepo contains the extension, shared Companion plugins, and optional OpenRouter, Claude Wrapper Advanced, and Codex Wrapper Advanced provider packages under `packages/providers/`. DSH and the independently operated wrapper services remain external.

```bash
pnpm install
pnpm test
```

The extension entrypoint is `vscode/`. The parent development workspace ensures that the required independently supervised source Runtime is available at `http://127.0.0.1:3081` across Extension Host restarts. Launch the extension in a VS Code Extension Development Host and run **DSH: New Chat Editor**. **DSH: Open Web UI** opens the connected source or packaged Runtime in the default browser through a fresh authenticated launch URL.

## Packaging and versioning

Checked-in manifests keep the neutral version `0.0.0`. Packaging derives the product version from Git without modifying them:

- `v<major>.<minor>.0` produces that stable version.
- An untagged descendant produces `<major>.<minor>.<UTC timestamp>`.
- Before the first release tag, an untagged build produces `0.0.<UTC timestamp>`.

GitHub Actions publishes timestamped master builds to one rolling `master-build` prerelease and supported version tags to durable releases. Master builds use a timestamp even on a tagged commit. See [automated builds and releases](docs/releases.md) for channels, caching, permissions, and release commands.

Build the VSIX with:

```bash
DSH_COMPANION_DSH_SOURCE=../deepseek-harness pnpm run vscode:package
```

The command requires a clean tracked working tree and an exact checkout containing the pinned DSH commit. It builds all Companion and provider packages from the same repository revision in dependency order; one product release tag identifies their complete source state. It reuses a verified content-addressed Linux runtime when its inputs are unchanged; otherwise it applies the reviewed patch series in a disposable clone and builds a new one. Every package health-checks its runtime and writes `dist/dsh-companion-<version>.vsix`. See [the runtime reference](runtime/README.md) and [DSH upgrade checklist](docs/dsh-upgrade-checklist.md).
