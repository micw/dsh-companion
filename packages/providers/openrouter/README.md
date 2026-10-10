# @dsh-companion/provider-openrouter

Dedicated multi-instance OpenRouter provider family for DSH Companion. The package registers one installed `openrouter` family and manages zero to many configured DSH routes. Each instance owns its stable route, write-only credential reference, dynamic catalog generation, account state, retry policy, and adapter lifecycle.

A fresh configuration contains no instances and publishes no route. DSH mints opaque instance identities, serializes family mutations, and invokes this package's Save & Test transaction. Editable display names never participate in instance or route identity.

## Configuration

Provider instances live under one family-owned settings map:

```yaml
dsh-companion-openrouter:
  instances:
    5fc97ca8-6768-47ca-b79d-d9ed709ef802:
      displayName: OpenRouter Work
      enabled: true
      provider: openrouter-5fc97ca8-6768-47ca-b79d-d9ed709ef802
      apiKeyEnv: DSH_COMPANION_OPENROUTER_5fc97ca8_6768_47ca_b79d_d9ed709ef802_...
      baseURL: https://openrouter.ai/api/v1
```

Users create and edit instances through DSH's provider-instance operations rather than writing route or credential identities. Save & Test validates the endpoint and key against `/models` and `/key` before publishing settings. Credential replacement stages a new uniquely addressed credential, switches settings only after validation, and removes the preceding package-owned credential after the switch. A failed settings write removes the staged credential and retains the previous instance.

Deleted instance IDs are retained as tombstones and cannot be rebound. Historical Session routes therefore become unavailable rather than resolving to a newly created account. Explicit manual migration may retain the legacy `openrouter` route for an imported instance.

`baseURL` defaults to `https://openrouter.ai/api/v1`. Stream-idle and image-request bounds are configurable and default to the same values used by DSH's pi-ai data plane. Retry policy uses DSH's provider-owned retry contract.

## Catalog and account state

The unpaginated default `/models` response is the catalog authority. Companion persists the validated provider payload as a last-known-good generation scoped to the instance route and projects model names, descriptions, input modalities, context capacity, reasoning efforts, and reported USD catalog rates. Invalid or empty optional reasoning metadata is omitted for that model instead of invalidating the provider catalog; no effort is offered without a validated level. OpenRouter's `-1` sentinel retains dynamically priced router models but produces no reported rate; the pi-ai compatibility value is zero and never becomes accounting. Router rows whose selected backend capacities are unknown use the route's overall context length as their operational context and output ceiling. Catalog rates remain metadata. Each terminal model response's validated `usage.cost` becomes call-scoped, provider-reported USD accounting; DSH aggregates all accounted calls in a complete normal Turn.

`GET /key` provides the non-secret key label, whether credits have ever been purchased, the optional per-key spending cap, and the current free-model daily request counter. Companion projects the spending cap as the primary allowance with exact USD-nano limit and remainder values, and the free-model request counter as secondary information, not as a subscription plan or account credit balance. Documented daily, weekly, monthly, and non-resetting spending caps produce exact UTC reset facts for the shared account UI. Account state is scoped to the instance route. Deprecated rate-limit data is ignored. Actual purchased and used account credits remain unavailable because the package does not call the management-key-only `/credits` endpoint with an inference key.

An enabled instance publishes its route only after its credential and catalog generation validate. A failed refresh withdraws that route while leaving other OpenRouter instances unaffected.

## Data plane

The package delegates request conversion, streaming, tools, reasoning, token usage, cancellation, retry semantics, and replay to DSH's public `PiAiAdapter`. It constructs a route-specific `ResolvedPiAiProviderProfile`, supplies inert pi-ai auth objects for request-key-only authentication, and wraps pi-ai's OpenRouter provider with model descriptors bound to the exact instance route and the immutable dynamic catalog generation. The wrapper observes the byte-identical SSE response while pi-ai consumes it, validates OpenRouter's terminal `usage.cost`, and associates that value with the same terminal SDK usage object for `PiAiAdapter`'s provider-owned accounting mapper.

`@deepseek-ai/dsh-llm-pi-ai` is a library dependency for this low-level adapter only; the generic pi-ai Cordis plugin is not loaded in the Companion runtime and contributes no routes, settings, or configurable-provider entries. A narrower provider-neutral transport factory remains preferable when DSH publishes one.

## Model Experience

The provider adds no prompt or tools. It sends DSH's existing messages, tool schemas, tool results, reasoning selection, and supported images through `PiAiAdapter`.

### Token effect

No fixed addition; request size follows DSH history and tool schemas.

### KV Cache effect

The pi-ai OpenRouter transport owns provider-native replay and request compatibility. Catalog refresh replaces metadata for later calls only; an admitted call retains its generation.

## Known Limitations and Deferred Work

- The catalog decoder targets the unpaginated default text-output Models API and requires a usable completion-token cap for every row.
- Catalog rates are reported metadata only. Actual OpenRouter generation cost is not yet emitted as `ModelCallAccounting`.
- Companion's provider-scoped policy default keeps newly discovered OpenRouter models disabled, including after an instance has exact model overrides, until the user enables exact models or the current catalog in bulk.
- Image-capable models resolve DSH's durable attachment store at request time; normalized execution-world paths are not yet added to image descriptors.
- A complete real-API lane and Loader-based REAL-composition test remain to be added before packaging.
- OpenRouter's management-key-only total-credit endpoint is intentionally not queried with ordinary inference keys.
