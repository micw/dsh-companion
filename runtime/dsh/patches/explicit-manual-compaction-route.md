# Explicit Manual Compaction Route Patch Assessment

## Requirement

DSH manual compaction normally summarizes through the latest durable routed request. A user can select a different Session provider/model after a provider-specific compaction failure, but that pending selection has not produced a new request header and therefore cannot be used for immediate recovery. Companion must not rewrite global compaction configuration or create a second compaction operation.

## Scope

The patch adds an optional `ManualCompactionTarget` to `CompactionEngine.compactNow()`. The `/compact` command accepts `--provider <id> --model <id>` and forwards that exact route for one manual summary call. The basic backend applies the explicit target ahead of configured and routed summary targets, including its exact-target policy. Automatic pressure and overflow compaction remain bound to the latest durable routed request. Existing compaction summary events continue to record the provider and model actually used.

Companion invokes the canonical command with the current durable model-selection projection. It does not retain separate compaction routing state.

## Alternatives

- Changing global compaction configuration around one command would race with automatic compaction and other Sessions.
- Treating a pending model selection as the latest routed request would conflate future routing intent with durable request history.
- Keeping manual compaction fixed to the failed provider would prevent immediate recovery through the existing model picker.

## Security assessment

The command parser accepts only the exact optional flag sequence and non-empty provider/model identifiers. DSH still resolves the named adapter and model through the normal LLM service; the patch adds no credential, endpoint, or arbitrary module input. Manual maintenance admission, cancellation, durable locking, range validation, and event ordering remain unchanged.

## Compatibility and maintenance

The target argument is optional, so existing command callers and compaction providers keep their inherited-route behavior. The public abstract method is pre-stable; every in-repository implementation and generated Cordis catalog is updated together. Every DSH upgrade re-runs command, compaction backend, generated-catalog, Companion editor, and managed-runtime checks.

## Upstream discussion

Before a public Companion release, propose the one-call manual compaction target to DSH upstream. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`; internal builds retain `null` until then.
