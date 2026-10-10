/** Translation from validated wrapper events to the DSH stream protocol. */

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { codexFailureCode } from './failure.js'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CodexReplayBlock, CodexReplayEnvelope } from './wire/request.js'
import type { CodexWireEvent, CodexWireTurnLimits, CodexWireUsage } from './wire/types.js'

/** Optional observers for provider state that does not enter model content. */
export interface CodexStreamObservers {
  /** Observe a quota snapshot attached to this call. */
  readonly limits?: (limits: CodexWireTurnLimits) => void
}

interface OpenBlock {
  readonly index: number
  readonly type: 'text' | 'reasoning'
  text: string
}

/**
 * Translate one complete validated wrapper stream. Usage precedes finish,
 * provider account events remain out of model content, and opaque reasoning
 * items are retained as block-aligned replay metadata.
 */
export async function* translateCodexWireStream(
  events: AsyncIterable<CodexWireEvent>,
  observers: CodexStreamObservers = {},
): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let open: OpenBlock | undefined
  let sawToolCall = false
  let actualModel: string | undefined
  const replayBlocks: CodexReplayBlock[] = []
  let reasoningGroup: number[] = []

  const start = (type: OpenBlock['type']): StreamChunk => {
    const index = nextIndex++
    open = { index, type, text: '' }
    replayBlocks.push(null)
    if (type === 'reasoning') reasoningGroup.push(index)
    return { type: 'block-start', index, blockType: type }
  }
  const close = (): StreamChunk | undefined => {
    if (open === undefined) return undefined
    const current = open
    open = undefined
    return {
      type: 'block-end',
      index: current.index,
      block: { type: current.type, text: current.text },
    }
  }

  for await (const event of events) {
    switch (event.type) {
      case 'started':
        actualModel = event.model
        break
      case 'text_delta': {
        if (open?.type !== 'text') {
          const ended = close()
          if (ended !== undefined) yield ended
          yield start('text')
        }
        open!.text += event.text
        yield { type: 'text-delta', index: open!.index, text: event.text }
        break
      }
      case 'thinking_delta': {
        if (open?.type !== 'reasoning') {
          const ended = close()
          if (ended !== undefined) yield ended
          yield start('reasoning')
        }
        open!.text += event.text
        yield { type: 'reasoning-delta', index: open!.index, text: event.text }
        break
      }
      case 'thinking_break': {
        if (open?.type === 'reasoning') {
          const ended = close()
          if (ended !== undefined) yield ended
        }
        break
      }
      case 'reasoning': {
        const first = reasoningGroup[0]
        if (first !== undefined) replayBlocks[first] = { reasoningItem: event.item }
        reasoningGroup = []
        break
      }
      case 'tool_call': {
        const ended = close()
        if (ended !== undefined) yield ended
        const index = nextIndex++
        const id = ToolCallId(event.callId)
        replayBlocks.push(null)
        sawToolCall = true
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index,
          id,
          name: event.name,
          argumentsDelta: event.arguments,
        }
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id, name: event.name, arguments: event.arguments },
        }
        break
      }
      case 'rate_limits':
        observers.limits?.(event.value)
        break
      case 'failed': {
        const ended = close()
        if (ended !== undefined) yield ended
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: event.message,
              code: codexFailureCode(event.message, event.retryable),
            },
          },
        }
        return
      }
      case 'done': {
        const ended = close()
        if (ended !== undefined) yield ended
        const usage = toTokenUsage(event.usage)
        if (usage !== undefined) yield { type: 'usage', usage }
        const replayState: CodexReplayEnvelope = {
          response: {
            version: 1,
            ...event.responseId === undefined ? {} : { responseId: event.responseId },
            ...actualModel === undefined ? {} : { actualModel },
          },
          blocks: replayBlocks,
        }
        yield {
          type: 'finish',
          reason: sawToolCall
            ? { kind: 'tool-calls' }
            : event.stopReason === 'aborted' ? { kind: 'max-tokens' } : { kind: 'stop' },
          replayState,
        }
        return
      }
    }
  }
}

/**
 * Map wrapper totals to DSH's disjoint token counters. The wrapper currently
 * reports every member; an incomplete or inconsistent optional sample is
 * omitted rather than treating unknown cache usage as zero.
 */
export function toTokenUsage(value: CodexWireUsage | undefined): TokenUsage | undefined {
  if (value?.inputTokens === undefined || value.outputTokens === undefined
    || value.cachedInputTokens === undefined || value.cacheWriteInputTokens === undefined) return undefined
  const inputTokens = value.inputTokens - value.cachedInputTokens - value.cacheWriteInputTokens
  if (inputTokens < 0) return undefined
  if (value.reasoningOutputTokens !== undefined && value.reasoningOutputTokens > value.outputTokens) return undefined
  if (value.totalTokens !== undefined && value.totalTokens !== value.inputTokens + value.outputTokens) return undefined
  return {
    inputTokens,
    outputTokens: value.outputTokens,
    ...value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens },
    cacheReadTokens: value.cachedInputTokens,
    cacheWriteTokens: value.cacheWriteInputTokens,
    ...value.reasoningOutputTokens === undefined ? {} : { reasoningTokens: value.reasoningOutputTokens },
  }
}
