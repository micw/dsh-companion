# DSH `dsh-v0.2.0-rc.2` Upgrade Assessment

Assessment date: 2026-10-10. This upgrade applies to the product monorepo, including the optional providers under `packages/providers/`.

## Upstream identity

| Field | Previous pin | Target |
|---|---|---|
| Version | `0.1.7-rc.2` | `0.2.0-rc.2` |
| Commit | `477b4f420553e8a52c2fbccc464d7561b239c443` | `639ed015397290b3745d163aafe02ffee4aa3f84` |
| Tree | `e3e63253d1d35ad07f785273235c40813cb6c8bd` | `ac66a6a3e77f6fa396509ddfecc7beacf0cf642a` |

The official tag and tree are verified against the upstream repository. The target is a prerelease. It retains Node `^22.19.0 || >=24.0.0` and pnpm `11.7.0`. The Session writer remains V4; no new adjacent migration is introduced by this upgrade. Same-format reader compatibility still requires behavioral validation rather than an assumption of downgrade support.

Release references: [0.2.0-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1), [0.2.0-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2).

## Relevant upstream changes

- Tool-scheduling failures now record recoverable results, distinguish unknown outcomes from operations not started, and allow resumed or forked history to continue. The Companion model patch retains the upstream recovery observer and its catch/finally handling.
- The persistence schema generator produces compact reachable-type snapshots. Regenerate the catalogs and schema from target types; do not carry forward the expanded previous schema diff.
- pi-ai advances to `0.87.1`, with updated compatibility fields, model identity and reasoning replay. OpenRouter uses the same compatible dependency range, and all product DSH peers name the exact target release.
- Configuration-editor inheritance and cloning change. Canonical configuration composition, provider mutation and credential rollback remain DSH-owned.
- Standard preset composition is unchanged. Schedule-related disabled rows move to an optional bundle; Companion does not add an independent scheduler.
- Base and Web compositions add telemetry services. Managed launch continues to set `DSH_TELEMETRY_DISABLED=1`; no upgrade enables telemetry intentionally.
- The executable builder includes additional Windows sandbox assets. Retained compression must preserve the complete upstream artifact closure.

## Patch disposition

| Patch | Decision | Target assessment |
|---|---|---|
| Node client object runtime | Retain | No supported product Node Client assembly replaces it. Gateway additions are additive; preserve canonical Client references and authenticated carriers. |
| Companion model runtime semantics | Retain and rebase | Accounting, status, selection intent, model capabilities, provider families and Companion V3 extension migration remain necessary. Regenerate compact persistence/API catalogs and preserve scheduler recovery. |
| Explicit manual compaction route | Retain | Upstream still lacks a per-call summary route without changing model selection. |
| Agent preset fallbacks | Retain | Existing `standard` identities must resolve without entering the new-session roster. |
| Enhanced SEA asset compression | Retain | Upstream does not replace Zstd compression; preserve added asset inputs. |
| Agent session title proposal | Retain | No equivalent service-owned proposal operation replaces manual-pin and supersession semantics. |
| Configured global instruction labels | Retain | Target instruction loading is unchanged; source/scope labels remain necessary. |
| Empty SEA assets | Retain | Upstream pkg patch still needs the bounded empty Zstd decode fix. |

All eight discussion URLs remain absent. This assessment does not satisfy the outstanding upstream-link requirement or authorize a public release. No upstream URLs are invented. Existing patch assessments document the requirements, security implications and removal conditions.

## Validation evidence

- Previous monorepo baseline: `pnpm test`, **443 passed**, including all three optional provider suites.
- Exact target patch preparation and manifest digest verification: passed for all eight ordered patches, including whitespace-error checks.
- Patched DSH focused behavior tests: **109 files, 2,789 passed, one upstream skip**. Coverage includes Gateway, scheduler failure/resume/fork, LLM/pi-ai, accounting and status projections, manual compaction, preset fallback, title proposal, instructions, migrations and JSONL admission/publication.
- Upgraded monorepo: `pnpm test`, **443 passed**, including all optional provider suites and the Companion V3 read-only/write-publication fixture. Final direct Node execution of the complete built-artifact suite, including the new exact-peer consistency assertion: **444 passed**, no skips. Focused packaging/patch checks: **13 passed**.
- Canonical configuration inheritance/settings and telemetry checks: **8 files, 90 passed**.
- Additional scheduler-failure regression with accounting/status persistence: **2 passed**, covering resume and fork (45 unrelated tests filtered out). The upstream keyless SDK `tool-scheduler-recovery` snapshot also passes (one selected test, 181 unrelated cases filtered out).
- Patched Harness `pnpm run build`: passed for native, Host, Client and Web artifacts. Existing obsolete ignored build directories produced warnings; the isolated payload build starts from a fresh prepared tree.
- Persistence catalog and historical-format freshness checks: passed. Persistence compatibility acknowledgements match **62 roots and 9 history records**; the release archive verifies **26 records and 25 adjacent transitions**.
- Final generated Cordis catalog and seven graph documents: freshness checks passed. Title catalog corrections are folded into patch 6; final event-source references are folded into patch 7. The prepared eight-patch source is byte-identical to the tested checkout for every changed/added file.
- Isolated Linux payload build and executable health check: passed. Runtime identity: `6ca072d951d14d1017588111bdd807b3b454a0fbd41b3ee9bd218ab6d193c36f`; patch-set digest: `a1499db450b386983a1d9e1277ed9bca3edd75a75efb3256cc38ac7e0549514c`.
- Managed runtime smoke: passed against a fresh isolated home and installation, including concurrent activation, authentication, dynamic Web bootstrap, Session list/search, explicit creation, independent restore references, permissions and runtime shutdown.
- Linux VSIX packaging, including the esbuild Extension bundle: passed. The local check package contains **9,822 files** and **9,798 declared Runtime artifacts**; every embedded artifact's size and SHA-256 match the Runtime manifest, with no extra Runtime files or `.git`, `.env`, or `.dev` path entries. The package is a local validation artifact, not a published release.
- A clean graphical Extension Development Host is unavailable in this remote shell; automated installer/supervisor and managed-runtime evidence does not claim a manual VS Code activation test.

No existing user Session, credential store or profile is used by upgrade smoke tests. The active managed runtime is not restarted by source preparation or testing.
