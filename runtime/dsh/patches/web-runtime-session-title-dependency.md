# Web Runtime Session Title Dependency Patch Assessment

## Requirement

The pinned DSH single-executable build completes, but its Web profile fails at startup because `@deepseek-ai/dsh-session-title-first-prompt-llm` imports the peer `@deepseek-ai/dsh-session-title-llm` and the Python SDK runtime closure does not deploy that package. DSH Companion cannot ship a runtime that fails its isolated Web health check.

## Scope

The patch adds `@deepseek-ai/dsh-session-title-llm` to the existing `dsh-python-runtime-closure` dependencies and lockfile importer. It changes only which already-built official DSH package enters the executable's closed dependency tree. It does not change Session title behavior, profile composition, Agent behavior, Session data, wire methods, or Companion UI.

## Alternatives

- Disabling the first-prompt title provider would change the shipped Web profile and product behavior.
- Suppressing the health check would ship a runtime known not to boot.
- Copying the package after executable creation cannot make it available inside DSH's single-executable virtual filesystem.

## Security assessment

The added package is already an official workspace package required by a configured DSH provider. The change adds no listener, credential path, external download at user runtime, model input, or executable entry point. The release build retains DSH's runtime-closure verification and records the resulting executable digest.

## Compatibility and maintenance

Every runtime build runs DSH's closure verifier, complete build, single-executable packager, and isolated `dsh web` health check. Remove this patch when the pinned DSH runtime closure directly includes the peer or when DSH changes the title-provider dependency declaration so the normal deploy includes it.

## Upstream discussion

Before a public Companion release, report that `pnpm exec tsx scripts/build-exe-for-python-sdk.ts --targets node24-linux-x64` produces an executable whose Web profile cannot resolve `@deepseek-ai/dsh-session-title-llm` at `dsh-v0.1.5-rc.2`. Include the missing peer, closure manifest, and health-check error, then record the resulting issue or PR URL in `runtime/dsh/upstream.json`. Internal builds retain `null` while that report remains open.
