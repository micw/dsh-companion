# Turn Cost Snapshots and Model Status Patch Assessment

## Requirement

Some providers expose one cumulative cost only after several model calls in the same logical Turn. DSH also had no provider-neutral way to retain transient reasoning-token progress without inserting provider text into model-visible history. Call-only accounting would misattribute deferred tool-loop costs, while persisting an unknown raw stream chunk would make predecessor assembly fail.

## Scope

The patch requires every `ModelCallAccounting` value to declare `call` or `turn` scope. A final turn-scoped `assistant/message` value replaces earlier call values and covers preceding attempts that omitted accounting; later settlements, retries, or Steps invalidate it. The Agent Loop supplies one branded `LlmTurnId` across every Step and retry in a normal Turn and changes it for the next Turn, so an adapter can correlate a cumulative provider snapshot without treating the Session identifier as a Turn identifier. The `modelCost` projection advances to state version 3.

The patch also adds merge-extensible `ModelStatusMap` values and a repeatable `reasoning-token-progress` status chunk with reported or estimated basis. Status chunks remain live-only in the raw model stream. The Agent Loop persists their validated timed timeline as optional top-level `statuses` on `assistant/message` and `assistant/attempt`; Session admission and current JSONL verification validate the timeline.

## Alternatives

- Treating a Session identifier as the cost scope would combine costs from separate human Turns.
- Emitting deferred costs on the last model call would leave the earlier attempts unaccounted and overstate the last call.
- Persisting status chunks inside `AssistantStreamRecord` would make the pinned predecessor reject an unknown record type.
- Converting thinking progress into reasoning text would invent model-visible content that the provider did not expose.

## Security assessment

Turn identifiers are opaque model-hidden correlation metadata. Status values accept only exact fields, a non-negative safe-integer token delta, and a fixed basis. They never enter model input. Turn-snapshot aggregation fails closed on contradictory ordering, repeated snapshots, later lifecycle activity, or unsafe monetary sums. Current-generation persistence rejects malformed status timelines and raw persisted status chunks.

## Compatibility and maintenance

The new Assistant `statuses` fields and `GenerateOptions.turnId` are optional. The pinned predecessor ignores the top-level status timeline and continues to assemble the unchanged raw stream records. `ModelCallAccounting.scope` becomes required within the unreleased Companion accounting patch, so no released Session or public provider value relied on an implicit default.

Every DSH upgrade re-runs the LLM, Agent Loop, token-meter, current-generation persistence, documentation, and Companion editor suites. Remove or reduce the patch when DSH publishes equivalent logical-Turn correlation, cumulative Turn accounting, and provider-neutral model status persistence.

## Upstream discussion

Before a public Companion release, propose logical-Turn request correlation, scoped accounting replacement, and top-level status persistence to DSH upstream. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`; internal builds retain `null` until then.
