# Configured User-Global Instruction Labels Patch Assessment

## Requirement

Companion loads shared personal instructions from `~/.agents/AGENTS.md` through the DSH agent-instructions plugin's `dshHome` configuration without changing the Runtime's `DSH_HOME`. Pinned DSH instead labels the file `$DSH_HOME/AGENTS.md` and describes a later update as applying under the internal `user-global` scope. Both claims misdescribe the configured source and its applicability.

## Scope

The patch renders the actual configured global file location as `~/...` when inside the user's home, or as an absolute path elsewhere. It recognizes those displayed paths as user-global during scope reconciliation and describes updates as applicable across workspaces. The historical `$DSH_HOME/AGENTS.md` label remains recognizable for previously logged events. Discovery, file contents, source authority, project candidate precedence, and the Runtime's data home remain unchanged. Focused DSH tests cover custom home, default home, refresh wording, and the existing scope behavior; package references are updated in both languages.

## Alternatives

- Relocating the Runtime's `DSH_HOME` to `~/.agents` would mix DSH state with shared instructions and change all DSH data paths.
- A Companion-specific replacement instruction loader would duplicate DSH's logged discovery and reconciliation behavior.
- A symbolic link under the Runtime's DSH home would require installation-side filesystem mutation and would still display the wrong source name.

## Security assessment

The displayed location is a configured file path already used for instruction reads. Paths under the user's home hide the absolute home prefix; paths outside it display their absolute location, which can enter model context and Session history. Operators should not configure private path names they cannot disclose to the chosen model. Delimiter escaping and instruction byte budgets remain DSH-owned and apply to the displayed path and update message. The change grants no read or write authority and does not elevate instruction precedence.

## Compatibility and maintenance

Previously persisted symbolic labels remain recognized as the global scope. Fresh messages use the displayed configured path; the loaded file and the typed global scope key remain unchanged. Review the patch against DSH instruction rendering on each pinned DSH upgrade and remove it when upstream displays configured user-global paths and cross-workspace applicability accurately.

## Upstream discussion

Raise the label and scope-text correction upstream before public release; the internal patch records a null discussion URL until then.
