# @dsh-companion/provider-openrouter

Dedicated OpenRouter provider for DSH Companion. It registers the `openrouter` DSH route, validates and retains OpenRouter's dynamic model catalog through Companion's durable LKG owner, projects API-key usage and limits into provider-account state, and delegates request conversion, streaming, tools, reasoning, usage, cancellation, retry semantics, and replay to DSH's public `PiAiAdapter`.

The provider is disabled by default. Its API key is resolved per operation through DSH Credentials and never enters catalog payloads, account snapshots, logs, or model context. A catalog generation is immutable once admitted: later refreshes affect later model operations only.

## Configuration

```yaml
- name: '@dsh-companion/provider-openrouter'
  config:
    enabled: true
    apiKeyEnv: OPENROUTER_API_KEY
```

`baseURL` defaults to `https://openrouter.ai/api/v1`. Stream-idle and image-request bounds are configurable and default to the same values used by DSH's generic pi-ai adapter. Retry policy uses DSH's provider-owned retry contract.

## Catalog and account state

The unpaginated default `/models` response is the catalog authority. Companion persists the validated provider payload as a last-known-good generation and projects model names, descriptions, input modalities, context capacity, reasoning efforts, and reported USD catalog rates. Rates remain catalog metadata; this package does not turn them into incurred Turn cost.

`GET /key` provides non-secret key label, free/paid tier, optional per-key credit limit and remaining amount, and the current free-model daily request counter. Deprecated rate-limit data is ignored. The package does not call the management-key-only `/credits` endpoint.

## Model Experience

The provider adds no prompt or tools. It sends DSH's existing messages, tool schemas, tool results, reasoning selection, and supported images through `PiAiAdapter`.

### Token effect

No fixed addition; request size follows DSH history and tool schemas.

### KV Cache effect

The pi-ai OpenRouter transport owns provider-native replay and request compatibility. Catalog refresh replaces metadata for later calls only; an admitted call retains its generation.

## Transport-spike result

`PiAiAdapter` is externally reusable without copying its OpenAI-compatible transport. The current public API is lower-level than ideal: this package constructs `ResolvedPiAiProviderProfile`, supplies inert pi-ai auth objects for request-key-only authentication, and wraps pi-ai's provider to substitute the dynamic model generation. A narrow upstream factory accepting a provider, DSH credential callback, and request bounds would remove this coupling; no DSH patch is currently required.

## Known Limitations and Deferred Work

- The catalog decoder targets the unpaginated default text-output Models API and requires a usable completion-token cap for every row.
- Catalog rates are reported metadata only. Actual OpenRouter generation cost is not yet emitted as `ModelCallAccounting`.
- Companion's provider-scoped policy default keeps newly discovered OpenRouter models disabled until the user enables exact models or the current catalog in bulk.
- Image-capable models resolve DSH's durable attachment store at request time; normalized execution-world paths are not yet added to image descriptors.
- A complete real-API lane and Loader-based REAL-composition test remain to be added before packaging.
- OpenRouter's management-key-only total-credit endpoint is intentionally not queried with ordinary inference keys.
