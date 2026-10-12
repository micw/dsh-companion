# @dsh-companion/bundle

Profile bundle for the DSH Companion agent preset and generic Host plugins. It makes the single `dsh-companion` system preset authoritative, starts the native DeepSeek route disabled, enables the durable derived Session full-text index on first search, and mounts provider catalog LKG storage, live provider account state, the DSH-owned session-title refresh Remote, and the shared settings-backed model policy. It selects Companion's prioritized Brave/Exa Web Search router while retaining DSH's anonymous HTTP fetch; model-provider adapters remain separate optional bundles.

## Model Experience

The `dsh-companion` preset provides DSH's standard coding-agent composition except fork-based delegation and includes a Companion-only current-Session title proposal Tool. Fresh subagents, Goals, plans, compaction, workflows, and the standard Tool set remain available. `web_fetch` remains keyless, while `web_search` returns cited Brave or Exa results with silent failover and requires at least one enabled access with a working credential.

### Token effect

The omitted `subagent_fork` Tool schema reduces the stable Tool prefix relative to DSH's standard preset. `set_session_title` adds one small stable Tool schema; its current title snapshot is a durable user-role context near the request tail.

### KV Cache effect

Stable while the Companion preset is unchanged. A title change appends a new runtime-context snapshot instead of rewriting the system-prompt prefix. Fresh subagents inherit the same preset as their Parent.

## Known Limitations and Deferred Work

The preset duplicates the pinned DSH standard composition because DSH presets do not support inheritance. A drift test requires every upstream composition change to be reviewed while preserving the intentional omission of `subagent_fork`. The bundle provides generic provider infrastructure and its DSH Web settings presentation, but no provider-specific adapter. OpenAI and OpenRouter remain available through DSH's add-provider catalog; each external wrapper provider remains an optional bundle with its own deployment and authentication requirements. No provider route is active in a fresh Companion profile until the user configures one.
