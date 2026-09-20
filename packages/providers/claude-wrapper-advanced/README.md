# @dsh-companion/provider-claude-wrapper-advanced

Optional DSH Companion provider for an independently operated Claude Wrapper Advanced `/wire/v1` service. It strictly validates `info`, `models`, `usage`, and `responses`; registers the `claude-wrapper-advanced` DSH route; persists catalog LKG state through Companion; follows settings, credentials, and model policy; and projects quota windows into provider-account state.

The DSH model catalog uses the concise provider display name `Claude`; settings and diagnostics retain the full Claude Wrapper Advanced product name.

The adapter serializes DSH history into OpenAI-chat-like messages with tools, tool results, and images. It sends the DSH Session identity separately from the logical Turn cost scope. `thinking_progress.tokens` becomes transient `reasoning-token-progress` status with an estimated basis; final `done.usage.thinking` becomes `reasoningTokens` only when the wrapper marks it reported. The wrapper exposes no replay payload, so none is fabricated.

Validated non-null costs with `scope: call | turn` become virtual USD `ModelCallAccounting`. USD is rounded once to safe integer nanos, and the wrapper counter epoch is retained as the tariff version. Null amount, null/unknown scope, or unsafe nanos emits no accounting. `by_model` remains validated private diagnostics.

## Configuration

The provider is disabled by default. Enabling it requires an explicit service URL; credentials remain in DSH's credential store.

```yaml
- name: '@dsh-companion/provider-claude-wrapper-advanced'
  config:
    enabled: true
    baseURL: https://wrapper.example
    apiKeyEnv: CLAUDE_WRAPPER_ADVANCED_API_KEY
```

## Model Experience

The provider adds no prompt or tools of its own. It forwards DSH messages, system content, image attachments, and tool schemas.

### Token effect

No fixed addition; request size follows the forwarded Session content.

### KV Cache effect

The wrapper and Claude CLI own cache behavior. Final cache read/write counters are passed through when reported.

## Known Limitations and Deferred Work

- Requires wire cost fields `scope: call | turn | null`, positive-integer-or-null `covered_requests`, stable UUID `epoch`, and `thinking_basis`; older deployments fail strict validation instead of guessing semantics.
- Turn-scoped costs rely on the patched DSH replacement contract; the wrapper owns epoch coverage.
- `by_model` can contain internal CLI work and is not exposed yet.
- Thinking progress is estimated and transient, never a replacement for final reasoning usage.
- The wire cannot enforce DSH output caps. `maxTokens` remains unsupported for normal calls; compaction alone follows the established best-effort adapter convention and omits its cap so DSH compaction can run.
- No native replay exists.
- Public packaging and provider-specific DSH Web settings remain deferred.
