# @dsh-companion/provider-account

Generic live account and allowance registry for DSH Companion providers. Provider integrations own protocol-specific polling and merge semantics, then publish provider-neutral snapshots here. The registry coordinates refresh cancellation, source replacement, listener isolation, and last-known in-process state.

Account state is separate from model catalogs and DSH Settings. It describes current provider observations, not durable user intent and not per-call monetary accounting.

## Model Experience

None. Account and allowance snapshots are presentation data and never enter model requests or Session events.

### Token effect

None.

### KV Cache effect

None.

## Known Limitations and Deferred Work

Snapshots are process-local and are refreshed after each Host start. The package exposes strict, cancellable `list` and `refresh` Remotes; `@dsh-companion/provider-client` mounts their generated Client contributions into DSH's canonical Web Client, and `@dsh-companion/ui-provider-settings` consumes them on the Models page. Reconnect-safe live account push is not available yet.
