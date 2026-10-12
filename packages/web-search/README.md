# @dsh-companion/web-search

DSH Companion's `dsh-companion-search` provider routes DSH's existing `web_search` requests through ordered Brave and Exa accesses. `web_fetch` is unchanged. Configuration and credentials belong to DSH; failures are stored in the `dsh_companion_web_search` Storage domain. No Session is created by settings or Retry.

## Configuration

| Field | Default | Behavior |
|---|---|---|
| `entries` | One enabled `legacy-brave` access referencing `BRAVE_SEARCH_API_KEY` | At most 32 unique access ids, each with `family` (`brave` or `exa`), `displayName`, `enabled`, and `credentialRef`. Order determines priority. |
| `revision` | `0` | Optimistic-concurrency revision maintained by management operations. |
| `cooldownMs` | `14400000` | Four-hour fallback when a failed provider supplies no relevant retry time; configurable from one second to 30 days. |
| `attemptTimeoutMs` | `10000` | Per-access deadline, configurable from one to 60 seconds, within the caller's overall deadline. |

All fields are volatile: DSH's config editor commits updates without restarting the plugin. The VS Code settings manager uses the generated `companionWebSearch.manage` Remote for listing, saving, removing, moving, changing cooldown, and retrying. Stored keys are never returned. New or replaced keys are staged under independent credential references before configuration commits; failed commits remove the staged key. Removed or superseded Companion-owned references are cleared, while legacy/shared references remain untouched. Launch-environment credentials are read-only.

## Failure and retry behavior

An enabled access is tried in order. A valid empty result is success. Authentication failures remain blocked until key replacement or a successful explicit retry. Quota, rate-limit, connection, server, response, and per-attempt timeout failures silently advance to the next access and retain sanitized failure metadata. Brave quota resets use exhausted nonzero long-window limits, not the per-second or unlimited window; other authoritative Retry-After times take precedence over the default cooldown. Request-validation failures, caller cancellation, and storage failures do not trigger failover.

A newly eligible access admits one probe; concurrent searches use another access while that probe runs. Healthy requests serialize per access, and waiting requests recheck cooldown after settlement. Success clears the durable failure and restores priority. Retry executes exactly one search for `example domain` with one result on the selected access, even when disabled or blocked, without fallback. Retry may incur provider charges. Key replacement prevents an earlier request from publishing into the new key generation.

Credential-bearing requests use fixed official endpoints and reject redirects. Responses are limited to 2 MiB and validated before returning DSH source objects. Failure messages do not contain keys, provider bodies, access names, or search queries. Failure metadata contains no search results or user content.

## Model Experience

Successful calls return the existing cited-source format, without fallback notices or settings state. When no access can complete the search, the Tool reports an aggregate unavailable error. Brave uses web-only moderate-safe-search results; Exa uses auto search with highlights and does not request generated answers.

### Token effect

No new Tool schema or routing context. Returned result excerpts use DSH's existing output limits.

### KV Cache effect

Configuration and cooldown changes do not alter the stable Tool prefix or inject model context.

## Known Limitations and Deferred Work

Access management is currently presented only in VS Code, although its canonical Remote is mounted in DSH Web. No automatic balance lookup or spending cap is implemented: postpaid providers may continue accepting billed requests after free credits run out, so configure provider-enforced caps where required. Persistent failures are restored through DSH Storage; active probes are process-local and are cancelled on disposal. No invariant companion is published because configuration, credentials, and failure records remain owned by their DSH services rather than parallel canonical stores.
