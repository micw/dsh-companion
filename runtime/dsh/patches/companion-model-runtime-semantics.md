# Companion Model Runtime Semantics Patch Assessment

## Requirement

DSH Companion needs provider-neutral monetary accounting and model-status snapshots, exact model capabilities and selection intent, provider-family instance operations, turn identity for wrapper accounting, current V4 persistence, and migration of the Companion V3 extensions. DSH must continue to own Session, LLM routes, projections, Remote services, and durable history.

## Scope

The patch adds optional V4 settlement fields and their persistence acknowledgement, translates the retired Companion V3 accounting/status stream variants during V3→V4 migration, projects model capabilities and explicit selection intent, provides provider-family operations, maps provider-owned accounting through pi-ai, and marks V4 as released by the pinned RC tag.

## Alternatives

A Companion-owned Session or route registry would create forbidden parallel state. Provider-specific accounting in the UI would not survive restore. Dropping V3 extensions would lose released user data. The patch is therefore limited to DSH-owned APIs and persistence paths that cannot yet be supplied by external plugins.

## Security assessment

Accounting validation rejects malformed amounts and never invents unknown values. Provider-family Remote projections exclude credential values and serialize mutations per family. Status metadata is diagnostic and never model-visible. V3 migration validates the resulting V4 generation before publication.

## Compatibility and maintenance

Every Session addition is optional and recorded as same-version V4 evolution. Older V4 readers ignore it. The migration removes old raw accounting/status chunks while retaining settlement snapshots. Focused LLM, pi-ai, token-meter, Agent Loop, Session Controller, migration, persistence, Gateway, and provider tests cover the affected paths. The 0.2.0-rc.2 rebase regenerates the compact reachable-type persistence snapshot and API catalogs with the target generators, retains upstream tool-scheduler recovery, and verifies exact accounting/status settlement through failure, persistence, resume, and fork. Reassess each sub-capability on every DSH upgrade.

## Upstream discussion

No upstream discussion or pull request is linked yet. Before public release, split the retained capabilities into reviewable upstream proposals and record their URLs in the manifest.
