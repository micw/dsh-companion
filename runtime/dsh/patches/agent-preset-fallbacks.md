# Agent Preset Fallbacks Patch Assessment

## Requirement

Sessions durably record the preset id used when they were created. Companion previously created Sessions with DSH's shipped `standard` preset, but its own restricted roster exposes only `dsh-companion`. Those Sessions must remain resumable without re-exposing the shipped presets or rewriting committed Session data.

## Scope

The patch adds an optional `fallbacks` map to `@deepseek-ai/dsh-agent-presets`. Resolution still prefers an available preset with the requested id. Only when that id is unavailable does it resolve the configured replacement. Fallback keys do not appear in the roster, and the Session record retains its original preset id. Companion maps only the retired `standard` id to `dsh-companion`.

## Alternatives

- Re-exposing `standard` would let new Sessions select fork delegation again.
- Shipping a second hidden preset is impossible because DSH currently publishes every discovered preset in the roster.
- Rewriting committed Session headers would violate DSH Session-data ownership and immutable-generation rules.
- Handling the failure only in the VS Code Client would not cover DSH's resume and cold-projection paths.

## Security assessment

Fallbacks can replace the capabilities of a missing composition, so they are trusted deployment configuration beside preset roots. They do not grant a Client a new operation and cannot override an installed preset with the same id. Companion's replacement removes fork delegation relative to the retired preset.

## Compatibility and maintenance

Deployments that omit `fallbacks` retain exact existing behavior. Unknown ids still fail with the same error when neither a direct preset nor a configured replacement exists. Every DSH upgrade rechecks whether upstream supports roster-hidden compatibility aliases; remove this patch when an equivalent published API is available.

## Upstream discussion

Before a public Companion release, propose roster-hidden preset fallbacks upstream for deployments that replace shipped compositions while retaining durable Sessions. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`; internal builds retain `null` until then.
