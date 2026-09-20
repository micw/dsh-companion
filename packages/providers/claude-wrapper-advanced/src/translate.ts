/** Translation from validated Claude wrapper events to DSH stream chunks. */
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ModelCallAccounting, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ClaudeWireCost, ClaudeWireEvent, ClaudeWireUsage, ClaudeWireUsageReport } from './wire/types.js'

export interface ClaudeStreamObservers {
  readonly quota?: (usage: ClaudeWireUsageReport) => void
  readonly limitStatus?: () => void
}

export async function* translateClaudeWireStream(events: AsyncIterable<ClaudeWireEvent>, observers: ClaudeStreamObservers = {}): AsyncGenerator<StreamChunk> {
  let index = 0
  let textOpen: number | undefined
  let text = ''
  let sawTool = false
  const closeText = (): StreamChunk | undefined => textOpen === undefined ? undefined : { type: 'block-end', index: textOpen, block: { type: 'text', text } }
  for await (const event of events) {
    switch (event.type) {
      case 'started': break
      case 'thinking_progress':
        if (event.tokens > 0) yield { type: 'status', status: { kind: 'reasoning-token-progress', deltaTokens: event.tokens, basis: 'estimated' } }
        break
      case 'text_delta':
        if (textOpen === undefined) { textOpen = index++; yield { type: 'block-start', index: textOpen, blockType: 'text' } }
        text += event.text
        yield { type: 'text-delta', index: textOpen, text: event.text }
        break
      case 'tool_call': {
        const closed = closeText(); if (closed !== undefined) { yield closed; textOpen = undefined }
        const at = index++; const id = ToolCallId(event.callId); sawTool = true
        yield { type: 'block-start', index: at, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: at, id, name: event.name, argumentsDelta: event.arguments }
        yield { type: 'block-end', index: at, block: { type: 'tool-call', id, name: event.name, arguments: event.arguments } }
        break
      }
      case 'quota': observers.quota?.(event.usage); break
      case 'limit_status': observers.limitStatus?.(); break
      case 'failed': {
        const closed = closeText(); if (closed !== undefined) yield closed
        const accounting = toVirtualAccounting(event.cost); if (accounting !== undefined) yield { type: 'accounting', accounting }
        yield { type: 'finish', reason: { kind: 'error', failure: failureOf(event) } }
        return
      }
      case 'done': {
        if (!sawTool && !event.text.startsWith(text)) {
          throw new LlmError('Claude Wrapper Advanced terminal text contradicts streamed text', 'PROTOCOL')
        }
        if (textOpen === undefined && !sawTool && event.text.length > 0) {
          const at = index++; yield { type: 'block-start', index: at, blockType: 'text' }; yield { type: 'text-delta', index: at, text: event.text }; yield { type: 'block-end', index: at, block: { type: 'text', text: event.text } }
        } else {
          if (!sawTool && textOpen !== undefined && event.text.length > text.length) {
            const suffix = event.text.slice(text.length); text = event.text; yield { type: 'text-delta', index: textOpen, text: suffix }
          }
          const closed = closeText(); if (closed !== undefined) yield closed
        }
        const usage = toTokenUsage(event.usage); if (usage !== undefined) yield { type: 'usage', usage }
        const accounting = toVirtualAccounting(event.cost); if (accounting !== undefined) yield { type: 'accounting', accounting }
        yield { type: 'finish', reason: sawTool || event.stopReason === 'tool_use' ? { kind: 'tool-calls' } : event.stopReason === 'aborted' ? { kind: 'max-tokens' } : { kind: 'stop' } }
        return
      }
    }
  }
}

export function toTokenUsage(value: ClaudeWireUsage): TokenUsage | undefined {
  if (value.thinking !== undefined && value.thinking > value.output) return undefined
  return {
    inputTokens: value.inputNew,
    outputTokens: value.output,
    totalTokens: value.inputTotal + value.output,
    cacheReadTokens: value.cacheRead,
    cacheWriteTokens: value.cacheWrite,
    ...value.thinking !== undefined && value.thinkingBasis === 'reported' ? { reasoningTokens: value.thinking } : {},
  }
}

export function toVirtualAccounting(cost: ClaudeWireCost): ModelCallAccounting | undefined {
  if (cost.totalUsd === undefined || cost.scope === undefined) return undefined
  const nanos = Math.round(cost.totalUsd * 1_000_000_000)
  if (!Number.isSafeInteger(nanos) || nanos < 0 || Object.is(nanos, -0)) return undefined
  return {
    scope: cost.scope,
    costs: [{
      kind: 'virtual',
      amount: { currency: 'USD', nanos },
      source: `claude-wrapper-advanced done.cost.total_usd; covered_requests=${String(cost.coveredRequests)}`,
      tariffVersion: `counter-epoch:${cost.epoch}`,
    }],
  }
}

function failureOf(event: Extract<ClaudeWireEvent, { type: 'failed' }>): {
  message: string
  code: string
  status?: number
} {
  const status = event.upstreamStatus
  const code = status === 401 || status === 403
    ? 'AUTH'
    : status === 429
      ? 'RATE_LIMIT'
      : event.errorType === 'timeout'
        ? 'TIMEOUT'
        : event.retryable
          ? status !== undefined && status >= 500 ? 'SERVER' : 'TRANSPORT'
          : 'CLAUDE_WRAPPER_ERROR'
  return { message: event.message, code, ...status === undefined ? {} : { status } }
}
