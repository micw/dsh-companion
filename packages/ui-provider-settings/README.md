# @dsh-companion/ui-provider-settings

DSH Web Models-page presentation for Companion provider catalogs and account allowances. The browser plugin contributes to the existing keyed provider-card slot and reads only the generated Companion Remote namespaces. It keeps request progress locally while DSH Host services remain authoritative for catalogs, account state, credentials, and settings.

## Model Experience

None. The package renders provider administration data and contributes no prompt, tool, or Session event.

### Token effect

None.

### KV Cache effect

None.

## Known Limitations and Deferred Work

The first card displays catalog freshness, discovered models, plan, allowances, and explicit refresh. Endpoint/API-key editing and shared model-policy switches are not rendered yet. Live account push will replace manual refresh after the provider Remote gains a reconnect-safe snapshot stream. No runtime invariant companion is published because this browser-only presentation retains no Host state or independent event stream.
