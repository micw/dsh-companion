# @dsh-companion/provider-catalog

Generic dynamic-provider catalog lifecycle for DSH Companion. Provider plugins register a source that loads and validates one complete provider-owned payload and projects it into provider-neutral model metadata. The service publishes immutable generations, persists only validated last-known-good payloads, keeps a prior generation active after refresh failure, and never materializes discovered models into DSH Settings.

The package contains no provider protocol, credentials, model adapter, or presentation code. The first consumer is `@dsh-companion/provider-codex-wrapper-advanced`.

## Model Experience

The service adds no model input. A provider adapter may derive its advertised and exact-route model metadata from the same immutable payload generation.

### Token effect

None.

### KV Cache effect

None directly. A provider adapter decides whether a newly published catalog generation changes request metadata or routing.

## Known Limitations and Deferred Work

The package exposes strict, cancellable `list` and `refresh` Remotes. `@dsh-companion/provider-client` mounts their generated Client contributions into DSH's canonical Web Client, and `@dsh-companion/ui-provider-settings` consumes them on the Models page. Reconnect-safe live catalog push is not available yet; clients explicitly refresh or read the latest Host snapshot.
