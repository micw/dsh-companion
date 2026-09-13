# DSH Companion for VS Code

DSH Companion is an independent VS Code integration built on DeepSeek Harness. It is not affiliated with or endorsed by DeepSeek.

The project is an early proof of concept. It already provides a restorable native chat editor over DSH sessions. Runtime management, protocol packaging, approvals, queue controls, and Session Changes remain under development. See [features.md](features.md) for the current product surface and known limits.

## Development

Requirements: Node.js 22 or newer and pnpm 11.7.

```bash
pnpm install
pnpm test
```

The extension entrypoint is `vscode/`. Its current development transport connects to a compatible `dsh web` instance at `http://127.0.0.1:3081`; launch it in a VS Code Extension Development Host and run **DSH: New Chat Editor**. Runtime installation and process supervision are not yet part of the distributable extension.

## Packaging and versioning

Checked-in manifests keep the neutral version `0.0.0`. Packaging derives the product version from Git without modifying them:

- `v<major>.<minor>.0` produces that stable version.
- An untagged descendant produces `<major>.<minor>.<UTC timestamp>`.
- `DSH_COMPANION_DEV_BUILD=<positive integer>` overrides the timestamp for reproducible development packages.

A reachable release tag is required. Build the VSIX with:

```bash
pnpm run vscode:package
```

The command requires a clean tracked working tree and writes `dist/dsh-companion-<version>.vsix`.
