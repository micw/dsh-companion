/** OpenRouter-reported call cost capture for the pi-ai data plane. */

import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  FetchFunction,
  Provider,
  Usage,
} from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { ModelCallAccounting } from '@deepseek-ai/dsh-llm'

const reportedCostByUsage = new WeakMap<Usage, number>()

/** Wrap OpenRouter's provider so terminal SDK usage retains the response-reported charge. */
export function withOpenRouterAccounting(
  base: Provider<Api>,
): Provider<Api> {
  return {
    ...base,
    streamSimple: (model, context, options) => {
      const capture = new OpenRouterCostCapture()
      const fetchImpl = options?.fetch ?? globalThis.fetch
      const events = base.streamSimple(model, context, {
        ...options ?? {},
        fetch: capturingFetch(fetchImpl, capture),
      })
      return attachReportedCost(events, capture)
    },
  }
}

/** Project a captured OpenRouter charge into one call-scoped reported USD amount. */
export function mapOpenRouterAccounting(usage: Usage): ModelCallAccounting | undefined {
  const cost = reportedCostByUsage.get(usage)
  if (cost === undefined) return undefined
  return {
    scope: 'call',
    costs: [{
      kind: 'reported',
      amount: { currency: 'USD', nanos: Math.round(cost * 1_000_000_000) },
      source: 'openrouter-response',
    }],
  }
}

function attachReportedCost(
  events: AsyncIterable<AssistantMessageEvent>,
  capture: OpenRouterCostCapture,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream()
  void forwardEvents(events, output, capture).catch((_unexpectedSourceFailure) => {
    // The output is already ended; PiAiAdapter reports the missing terminal event as STREAM_CLOSED.
  })
  return output
}

async function forwardEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  output: AssistantMessageEventStream,
  capture: OpenRouterCostCapture,
): Promise<void> {
  try {
    for await (const event of events) {
      if (event.type === 'done') capture.attach(event.message.usage)
      else if (event.type === 'error') capture.attach(event.error.usage)
      output.push(event)
    }
  } finally {
    output.end()
  }
}

function capturingFetch(fetchImpl: FetchFunction, capture: OpenRouterCostCapture): FetchFunction {
  return async (input, init) => {
    const response = await fetchImpl(input, init)
    if (response.body === null || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      return response
    }
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        capture.write(chunk)
        controller.enqueue(chunk)
      },
      flush() {
        capture.close()
      },
    }))
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

class OpenRouterCostCapture {
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private data: string[] = []
  private cost: number | undefined

  write(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    this.drainLines(false)
  }

  close(): void {
    this.buffer += this.decoder.decode()
    this.drainLines(true)
    this.dispatch()
  }

  attach(usage: Usage): void {
    if (this.cost !== undefined) reportedCostByUsage.set(usage, this.cost)
  }

  private drainLines(flush: boolean): void {
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      this.acceptLine(line)
    }
    if (flush && this.buffer.length > 0) {
      this.acceptLine(this.buffer.replace(/\r$/u, ''))
      this.buffer = ''
    }
  }

  private acceptLine(line: string): void {
    if (line === '') {
      this.dispatch()
      return
    }
    if (!line.startsWith('data:')) return
    const value = line.slice(5)
    this.data.push(value.startsWith(' ') ? value.slice(1) : value)
  }

  private dispatch(): void {
    if (this.data.length === 0) return
    const payload = this.data.join('\n')
    this.data = []
    if (payload === '[DONE]') return
    const parsed: unknown = JSON.parse(payload)
    if (!isRecord(parsed) || !isRecord(parsed.usage) || parsed.usage.cost === undefined) return
    const cost = parsed.usage.cost
    const nanos = typeof cost === 'number' ? Math.round(cost * 1_000_000_000) : Number.NaN
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0 || !Number.isSafeInteger(nanos)) {
      throw new Error('OpenRouter usage.cost must be a non-negative finite amount representable in USD nanos')
    }
    this.cost = cost
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
