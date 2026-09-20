# SEA Client Module Proxy Patch Assessment

## Requirement

The packaged Companion Runtime boots DSH Web from a single executable. DSH's profile fallback creates filesystem package proxies for modules inside the executable, but those proxies retain only runtime export targets. The Web client-module scanner therefore sees no `dsh.client` declaration, emits an empty browser roster, and the UI fails before Cordis boot because `@deepseek-ai/dsh-client-modules/client.js` was not preloaded.

## Scope

The patch extends `@deepseek-ai/dsh-client-modules` package resolution only when an entry's filesystem manifest has no client declaration and names a `dsh.moduleFallback.targets["./client"]` URL. The scanner resolves the original package manifest through that trusted launcher-generated target, reads its `dsh.client` declaration, and serves the target bundle bytes directly. Ordinary packages keep the existing owning-tree resolution path. A package proxy fixture covers the browser module id and client artifact path.

## Alternatives

- Copying the complete DSH workspace or hundreds of browser package trees beside the executable would enlarge the managed installation and create a second dependency layout.
- Hand-building a Companion browser roster would duplicate DSH Web's module graph and plugin activation rules.
- Replacing DSH Web with a second Settings and Session UI would defer the existing product surfaces rather than repair the packaged runtime.
- Serving the static shell without dynamic client plugins leaves the page unusable and hides the failure until browser boot.

## Security assessment

Only launcher-generated module fallback metadata already trusted for executable module resolution activates the added path. The target must resolve through a `file:` URL to a nearest manifest with the same package name and a valid Web client declaration. Existing client manifest validation, module-graph ordering, immutable bundle snapshots, and Web authentication remain unchanged. No new network listener or unauthenticated route is added.

## Compatibility and maintenance

Source runs and ordinary installed packages do not carry module fallback metadata and retain existing behavior. Every DSH upgrade rechecks whether profile module proxies preserve browser metadata or the client scanner natively follows fallback targets; remove this patch when upstream supports Web profiles from the packaged executable.

## Upstream discussion

Before a public Companion release, report that a packaged `dsh --profile <web-profile>` emits an empty `__DSH_BOOT__` graph because profile module proxies omit the original `dsh.client` metadata. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`; internal builds retain `null` until then.
