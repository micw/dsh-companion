# Node Client Object Runtime Patch Assessment

## Requirement

DSH Companion runs in a Node.js VS Code Extension Host and must consume DSH-owned Connection, Gateway, Remote, Session, queue, paging, projection, and recovery behavior without loading the DSH Web presentation. Published DSH `/client` entries are browser module-table bundles and cannot be imported as Node.js ESM.

## Scope

The patch adds `@deepseek-ai/dsh-api-client-runtime`, a React-free Node.js assembly of existing DSH Client services, and lets `RemoteStreamMuxClient` accept a shell-owned URL and authenticated WebSocket factory. It does not change Agent Loop, Session persistence, Queue semantics, Host Remote methods, tools, model behavior, or the Session format.

## Alternatives

- Extending Companion's handwritten Wire client duplicates DSH synchronization and recovery behavior.
- Copying the existing Client implementation would create a substantially larger hidden fork.
- Loading the browser bundles would require DSH's browser module loader and presentation environment inside the Extension Host.

## Security assessment

The Node carrier accepts only an IPv4 loopback HTTP origin, requires a non-empty single-line authority-bound cookie, supplies matching Cookie and Origin headers on HTTP and WebSocket requests, and retains DSH's generated codecs and Remote validation. The patch adds no network listener, credential store, provider secret path, or model-visible input. Companion keeps the cookie in VS Code Secret Storage.

## Compatibility and maintenance

The assembly closes over DSH's generated Remote and Client object graph, so it must be rebuilt from the exact pinned DSH source. Every DSH upgrade re-runs Client typechecking, focused 100% coverage, Gateway tests, the real `dsh web` authentication smoke, and built-package checks. The patch is removed or reduced when DSH publishes a supported Node-compatible assembly with equivalent ownership.

## Upstream discussion

Before a public Companion release, discuss the need for a supported non-browser Node.js Client assembly with DSH upstream. The discussion should cover the product-shell consumer, authenticated socket construction, package ownership, file-upload exclusion, multi-Session bindings, and whether DSH prefers this package or another public entry point. Record the resulting Discussion or PR URL in `runtime/dsh/upstream.json`. Internal builds retain `null` to show that this action remains open.
