# Native DeepSeek Enablement Patch Assessment

## Requirement

A fresh DSH Companion installation must expose no usable provider route until the user explicitly enables and configures one. DSH's native DeepSeek adapter is always registered even without a credential, so it appears selectable and fails only when a request resolves the missing key. Companion needs the native route to remain discoverable in Models settings while starting inactive, matching the separately packaged wrapper providers and DSH's add-provider flow for OpenAI and OpenRouter.

## Scope

The patch adds an `enabled` boolean to `@deepseek-ai/dsh-llm-deepseek`, defaulting to `true` for upstream compatibility. Route registration follows the hot-reloaded Settings value: disabling atomically removes `deepseek-official`, and enabling restores it with the current retry policy. The configurable-provider directory entry remains registered so the Models page can repair and activate the provider. DSH Web's curated DeepSeek editor gains an enable checkbox, and first-run credential onboarding enables the route in the same Settings write as storing the key. Companion alone pins the composition default to `false`.

## Alternatives

- Hiding DeepSeek only in Companion's model picker would leave direct DSH callers able to dispatch the route and create a second policy.
- Omitting the DeepSeek plugin would also remove its configurable-provider directory entry, preventing normal activation through Settings.
- An empty model catalog would not disable exact-route dispatch and would make restoring the built-in catalog awkward.
- Treating a missing credential as disabled keeps a failing route visible and conflates connection configuration with user activation intent.

## Security assessment

The new field can only remove or restore the adapter route already owned by the plugin. It does not bypass credential resolution, model validation, sandbox policy, or authorization. Settings validation remains the wire and durable boundary. First-run onboarding writes `enabled: true` only after an explicit user credential submission; no ambient key silently enables the Companion profile.

## Compatibility and maintenance

Deployments that omit `enabled` retain the existing enabled behavior. Existing Settings documents therefore continue to register DeepSeek unless a deployment such as Companion pins or writes `false`. Every DSH upgrade rechecks whether native configurable providers support a common activation operation; remove this patch when upstream ships equivalent behavior.

## Upstream discussion

Before a public Companion release, propose common activation semantics for native configurable providers so a deployment can start with no route while keeping provider onboarding available. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`; internal builds retain `null` until then.
