# DSH `dsh-v0.1.7-rc.2` Upgrade Assessment

Assessment date: 2026-09-25.

This record covers the impact review required before changing DSH Companion's embedded DSH pin from `dsh-v0.1.5-rc.2` to `dsh-v0.1.7-rc.2`. It records decisions for the current downstream patch series and identifies validation still required during implementation. A proposed patch disposition is not evidence that the resulting runtime has passed its build or product checks.

## Upstream identity

| Field | Current pin | Upgrade target |
|---|---|---|
| Version | `0.1.5-rc.2` | `0.1.7-rc.2` |
| Tag | `dsh-v0.1.5-rc.2` | `dsh-v0.1.7-rc.2` |
| Commit | `fb2c4b9e698e30edb738bca4cf0618587db7d203` | `477b4f420553e8a52c2fbccc464d7561b239c443` |
| Tree | `bd7dd6d90010a35d3d6ff9f12c1f6207d5b6fe38` | `e3e63253d1d35ad07f785273235c40813cb6c8bd` |
| Tag form | lightweight | lightweight |

The target tag was fetched from `https://github.com/deepseek-ai/deepseek-harness.git`, and its commit and tree were verified locally. The target remains a release candidate. It retains pnpm `11.7.0` and Node `^22.19.0 || >=24.0.0`, so the toolchain floor does not change between these two DSH releases.

The source delta is unusually large: the target contains 20,020 commits reachable after the current tag and changes 8,945 paths when rename detection is disabled. Compatibility must therefore be established from current APIs and behavior rather than patch context alone.

## Release change impact

### Session data and lifecycle

| Upstream change | Companion impact | Required action |
|---|---|---|
| The Session writer advances from V3 to V4. | Critical. The target reads V3 in memory and publishes a V4 successor on a write open. The `0.1.5-rc.2` runtime cannot open the highest generation after that publication. | Exercise read-only open, migration publication, interrupted migration, and existing Companion histories. Installed-runtime rollback must be marked unavailable once any Session has published V4, unless runtime selection can prove that no migrated generation exists. |
| V4 introduces tool-role results, producer-owned sources, developer messages, fork result changes, and stricter native validation. | High. Transcript projection, tool rows, attachments, forks, event validation, and cost/status additions all touch changed event types. | Rebase Client validation and transcript tests onto V4. Any retained accounting/status fields require a declared V4 persistence-type acknowledgement and current native validation, not the old V3 JSONL verifier changes. |
| DSH adds a V3-to-V4 adjacent migration and a batch migration utility. | Positive, but not a substitute for product testing. The migration preserves predecessor files while old readers refuse the newer highest generation. | Use the canonical migration; do not create a Companion migration or rewrite old generations. |
| The tagged `session-format-status.md` still records `latestReleasedVersion: 3`, although the tagged writer is V4 and `0.1.7-rc.2` is published as a prerelease. | Upstream release-record inconsistency. DSH's own policy states that prereleases establish persisted-data obligations. | Treat V4 as released for compatibility and raise the stale release record upstream; do not use the stale field to justify rollback. |
| Pending Inbox entries are restored after restart; blank Session reuse and stale blank-state reconciliation are fixed. | Positive and directly relevant to New Chat, restore, queue, and reconnect behavior. | Keep DSH authoritative; remove no Companion race handling until live and restore tests pass against the new Client. |
| Client Session references now use explicit `retain`/`release` ownership and support multiple coexisting consumers. | High. The patched Node Client assembly currently closes over the old Client object graph. | Rebuild the Node assembly from the new Connection, `ClientSessions`, retention, Session, Follow, Control, paging, and projection modules. Ensure closing one editor releases only its own reference. |
| Long-conversation initialization, paging, turn navigation, reconnect, and send failures were improved. | Positive but high regression risk because Companion consumes the same Session Client. | Re-run long-history, follow-gap, pending-submission, reconnect, and restored-tab tests without reimplementing these fixes. |
| Session archive, pinning, restoration, and active-work admission were added. | No immediate UI requirement, but Session list payloads and lifecycle state changed. | Accept and preserve new fields through the canonical Client. Do not add a competing archive state. |

### Gateway, Connection, and wire behavior

