export interface CopyTextMessage {
  readonly type: 'copyText';
  readonly format: 'plain' | 'html';
  readonly text: string;
}

/** Admit only bounded text-copy requests from the Webview. */
export function isCopyTextMessage(value: unknown): value is CopyTextMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== 3 || Reflect.get(value, 'type') !== 'copyText') return false;
  const format = Reflect.get(value, 'format');
  const text = Reflect.get(value, 'text');
  return (format === 'plain' || format === 'html') && typeof text === 'string'
    && Buffer.byteLength(text, 'utf8') <= 4 * 1024 * 1024;
}
