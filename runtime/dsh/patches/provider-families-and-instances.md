# Provider Families and Instances Patch Assessment

## Requirement

DSH's configurable-provider directory combines an installed provider kind, one stored configuration, and one active route. DSH Companion needs an empty initial configuration, multiple independently named instances of one provider family, stable route identities across rename, server-enforced family limits, and one authoritative Save & Test operation without creating a second provider registry in the Extension.

## Scope

The patch adds branded provider-family and provider-instance identities to `@deepseek-ai/dsh-llm`. A provider plugin registers one installed family and its controller. Separate Remote projections list installed families, configured instances, and active routes. DSH serializes mutations per family, mints create identities, verifies update and delete existence, enforces `maxInstances`, validates controller projections, and exposes write-only credential actions without returning credential values.

The family controller owns authoritative settings, credential, connection-test, route, rollback, and identity-retirement behavior. The legacy configurable-provider directory remains temporarily for upstream providers not yet migrated. Generated Cordis API metadata and `dsh-tool-cordis` expose the new service operations.

## Alternatives

- Extending `LlmConfigurableProvider` with optional instance fields would retain ambiguous mode-dependent identity semantics.
- Mounting one Cordis plugin per user instance would make user settings rewrite application composition and duplicate package lifecycle.
- Coordinating settings and credential calls in each UI would permit partial writes and could not enforce limits across concurrent clients.
- Deriving routes from display names would break durable Session references on rename or recreation.

## Security assessment

The Remote draft accepts only validated lossless JSON configuration and one closed credential action. Credential replacement values travel only in the authenticated request and provider-owned operation; no response or projection has a field for secret material. Family limits and identity existence are enforced on the Host. Invalid duplicate IDs, routes, settings addresses, credential states, or diagnostics fail closed before entering a client projection.

## Compatibility and maintenance

Existing adapter registration, `listProviders()`, model calls, and the configurable-provider directory remain compatible. New providers opt into the family controller. The change adds no Session event or persisted DSH format; stable route strings continue to be the Session reference. Every DSH upgrade re-runs LLM topology, Typert generation, API catalog, Host build, and provider composition tests. Remove the patch when DSH publishes equivalent family and instance operations.

## Upstream discussion

Before a public Companion release, propose the provider-family and provider-instance service contract to DSH upstream. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`; internal builds retain `null` until then.