| Upstream change | Companion impact | Required action |
|---|---|---|
| Remote streams now support bidirectional uplinks and binary unary results. | High. The Node carrier patch changes `RemoteStreamMuxClient`, whose protocol now has `open`, uplink `item`/`end`, cancellation, and pump teardown. | Rebase the carrier instead of copying the old stream implementation. Preserve strict Cookie and Origin handling and support the complete current protocol. |
| Consumed data is released from long-lived Gateway streams. | Positive. | Retain upstream behavior in the Node assembly and add a long-lived follow/control smoke. |
| The multiplexed endpoint remains `/api/remote.mux`; launch-token exchange and the authority-bound Web cookie remain in use. | No transport replacement is needed. | Re-run the authenticated HTTP and WebSocket smoke with the exact target. |
| Desktop introduces a shell-owned `__DSH_TRANSPORT__` origin hook and an in-process stream carrier. | Useful prior art, but not a supported Node object assembly. The test-support Client runtime is explicitly test-only and includes presentation fixtures. | Keep a small published Node assembly patch unless upstream accepts a supported product-shell entry point. Reuse current transport seams where possible. |
| Workspace file reads converge on `readBytes`. | Low for the current VS Code surface; Companion does not call the retired workspace read methods directly. | Verify generated Remote codecs and provider/UI packages compile; use `readBytes` for any newly encountered file transport. |

### Profiles, presets, tools, and Agent behavior

| Upstream change | Companion impact | Required action |
|---|---|---|
| Agent presets move from scanned directories to declarative `@deepseek-ai/dsh-agent-preset` rows in bundle patches. | Critical. Companion's bundle still publishes a preset root and an `agent.cordis.yml`; those mechanisms no longer exist. | Convert `dsh-companion` into a bundle-declared preset row. Remove the directory scanner patch. Rebase the legacy `standard` compatibility fallback onto the new registry. |
| Existing Sessions recover by recorded preset id and fail when that definition is missing. | Critical for Companion Sessions created before the custom preset. | Keep a roster-hidden `standard -> dsh-companion` fallback or obtain an equivalent upstream alias. Merely declaring `standard` would expose it to new Sessions and violate the product requirement. |
| `agent/session-start` is replaced by awaited serial `agent/created`. | No direct Companion listener was found. Provider plugins do not use the retired event. | Verify the composed preset and all external bundles activate before first model work. |
| PTC packages and services move to the `ptc-runtime` family; the workflow executor becomes `workflow-ptc`. | High. Companion still names `@deepseek-ai/dsh-workflow-worker-thread`, which is absent from the target. | Update the duplicated preset composition to current Web preset rows and review Node PTC's process, environment, output, and memory limits. |
| Node PTC runs in a separate process with an empty `process.env`. | Potential model/tool behavior change. | Add preset drift and workflow/PTC smoke coverage; do not restore the former environment implicitly. |
| Ralph is disabled by default, E2B backends are removed, Team mode changes tools, and continuable subagent defaults change. | Ralph is currently explicitly mounted by Companion; E2B and Team are not. Subagent defaults can change behavior. | Decide deliberately whether Companion continues to expose Ralph. Reconcile current subagent and workflow rows with the target's standard preset rather than carrying old defaults accidentally. |
| Newly enabled tools can enter an ongoing conversation. | Positive. It depends on request-series and tool-history behavior introduced upstream. | Preserve current request headers and V4 developer/tool history through the Node Client; do not add Companion tool state. |
| Proactive compaction reserves output and context headroom. | Positive but does not allow one manual invocation to use a newly selected route before a request header exists. | Retain a reduced explicit manual-target patch and test it against the new compaction transaction and maintenance APIs. |

### Settings, providers, and plugins

