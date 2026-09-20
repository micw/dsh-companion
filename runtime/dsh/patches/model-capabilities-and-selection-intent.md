# Model Catalog Capabilities and Selection Intent Patch Assessment

## Requirement

DSH's canonical `session/modelCatalog` did not project the model capabilities every adapter already validates — the accepted request modalities and the route's context-window capacity — and `session.selectModel` persisted the adapter's currently resolved default reasoning effort, turning an omitted "provider default" selection into a pinned value.

## Scope

The patch adds the optional `inputModalities` and `context.contextWindow` fields to `ModelCatalogModel`, projects them from adapter-validated `LlmResolvedModelInfo` in `buildModelCatalog()`, and keeps an omitted `reasoningEffort` as user intent in `session.selectModel` so the adapter default resolves per request instead of being stored. It changes no Agent Loop, Session persistence, queue semantics, tool behavior, or Session format.

## Alternatives

- Companion could read capabilities through a provider-private side channel, creating a second model-capability authority beside DSH's catalog.
- Companion could wait for the next provider request to refresh context capacity, leaving stale capacities visible after a model switch.
- Keeping the materialized reasoning default would freeze the provider's current default into every durable selection.

## Security assessment

The patch adds two optional catalog fields with strict parsing — a positive-integer window and a closed modality set — and changes no authorization, credential, network, or persistence path. Catalog entries that omit the fields mean "unknown" and are never rendered as zero or free.

## Compatibility and maintenance

The catalog fields are optional additions consumed by Companion's model picker and context meter; absent fields mean unknown. The selection change preserves the wire shape and only stops persisting an adapter-resolved default. Every DSH upgrade re-runs the session-controller focused suite, the generated-catalog gates, and Companion's editor tests; the patch is removed or reduced when DSH publishes the capability fields and preserves omitted reasoning intent upstream.

## Upstream discussion

Before a public Companion release, discuss with DSH upstream whether `session/modelCatalog` should project shared model capabilities and whether `selectModel` should persist user intent rather than resolved adapter defaults. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`. Internal builds retain `null` to show that this action remains open.
