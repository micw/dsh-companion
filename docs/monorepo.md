# Product monorepo

DSH Companion, its VS Code extension, shared Runtime plugins and optional model-provider plugins are developed and released from one repository revision. The providers remain separately loadable packages; sharing Git history does not make them mandatory dependencies of the Companion bundle.

## Boundaries

- `vscode/` contains the native extension and Webview presentation.
- `packages/*` contains shared Companion infrastructure and capabilities.
- `packages/providers/{openrouter,claude-wrapper-advanced,codex-wrapper-advanced}` contains optional model-provider plugins.
- `runtime/dsh/` records the exact external DSH upstream pin and reviewed patch series. DSH source remains outside this repository.
- Claude and Codex wrapper services, deployment, authentication and secrets remain external.

The root pnpm workspace and lockfile cover all product packages. Internal Companion dependencies use `workspace:*`; local development DSH dependencies point to `../deepseek-harness` from the product root. Build execution follows the workspace dependency graph so shared package outputs exist before provider compilation. `pnpm test` includes shared, extension and provider suites. A provider can still be tested independently with a filtered workspace test command after building its dependencies.

## Packaging and releases

A product Git tag identifies extension, Companion plugin and provider source together. Checked-in versions stay `0.0.0`; packaging derives the extension version only in a staging copy. Independent provider release tags or externally selected provider checkouts are not needed for the bundled product.

`DSH_COMPANION_DSH_SOURCE` selects an external checkout containing the exact committed upstream revision. Packaging never accepts provider-directory overrides: its ordered provider inventory is recorded in `scripts/product-packages.mjs`. The Runtime builder flattens provider packages into DSH's prepared workspace, preserves their optional plugin entrypoints, and records the same ordered profile bundles as before. Provider source, compiled output and product workspace inputs participate in the content fingerprint.

The product monorepo does not change DSH ownership of Sessions, settings, approvals, queues or credentials. Migrating a development profile from old provider locations requires an explicit profile synchronization; it must not restart an existing Runtime merely because the Git layout changed. Release packaging uses an isolated DSH home and does not update a running development profile.

## Imported history

Provider histories were rewritten only to prefix their existing paths, then joined to the Companion history with separate import merges. Existing authors and timestamps were retained. The migration starts from the consolidated Companion revision `a10e08e` and these provider tips:

| Provider | Original consolidated tip | Path-prefixed imported tip |
|---|---|---|
| OpenRouter | `827a85b` | `c40f681` |
| Claude Wrapper Advanced | `93bf986` | `194bf80` |
| Codex Wrapper Advanced | `adf4ef5` | `a2361b7` |

Before workspace adjustments, each imported provider tree matched the corresponding original provider tree exactly. The subsequent migration changes package locations, dependency links, build/test discovery and Runtime staging, not provider wire behavior. Existing product release tags are retained; imported historical provider tags are not used to derive the unified product version.
