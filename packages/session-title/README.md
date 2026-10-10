# @dsh-companion/session-title

Host Remote adapter for DSH's session-title service. `companionSessionTitle/refreshTitle(sessionId, signal)` looks up the exact live session and delegates to DSH `sessionTitle.refresh`; it returns the resulting title string or `undefined` when no eligible title input exists. `prepareForkTitle(sessionId, signal)` accepts only a live ordinary fork and refreshes only a user title inherited from its source, allowing the branch Agent to propose its own title. DSH's registered title provider may make an auxiliary model request during that refresh. An absent or no-longer-live session fails explicitly. Empty or noncanonical session IDs are rejected. No title state or generation policy is owned by Companion.

The `./remote` entry is the generated client contribution; `./typert` is the generated Host codec. Build them with `pnpm run build`, not by editing generated files.