| Upstream change | Companion impact | Required action |
|---|---|---|
| Settings move from independent namespaces and `settings.yaml` to volatile fields in the current Profile's plugin configuration. | Critical. `installSection`, `settings.register`, `SettingsScope`, and Client `settingsScope` no longer exist. Companion model policy and all three provider integrations use them. | Move configuration into each plugin's Config reference, mark supported fields volatile, and use the canonical config editor/Settings Remote. Remove the old settings service calls from every Companion package and provider repository. |
| The Models page supports installed providers, arbitrary custom pi-ai routes, model discovery, model editing, write-only credential storage, and extension slots. | High and supersedes much of the downstream provider-instance Web patch. | Replace the DSH-core provider-family and Models-page patches with external Companion services and the published `settings.models.provider-card`/`settings.models.footer` slots. Keep DSH's LLM route registry authoritative. |
| Upstream's configurable-provider directory still addresses routes, not provider families, and does not provide an atomic generic Save & Test operation. | A direct drop-in replacement for the old family controller does not exist. | Let each external Companion provider own create/update/delete/test and credential staging, while publishing configured routes through `ctx.llm` and `registerConfigurableProviders`. The Companion service must not become a second route registry. |
| Plugin bundles support ordered patch lists, compatibility checks, localized metadata, icons, runtime unloading, and selected live config fields. | Positive and relevant to external providers. | Update bundle manifests and compatibility ranges. Verify staged external bundles under the target's package and config rules. |
| Config hot reload no longer has transactional rollback after activation failure. | High for provider editing. | Provider save/test must validate and stage credentials before publishing config. Surface partial activation diagnostics and test recovery after correcting config. |
| Inspector is no longer included by default; plugin manager, browser backends, Computer Use, MCP v2, speech input, and Desktop onboarding were expanded. | No direct Companion requirement. | Do not add these built-in UI features to the VS Code shell. Ensure optional plugin failures do not prevent the Companion profile from starting. |
| Official DeepSeek uses Messages only, and V4 Flash defaults are removed. | Low because the native DeepSeek route is disabled in a fresh Companion profile. | Confirm disabled native rows still match the target composition and remove obsolete protocol assumptions if encountered. |

### Usage, accounting, and UI state

| Upstream change | Companion impact | Required action |
|---|---|---|
| DSH already retains terminal `reasoningTokens` in usage, but still has no provider-neutral monetary accounting stream or durable cost projection. | The monetary accounting requirement remains open. | Rebase the accounting patches onto V4 Assistant settlements and persistence acknowledgement machinery. |
| DSH still has no live provider-neutral reasoning-token progress status. | The OpenRouter progress requirement remains open. | Retain a model-status concept, but rebase it onto the current stream vocabulary and V4 validation. Do not convert progress into model-visible reasoning text. |
| Upstream Web adds configurable work-detail and performance/usage presentation. | No direct reuse in the VS Code Webview, and it does not supply Companion's cost data. | Keep VS Code presentation separate while consuming the same durable DSH events and projections. |
| Scheduled tasks/reminders, keyboard shortcuts, background Desktop tasks, document previews, diffs, local images, and sidebar terminals were added or improved. | Mostly Web/Desktop presentation with no direct VS Code implementation impact. Schedules and jobs matter to future idle-shutdown eligibility. | Do not duplicate these UIs during this upgrade. Preserve authoritative Session/job/schedule state and leave idle shutdown unavailable until DSH exposes the required eligibility signal. |

### Reliability and security fixes

The target includes fixes relevant to Companion even where no API changes are required: large pi-ai tool-call arguments no longer block the process; long tool output no longer corrupts characters and later requests; some long conversations no longer remain unable to send; optional plugin failures no longer abort unrelated plugins; Web module routes recover after server restart; plugin operations have bounded waits; native addons avoid concurrent first-load crashes; and reconnect distinguishes automatic from manual recovery. These fixes strengthen the case for the upgrade and must remain covered by the managed-runtime and Session smoke tests.

The Windows sandbox deletion fix is security-relevant upstream but does not change the current Linux-only managed-runtime target. It remains part of any later Windows assessment rather than being reimplemented in Companion.

## Downstream patch disposition

A fail-closed `git apply --check` against the exact target was run for every current patch in isolation. Only patch 0011 applies textually. Textual application is not a keep decision, and a failure is not by itself evidence that a requirement disappeared.

