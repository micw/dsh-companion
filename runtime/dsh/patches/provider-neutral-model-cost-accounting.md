# Provider-Neutral Model Cost Accounting Patch Assessment

## Requirement

DSH persisted provider token usage but had no durable provider-neutral monetary accounting. Companion could not show restored Turn costs or a cumulative Session subtotal without inventing a second history or repricing old calls from a mutable current tariff.

## Scope

The patch adds a monetary accounting value separate from `TokenUsage`: reported, estimated, and virtual costs use non-negative safe-integer nanos, an uppercase currency identifier, source provenance, an optional tariff version, and optional component nanos. Adapters may emit one accounting chunk before finish. The Agent Loop validates it before durable accumulation and copies it atomically onto the matching `assistant/message` or `assistant/attempt` settlement. The token-meter derives complete normal-Turn costs and projects cumulative per-currency and per-kind totals with accounted/unaccounted Turn coverage. Current JSONL generation verification enforces accounting order and top-level/embedded equality.

The patch supplies no tariff and changes no provider adapter. Session-title, compaction, and child-Session calls remain outside the `modelCost` projection.

## Alternatives

- Storing cost in Companion would create a second canonical history and allow restore to disagree with DSH.
- Repricing old token usage from the current model catalog would change historical values after tariff updates.
- Adding monetary fields to `TokenUsage` would combine token measurement with accounting provenance that has different availability and semantics.
- Appending a separate downstream Session event would not commit atomically with its Assistant settlement.
- Binary floating-point totals or implicit currency conversion would not be exact or reproducible.

## Security assessment

Accounting is display and telemetry data and never enters model input. Runtime validation rejects unknown fields, empty or duplicate kind/currency entries, malformed provenance, negative zero, unsafe nanos, and component sums above the owning amount. Aggregation fails closed on incomplete attempts, contradictory embedded values, malformed lifecycle, or unsafe sums. Currency conversion and provider-supplied executable content are absent.

## Compatibility and maintenance

The accounting fields are optional. Sessions without them remain valid and are counted as unaccounted when a normal Turn settled model work. The pinned predecessor snapshots raw chunks as lossless JSON and ignores an unknown raw chunk in assembly, so it can open a Session containing accounting while omitting the new projection; the top-level optional field is likewise non-surface data. The current verifier rejects duplicate, late, missing, or contradictory accounting.

Every DSH upgrade re-runs the LLM, Agent Loop, token-meter, current-generation persistence, documentation, and Companion editor suites. Remove or reduce the patch when DSH publishes equivalent monetary accounting and Session projections.

## Upstream discussion

Before a public Companion release, propose the provider-neutral accounting vocabulary, atomic Assistant-settlement persistence, and replayable Turn/Session aggregation to DSH upstream. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`; internal builds retain `null` until then.
