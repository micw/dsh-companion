# Provider Instance Models Settings Patch Assessment

## Requirement

DSH Web's Models page joins active routes with the configurable-provider directory and infers configuration from settings paths. That presentation renders dormant providers as rows, cannot add multiple instances of one family, sequences settings and credential writes in the browser, and contains a provider-specific DeepSeek onboarding step. DSH Companion needs the Web UI to consume the same authoritative family operations as the VS Code shell.

## Scope

The patch extends the Client Remote assembly with provider-family and instance types. The Models store loads installed families and configured instances separately from active routes and redacted settings. When a family is installed, the page renders only configured instances and an Add Provider dialog. The common editor submits display name, enabled state, base URL, and an optional write-only credential replacement through `saveProviderInstance`; deletion uses `deleteProviderInstance`. Host diagnostics remain inline, and provider-card/footer slots remain available for external provider presentation.

The predecessor configurable-provider editor remains active only when no family is installed, preserving upstream profiles during migration. The hard-coded official-DeepSeek credential onboarding dialog and its readiness projection are removed; a profile with no provider instances uses the generic Models empty state.

## Alternatives

- Teaching the old row join about repeated directory entries would retain settings-path inference and browser-coordinated writes.
- Building the provider manager only in VS Code would leave DSH Web with a conflicting configuration model.
- Keeping DeepSeek as a privileged first-run step would contradict an installation with no configured family and would make one provider identity part of generic UI policy.
- Sending family-specific React components from the Host would cross the Client plugin composition boundary; external UI continues through Slots.

## Security assessment

Credential inputs use password controls and enter only the authenticated `saveProviderInstance` request. The Client never reads a credential value, stores one in settings, or includes one in provider-card owner props. Refused saves display Host diagnostics without echoing the submitted credential. Settings descriptors remain redacted, links and model output behavior are unchanged, and all new product copy remains locale-owned.

## Compatibility and maintenance

The old configurable-provider components and tests remain for upstream adapters during migration. Provider-family behavior has focused empty-state, Save & Test, refusal, credential non-display, store, HMR, and GUI-suite coverage. Every DSH upgrade reruns `test:gui`, Client typecheck, Web replay, and Companion provider integration tests. Remove the patch when DSH Web consumes upstream provider-family APIs.

## Upstream discussion

Submit the generic family/instance Models presentation with the Core provider API proposal. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`; internal builds retain `null` until then.
