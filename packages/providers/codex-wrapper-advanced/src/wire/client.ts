/** Authenticated HTTP client for an independently operated wrapper service. */

import { attributionHeaders, LlmError, ProviderRequestId } from '@deepseek-ai/dsh-llm'
import type { ProviderRequestId as ProviderRequestIdType } from '@deepseek-ai/dsh-llm'
import { parseCodexWireSse } from './sse.js'
import type {
  CodexWireCatalog,
  CodexWireEvent,
  CodexWireRequest,
  CodexWireServiceInfo,
  CodexWireUsageReport,
} from './types.js'
import {
  parseCodexWireCatalog,
  parseCodexWireServiceInfo,
  parseCodexWireUsageReport,
} from './validation.js'

const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024

/** Immutable endpoint and credential facts captured for one client generation. */
export interface CodexWireConnection {
  /** Service root; the client appends `/wire/v1`. */
  readonly baseURL: string
  /** Raw API key resolved through DSH Credentials for this generation. */
  readonly apiKey: string
}

/** Testable transport constructor options. */
export interface CodexWireClientOptions {
  readonly fetch?: typeof fetch
}

/** Client for the complete version-1 wrapper service API consumed by this provider. */
export class CodexWireClient {
  private readonly baseURL: string
  private readonly apiKey: string
  private readonly fetch: typeof fetch

  constructor(connection: CodexWireConnection, options: CodexWireClientOptions = {}) {
    this.baseURL = normalizeServiceRoot(connection.baseURL)
    if (connection.apiKey.length === 0) throw new LlmError('Codex Wrapper Advanced API key is empty', 'INVALID_CREDENTIAL')
    this.apiKey = connection.apiKey
    this.fetch = options.fetch ?? globalThis.fetch
  }

  /** Read and validate wrapper service identity without changing provider state. */
  async info(signal?: AbortSignal): Promise<CodexWireServiceInfo> {
    return parseCodexWireServiceInfo(await this.getJson('info', signal))
  }

  /** Read and validate the complete wrapper model catalog. */
  async models(signal?: AbortSignal): Promise<CodexWireCatalog> {
    return parseCodexWireCatalog(await this.getJson('models', signal))
  }

  /** Read and validate the complete account/quota report. */
  async usage(signal?: AbortSignal): Promise<CodexWireUsageReport> {
    return parseCodexWireUsageReport(await this.getJson('usage', signal))
  }

  /** Start one model request and return its validated SSE events. */
  async responses(request: CodexWireRequest, signal?: AbortSignal): Promise<AsyncIterable<CodexWireEvent>> {
    const response = await this.request('responses', {
      method: 'POST',
      ...signal === undefined ? {} : { signal },
      headers: { 'content-type': 'application/json', 'accept': 'text/event-stream' },
      body: JSON.stringify(request),
    })
    if (!response.ok) throw await responseError(response)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'text/event-stream') {
      await response.body?.cancel()
      const id = requestId(response)
      throw new LlmError(
        `Codex Wrapper Advanced responses endpoint returned ${contentType ?? 'no content type'} instead of text/event-stream`,
        'PROTOCOL',
        { status: response.status, ...id === undefined ? {} : { requestId: id } },
      )
    }
    if (response.body === null) {
      throw new LlmError('Codex Wrapper Advanced responses endpoint returned no body', 'EMPTY_RESPONSE')
    }
    return parseCodexWireSse(response.body, undefined, signal)
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request(path, {
      method: 'GET',
      ...signal === undefined ? {} : { signal },
      headers: { accept: 'application/json' },
    })
    if (!response.ok) throw await responseError(response)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      await response.body?.cancel()
      const id = requestId(response)
      throw new LlmError(
        `Codex Wrapper Advanced ${path} endpoint returned ${contentType ?? 'no content type'} instead of application/json`,
        'PROTOCOL',
        { status: response.status, ...id === undefined ? {} : { requestId: id } },
      )
    }
    const text = await readBounded(response, MAX_JSON_RESPONSE_BYTES, path)
    try {
      return JSON.parse(text)
    } catch (error: unknown) {
      const id = requestId(response)
      throw new LlmError(`Codex Wrapper Advanced ${path} endpoint returned invalid JSON`, 'PROTOCOL', {
        cause: error,
        status: response.status,
        ...id === undefined ? {} : { requestId: id },
      })
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(`${this.baseURL}/wire/v1/${path}`, {
        ...init,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...attributionHeaders(),
          ...init.headers,
        },
      })
    } catch (error: unknown) {
      if (init.signal?.aborted) {
        throw new LlmError('Codex Wrapper Advanced request aborted by caller', 'ABORTED', { cause: error })
      }
      throw new LlmError(`Codex Wrapper Advanced ${path} request failed`, 'TRANSPORT', { cause: error })
    }
  }
}

/** Validate and canonicalize one configured service root without adding protocol paths. */
export function normalizeServiceRoot(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw new LlmError('Codex Wrapper Advanced baseURL must be an absolute HTTP or HTTPS URL', 'INVALID_CONFIG', {
      cause: error,
    })
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '') {
    throw new LlmError(
      'Codex Wrapper Advanced baseURL must be an HTTP or HTTPS service root without credentials, query, or fragment',
      'INVALID_CONFIG',
    )
  }
  return url.href.replace(/\/+$/u, '')
}

async function responseError(response: Response): Promise<LlmError> {
  const raw = await readBounded(response, MAX_ERROR_RESPONSE_BYTES, 'error')
  let message = `Codex Wrapper Advanced answered HTTP ${String(response.status)}`
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
      && parsed.error.message.length > 0) message = parsed.error.message
  } catch {
    // The status remains authoritative when an intermediary returns non-JSON error text.
  }
  const delay = retryAfter(response.headers.get('retry-after'))
  const id = requestId(response)
  return new LlmError(message, httpErrorCode(response.status), {
    status: response.status,
    ...delay === undefined ? {} : { providerRetryAfterMs: delay },
    ...id === undefined ? {} : { requestId: id },
  })
}

async function readBounded(response: Response, limit: number, label: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel()
    throw new LlmError(`Codex Wrapper Advanced ${label} response exceeds ${String(limit)} bytes`, 'RESPONSE_TOO_LARGE')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      const chunk = new Uint8Array(result.value)
      total += chunk.byteLength
      if (total > limit) {
        throw new LlmError(`Codex Wrapper Advanced ${label} response exceeds ${String(limit)} bytes`, 'RESPONSE_TOO_LARGE')
      }
      chunks.push(chunk)
    }
  } finally {
    await reader.cancel().catch(() => {
      // The bounded reader owns this response body; cancellation after drain or overflow is cleanup.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400 || status === 422) return 'INVALID_REQUEST'
  if (status === 413) return 'REQUEST_TOO_LARGE'
  if (status >= 500) return 'PROVIDER_UNAVAILABLE'
  return `HTTP_${String(status)}`
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return undefined
  const delay = date - Date.now()
  return delay > 0 ? delay : undefined
}

function requestId(response: Response): ProviderRequestIdType | undefined {
  for (const name of ['x-request-id', 'request-id']) {
    const value = response.headers.get(name)?.trim()
    if (value !== undefined && value.length > 0) return ProviderRequestId(value)
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
