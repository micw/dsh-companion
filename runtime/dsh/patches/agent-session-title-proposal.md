# Agent Session Title Proposal Patch Assessment

## Requirement

Companion lets the active root Agent propose a concise Session title through a model-facing Tool when the topic changes. The existing title service supports explicit user renames and an auxiliary title provider, but neither operation accepts a title supplied by the main Agent without misattributing it to the user or making another model call. A manually pinned title must remain protected.

## Scope

The patch adds `SessionTitleService.proposeFromAgent(session, title, providerId, signal?)`. DSH verifies the exact live Session, cancellation, eligible committed human-message citations, normalization, and manual pin; it supersedes pending automatic generation and appends a canonical `session/title` event with the existing `provider` source kind, the Companion Tool's stable provider ID, and the logged main-model route when available. It adds service and JSONL-remount tests and updates the generated service reference. The Companion Tool authenticates the exact running root Agent at execution time; the DSH service does not infer Agent authority from a provider ID.

## Alternatives

- `sessionTitle.rename()` incorrectly records a model-authored title as a user rename and pins it against future generation.
- Direct Session-event append from Companion bypasses DSH's title validation, cancellation, and supersession rules.
- `sessionTitle.refresh()` makes a second model request and cannot submit the Agent's proposed text.
- Adding a new persisted `agent` source kind requires an adjacent Session-format successor and migrations for released data; the existing provider source with a distinct trusted plugin ID preserves the current format and identifies the producer.

## Security assessment

Only trusted Host plugins can call the new service method; its provider ID is provenance, not an authorization token. Companion enforces current-root-Agent ownership before calling it. The service rejects detached Sessions and aborts, bounds the title, requires prior human input, and refuses to overwrite a pinned user title. The Agent cannot target another Session or choose the provider ID. No provider secret, prompt text, or arbitrary user-supplied ID is added to the title event.

## Compatibility and maintenance

Existing title sources and wire projections are unchanged; the new provider ID is valid under the existing persisted provider variant. JSONL remount verifies title, citation, provider identity, and model route. The Tool context reads the DSH-owned title projection and enters model context only as a durable, change-suppressed user-role runtime snapshot; it does not rewrite the system-prompt prefix. Review the patch and Companion Tool together on every DSH upgrade, and remove this patch when DSH publishes a service-owned proposal operation with equivalent pin, provenance, and concurrency semantics.

## Upstream discussion

The upstream API proposal and security review remain to be raised before a public Companion release. Internal Linux packaging records a `null` discussion URL until then.
