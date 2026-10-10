import path from 'node:path';

export interface OpenFileMessage {
  readonly type: 'openFile';
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly action?: 'open' | 'openBeside' | 'copyPath';
}

/** Validates a Webview request to open a local file after an explicit link click. */
export function isOpenFileMessage(value: unknown): value is OpenFileMessage {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'type') !== 'openFile') return false;
  const file = Reflect.get(value, 'path');
  const line = Reflect.get(value, 'line');
  const endLine = Reflect.get(value, 'endLine');
  const action = Reflect.get(value, 'action');
  return typeof file === 'string' && file.length > 0 && file.length <= 4096
    && !/[\u0000-\u001f\u007f]/u.test(file)
    && (!/^[a-z][a-z\d+.-]*:/i.test(file) || /^[a-z]:[\\/]/i.test(file))
    && (line === undefined || (Number.isSafeInteger(line) && line > 0 && line <= 999_999_999))
    && (endLine === undefined || (line !== undefined && Number.isSafeInteger(endLine)
      && endLine >= line && endLine <= 999_999_999))
    && (action === undefined || action === 'open' || action === 'openBeside' || action === 'copyPath');
}

/** Resolves an absolute or Session-relative local path without consulting process.cwd(). */
export function resolveLocalFilePath(file: string, sessionCwd: string | undefined): string | undefined {
  if (path.isAbsolute(file)) return path.normalize(file);
  if (sessionCwd === undefined || !path.isAbsolute(sessionCwd)) return undefined;
  return path.resolve(sessionCwd, file);
}

/** Preserves a workspace URI's scheme and authority for files below its deepest matching root. */
export function uriForLocalFile<Uri extends { readonly fsPath: string }>(
  file: string,
  workspaceUris: readonly Uri[],
  joinPath: (root: Uri, relative: string) => Uri,
  fileUri: (absolute: string) => Uri,
): Uri {
  let matched: { uri: Uri; relative: string } | undefined;
  for (const uri of workspaceUris) {
    const relative = path.relative(uri.fsPath, file);
    if (relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) continue;
    if (matched === undefined || uri.fsPath.length > matched.uri.fsPath.length) matched = { uri, relative };
  }
  return matched === undefined ? fileUri(file) : joinPath(matched.uri, matched.relative);
}
