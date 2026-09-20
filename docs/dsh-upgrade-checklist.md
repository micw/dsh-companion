# DSH Upgrade Checklist

Use this checklist for every change to the DSH version embedded in DSH Companion. Complete it against a clean tracked Companion tree and an exact upstream DSH checkout; do not treat a successful patch application as compatibility evidence.

## Upstream identity

- [ ] Select an exact official DSH tag and commit.
- [ ] Verify that the tag resolves to the recorded commit and tree.
- [ ] Update `runtime/dsh/upstream.json` without changing checked-in package versions.
- [ ] Review the DSH release notes, Session format status, supported Node versions, and native target requirements.

## Upstream discussions and patches

- [ ] Review every Discussion, PR, and issue referenced by a patch assessment.
- [ ] Record which DSH release resolves each upstream request, if any.
- [ ] Re-evaluate every patch as `retain`, `reduce`, or `remove`.
- [ ] Prefer a published DSH module over a downstream patch whenever it supplies the required ownership and behavior.
- [ ] Regenerate the ordered patch files and SHA-256 values from reviewed commits.
- [ ] Confirm that each patch applies fail-closed to the exact upstream tree without fuzz.
- [ ] Confirm that patch assessments still name the complete affected modules, security consequences, and removal condition.

## Companion workarounds

- [ ] Confirm that Connection, generated Remotes, Session synchronization, queue state, paging, and recovery still use the managed DSH Client module without a direct Wire fallback.
- [ ] Remove code superseded by published or patched DSH Client modules.
- [ ] Retain Companion code only for VS Code lifecycle, presentation, and explicitly documented gaps.
- [ ] Review `backlog.md` and remove completed entries rather than preserving upgrade history.
- [ ] Update `features.md` to describe the resulting current behavior and limits.

## Wire and data compatibility

- [ ] Compare generated Remote namespaces and codecs used by Companion.
- [ ] Check Connection authentication, launch-token exchange, Cookie/Origin handling, and `/api/remote.mux` behavior.
- [ ] Check the DSH Session writer version and every newly required Session event.
- [ ] Open existing Companion Sessions read-only before any migration test.
- [ ] Exercise a write with the new runtime and determine whether the previous runtime can still open the highest generation.
- [ ] Mark rollback unavailable when the previous runtime would refuse data written by the new runtime.
- [ ] Check settings, credentials, Workspace storage, projection cache, attachments, and search-index compatibility.

## Runtime lifecycle

- [ ] Build the Linux runtime payload from the prepared patched source.
- [ ] Verify the payload manifest, target, executable files, modes, and SHA-256 values.
- [ ] Install into a fresh staging directory under VS Code global storage.
- [ ] Prove that activation never overwrites an immutable installed version.
- [ ] Health-check the staged DSH runtime against an isolated DSH home.
- [ ] Test first install, normal reuse, failed staging cleanup, upgrade, rollback, and stale-version cleanup.
- [ ] Test exclusive ownership when two Extension Hosts start concurrently.
- [ ] Test Extension Host reload while DSH continues running.
- [ ] Test controlled installed-to-source and source-to-installed runtime handoff with one shared Companion DSH home.
- [ ] Test DSH crash recovery and explicit managed-runtime stop.
- [ ] Verify that idle shutdown waits for no clients and DSH-reported shutdown eligibility; active Schedules, Agents, queued work, Jobs, Workflows, Terminals, and Subagents must block it.

## Product behavior

- [ ] Create a new Session rather than reusing local tab state.
- [ ] Restore multiple tabs and their authoritative DSH Sessions.
- [ ] Exercise Follow, Control, live Assistant streaming, durable settlement, paging, and gap repair.
- [ ] Exercise pending submission and Queue races.
- [ ] Exercise Stop, model selection, Context Pressure, and manual compaction.
- [ ] Exercise approvals, questions, Session management, and queue editing when those features are available.

## Packaging evidence

- [ ] Run `pnpm test` in DSH Companion.
- [ ] Run the Companion runtime preparation and verification tests.
- [ ] Run the checks named by every retained DSH patch assessment.
- [ ] Build a clean Linux VSIX and inspect its exact file list.
- [ ] Install the VSIX into a clean Extension Development Host and start its embedded runtime without system DSH.
- [ ] Record the Companion version, DSH upstream identity, patch digests, payload digests, and target in the staged runtime manifest.
- [ ] Confirm that generated artifacts contain no launch token, provider secret, private path, or untracked development file.
