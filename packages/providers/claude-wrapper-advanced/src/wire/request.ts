/** OpenAI-chat-like serialization for Claude Wrapper Advanced `/wire/v1/responses`. */
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ClaudeWireRequest } from './types.js'

export interface ClaudeWireRequestOptions {
  readonly wireModel: string
  readonly imageUrl: (image: ImageAttachmentRef, signal?: AbortSignal) => Promise<string>
}

export async function serializeClaudeWireRequest(request: GenerateOptions, options: ClaudeWireRequestOptions): Promise<ClaudeWireRequest> {
  const unsupported = [
    request.temperature === undefined ? undefined : 'temperature',
    request.maxTokens === undefined || request.purpose === 'compaction' || request.purpose === 'session-title' ? undefined : 'maxTokens',
    request.stop === undefined ? undefined : 'stop',
  ].filter((name): name is string => name !== undefined)
  if (unsupported.length > 0) {
    throw new LlmError(
      `Claude Wrapper Advanced wire does not support DSH option${unsupported.length === 1 ? '' : 's'} ${unsupported.join(', ')}`,
      'UNSUPPORTED_OPTION',
    )
  }
  const messages: unknown[] = []
  if (request.system !== undefined) messages.push({ role: 'system', content: request.system })
  for (const message of request.messages) await appendMessage(messages, message, options.imageUrl, request.signal)
  const tools = (request.tools ?? []).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
  return {
    model: options.wireModel,
    messages,
    tools,
    ...request.reasoningEffort === undefined ? {} : { reasoning_effort: String(request.reasoningEffort) },
    ...request.sessionId === undefined ? {} : { session_id: String(request.sessionId) },
    ...request.turnId === undefined ? {} : { cost_scope_id: String(request.turnId) },
  }
}

async function appendMessage(out: unknown[], message: RequestMessage, imageUrl: ClaudeWireRequestOptions['imageUrl'], signal?: AbortSignal): Promise<void> {
  if (message.role === 'system') {
    out.push({ role: 'system', content: textOnly(message.content, 'system') })
    return
  }
  if (message.role === 'assistant') {
    const text: string[] = []
    const toolCalls: unknown[] = []
    for (const block of message.content) {
      if (block.type === 'text') text.push(block.text)
      else if (block.type === 'tool-call') toolCalls.push({ id: String(block.id), type: 'function', function: { name: block.name, arguments: block.arguments } })
      else if (block.type === 'reasoning') continue // Claude wire exposes no replay; never fabricate it.
      else throw new LlmError(`Unsupported assistant block ${JSON.stringify(block.type)}`, 'UNSUPPORTED_CONTENT')
    }
    out.push({ role: 'assistant', content: text.join(''), ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls } })
    return
  }
  if (message.role === 'tool') {
    if (message.content.some(block => block.type !== 'text' && block.type !== 'image')) {
      throw new LlmError('Claude Wrapper Advanced tool result contains unsupported content', 'UNSUPPORTED_CONTENT')
    }
    const content = message.content.every(block => block.type === 'text')
      ? textOnly(message.content, 'tool result')
      : await inputContent(message.content, imageUrl, signal)
    out.push({ role: 'tool', tool_call_id: String(message.toolCallId), content })
    return
  }
  if (message.role === 'developer') {
    out.push({ role: 'developer', content: textOnly(message.content, 'developer') })
    return
  }
  out.push({ role: 'user', content: await inputContent(message.content, imageUrl, signal) })
}

async function inputContent(contentBlocks: readonly ContentBlock[], imageUrl: ClaudeWireRequestOptions['imageUrl'], signal?: AbortSignal): Promise<unknown[]> {
  const content: unknown[] = []
  for (const block of contentBlocks) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'image') content.push({ type: 'image_url', image_url: { url: await imageUrl((block as ImageBlock).attachment, signal) } })
    else if (block.type === 'reasoning' || block.type === 'tool-call') content.push({ type: 'text', text: embeddedText(block) })
    else throw new LlmError(`Unsupported input block ${JSON.stringify(block.type)}`, 'UNSUPPORTED_CONTENT')
  }
  return content
}

function textOnly(content: readonly ContentBlock[], label: string): string {
  if (content.some(block => block.type !== 'text')) throw new LlmError(`Claude Wrapper Advanced ${label} must be text-only`, 'UNSUPPORTED_CONTENT')
  return content.map(block => (block as Extract<ContentBlock, { type: 'text' }>).text).join('')
}
function embeddedText(block: Extract<ContentBlock, { type: 'reasoning' | 'tool-call' }>): string {
  return block.type === 'reasoning' ? `[Embedded reasoning]\n${block.text}` : `[Embedded tool call: ${block.name}]\n${block.arguments}`
}
