/** Serialization from immutable DSH requests to the wrapper Responses vocabulary. */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, Message, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CodexWireRequest } from './types.js'

/** Adapter-private response metadata retained with one successful Assistant message. */
export interface CodexReplayResponse {
  readonly version: 1
  readonly responseId?: string
  readonly actualModel?: string
}

/** Adapter-private metadata aligned with one emitted DSH content block. */
export type CodexReplayBlock = { readonly reasoningItem: Readonly<Record<string, unknown>> } | null

/** Complete replay state emitted through DSH's `ReplayEnvelope`. */
export interface CodexReplayEnvelope {
  readonly response: CodexReplayResponse
  readonly blocks: readonly CodexReplayBlock[]
}

/** Inputs needed to serialize one prepared DSH call. */
export interface CodexWireRequestOptions {
  /** Wrapper-facing model id captured with the catalog generation. */
  readonly wireModel: string
  /** Convert one durable image reference to a wrapper-accepted URL. */
  readonly imageUrl: (image: ImageAttachmentRef, signal?: AbortSignal) => Promise<string>
}

/**
 * Serialize one DSH call. Assistant-only blocks embedded in User input become
 * labeled inert text; unsupported controls fail instead of being discarded.
 * Compaction's required output cap is omitted because the Codex backend cannot
 * enforce it and rejecting it would prevent DSH from maintaining the Session.
 */
