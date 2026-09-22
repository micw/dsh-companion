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

The unpaginated default `/models` response is the catalog authority. Companion persists the validated provider payload as a last-known-good generation scoped to the instance route and projects model names, descriptions, input modalities, context capacity, reasoning efforts, and reported USD catalog rates. Rates remain catalog metadata; this package does not turn them into incurred Turn cost.

`GET /key` provides non-secret key label, free/paid tier, optional per-key credit limit and remaining amount, and the current free-model daily request counter. Account state is scoped to the instance route. Deprecated rate-limit data is ignored. The package does not call the management-key-only `/credits` endpoint.

An enabled instance publishes its route only after its credential and catalog generation validate. A failed refresh withdraws that route while leaving other OpenRouter instances unaffected.

## Data plane

The package delegates request conversion, streaming, tools, reasoning, usage, cancellation, retry semantics, and replay to DSH's public `PiAiAdapter`. It constructs a route-specific `ResolvedPiAiProviderProfile`, supplies inert pi-ai auth objects for request-key-only authentication, and wraps pi-ai's OpenRouter provider to substitute the immutable dynamic catalog generation.

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
- Companion's provider-scoped policy default keeps newly discovered OpenRouter models disabled until the user enables exact models or the current catalog in bulk.
- Image-capable models resolve DSH's durable attachment store at request time; normalized execution-world paths are not yet added to image descriptors.
- A complete real-API lane and Loader-based REAL-composition test remain to be added before packaging.
- OpenRouter's management-key-only total-credit endpoint is intentionally not queried with ordinary inference keys.
