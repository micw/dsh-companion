# @dsh-companion/provider-client

DSH Web Client infrastructure assembly for Companion provider state. Its Host entry carries only the `dsh.client` package declaration; the browser half mounts the generated provider-catalog, provider-account, and session-title Remote contributions into the canonical DSH Client Remote service.

The browser bundle is loaded dynamically from the enabled DSH Loader entry. It contains the generated descriptors and validation codecs but no provider protocol, credentials, catalog cache, or account state.

## Model Experience

None. This package exposes Host-owned presentation data to browser plugins and adds no model input.

### Token effect

None.

### KV Cache effect

None.

## Known Limitations and Deferred Work

The package mounts provider Remotes but renders no controls; `@dsh-companion/ui-provider-settings` consumes the mounted namespaces. No runtime invariant companion is published because Remote contribution ownership and duplicate rejection remain in the canonical DSH Client Remote service.