| # | Patch | Apply check | Decision | Evidence and replacement |
|---:|---|---|---|---|
| 1 | `node-client-object-runtime` | Fails | **Retain and rebase** | No supported non-browser Node Client object assembly exists. The new Desktop transport hook and test-support assembly are not product-shell APIs. Rebuild around current Client Session references and bidirectional Gateway streams. |
| 2 | `web-runtime-session-title-dependency` | Fails | **Remove** | `python/sdk-runtime/package.json` now directly includes `@deepseek-ai/dsh-session-title-llm`. The original executable-closure failure is fixed upstream. Confirm through the packaged Web health check. |
| 3 | `sea-compatible-preset-directory-scan` | Fails; source file removed | **Remove** | Preset directories are no longer scanned. Bundle-declared preset rows replace the affected mechanism. |
| 4 | `model-capabilities-and-selection-intent` | Fails | **Reduce and rebase** | `ModelCatalogModel` still omits `inputModalities` and `context.contextWindow`, so capability projection remains required. Upstream now records `adapterDefaults` on request headers and omits a defaulted effort when restoring a consumed selection, but `selectModel` still materializes the resolved default into the pending durable selection. Preserve omitted user intent in the new selection projection without undoing upstream's request-header logic. |
| 5 | `provider-neutral-model-cost-accounting` | Fails | **Retain and redesign for V4** | No upstream `ModelCallAccounting` or durable monetary projection exists. Add current persistence acknowledgements and native V4 validation; do not carry the old V3 generation edits forward mechanically. |
| 6 | `turn-cost-snapshots-and-model-status` | Fails | **Retain and redesign for V4** | No logical Turn correlation id for adapters and no provider-neutral model-status stream exist. Current terminal usage covers final reasoning-token totals only. Rebase Turn snapshots and status timelines onto current Agent Loop settlement and V4 schemas. |
| 7 | `explicit-manual-compaction-route` | Fails | **Retain and rebase** | `/compact` remains argument-free and `compactNow` has no per-call route. New pressure headroom and model policies do not solve recovery through a newly selected route. Adapt the target to current command identity, maintenance admission, and region transaction APIs. |
| 8 | `provider-families-and-instances` | Fails | **Remove from DSH; replace externally** | Upstream now has profile-owned plugin config, dynamic configurable-provider directories, arbitrary pi-ai routes, write-only credentials, and plugin compatibility. Implement Companion instance operations in external provider plugins, publish routes through canonical `ctx.llm`, and enforce family limits and atomic Save & Test in the owning provider service. Do not patch the DSH LLM service with a parallel family registry. |
| 9 | `provider-instance-models-settings` | Fails | **Remove from DSH; replace externally** | The current Models page already owns add/edit/delete, custom routes, discovery, credentials, and model fields, and publishes provider-card/footer slots. Use those slots for Companion account/catalog/instance presentation and an external add-instance flow. Remove the downstream rewrite of the core Models store. |
| 10 | `agent-preset-fallbacks` | Fails; predecessor package removed | **Retain requirement, reimplement on the new registry** | The new registry rejects a recorded missing preset id. Companion still needs old `standard` Sessions to resolve to `dsh-companion` without showing `standard` in the roster. Add a minimal fallback map to `agent-preset-registry`, or remove the patch only if upstream accepts an equivalent hidden alias. |
| 11 | `sea-client-module-proxies` | Passes | **Remove subject to executable smoke** | Upstream replaced profile link projections with installation-first runtime resolution and removes legacy `.dsh-module-fallback` trees. The Client scanner now resolves active entries through Loader internals to the owning package. Build the exact executable and prove that Companion client bundles populate `__DSH_BOOT__`; restore a reduced patch only if that smoke reproduces the old empty graph. |
| 12 | `pi-ai-provider-accounting-mapper` | Fails | **Retain and rebase** | Current `PiAiAdapter` emits token usage then finish and has no provider accounting hook. OpenRouter's reported amount is available only on terminal provider usage before generic conversion. Keep an optional provider-owned mapper after the accounting stream contract is rebased. |

Proposed result: remove patches 2 and 3; remove and replace patches 8 and 9 with external modules; conditionally remove patch 11; reduce patch 4; rebase patches 1, 5, 6, 7, 10, and 12. Patch numbering and digests must be regenerated only after these decisions are implemented and tested.

All twelve patch declarations currently have `upstreamDiscussion: null`. That remains acceptable for an internal build under the current policy, but no public release may proceed until every retained DSH change has the required upstream issue, Discussion, or PR and every removed patch's assessment is deleted with its manifest entry.

## Companion code impact outside the DSH patch series

- Convert `packages/bundle/cordis.patch.yml` from the removed `agent-presets` root configuration to the new `agent-preset-registry` plus declarative preset row.
- Replace the duplicated old `agent.cordis.yml` with the target Web preset composition, preserving only Companion's intentional product differences. `@deepseek-ai/dsh-workflow-worker-thread` is gone and must become the current workflow/PTC composition.
- Replace removed Settings APIs in `model-policy`, OpenRouter, Claude Wrapper Advanced, Codex Wrapper Advanced, and `ui-provider-settings`.
- Refactor OpenRouter's `registerProviderFamily` integration to current configurable-provider and external Companion instance operations.
- Rebuild `vscode/src/dshClient.ts` against the target Client Session reference API and regenerated Remotes. The editor tab must own and release one reference without terminating another tab's generation.
- Revalidate every Webview wire validator against V4 events, new projections, and current generated error details.
- Update the runtime build to copy every artifact returned by the target single-executable builder. The builder now stages target resources for Python and Office support in addition to the executable, ripgrep, and Office sidecar; the current Companion script copies only the executable and ripgrep.
- Keep the managed profile on `dsh-base`, `dsh-web-app`, and external Companion bundles, but validate current bundle compatibility declarations and ordered patches.
- Update feature documentation only after behavior is running; this assessment does not mark any target feature as available in Companion.

