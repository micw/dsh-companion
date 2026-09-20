# @dsh-companion/bundle

Profile bundle for the generic DSH Companion Host plugins. It mounts provider catalog LKG storage, live provider account state, and the shared settings-backed model policy. Provider-specific adapters are separate optional bundles and are not dependencies of this package.

## Model Experience

None directly. This bundle mounts provider infrastructure but no model adapter, prompt, or tool.

### Token effect

None.

### KV Cache effect

None.

## Known Limitations and Deferred Work

The bundle provides generic provider infrastructure and its DSH Web settings presentation, but no provider-specific adapter. Each external provider remains an optional bundle with its own deployment and authentication requirements.
