# DSH Companion provider for Codex Wrapper Advanced

This package connects DeepSeek Harness to an independently operated Codex Wrapper Advanced service through its authenticated `/wire/v1` HTTP and SSE API. It is an independent DSH Companion plugin and is not affiliated with or endorsed by DeepSeek or OpenAI.

The DSH model catalog uses the concise provider display name `Codex`; settings and diagnostics retain the full Codex Wrapper Advanced product name.

The wrapper process, wrapper authentication, wrapper deployment, and wrapper updates are outside this package's lifecycle. The plugin is only a client of a configured service endpoint and a provider adapter for DSH.

## Development

Requirements: Node.js 22 or newer and pnpm 11.7.

Run installation and focused checks from the DSH Companion monorepo root:

```bash
pnpm install
pnpm --filter @dsh-companion/provider-codex-wrapper-advanced test
```

This package is part of the root pnpm workspace; internal Companion dependencies use `workspace:*`. Local development links the pinned DSH source checkout in `../deepseek-harness` relative to the monorepo root (`../../../../deepseek-harness` relative to this package). Distribution and optional installation policy remain undecided; development and internal builds install this package locally.

The provider is disabled by default. Enabling it requires an explicit service URL; credentials remain in DSH's credential store.

## Model-step recovery

The provider uses DSH's shipped `llm-retry` plugin, not a second HTTP retry loop. The retry budget belongs to one provider and resolved policy within the current step; changing either can select a different budget. Its configurable `retryPolicy` defaults to three retries with exponential delays starting at two seconds, ten-percent jitter, and a ten-second maximum delay. Eligible failures are provider unavailability, transport failure, premature stream closure, timeout, rate limiting, and an empty response. DSH honors supported `Retry-After` delays within that maximum. Set normal-mode `maxRetries` to zero to disable automatic recovery.

Recovery repeats only the failed model step from committed history. Completed earlier tool calls and their results remain in history and are not executed again. Failed partial text and tool-call blocks remain diagnostic attempts; they do not become model context or executable tool calls. This is a new model generation, not resumption of a partial stream, and may incur additional provider usage. Stop cancels the backoff. Existing DSH retry events drive live and restored retry presentation.

HTTP 507 upstream retry-buffer limits, authentication failures, invalid requests, and protocol-validation errors remain terminal. For legacy wrapper failure events without structured transport information, only the exact observed response-body decoding error is additionally classified as transport; arbitrary `PROVIDER_ERROR` messages are not retried. The wrapper remains responsible for its own upstream retries.

## Model Experience

The adapter maps DSH messages and tools to the wrapper's complete `/wire/v1/responses` request, sends that JSON body with Zstandard request compression when Node provides it, then maps text, reasoning summaries, tool calls, usage, finish state, and opaque reasoning replay data back to DSH. Older Node 22 builds without native Zstandard send ordinary JSON. DSH tool schemas are explicitly non-strict so the Responses endpoint preserves their optional parameters. Reasoning and tool-call blocks embedded by DSH in synthetic User input are retained as labeled inert text because the Responses User-content vocabulary cannot represent their original channels. The adapter does not add instructions or tools of its own. The Codex backend cannot enforce DSH's compaction or auxiliary session-title output cap; the adapter admits those requests without forwarding the cap so a Codex-routed Session remains compactable and receives DSH-generated titles, while rejecting unsupported output caps on ordinary model calls.

### Token effect

Wire serialization preserves DSH request content. Synthetic User messages containing embedded Assistant reasoning or tool calls gain short labels that retain their meaning without presenting the tool call as executable provider input.
The measured Sol models, including GPT-6.1 Sol, offer a separate `:long` model choice with the wrapper catalog's 872,000-token maximum instead of the 272,000-token default. The suffix changes DSH's context budget, not the model sent to the wrapper. GPT-6.1 Sol does not offer the unsupported `none` reasoning effort.

### KV Cache effect

The DSH Session id is sent as the wrapper `session_id`, keeping the wrapper's provider-side prompt-cache route stable across turns. Model, instructions, tools, and history remain the cache-relevant request content.

## Known Limitations and Deferred Work

The package is loadable as an optional DSH profile bundle and is installed from its checkout by the DSH Companion development runtime. Public distribution as a bundled or separately downloadable provider remains undecided.

Codex compaction and auxiliary title generation rely on their instructions and the backend's own output limit because the backend rejects `max_output_tokens`. Deployments that require an exact compaction or title cap configure DSH's dedicated summarization or title provider and model to a route that supports `maxTokens`.

The native adapter, dynamic catalog, account projection, settings, credentials, model policy, and browser presentation are available. Live wrapper validation through DSH's canonical Web Client covers a text Turn, cold Session restore, a successful two-Step Tool call/result round trip, reasoning output, opaque reasoning replay into a later request, and DSH Session cancellation. The VS Code Client assembly discovers the same route, submits a native provider Turn, and restores its transcript. Post-header SSE cancellation is enforced independently of Fetch implementation behavior. Live image transport remains outstanding; the current VS Code composer does not admit image attachments.
