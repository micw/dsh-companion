# Pi-AI Provider Accounting Mapper Patch Assessment

## Requirement

OpenRouter reports the amount charged for each model call in the terminal response usage. Pi-ai also computes a catalog-based cost but does not preserve whether a value came from the provider, so Companion cannot classify that calculation as provider-reported accounting.

## Scope

The patch adds an optional provider-owned terminal-usage mapper to DSH's public `PiAiAdapter`. The mapper may emit one existing `ModelCallAccounting` value after token usage and before finish. The generic pi-ai plugin leaves the mapper absent; Companion's dedicated OpenRouter integration supplies it after independently capturing and validating OpenRouter's response-reported amount.

No cost field, tariff, currency assumption, or provider-specific parser enters DSH. The existing stream validator, Assistant settlement, retry handling, and token-meter projection remain the authorities for persistence and Turn aggregation.

## Alternatives

- Treating pi-ai's catalog calculation as reported spend would lose provenance and would be incorrect for dynamic OpenRouter routes.
- Adding OpenRouter parsing to DSH would make the generic adapter own an external provider's response extension.
- Storing the cost only in Companion would bypass DSH's atomic Assistant settlement and canonical Session history.
- Fetching generation details after every call would add latency and another failure path for data already present in the terminal response.

## Security assessment

The callback receives the same typed terminal SDK usage already held in process and cannot access credentials through this API. Its result crosses the existing validated accounting boundary, which rejects malformed currencies, unsafe or negative nanos, duplicate entries, and invalid ordering. Accounting remains non-model-visible.

## Compatibility and maintenance

The option is optional, so all existing `PiAiAdapter` consumers preserve their current stream. The only wire-visible effect occurs when an external integration explicitly returns accounting through the mapper. Every DSH upgrade reruns the focused pi-ai conversion tests and the OpenRouter adapter tests. Remove the patch when DSH publishes an equivalent provider accounting projection hook.

## Upstream discussion

Before a public Companion release, propose the provider-owned pi-ai terminal-usage accounting mapper to DSH upstream. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`; internal builds retain `null` until then.
