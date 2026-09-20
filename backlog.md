# DSH Companion Backlog

This backlog records concrete work that is intentionally deferred. It is not a roadmap or a duplicate of the current product status in [features.md](features.md).

Entries under **Companion work** belong to this repository. Entries under **DSH dependencies** require a capability or behavior owned by DeepSeek Harness; Companion does not create a parallel contract or canonical state to bypass them. Add only observed gaps or explicit decisions, keep private development details out, and remove completed entries after documenting the shipped behavior in `features.md`.

## Companion work

### COMP-004 — Establish contributor relicensing terms

**Current behavior:** DSH Companion is MIT-licensed and has no Contributor License Agreement.

**Deferred work:** Before accepting external contributions, identify the legal project owner and adopt legally reviewed contribution terms that preserve an explicit right to sublicense and relicense contributions, including transfer to a project successor, while public releases remain MIT-licensed.

**Completion:** Contribution documentation, acceptance records, and any required individual or corporate agreement are in place before the first external contribution is merged.

### COMP-005 — Ship the Companion Managed Runtime

**Current behavior:** Internal Linux packaging builds a pinned, patched DSH single-executable runtime, records every payload digest, and includes it in the VSIX. The Extension verifies and installs immutable versions under VS Code global storage, retains active and rollback records, starts one identity-matched independent supervisor, stores DSH data separately, and provides an explicitly confirmed runtime-stop command. Development uses the shared lifecycle owner and data home with its task-owned source runtime.

**Deferred work:** Add DSH-owned idle eligibility and automatic idle shutdown, robust crash recovery, update rollback qualification across DSH data-format changes, the Companion bundle, and External DSH mode. Public signing and additional targets remain outside internal Linux packaging.

**Completion:** A packaged extension starts and reconnects to one independently supervised, version-matched DSH Runtime, shares it across windows and Development Extension Hosts, stops it only through the declared idle or explicit lifecycle, and never depends on system Node.js, pnpm, or a source checkout.

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

### DSH-003 — Report managed-runtime idle eligibility

**Current behavior:** DSH exposes individual Session and capability operations but no host-wide status proving that shutdown would leave no active or time-dependent Agent, maintenance, Job, Terminal, Workflow, Subagent, Schedule, or comparable work behind.

**Companion behavior:** The development supervisor tracks Extension Host leases but deliberately does not stop DSH when the last lease expires.

**Needed capability:** DSH publishes one authoritative, change-observable runtime lifecycle status that distinguishes quiescent shutdown eligibility from active or time-dependent work without exposing secrets or requiring Companion to combine subsystem internals.

**Completion:** The managed supervisor starts its idle deadline only after the last Companion client leaves, cancels that deadline when a client returns or DSH becomes non-quiescent, and stops DSH plus itself after the deadline expires while DSH remains shutdown-eligible.
