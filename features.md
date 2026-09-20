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
| History | `available` | Opens DSH's bounded canonical Session event window and automatically requests older DSH history near the upper edge. |
| Connection recovery | `available` | Managed and source Development Runtimes use DSH's canonical Client connection, generation replacement, Session synchronization, and cursor repair after transport loss. |
| Development connection | `development only` | Connects to a managed DSH Web source Runtime on loopback port 3081 through an independent lifecycle supervisor ensured by the parent development task. |
| Managed Runtime | `partial` | Internal Linux packages carry an integrity-recorded patched DSH runtime, install immutable versions under VS Code global storage, retain one rollback version, and start an identity-matched independent supervisor; DSH-owned idle eligibility remains unavailable. |
| Provider/model selection | `available` | Selects DSH catalog models and model-specific reasoning effort from the composer; DSH owns validation, persistence, and defaults. |
| Approvals and questions | `not available` | No VS Code answerer exists yet for Tool approvals or `ask_user_question`. |
| Queue display | `partial` | Shows local submissions and the authoritative DSH control-stream queue separately from the transcript; edit, remove, and steering controls are not available. |
| Session browser | `not available` | There is no list, search, rename, archive, fork, or reopen UI for closed tabs. |
| Session Changes | `not available` | Native SCM projection, persistent Edit Ledger, Dirty-buffer protection, review, and guarded revert remain planned. |
| Native terminals | `not available` | No VS Code-backed DSH `TerminalBackend` exists yet. |
| Context meter | `available` | Shows DSH-projected next-request pressure and route capacity in a composer ring, with manual DSH compaction when the Session provides `/compact`. |
| Monetary cost | `not available` | DSH currently persists token usage but no provider-neutral monetary accounting. |

## Chat and session behavior

**DSH: New Chat Editor** always creates a new session rooted at the first VS Code workspace folder. Restoring an existing editor tab reuses its saved Session id and reloads transcript content from DSH; Companion does not persist a second transcript. Closing a tab only closes its client stream and does not delete the DSH session.

The tab-local state contains the Session id, unsent draft, current scroll position, and disclosure choices. A reconstructed tab deliberately opens at the latest output instead of applying its stored pixel position. Stable keys identify Turn, reasoning, Tool, context, Usage, and timing disclosures, so each row can retain its open state independently. This state is presentation-only and never enters the DSH session log.

History remains a contiguous DSH-owned event window. Initial loading extends the bounded Follow snapshot through at least the next older human prompt when one exists. Approaching the upper edge loads additional `session/page` records through the next older human prompt and preserves the visible scroll position while prepending them.

Submitted prompts remain in a dedicated queue area until DSH commits the matching `user/message`. Companion correlates the local submission and durable message by request id, removes the queue row, and renders the canonical message at its DSH Turn with the DSH event time. The queue baseline and replacements come from `session/control`; queued prompts are not optimistic transcript entries.

The composer model picker searches the provider-grouped `session/modelCatalog` and follows the Session's durable `modelSelection` projection. Models expose only the reasoning efforts and display metadata reported by their DSH adapter; selecting another model lets DSH resolve that model's default instead of carrying effort across routes. Selection is unavailable during a running Turn. With the current DSH operation, a Session selection also becomes the default for future Sessions.

The context ring appears only when DSH's `contextPressure` projection provides both pressure and route capacity. It prefers projected next-request tokens over the latest provider sample, caps only the visual ring at 100 percent, and exposes the approximate size and limit on hover, focus, or click. The Compact action appears only when the Session command catalog provides `/compact`; it executes that DSH command while the Agent is idle and displays its canonical result without changing context state optimistically. Durable `compaction/*` events produce a running and settled transcript activity row. While compaction runs, the prompt and model controls are locked and Stop remains available through `session.cancel`.

## Transcript presentation

User prompts use a compact VS Code-themed card. Live output follows the bottom until the user scrolls away; wheel, touch, keyboard, scrollbar, and text-selection gestures pause following before the next streamed update can override them. Returning to the bottom, using the latest-output button, or submitting another prompt resumes following. When no prompt is visible, the nearest prompt fully above the viewport is pinned at the top; if any later prompt remains visible, the earlier prompt stays unpinned until that later prompt has scrolled away. A jump button returns to the original prompt. Assistant text uses `markdown-it`; raw model HTML is escaped, unsafe links are rejected, and HTTP or HTTPS links open through VS Code. Reasoning, context injections, Tool calls, and Tool results appear inside a Turn process disclosure inspired by DSH Web. Its title summarizes the represented Reasoning, Tool Calls, and Context Injections, while a Turn without process rows shows its measured `Thought for …` duration as a non-interactive row instead of an empty disclosure.

Tool rows currently show a generic summary, raw arguments, and text result. Specialized file previews, code-copy controls, syntax highlighting, Mermaid, native file/line links, approvals, and presenter-specific cards are not available.

## Turn information

Companion derives one completed-Turn summary from DSH's durable Turn, Step, request, Assistant, and usage events. Usage aggregates recorded attempts and displays exact total, uncached input, optional cached input and cache write, output, provider/model routes, and cache-hit percentage. Reasoning is displayed only when its aggregate is greater than zero. Context occupancy is deliberately excluded.

The timing panel shows Turn wall time and, when the event sequence provides them, first-Step time to first token and aggregate decode throughput. The clock uses `turn/end.time`. Usage and timing panels preserve their open state with the tab, while opening another panel, clicking outside, or pressing Escape closes the active transient panel.

## Stop semantics

Stop targets only the current session's active Turn or Agent maintenance. It cancels the model request, cancellable in-flight Tool work, or manual compaction through DSH `session.cancel`; pending inbox entries remain. It does not clear the queue or globally stop independently owned jobs, terminals, schedules, or other sessions.

## Development connection

The current connection is fixed to `http://127.0.0.1:3081` and requires a managed source or packaged Runtime. The parent development task starts or reuses an independent lifecycle-only source supervisor, while each activated Extension Host renews a private client lease and obtains the process launch URL through the supervisor without persisting its token in the rendezvous. The extension exchanges that URL for an authority-bound cookie and retains the cookie in VS Code Secret Storage. Session streams, queue state, projections, paging, and recovery use DSH's Node Client assembly. Companion has no manual URL/token or no-supervisor connection mode. Debug restarts reuse the source Runtime; running **DSH Companion: stop runtime** or **DSH: Stop Managed Runtime** ends its process tree explicitly.

Internal Linux VSIX packages include a runtime built from the pinned official DSH commit plus an integrity-checked downstream patch series. On first activation the Extension verifies the closed payload, installs it under `globalStorageUri/runtime/versions/<companion-version>-linux-x64`, starts its supervisor against the separate persistent `dsh-home`, and records active and rollback versions only after readiness. The supervisor publishes its source or installed runtime identity; packaged activation reuses an explicit source owner and replaces a mismatched installed owner under the shared lifecycle lock. Runtime installation never modifies the Extension directory, and cleanup retains DSH data. DSH-reported idle eligibility, automatic idle shutdown, robust crash recovery, signed public builds, and External DSH mode remain unavailable.