## Pre-upgrade characterization baseline

The current `0.1.5-rc.2` implementation has an executable baseline before the target APIs replace it. These checks must continue to pass or receive an explicitly reviewed successor; deleting a test with its old implementation is not sufficient.

| Behavior at the current pin | Baseline evidence | Target expectation |
|---|---|---|
| Companion package logic, Webview parsing, transcript ordering, live/restore equivalence, model/context projections, accounting, compaction projection, runtime installation, supervisor ownership, preset drift, patch integrity, client bundle materialization, and the V3 migration fixture | 102 Node tests across `tests/` and `packages/*/tests/` pass. | Preserve behavioral assertions; update only wire fixtures and implementation-specific patch inventory assertions. |
| Node Client assembly, authenticated Web launch, Gateway carrier, model capabilities and intent, accounting/status assembly, persistence validation, compaction target, provider families, Models UI, preset fallback, SEA client modules, and pi-ai mapper | 695 focused DSH tests across the 21 patch-owned spec files pass. | Every retained/reduced patch keeps equivalent focused coverage on the target. Removed DSH patches require passing upstream or external replacement tests for the same product behavior. |
| OpenRouter catalog/account/adapter, cancellation, family instances, credential rollback, rename/delete, policy, and accounting | 20 provider tests pass. | Replace family APIs without weakening create/update/delete/test, identity, credential rollback, or adapter coverage. |
| Claude Wrapper Advanced transport, catalog/account, policy, compaction, progress status, usage, cost, and failure settlement | 20 provider tests pass. | Preserve the same adapter and wire outcomes under profile-owned config. |
| Codex Wrapper Advanced transport, catalog/account merging, immutable generations, policy, compaction, reasoning replay, usage, cost, cancellation, and failure settlement | 38 provider tests pass. | Preserve the same adapter and wire outcomes under profile-owned config. |
| Built runtime authentication, dynamic Client bootstrap, Session list/search, lazy Client connection, empty provider-instance projection, distinct explicit Session creation, two simultaneous restores of one Session, and release of one restore without breaking the other | `scripts/smoke-managed-runtime.mjs` passes against the existing Linux payload. | Run the same smoke against the target payload. This is the final removal check for the SEA client-module proxy patch and the primary Node Client reference check. |
| New Chat identity | `DshClient.ensureSession()` supplies a client-generated `sessionId`; `editor.test.mjs` fixes that call contract and the managed smoke checks distinct explicit identities. | Keep explicit identity creation when adopting the target Client reference API. |
| V3 data baseline | The pinned writer deterministically reproduces `tests/fixtures/dsh-companion-v3-session.jsonl` with the retired `standard` preset id, a completed Turn, image attachment reference, request route/context, Tool call/result, reported cost, reasoning-token status, usage, and queued Inbox message. | Resolve the hidden preset fallback, open read-only without publication, publish V4 beside the unchanged V3 generation on write, preserve transcript/accounting/status/queue projections, and confirm predecessor refusal of the V4 highest generation. |
| VS Code frontend presentation | `editor.test.mjs`, `transcript-state.test.mjs`, `history-projection.test.mjs`, and Markdown tests fix the current message protocol, controls, disclosure identities, scroll behavior, and live/restore projection. | Update the tests with any message or event change. Add behavior tests for new provider operations rather than relying only on source-pattern assertions. |
| DSH Web provider presentation | Patch-owned Models component and store tests plus Companion `ui-provider-settings` server-render and bundle-materialization tests pass. | The DSH-core patch disappears; external provider-card/footer components must cover empty, create, edit, test, refusal, credential non-display, delete, and reload states. |

The baseline was run directly with the existing built artifacts because `pnpm` is unavailable on the current shell `PATH`. The standard `pnpm test` build-first command remains mandatory once the toolchain is available; direct Node execution does not establish that generated output is fresh. The VS Code TypeScript compiler passes after fixing explicit New Chat identity creation.

The checked-in migration fixture is generated through the current Session store and JSONL persistence writer rather than hand-authored. Its current-writer reproduction test must be replaced, not deleted, by the target migration and predecessor-refusal tests when the pin advances.

