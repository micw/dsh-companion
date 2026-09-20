# DSH Companion provider for Codex Wrapper Advanced

This package connects DeepSeek Harness to an independently operated Codex Wrapper Advanced service through its authenticated `/wire/v1` HTTP and SSE API. It is an independent DSH Companion plugin and is not affiliated with or endorsed by DeepSeek or OpenAI.

The DSH model catalog uses the concise provider display name `Codex`; settings and diagnostics retain the full Codex Wrapper Advanced product name.

The wrapper process, wrapper authentication, wrapper deployment, and wrapper updates are outside this package's lifecycle. The plugin is only a client of a configured service endpoint and a provider adapter for DSH.

## Development

Requirements: Node.js 22 or newer and pnpm 11.7.

```bash
pnpm install
pnpm test
```

Local development links the pinned DSH source checkout in the sibling `deepseek-harness` directory. Distribution and optional installation policy remain undecided; development and internal builds install this package locally.

The provider is disabled by default. Enabling it requires an explicit service URL; credentials remain in DSH's credential store.

## Model Experience

The adapter maps DSH messages and tools to the wrapper's complete `/wire/v1/responses` request, then maps text, reasoning summaries, tool calls, usage, finish state, and opaque reasoning replay data back to DSH. DSH tool schemas are explicitly non-strict so the Responses endpoint preserves their optional parameters. Reasoning and tool-call blocks embedded by DSH in synthetic User input are retained as labeled inert text because the Responses User-content vocabulary cannot represent their original channels. The adapter does not add instructions or tools of its own. The Codex backend cannot enforce DSH's compaction output cap; the adapter admits that maintenance request without forwarding the cap so a Codex-routed Session remains compactable, while rejecting unsupported output caps on ordinary model calls.

### Token effect

Wire serialization preserves DSH request content. Synthetic User messages containing embedded Assistant reasoning or tool calls gain short labels that retain their meaning without presenting the tool call as executable provider input.

### KV Cache effect

The DSH Session id is sent as the wrapper `session_id`, keeping the wrapper's provider-side prompt-cache route stable across turns. Model, instructions, tools, and history remain the cache-relevant request content.

## Known Limitations and Deferred Work

The package is loadable as an optional DSH profile bundle and is installed from its checkout by the DSH Companion development runtime. Public distribution as a bundled or separately downloadable provider remains undecided.

Codex compaction relies on the summarization instruction and the backend's own output limit because the backend rejects `max_output_tokens`. Deployments that require an exact compaction cap configure DSH's dedicated summarization provider and model to a route that supports `maxTokens`.

The native adapter, dynamic catalog, account projection, settings, credentials, model policy, and browser presentation are available. Live wrapper validation through DSH's canonical Web Client covers a text Turn, cold Session restore, a successful two-Step Tool call/result round trip, reasoning output, opaque reasoning replay into a later request, and DSH Session cancellation. The VS Code Client assembly discovers the same route, submits a native provider Turn, and restores its transcript. Post-header SSE cancellation is enforced independently of Fetch implementation behavior. Live image transport remains outstanding; the current VS Code composer does not admit image attachments.
