# Settings editor

The native Settings editor manages the connected DSH Runtime. It is independent of chat tabs and does not create, attach, or submit a Session. The existing DSH Client supplies canonical provider, model-policy, credential, and search operations; there is no VS Code `settings.json` copy of these values. The authority label identifies the Extension Host's local or Remote machine. Committed model-provider changes refresh the presentation of existing chat Clients without restarting the Runtime or replacing their Sessions.

## Presentation and connection

Models and Web Search are categories in one editor. Each category has a compact overview and separate editing forms. The content column is the only vertical scroll region; narrow layouts move category navigation above it. Persisted Webview state includes only category, selected stable id, and bounded scroll position. Draft fields and keys are never persisted or backed up.

The initial connection admits a complete Models/Search snapshot together. Connection loss retains the loaded values and disables mutations. A new connection generation reloads canonical values and invalidates pending responses; cancelled or stale mutations are never replayed automatically. Search status polling is limited to a visible Search category and updates existing rows without resetting focus, disclosure state, forms, or scroll position. Web Search has no manual Refresh control. Explicit retry locks only its selected access.

## Draft protection

The editor uses a `CustomEditorProvider` with one virtual resource and a content-change dirty marker. VS Code owns the close/discard prompt. Dirty category navigation asks for confirmation through the Extension Host. The form's Save reads its password input once, clears the input before delivery, and commits through validated canonical operations. Failed saves retain non-secret input and the dirty marker, but require the key to be re-entered. Native revert clears the ephemeral draft. A successful explicit form save clears the native dirty marker when this editor is active.

The Custom Editor API does not supply a save reason, so it cannot reliably distinguish native Save from file autosave. While VS Code file autosave is enabled, dirty native-save requests are rejected before requesting or submitting a draft; users apply changes with the form's Save button. With file autosave disabled, native Save requests the same form save. The extension never changes the user's file-autosave configuration. Backup records restore only the virtual editor identity; they do not preserve drafts or credentials.

## Validation

Settings messages and submitted values are bounded and validated before dispatch. Handwritten browser snapshots are validated before publication. RPC failures use generic diagnostics rather than raw credential, provider-response, or user-content errors. Editor tests cover singleton opening, late connection disposal, dirty Save/revert, autosave denial, generation changes, stable live rows, navigation restore, partial initial loads, readonly states, and password handling. Browser smoke checks additionally exercise wide/narrow layouts and the single scroll region without contacting search providers.

`pnpm run test:settings-native` opens an isolated desktop VS Code window with temporary user data, copied presentation assets, and mocked DSH services. It checks the real Custom Editor registration, Webview script/IPC startup, singleton focus, native dirty/save behavior, autosave denial, and close. It does not start a DSH Runtime or use the current window's credentials. The VS Code CLI must be available as `code`, or supplied through `DSH_COMPANION_CODE`.
