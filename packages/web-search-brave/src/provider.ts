/** Brave Web Search API adapter for the published DSH web provider seam. */
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/** Stable provider identifier. */
export const BRAVE_PROVIDER_ID = 'brave'
/** Official API endpoint; alternate endpoints are intentionally unsupported to protect credentials. */
export const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_RESULTS = 20

/** Resolve the credential afresh for every operation. */
export interface BraveSearchProviderOptions {
  resolveApiKey: () => Promise<string | undefined>
}

/** Map a validated Brave web result to a DSH source. */
export function mapBraveResult(value: unknown): WebSearchSource | undefined {
  if (!record(value) || typeof value.url !== 'string' || !/^https?:\/\//u.test(value.url)) return undefined
  return {
    url: value.url,
    ...typeof value.title === 'string' && value.title.length ? { title: value.title } : {},
    ...typeof value.description === 'string' && value.description.length ? { snippet: value.description } : {},
    ...typeof value.page_age === 'string' && isIsoTimestamp(value.page_age) ? { publishedAt: value.page_age } : {},
  }
}

/** Parse only the web results; Brave's other response sections are not generated answers. */
export function mapBraveResponse(value: unknown, limit = MAX_RESULTS): WebSearchResult {
  if (!record(value) || !record(value.web) || !Array.isArray(value.web.results)) throw providerError('Brave returned malformed web results')
  const sources = value.web.results.slice(0, limit).map(mapBraveResult).filter((source): source is WebSearchSource => source !== undefined)
  return { sources, truncated: value.web.results.length > limit }
}

/** DSH search provider backed by the official Brave Web Search endpoint. */
export class BraveSearchProvider implements WebSearchProvider {
  readonly id = BRAVE_PROVIDER_ID
  constructor(private readonly options: BraveSearchProviderOptions) {}
  available(): boolean { return true }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted) throw aborted(signal.reason)
    let key: string | undefined
    try { key = await this.options.resolveApiKey() } catch (error) {
      if (signal?.aborted || isAbort(error)) throw aborted(error)
      throw providerError('Brave credential resolution failed', error)
    }
    if (signal?.aborted) throw aborted(signal.reason)
    if (!key) throw new WebError('Brave search requires BRAVE_SEARCH_API_KEY in the credential service or launch environment', 'WEB_PROVIDER_CREDENTIAL_MISSING')
    const count = request.maxResults ?? MAX_RESULTS
    if (!Number.isInteger(count) || count < 1 || count > MAX_RESULTS) throw providerError('Brave result count must be between 1 and 20')
    const url = new URL(BRAVE_ENDPOINT)
    url.searchParams.set('q', request.query)
    url.searchParams.set('count', String(count))
    url.searchParams.set('result_filter', 'web')
    url.searchParams.set('safesearch', 'moderate')
    let response: Response
    try {
      response = await fetch(url, { method: 'GET', redirect: 'error', ...(signal ? { signal } : {}), headers: { 'X-Subscription-Token': key, Accept: 'application/json' } })
      if (signal?.aborted) throw aborted(signal.reason)
      if (!response.ok) throw providerError(`Brave API error (HTTP ${response.status})`)
      const body = await readBounded(response, signal)
      return mapBraveResponse(JSON.parse(body), count)
    } catch (error) {
      if (signal?.aborted || isAbort(error)) throw aborted(error)
      if (error instanceof WebError) throw error
      throw providerError('Brave search request or response failed', error)
    }
  }
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && !Number.isNaN(Date.parse(value))
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function providerError(message: string, cause?: unknown): WebError { return new WebError(message, 'WEB_PROVIDER_ERROR', { cause }) }
function aborted(cause?: unknown): WebError { return new WebError('Brave search aborted', 'WEB_ABORTED', { cause }) }
function isAbort(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError' || error instanceof WebError && error.code === 'WEB_ABORTED' }
async function readBounded(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) throw providerError('Brave returned an empty response body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (signal?.aborted) throw aborted(signal.reason)
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_BODY_BYTES) throw providerError('Brave response exceeds 2 MiB')
      chunks.push(next.value)
    }
  } catch (error) {
    try { await reader.cancel() } catch { /* Preserve the original read or size error. */ }
    throw error
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
