# @dsh-companion/model-policy

Settings-backed provider/model enablement policy for DSH Companion. The policy stores only user intent: one shared default for newly discovered models, optional provider-specific defaults and switches, and exact model overrides keyed by stable provider and model ids. An exact override wins over defaults, while a disabled provider denies every model. Removed ids remain in the user document and automatically apply if they return.

Provider adapters enforce this policy while listing, resolving, preparing, and directly dispatching model calls. DSH Settings remains the durable authority; discovered catalogs are never copied into the policy namespace.

## Model Experience

The policy adds no model input. A denied route fails before provider I/O.

### Token effect

None.

### KV Cache effect

None for allowed calls. Disabling a model prevents a request rather than changing its prefix.

## Known Limitations and Deferred Work

The initial enforcement is adapter-owned. Applying one policy to built-in and manual DSH adapters requires a central DSH LLM policy registration point that filters catalog listings and denies exact-route preparation.