export async function serializeCodexWireRequest(
  request: GenerateOptions,
  options: CodexWireRequestOptions,
): Promise<CodexWireRequest> {
  rejectUnsupportedControls(request)
  const { instructions, messages } = systemInstructions(request)
  const input: unknown[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      appendAssistant(input, message)
    } else {
      await appendUser(input, message, options.imageUrl, request.signal)
    }
  }
  const tools = (request.tools ?? []).map(tool => ({
    type: 'function',
    strict: false,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  return {
    model: options.wireModel,
    input,
    ...instructions === undefined ? {} : { instructions },
    tools,
    ...request.reasoningEffort === undefined ? {} : { effort: String(request.reasoningEffort) },
    parallel_tool_calls: tools.length > 0,
    store: false,
    ...request.sessionId === undefined ? {} : { session_id: String(request.sessionId) },
  }
}

function rejectUnsupportedControls(request: GenerateOptions): void {
  const unsupported = [
    request.temperature === undefined ? undefined : 'temperature',
    request.maxTokens === undefined || request.purpose === 'compaction' ? undefined : 'maxTokens',
    request.stop === undefined ? undefined : 'stop',
  ].filter((name): name is string => name !== undefined)
  if (unsupported.length > 0) {
    throw new LlmError(
      `Codex Wrapper Advanced wire API does not support DSH option${unsupported.length === 1 ? '' : 's'} ${unsupported.join(', ')}`,
      'UNSUPPORTED_OPTION',
    )
  }
}

function systemInstructions(request: GenerateOptions): { instructions?: string; messages: readonly Message[] } {
  const systemMessages = request.messages.filter(message => message.role === 'system')
  if (request.system !== undefined && systemMessages.length > 0) {
    throw new LlmError(
      'Codex Wrapper Advanced request cannot combine one-shot system text with system history',
      'INVALID_REQUEST',
    )
  }
  if (systemMessages.some(message => request.messages.indexOf(message) !== 0)) {
    throw new LlmError(
      'Codex Wrapper Advanced adapter has not verified mid-history system prompt updates',
      'UNSUPPORTED_CONTENT',
    )
  }
  if (systemMessages.length > 1) {
    throw new LlmError(
      'Codex Wrapper Advanced request contains more than one system message',
      'INVALID_REQUEST',
    )
  }
  const fromHistory = systemMessages[0] === undefined ? undefined : systemText(systemMessages[0])
  const instructions = request.system ?? fromHistory
  return {
    ...instructions === undefined || instructions.length === 0 ? {} : { instructions },
    messages: systemMessages.length === 0 ? request.messages : request.messages.slice(1),
  }
}

function systemText(message: Message): string {
  const text: string[] = []
  for (const block of message.content) {
    if (block.type !== 'text') {
      throw new LlmError(
        `Codex Wrapper Advanced system message contains unsupported block ${JSON.stringify(block.type)}`,
        'UNSUPPORTED_CONTENT',
      )
    }
    text.push(block.text)
  }
  return text.join('')
}

async function appendUser(
  input: unknown[],
  message: Message,
  imageUrl: CodexWireRequestOptions['imageUrl'],
  signal?: AbortSignal,
): Promise<void> {
  const toolResults = message.content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
  if (toolResults.length > 0) {
    if (toolResults.length !== message.content.length) {
      throw new LlmError('Codex Wrapper Advanced user message mixes tool results with ordinary input', 'UNSUPPORTED_CONTENT')
    }
    for (const result of toolResults) {
      const output = await inputContent(result.content, imageUrl, signal)
      input.push({
        type: 'function_call_output',
        call_id: String(result.toolCallId),
        output: output.length === 1 && output[0]?.type === 'input_text'
          ? output[0].text
          : output,
      })
    }
    return
  }
  input.push({
    type: 'message',
    role: 'user',
    content: await inputContent(message.content, imageUrl, signal),
  })
}

function appendAssistant(
  input: unknown[],
  message: Message,
): void {
  const replay = parseReplayEnvelope(message.source.kind === 'model' ? message.source.replayState : undefined)
  let pendingText: Array<{ type: 'output_text'; text: string }> = []
  const flushText = (): void => {
    if (pendingText.length === 0) return
    input.push({ type: 'message', role: 'assistant', content: pendingText })
    pendingText = []
  }
  for (const [index, block] of message.content.entries()) {
    switch (block.type) {
      case 'text':
        pendingText.push({ type: 'output_text', text: block.text })
        break
      case 'reasoning': {
        flushText()
        const metadata = replay?.blocks[index]
        if (metadata?.reasoningItem !== undefined) input.push(metadata.reasoningItem)
        break
      }
      case 'tool-call':
        flushText()
        input.push({
          type: 'function_call',
          call_id: String(block.id),
          name: block.name,
          arguments: block.arguments,
        })
        break
      default:
        throw new LlmError(
          `Codex Wrapper Advanced assistant history contains unsupported block ${JSON.stringify(block.type)}`,
          'UNSUPPORTED_CONTENT',
        )
    }
  }
  flushText()
}

function embeddedAssistantText(block: Extract<ContentBlock, { type: 'reasoning' | 'tool-call' }>): string {
  switch (block.type) {
    case 'reasoning':
      return `[Embedded reasoning]\n${block.text}`
    case 'tool-call':
      return `[Embedded tool call: ${block.name}]\n${block.arguments}`
  }
}

async function inputContent(
  blocks: readonly ContentBlock[],
  imageUrl: CodexWireRequestOptions['imageUrl'],
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const content: Array<Record<string, unknown>> = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'input_text', text: block.text })
        break
      case 'image':
        content.push({ type: 'input_image', image_url: await imageUrl((block as ImageBlock).attachment, signal) })
        break
      case 'reasoning':
      case 'tool-call':
        content.push({ type: 'input_text', text: embeddedAssistantText(block) })
        break
      default:
        throw new LlmError(
          `Codex Wrapper Advanced user input contains unsupported block ${JSON.stringify(block.type)}`,
          'UNSUPPORTED_CONTENT',
        )
    }
  }
  return content
}

/** Validate adapter-private replay state before placing opaque provider data back on the wire. */
export function parseReplayEnvelope(value: unknown): CodexReplayEnvelope | undefined {
  if (!isRecord(value) || !isRecord(value.response) || value.response.version !== 1
    || !Array.isArray(value.blocks)) return undefined
  const responseId = value.response.responseId
  const actualModel = value.response.actualModel
  if (responseId !== undefined && (typeof responseId !== 'string' || responseId.length === 0)) return undefined
  if (actualModel !== undefined && (typeof actualModel !== 'string' || actualModel.length === 0)) return undefined
  const blocks: CodexReplayBlock[] = []
  for (const block of value.blocks) {
    if (block === null) {
      blocks.push(null)
    } else if (isRecord(block) && isRecord(block.reasoningItem)) {
      blocks.push({ reasoningItem: block.reasoningItem })
    } else {
      return undefined
    }
  }
  return {
    response: {
      version: 1,
      ...responseId === undefined ? {} : { responseId },
      ...actualModel === undefined ? {} : { actualModel },
    },
    blocks,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
