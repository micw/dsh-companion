/** Validation for write-only Brave credentials crossing the VS Code Webview boundary. */
export const BRAVE_SEARCH_CREDENTIAL_REF = 'BRAVE_SEARCH_API_KEY';

export interface LoadBraveCredentialMessage {
  readonly type: 'loadBraveCredential';
  readonly requestId: number;
}

export interface SaveBraveCredentialMessage {
  readonly type: 'saveBraveCredential';
  readonly requestId: number;
  readonly apiKey: string;
}

/** Accept only a bounded status request with no additional fields. */
export function isLoadBraveCredentialMessage(value: unknown): value is LoadBraveCredentialMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 2 && Reflect.get(value, 'type') === 'loadBraveCredential'
    && Number.isSafeInteger(Reflect.get(value, 'requestId')) && Number(Reflect.get(value, 'requestId')) > 0;
}

/** Validate the complete write-only secret message before dispatching to DSH. */
export function isSaveBraveCredentialMessage(value: unknown): value is SaveBraveCredentialMessage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const apiKey: unknown = Reflect.get(value, 'apiKey');
  return Object.keys(value).length === 3 && Reflect.get(value, 'type') === 'saveBraveCredential'
    && Number.isSafeInteger(Reflect.get(value, 'requestId')) && Number(Reflect.get(value, 'requestId')) > 0
    && typeof apiKey === 'string' && apiKey.trim().length > 0 && apiKey.length <= 4096
    && !/[\r\n\0]/u.test(apiKey);
}