## Upgrade checklist status

### Upstream identity

- [x] Select and locally verify the exact official tag, commit, and tree.
- [x] Update `runtime/dsh/upstream.json` with the replacement patch series.
- [x] Review release notes and the tagged Session-format status.
- [x] Review Node and package-manager requirements; unchanged.
- [x] Review native/build target changes; the existing Node 24 Linux target remains available, but its artifact set expanded.

### Upstream discussions and patches

- [x] Review every patch requirement against the target source.
- [x] Classify every patch as retain, reduce, remove, or external replacement.
- [x] Run fail-closed textual application checks against the exact target.
- [ ] Create or update upstream references for every retained patch.
- [x] Regenerate patches, assessments, affected-module lists, series order, and SHA-256 values.
- [x] Run each retained patch's focused DSH checks.

### Companion workarounds

- [x] Identify the current canonical Connection, Gateway, Remote, and Session Client concepts.
- [x] Identify old Settings and preset APIs that must be removed from Companion.
- [x] Identify DSH-core provider patches that can move to external Companion modules.
- [x] Implement the new Node Client assembly and update every consumer.
- [x] Update `backlog.md` and verify `features.md` after resulting behavior is known.

### Wire and data compatibility

- [x] Confirm `/api/remote.mux`, HTTP `/api`, launch-token exchange, and cookie authentication remain the transport.
- [x] Identify bidirectional stream and binary-result protocol changes.
- [x] Identify V3-to-V4 migration and predecessor refusal.
- [x] Determine that automatic runtime rollback is unsafe after a V4 generation is published.
- [x] Diff and regenerate the exact Remote namespaces and codecs consumed by Companion.
- [x] Open representative existing Companion Sessions read-only under the target.
- [x] Publish a V4 successor in an isolated copy and validate transcript, queue, cost, status, attachment, and tool-role projections.
- [ ] Validate settings/profile import, credentials, Workspace storage, provider catalog LKG data, and search-index compatibility.

### Runtime lifecycle

- [x] Inspect target executable-builder inputs and outputs.
- [x] Build the patched Linux payload and inventory executable, ripgrep, Office, and primary-runtime resources.
- [x] Run isolated health, Session-create, client-module graph, and provider-bundle smokes.
- [ ] Test first install, reuse, failed staging, upgrade, cleanup, and rollback refusal after V4 publication.
- [ ] Test exclusive ownership, Extension Host reload, source/installed handoff, crash recovery, and explicit stop.
- [x] Keep idle shutdown unavailable until DSH reports complete eligibility for Sessions, queues, Jobs, Workflows, Terminals, Schedules, Agents, and Subagents.

### Product behavior

- [x] New Chat always creates a new DSH Session.
- [x] Restored tabs retain the same Session and reacquire independent Client references.
- [x] Follow, Control, streaming, settlement, paging, and gap repair pass live and restore tests.
- [x] Pending submission and Queue cross-stream races pass live and restore tests.
- [x] Stop cancels the active Session work without clearing pending Inbox entries or unrelated work.
- [x] Model selection, capabilities, Context Pressure, and explicit-target manual compaction pass.
- [x] Provider instance create/update/delete/test and credential replacement pass through external plugins.
- [x] Approvals, questions, Session management, and queue editing remain accurately reported as available or unavailable.

### Packaging evidence

- [x] Run Companion `pnpm test` after code and patch updates.
- [x] Run runtime preparation and verification tests.
- [x] Run every retained patch assessment's focused DSH checks.
- [ ] Build and inspect a clean Linux VSIX.
- [ ] Install it in a clean Extension Development Host and start the embedded runtime without system DSH.
- [ ] Verify manifest identity, patch and payload digests, target, and complete artifact inventory.
- [ ] Scan generated artifacts for secrets, launch tokens, private paths, and untracked development files.

## Implementation order

1. Convert the Companion profile and preset to the target composition and replace removed Settings APIs.
2. Move provider instance management off DSH-core patches and onto current external plugin and Models-slot APIs.
3. Rebase the Node Client runtime and generated Remote consumers.
4. Rebase the capability, accounting, status, compaction, preset-fallback, and pi-ai mapper patches onto the exact target.
5. Build the executable before deciding patch 11 finally; keep it only if the client-module graph smoke fails without it.
6. Update the pin and patch manifest after the complete series applies fail-closed.
7. Execute data, runtime, product, and packaging validation, then update current feature documentation.
