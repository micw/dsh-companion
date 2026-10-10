# Session title tool

`@dsh-companion/tool-session-title` contributes `set_session_title` when a new primary user task makes the current title stale, not for follow-ups or subtasks. The executor requires the exact live, running root calling agent in its active driver. It delegates normalization, eligibility, user-title pinning, and the logged title update to DSH's `sessionTitle.proposeFromAgent`; it never renames a session directly.

A dynamic system-prompt context reads the canonical session title and fork metadata for a live root agent. DSH materializes the context as a user-role tail snapshot for each request, including after restoring a session. For an automatic title, it asks the model to replace a stale title when the primary task changes; for a user-set title, it says not to change it. An ordinary fork instead asks for one branch-specific title until its Agent has named the new task. Neither the tool nor the context retains title state. A missing title contributes no context outside a fork, and an explicitly pinned user title produces an unchanged tool result.

## Model Experience

The tool description and title context distinguish a new primary task from follow-ups and subtasks. Calling the tool adds one tool call and result to the model transcript; a populated canonical title or fork context contributes one short user-role snapshot to subsequent model requests. The extra prompt tokens scale with the title length and reduce available context and KV-cache reuse accordingly. The tool makes no additional model request.

## Known Limitations and Deferred Work

The package does not determine whether a new request changes the primary task; the model makes that decision. The DSH title service determines eligibility and normalizes candidate titles.
