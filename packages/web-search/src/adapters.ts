/** Fixed-origin Brave and Exa adapters; failures never quote provider bodies or queries. */
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { SearchEntry, SearchFailureState } from './protocol.js'

const ENDPOINTS = { brave: 'https://api.search.brave.com/res/v1/web/search', exa: 'https://api.exa.ai/search' }
const BODY_LIMIT = 2 * 1024 * 1024

/** Classified provider failure with an optional authoritative retry time (Unix milliseconds). */
export class SearchFailure extends WebError {
  constructor(readonly reason: SearchFailureState['reason'], message: string, readonly retryAt?: number | null) {
    super(message, 'WEB_PROVIDER_ERROR')
  }
}

/** Execute one search without redirects, retries, or provider selection. */
export async function searchProvider(
  family: SearchEntry['family'], key: string, request: WebSearchRequest, signal: AbortSignal,
): Promise<WebSearchResult> {
  const count = Math.min(request.maxResults ?? 8, 20)
  const url = new URL(ENDPOINTS[family])
  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: string | undefined
  if (family === 'brave') {
    headers['X-Subscription-Token'] = key
    url.searchParams.set('q', request.query)
    url.searchParams.set('count', String(count))
    url.searchParams.set('result_filter', 'web')
    url.searchParams.set('safesearch', 'moderate')
  } else {
    headers.Authorization = `Bearer ${key}`
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({ query: request.query, type: 'auto', numResults: count, contents: { highlights: true } })
  }
  let response: Response
  try {
    response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers,
      ...(body === undefined ? {} : { body }), signal })
  } catch {
    signal.throwIfAborted()
    throw new SearchFailure('transport', `${label(family)} search connection failed`)
  }
  const value = await readJson(response, signal)
  if (!response.ok) throw httpFailure(family, response, value, Date.now())
  return mapResponse(family, value, count)
}

/** Interpret only documented provider codes and matching reset windows. */
export function httpFailure(family: SearchEntry['family'], response: Response, value: unknown, now: number): Error {
  const status = response.status
  const error = record(value) && record(value.error) ? value.error : undefined
  const code = family === 'brave' ? error?.code : record(value) ? value.tag : undefined
  if (status === 401) return new SearchFailure('credentials', `${label(family)} API key is missing or invalid`, null)
  if (status === 400 || status === 422) return new WebError(`${label(family)} rejected the search request (HTTP ${status})`, 'WEB_INVALID_QUERY')
  const quota = status === 402 || code === 'QUOTA_LIMITED'
  const retryAt = braveReset(response, quota, family, now) ?? retryAfter(response.headers.get('retry-after'), now)
  const reason = quota ? 'quota' : status === 429 ? 'rate-limit' : status === 403 ? 'access' : 'server'
  return new SearchFailure(reason, `${label(family)} ${reason === 'quota' ? 'search budget or quota exhausted' : `search failed (HTTP ${status})`}`,
    retryAt)
}

function braveReset(response: Response, quota: boolean, family: SearchEntry['family'], now: number): number | undefined {
  if (family !== 'brave' || response.status !== 429) return undefined
  const limits = numbers(response.headers.get('x-ratelimit-limit'))
  const remaining = numbers(response.headers.get('x-ratelimit-remaining'))
  const reset = numbers(response.headers.get('x-ratelimit-reset'))
  const policy = response.headers.get('x-ratelimit-policy')?.split(',').map(s => Number(/;w=(\d+)/u.exec(s)?.[1])) ?? []
  const waits = reset.filter((seconds, i) => limits[i] !== undefined && limits[i]! > 0 && remaining[i] !== undefined
    && remaining[i]! <= 0 && Number.isFinite(policy[i]) && (quota ? policy[i]! > 1 : policy[i] === 1) && seconds >= 0)
  const at = waits.length ? now + Math.max(...waits) * 1000 : NaN
  return Number.isSafeInteger(at) && at <= 8_640_000_000_000_000 ? at : undefined
}
function numbers(value: string | null): number[] {
  return value === null ? [] : value.split(',').map(s => /^\d+$/u.test(s.trim()) ? Number(s.trim()) : NaN)
}
function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined
  const at = /^\d+(?:\.\d+)?$/u.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value)
  return Number.isSafeInteger(at) && at >= now ? at : undefined
}
function label(family: SearchEntry['family']): string { return family === 'brave' ? 'Brave' : 'Exa' }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return null
  const reader = response.body.getReader()
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      length += value.byteLength
      if (length > BODY_LIMIT) throw new SearchFailure('response', 'Search provider response exceeds 2 MiB')
      chunks.push(value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      if (!response.ok) return null
      throw new SearchFailure('response', 'Search provider returned invalid JSON')
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof SearchFailure) throw error
    throw new SearchFailure('transport', 'Search provider response could not be read')
  } finally {
    await reader.cancel().catch(() => { /* Preserve the settled provider outcome. */ })
  }
}

/** Validate provider JSON and normalize public source URLs; empty arrays are successful searches. */
export function mapResponse(family: SearchEntry['family'], value: unknown, limit: number): WebSearchResult {
  const rows = record(value) ? family === 'brave' ? record(value.web) ? value.web.results : undefined : value.results : undefined
  if (!Array.isArray(rows)) throw new SearchFailure('response', `${label(family)} returned malformed search results`)
  const sources: WebSearchSource[] = []
  for (const row of rows.slice(0, limit)) {
    if (!record(row) || typeof row.url !== 'string') throw new SearchFailure('response', 'Search result is missing its URL')
    let url: URL
    try { url = new URL(row.url) } catch { throw new SearchFailure('response', 'Search result URL is invalid') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new SearchFailure('response', 'Search result URL is unsupported')
    if (row.title !== undefined && typeof row.title !== 'string') throw new SearchFailure('response', 'Search result title is invalid')
    const snippet = family === 'brave' ? row.description : Array.isArray(row.highlights) ? row.highlights.find(s => typeof s === 'string' && s.trim()) : undefined
    if (snippet !== undefined && snippet !== null && typeof snippet !== 'string') throw new SearchFailure('response', 'Search result snippet is invalid')
    sources.push({ url: row.url, ...(typeof row.title === 'string' ? { title: row.title } : {}),
      ...(typeof snippet === 'string' ? { snippet } : {}) })
  }
  return { sources, truncated: rows.length > limit }
}
