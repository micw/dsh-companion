/** SSE framing and terminal-state validation for `/wire/v1/responses`. */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CodexWireEvent } from './types.js'
import { parseCodexWireEvent } from './validation.js'

/** Largest single SSE frame accepted before JSON parsing. */
const MAX_SSE_EVENT_BYTES = 8 * 1024 * 1024

/**
 * Parse a wrapper SSE response through its terminal event and reject truncation
 * or data after settlement. Terminal events are yielded only after the parser
 * has observed clean EOF, allowing a DSH adapter to emit its own finish last.
 * @param stream - response body bytes.
 * @param onComment - optional callback for SSE keepalive activity.
 * @param signal - optional caller cancellation for body consumption after response headers arrive.
 * @returns validated non-terminal events followed by exactly one terminal event.
 */
export async function* parseCodexWireSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
  signal?: AbortSignal,
): AsyncGenerator<CodexWireEvent> {
  const events = stream
    .pipeThrough(boundSseEvents(MAX_SSE_EVENT_BYTES))
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  let terminal: CodexWireEvent & ({ readonly type: 'done' } | { readonly type: 'failed' }) | undefined
  const reader = events.getReader()
  let exhausted = false
  try {
    for (;;) {
      const result = await readWithSignal(reader, signal)
      if (result.done) {
        exhausted = true
        break
      }
      const frame = result.value
      let decoded: unknown
      try {
        decoded = JSON.parse(frame.data)
      } catch (error: unknown) {
        throw new LlmError('Codex Wrapper Advanced SSE event is not valid JSON', 'PROTOCOL', { cause: error })
      }
      const event = parseCodexWireEvent(decoded)
      if (terminal !== undefined) {
        throw new LlmError('Codex Wrapper Advanced SSE stream continued after its terminal event', 'PROTOCOL')
      }
      if (event.type === 'done' || event.type === 'failed') {
        terminal = event
      } else {
        yield event
      }
    }
  } catch (error: unknown) {
    if (signal?.aborted) throw abortedStreamError(signal.reason)
    if (error instanceof LlmError) throw error
    throw new LlmError('Codex Wrapper Advanced response body transport failed', 'TRANSPORT', { cause: error })
  } finally {
    if (!exhausted) {
      await reader.cancel().catch(() => {
        // The consumer has already selected the outcome; transport cancellation is cleanup.
      })
    }
    reader.releaseLock()
  }
  if (terminal === undefined) {
    throw new LlmError('Codex Wrapper Advanced SSE stream ended without a terminal event', 'STREAM_CLOSED')
  }
  yield terminal
}

async function readWithSignal<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  if (signal === undefined) return reader.read()
  if (signal.aborted) throw abortedStreamError(signal.reason)
  let rejectAbort: ((error: LlmError) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort?.(abortedStreamError(signal.reason)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([reader.read(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function abortedStreamError(reason: unknown): LlmError {
  return new LlmError('Codex Wrapper Advanced response stream aborted by caller', 'ABORTED', {
    ...reason instanceof Error ? { cause: reason } : {},
  })
}

/** Refuse an oversized SSE event before handing its accumulated text to the parser. */
function boundSseEvents(limit: number): TransformStream<BufferSource, BufferSource> {
  let eventBytes = 0
  let lineBytes = 0
  let previousWasCarriageReturn = false
  const finishLine = (): void => {
    if (lineBytes === 0) eventBytes = 0
    lineBytes = 0
  }
  return new TransformStream({
    transform(chunk, controller) {
      const bytes = chunk instanceof ArrayBuffer
        ? new Uint8Array(chunk)
        : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      for (const byte of bytes) {
        eventBytes += 1
        if (eventBytes > limit) {
          throw new LlmError(
            `Codex Wrapper Advanced SSE event exceeds ${String(limit)} bytes`,
            'RESPONSE_TOO_LARGE',
          )
        }
        if (previousWasCarriageReturn) {
          previousWasCarriageReturn = false
          if (byte === 0x0a) continue
        }
        if (byte === 0x0d) {
          finishLine()
          previousWasCarriageReturn = true
        } else if (byte === 0x0a) {
          finishLine()
        } else {
          lineBytes += 1
        }
      }
      controller.enqueue(chunk)
    },
  })
}
