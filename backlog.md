# DSH Companion Backlog

This backlog records concrete work that is intentionally deferred. It is not a roadmap or a duplicate of the current product status in [features.md](features.md).

Entries under **Companion work** belong to this repository. Entries under **DSH dependencies** require a capability or behavior owned by DeepSeek Harness; Companion does not create a parallel contract or canonical state to bypass them. Add only observed gaps or explicit decisions, keep private development details out, and remove completed entries after documenting the shipped behavior in `features.md`.

## Companion work

### COMP-004 — Establish contributor relicensing terms

**Current behavior:** DSH Companion is MIT-licensed and has no Contributor License Agreement.

**Deferred work:** Before accepting external contributions, identify the legal project owner and adopt legally reviewed contribution terms that preserve an explicit right to sublicense and relicense contributions, including transfer to a project successor, while public releases remain MIT-licensed.

**Completion:** Contribution documentation, acceptance records, and any required individual or corporate agreement are in place before the first external contribution is merged.

### COMP-005 — Ship the Companion Managed Runtime

**Current behavior:** Internal Linux packaging stages the pinned, patched DSH runtime, Companion packages, provider bundles, Office resources, and primary-runtime resources, compresses the enhanced SEA closure, and records every payload digest for the VSIX. The Extension verifies and installs immutable versions under VS Code global storage, retains active and rollback records, starts one identity-matched independent supervisor, stores DSH data separately, and provides an explicitly confirmed runtime-stop command. The packaged runtime passes authentication, Web bootstrap, Session list/search/create, provider-family baseline, simultaneous restore, and independent release smokes. Development uses the shared lifecycle owner and data home with its task-owned source runtime.

**Deferred work:** Replace the compressed Postject path after DSH qualifies Node's native SEA builder. Add DSH-owned idle eligibility and automatic idle shutdown, robust crash recovery, update rollback qualification across DSH data-format changes, the Companion bundle, and External DSH mode. Public signing and additional targets remain outside internal Linux packaging.

**Completion:** A packaged extension starts and reconnects to one independently supervised, version-matched DSH Runtime, shares it across windows and Development Extension Hosts, stops it only through the declared idle or explicit lifecycle, and never depends on system Node.js, pnpm, or a source checkout.

### COMP-006 — Stream provider-account snapshot changes to clients

**Current behavior:** The Companion provider-account service has process-local change notifications, but its Remote exposes only `list` and coalesced `refresh`. The VS Code client reloads snapshots at connect, after explicit refresh, at reconnect, and after a live Turn. When its initial read intersects an in-flight refresh, it joins that one refresh once and republishes the settled list.

**Deferred work:** Expose provider-account changes through a Companion-owned Remote follow stream or equivalent observable Client contribution, including initial state, refresh transitions, Turn quota observations, errors, reconnect, and disposal.

**Completion:** Connected clients receive every provider-account snapshot transition without polling, Turn-end coupling, or initiating a redundant refresh, while the provider-account service remains the single state owner.

### COMP-007 — Add dedicated OpenAI and DeepSeek provider families

**Current behavior:** Companion disables DSH's generic pi-ai and native DeepSeek plugins. OpenRouter is the first provider-family implementation; OpenAI and DeepSeek do not appear in Add Provider and publish no Companion route.

**Deferred work:** Implement dedicated OpenAI and DeepSeek family packages over reviewed upstream transport code, a narrow extracted adapter factory, or maintained forks. Each package uses the canonical DSH family/instance operations and starts with an explicit instance limit rather than reintroducing configurable-provider directory rows.

**Completion:** OpenAI and DeepSeek appear as installed families, create independently validated instances without a second settings contract, and pass the same credential, route identity, rollback, restore, REAL-composition, and packaged-runtime checks as OpenRouter.

### COMP-008 — Manage web search accesses in DSH Web

**Current behavior:** The native Companion Settings editor manages prioritized Brave and Exa accesses, write-only credentials, explicit retry, and durable failover without a Runtime restart. DSH Web can use the configured search service but does not present access management.

**Deferred work:** Expose the existing search-access management operations in DSH Web, retaining the same Runtime-owned access identities, credential handling, priorities, and cooldowns rather than introducing a second settings state.

**Completion:** DSH Web users can configure and retry the same search accesses as the native editor without editing a profile file or exposing credentials; changes remain consistent across both surfaces and Runtime restarts.

### COMP-009 — Show Session fork lineage in the browser

**Current behavior:** DSH records each ordinary fork's parent Session and inherited prefix, but Companion's Session browser presents child and source as separate flat entries.

**Deferred work:** Expose DSH's parent Session identity in the validated browser projection and present a clear, restorable source–fork relationship without creating a second lineage registry.

**Completion:** The browser distinguishes a fork from its source after live updates and restart, including when the source is no longer available.

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
