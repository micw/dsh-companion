# DSH Companion Features

This document describes the currently implemented product behavior. DSH remains the authority for agents, sessions, model calls, tools, and durable history; Companion owns VS Code presentation and tab-local interaction state.

## Status legend

| Status | Meaning |
|---|---|
| `available` | Implemented and covered by the current build or tests |
| `partial` | Usable for the proof of concept, with listed limits |
| `development only` | Local F5 support, not a distributable product contract |
| `not available` | Intended scope with no current implementation |

## Overview

| Feature | Status | Current behavior |
|---|---|---|
| Native chat editor | `available` | **DSH: New Chat Editor** creates one DSH session in a VS Code editor tab. |
| Prompt composer | `available` | Starts at one line, grows to 200 pixels, retains drafts, sends with Enter, and inserts newlines with Shift+Enter. |
| Text streaming | `available` | Streams Assistant text from `session/follow` and reconciles it with the durable message. |
| Markdown | `available` | Renders headings, lists, quotes, tables, links, inline code, and fenced code with raw HTML disabled. |
| Reasoning and Tool activity | `partial` | Groups reasoning, context injections, and paired Tool calls/results into collapsible Turn process rows; Tool presentation is generic. |
| Turn usage and timing | `available` | Shows DSH-Web-style Usage and Run-time pills plus the Turn end clock. |
| Stop | `available` | Calls DSH `session.cancel`, cancelling the active Turn or manual compaction while retaining pending inbox work. |
| Tab restore | `available` | Restores the same DSH session, draft, and disclosure state after the editor tab is reconstructed, then opens the transcript at its latest output. |
| Session information | `available` | A composer info panel shows the Session id, Companion version, supervised DSH backend build identity, and the known cumulative normal-Turn cost plus coverage when DSH has accounting data; the Session id can be copied through VS Code. |
| History | `available` | Opens DSH's bounded canonical Session event window and automatically requests older DSH history near the upper edge. |
| Connection recovery | `available` | Managed and source Development Runtimes use DSH's canonical Client connection, generation replacement, Session synchronization, and cursor repair after transport loss. |
| Development connection | `development only` | Connects to a managed DSH Web source Runtime on loopback port 3081 through an independent lifecycle supervisor ensured by the parent development task; **DSH: Open Web UI** opens that Runtime in the default browser. |
| Managed Runtime | `partial` | Internal Linux packages carry an integrity-recorded patched DSH runtime, install immutable versions under VS Code global storage, retain one rollback version, and start an identity-matched independent supervisor on the packaged runtime's own loopback origin; DSH-owned idle eligibility remains unavailable. |
| Provider/model selection | `available` | Selects DSH catalog models and model-specific reasoning effort from the composer; DSH owns validation, persistence, and defaults. |
| External provider plugins | `available` | Source and packaged Managed Runtime profiles load Companion's provider platform together with the separately maintained Codex Wrapper Advanced and Claude Wrapper Advanced adapters; wrapper services, deployment, authentication, and secrets remain external. |
| Agent preset | `available` | Companion exposes one system preset based on DSH `standard`, with fresh spawn delegation and Goals retained and fork-based delegation omitted; Sessions that recorded the retired `standard` id resume through a roster-hidden fallback. |
| Fork-based Subagents | `not available` | The Companion preset omits `subagent_fork` to prevent unbudgeted copies of Parent history; fresh spawn delegation and Goals remain unchanged. |
| Approvals and questions | `not available` | No VS Code answerer exists yet for Tool approvals or `ask_user_question`. |
| Queue display | `partial` | Shows local submissions and the authoritative DSH control-stream queue separately from the transcript; edit, remove, and steering controls are not available. |
| Session browser | `not available` | There is no list, search, rename, archive, fork, or reopen UI for closed tabs. |
| Session Changes | `not available` | Native SCM projection, persistent Edit Ledger, Dirty-buffer protection, review, and guarded revert remain planned. |
| Native terminals | `not available` | No VS Code-backed DSH `TerminalBackend` exists yet. |
| Context meter | `available` | Shows DSH-projected next-request pressure and route capacity in a composer ring, with manual DSH compaction when the Session provides `/compact`. |
| Monetary cost | `partial` | The patched DSH Runtime persists provider-neutral reported, estimated, and virtual call or complete-Turn accounting, derives Turn and cumulative Session sums without converting currencies, and projects them to the VS Code UI; the Claude Wrapper Advanced adapter emits virtual USD list-price equivalents with explicit coverage. |

