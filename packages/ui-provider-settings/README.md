# @dsh-companion/ui-provider-settings

DSH Web Models-page presentation for Companion provider catalogs and account allowances. The browser plugin contributes to the existing keyed provider-card slot and reads only the generated Companion Remote namespaces. It keeps request progress locally while DSH Host services remain authoritative for catalogs, account state, credentials, and settings.

## Model Experience

None. The package renders provider administration data and contributes no prompt, tool, or Session event.

### Token effect

None.

### KV Cache effect

None.

## Known Limitations and Deferred Work

The keyed Codex Wrapper Advanced and Claude Wrapper Advanced cards display connection settings, catalog freshness, discovered models, model-policy switches, plan and allowances, and explicit refresh. Live account push will replace manual refresh after the provider Remote gains a reconnect-safe snapshot stream. No runtime invariant companion is published because this browser-only presentation retains no Host state or independent event stream.
