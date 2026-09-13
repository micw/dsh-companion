# DSH Companion Backlog

This backlog records concrete work that is intentionally deferred. It is not a roadmap or a duplicate of the current product status in [features.md](features.md).

Entries under **Companion work** belong to this repository. Entries under **DSH dependencies** require a capability or behavior owned by DeepSeek Harness; Companion does not create a parallel contract or canonical state to bypass them. Add only observed gaps or explicit decisions, keep private development details out, and remove completed entries after documenting the shipped behavior in `features.md`.

## Companion work

### COMP-001 — Restore paged history by a stable event anchor

**Current behavior:** A restored editor tab stores a pixel scroll position, while older DSH history pages are loaded only into the current Webview lifetime.

**Deferred work:** Store a stable DSH event identity and its viewport offset as presentation state, load backwards through DSH until that event is present, and then restore the offset.

**Completion:** A reconstructed tab returns to the same logical transcript position after the previous Webview had loaded older history pages.

### COMP-002 — Recover continuous transports and repair cursor gaps

**Current behavior:** Reconstructing an editor reconnects its Follow and Control streams, but a transport interruption inside the same Webview does not continuously retry or repair durable sequence gaps.

**Deferred work:** Adopt DSH's reconnect and cursor-repair behavior without introducing a second Session stream protocol.

**Completion:** Follow and Control recover from physical transport loss, replace transient baselines correctly, and deliver a gap-free durable event window.

### COMP-003 — Replace the handwritten DSH Wire client

**Current behavior:** The proof of concept handwrites HTTP Remote envelopes and multiplexed WebSocket frames for the DSH Web protocol.

**Deferred work:** Determine which published DSH Connection, Gateway, Remote, Session Controller, and Session client artifacts can replace owned transport and continuity code in the VS Code extension.

**Completion:** Companion uses supported published DSH client artifacts for every capability they cover, with any remaining handwritten Wire code explicitly justified and validated.

### COMP-004 — Establish contributor relicensing terms

**Current behavior:** DSH Companion is MIT-licensed and has no Contributor License Agreement.

**Deferred work:** Before accepting external contributions, identify the legal project owner and adopt legally reviewed contribution terms that preserve an explicit right to sublicense and relicense contributions, including transfer to a project successor, while public releases remain MIT-licensed.

**Completion:** Contribution documentation, acceptance records, and any required individual or corporate agreement are in place before the first external contribution is merged.

## DSH dependencies

### DSH-001 — Separate Session model selection from the global default

**Current behavior:** DSH `session.selectModel` installs a durable selection for the addressed Session and saves the same selection as the default for future Agents. Existing Sessions restore their pending or last-used selection from durable Session state.

**Companion behavior:** The model picker uses the existing DSH operation, displays the Session's DSH-owned selection, and does not maintain a separate Companion default.

**Needed capability:** DSH distinguishes Session-local model selection from an explicit update of the global Agent default.

**Completion:** Companion can offer separate “Use in this Session” and “Set as default” actions through DSH-owned operations without retaining another model-selection state.

### DSH-002 — Expose staged manual-compaction progress

**Current behavior:** DSH `/compact` performs one canonical compaction transaction and returns its settled command result. Repeated compactions can include and merge a prior checkpoint, but the Remote operation exposes no stable intermediate stage progress for a richer client display.

**Companion behavior:** The context panel shows one busy state and the final `/compact` result. Repeating the action delegates another complete compaction decision to DSH.

**Needed capability:** If DSH adopts adaptive multi-stage manual compaction, its durable events or Remote frames identify each stage and publish user-facing progress without requiring Companion to infer backend control flow.

**Completion:** Companion can present canonical multi-stage progress and cancellation from DSH-owned identities and state while retaining one Compact action.