## Chat and session behavior

**DSH: New Chat Editor** always creates a new session rooted at the first VS Code workspace folder. Restoring an existing editor tab reuses its saved Session id and reloads transcript content from DSH; Companion does not persist a second transcript. Closing a tab only closes its client stream and does not delete the DSH session.

The tab-local state contains the Session id, unsent draft, current scroll position, and disclosure choices. A reconstructed tab deliberately opens at the latest output instead of applying its stored pixel position. Stable keys identify Turn, reasoning, Tool, context, Usage, Cost, and timing disclosures, so each row can retain its open state independently. This state is presentation-only and never enters the DSH session log.

History remains a contiguous DSH-owned event window. Initial loading extends a bounded Follow snapshot only when it contains no human prompt, then positions a reconstructed tab at the latest output. Approaching the upper edge loads additional `session/page` records through the next older human prompt, merges a Turn split across page boundaries by its stable DSH Turn identity, and preserves the visible scroll position while prepending the page.

Submitted prompts remain in a dedicated queue area until DSH commits the matching `user/message`. Companion correlates the local submission and durable message by request id, removes the queue row, and renders the canonical message at its DSH Turn with the DSH event time. The queue baseline and replacements come from `session/control`; queued prompts are not optimistic transcript entries.

The composer model picker searches the provider-grouped `session/modelCatalog` and follows the Session's durable `modelSelection` projection. Models expose only the reasoning efforts and display metadata reported by their DSH adapter. Provider default remains a distinct choice even when the catalog names its current effective default, so selecting it omits `reasoningEffort` and continues to follow later provider-default changes. Selecting another model also lets DSH resolve that model's default instead of carrying effort across routes. Selection is unavailable during a running Turn. With the current DSH operation, a Session selection also becomes the default for future Sessions.

The source and packaged profiles load external provider bundles without adding a Companion-owned transport or model registry. Generic Companion plugins retain validated last-known-good catalogs in DSH storage, expose process-local account and allowance snapshots, and store only user model-policy intent in DSH Settings. For the selected provider, the VS Code composer shows a compact usage trigger beside Context and a refreshable allowance panel with plan, primary and secondary windows, reset countdowns, warning thresholds, and a time-position marker that relates elapsed window time to reported consumption. The Codex Wrapper Advanced and Claude Wrapper Advanced adapters obtain their endpoints from DSH Settings and API keys through DSH credential references, then contribute native DSH LLM routes backed by their `/wire/v1` protocols. Claude additionally reports estimated thinking progress, reported final reasoning usage, quota groups, and scoped virtual USD list-price equivalents. Dynamic model discovery does not materialize provider models into `settings.yaml`; running calls retain the immutable adapter and catalog generation captured at admission. Local validation covers catalog and account refresh, a complete text Turn, cold Session restore, a successful two-Step Tool call/result round trip, and DSH Session cancellation through the canonical DSH Web Client. The VS Code Client assembly also discovers the provider, selects its model, submits a real Turn, and reconstructs the resulting transcript after reconnect. Packaging embeds only the independently maintained adapter packages; wrapper services and their secrets remain external.

The context ring appears only when DSH provides both pressure and route capacity. Its numerator comes from the `contextPressure` projection, while its denominator follows the selected route's adapter-validated capacity from `session/modelCatalog`; model switches therefore refresh the percentage without waiting for another request. It prefers projected next-request tokens over the latest provider sample, caps only the visual ring at 100 percent, and exposes the approximate size and limit on hover, focus, or click. The Compact action appears only when the Session command catalog provides `/compact`; it executes that DSH command with the composer's current provider/model selection while the Agent is idle and displays its canonical result without changing context state optimistically. Durable `compaction/*` events produce a running and settled transcript activity row. While compaction runs, the prompt and model controls are locked and Stop remains available through `session.cancel`.

## Transcript presentation

