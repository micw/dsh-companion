# @dsh-companion/bundle

Profile bundle for the DSH Companion agent preset and generic Host plugins. It makes the single `dsh-companion` system preset authoritative, starts the native DeepSeek route disabled, mounts provider catalog LKG storage, live provider account state, and the shared settings-backed model policy. Provider-specific adapters are separate optional bundles and are not dependencies of this package.

## Model Experience

The `dsh-companion` preset provides DSH's standard coding-agent composition except fork-based delegation. Fresh subagents, Goals, plans, compaction, workflows, and the standard Tool set remain available.

### Token effect

The omitted `subagent_fork` Tool schema reduces the stable Tool prefix relative to DSH's standard preset.

### KV Cache effect

Stable while the Companion preset is unchanged. Fresh subagents inherit the same preset as their Parent.

## Known Limitations and Deferred Work

The preset duplicates the pinned DSH standard composition because DSH presets do not support inheritance. A drift test requires every upstream composition change to be reviewed while preserving the intentional omission of `subagent_fork`. The bundle provides generic provider infrastructure and its DSH Web settings presentation, but no provider-specific adapter. OpenAI and OpenRouter remain available through DSH's add-provider catalog; each external wrapper provider remains an optional bundle with its own deployment and authentication requirements. No provider route is active in a fresh Companion profile until the user configures one.