User prompts use a compact VS Code-themed card. Live output follows the bottom until the user scrolls away; wheel, touch, keyboard, scrollbar, and text-selection gestures pause following before the next streamed update can override them. Returning to the bottom, using the latest-output button, or submitting another prompt resumes following. When no prompt is visible, the nearest prompt fully above the viewport is pinned at the top; if any later prompt remains visible, the earlier prompt stays unpinned until that later prompt has scrolled away. A jump button returns to the original prompt. Assistant text uses `markdown-it`; raw model HTML is escaped, unsafe links are rejected, and HTTP or HTTPS links open through VS Code. An Assistant progress message precedes the Turn process disclosure that its following Tool call grows, while the final Assistant answer follows that disclosure. Reasoning, context injections, Tool calls, and Tool results appear inside the disclosure inspired by DSH Web. Its title summarizes the represented Reasoning, Tool Calls, and Context Injections, while a Turn without process rows shows its measured `Thought for …` duration as a non-interactive row instead of an empty disclosure.

Tool rows currently show a generic summary, raw arguments, and text result. Specialized file previews, code-copy controls, syntax highlighting, Mermaid, native file/line links, approvals, and presenter-specific cards are not available.

## Turn information

Companion derives one completed-Turn summary from DSH's durable Turn, Step, request, Assistant, usage, and accounting data. Usage aggregates recorded attempts and displays exact total, uncached input, optional cached input and cache write, output, provider/model routes, and cache-hit percentage. Reasoning is displayed only when its aggregate is greater than zero. When accounting exists, a separate Cost pill sums each currency and retains reported, estimated, and virtual kinds plus route, source, tariff, and bucket details; estimated totals use `~`, virtual totals identify their equivalent value, mixed kinds use a sum marker, and incomplete Session coverage identifies the displayed amount as a known subtotal. Context occupancy is deliberately excluded.

The Session Information panel shows one compact known sum per currency with an expandable reported, estimated, and virtual breakdown. Projection coverage counts accounted and unaccounted model Turns; a partial sum is marked as known rather than presented as complete spend. It folds only normal-Turn model settlements in that DSH Session; Session-title, compaction, and child-Session calls are not included.

The timing panel shows Turn wall time and, when the event sequence provides them, first-Step time to first token and aggregate decode throughput. The clock uses `turn/end.time`. Usage, Cost, and timing panels preserve their open state with the tab, while opening another panel, clicking outside, or pressing Escape closes the active transient panel.

## Stop semantics

Stop targets only the current session's active Turn or Agent maintenance. It cancels the model request, cancellable in-flight Tool work, or manual compaction through DSH `session.cancel`; pending inbox entries remain. It does not clear the queue or globally stop independently owned jobs, terminals, schedules, or other sessions.

## Development connection

The source development connection is fixed to `http://127.0.0.1:3081`, and the installed Managed Runtime binds its own loopback origin (`http://127.0.0.1:3082`), so packaged activation never collides with a DSH already running on the development origin; both require a managed source or packaged Runtime. The parent development task starts or reuses an independent lifecycle-only source supervisor, while each activated Extension Host renews a private client lease and obtains the process launch URL through the supervisor without persisting its token in the rendezvous. The authenticated supervisor endpoint returns a compact DSH backend build identity: source development includes the checkout commit and dirty state, while packaged Runtimes include the pinned upstream commit and patch-set digest. A retained older supervisor can report this field as unavailable without preventing Session use. The extension exchanges that URL for an authority-bound cookie and retains the cookie in VS Code Secret Storage. Session streams, queue state, projections, paging, and recovery use DSH's Node Client assembly. Companion has no manual URL/token or no-supervisor connection mode. Debug restarts reuse the source Runtime; running **DSH Companion: stop runtime** or **DSH: Stop Managed Runtime** ends its process tree explicitly.

Internal Linux VSIX packages include a runtime built from the pinned official DSH commit plus an integrity-checked downstream patch series. On first activation the Extension verifies the closed payload, installs it under `globalStorageUri/runtime/versions/<companion-version>-linux-x64`, starts its supervisor against the separate persistent `dsh-home`, and records active and rollback versions only after readiness. The supervisor publishes its source or installed runtime identity; packaged activation reuses an explicit source owner and replaces a mismatched installed owner under the shared lifecycle lock. Runtime installation never modifies the Extension directory, and cleanup retains DSH data. DSH-reported idle eligibility, automatic idle shutdown, robust crash recovery, signed public builds, and External DSH mode remain unavailable.
