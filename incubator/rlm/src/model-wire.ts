import {
  createAssistantMessage,
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
  type ImageBlock,
  type Message,
  type StreamChunk,
  type TokenUsage,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-solar-rlm/openai-completions': {
      kind: 'dsh-solar-rlm/openai-completions'
      openaiRole: 'developer' | 'user'
    }
  }
}

/** The configured DSH route behind one Prime OpenAI-compatible endpoint. */
export interface ModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

export interface DecodeChatRequestOptions {
  signal?: AbortSignal
  sessionId?: string
  /** Resolves an OpenAI image URL without letting this wire layer fetch it itself. */
  resolveImage?: (url: string) => Promise<ImageBlock>
  /** Recreates adapter-private replay data from one historical assistant message. */
  replayFor?: (message: unknown) => unknown
}

export interface EncodeChatStreamOptions {
  id: string
  model: string
  onFinish?: (value: {
    message: unknown
    replayState?: unknown
    usage?: TokenUsage
    finishReason: string
  }) => void
}

type JsonRecord = Record<string, unknown>

type WireRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

interface ToolAccumulator {
  callIndex: number
  id: string
  name?: string
  arguments: string
}

interface BlockAccumulator {
  blockType: string
  text: string
  tool?: ToolAccumulator
  block?: ContentBlock
}

type OpenAiOutputBlock = Extract<ContentBlock, { type: 'text' | 'reasoning' | 'tool-call' }>

const OPENAI_SOURCE_PLUGIN = 'dsh-solar-rlm/openai-completions'

const REQUEST_FIELDS = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'store',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
  'stop',
  'temperature',
  'tools',
])

function invalid(path: string, detail: string): never {
  throw new TypeError(`Invalid OpenAI chat-completions request at ${path}: ${detail}`)
}

function unsupported(path: string, detail: string): never {
  throw new TypeError(`Unsupported OpenAI chat-completions behavior at ${path}: ${detail}`)
}

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function expectRecord(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) invalid(path, 'must be an object')
  return value
}

function expectString(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== 'string') invalid(path, 'must be a string')
  if (nonEmpty && value.length === 0) invalid(path, 'must be a non-empty string')
  return value
}

function expectOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return expectString(value, path)
}

function expectNonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    invalid(path, 'must be a non-negative integer')
  }
  return value
}

function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'must be a finite number')
  return value
}

function assertOnlyFields(value: JsonRecord, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) unsupported(`${path}.${key}`, 'the custom DSH route has no equivalent')
  }
}

function has(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function cloneJson(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return expectFiniteNumber(value, path)
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${path}[${index}]`))
  if (!isRecord(value)) invalid(path, 'must be JSON-compatible')
  const result: JsonRecord = {}
  for (const [key, item] of Object.entries(value)) result[key] = cloneJson(item, `${path}.${key}`)
  return result
}

function pluginSource(openaiRole: 'developer' | 'user'): {
  kind: 'dsh-solar-rlm/openai-completions'
  openaiRole: 'developer' | 'user'
} {
  return {
    kind: OPENAI_SOURCE_PLUGIN,
    openaiRole,
  }
}

function validateRoute(route: ModelRoute): void {
  expectString(route.provider, 'route.provider', true)
  expectString(route.model, 'route.model', true)
  if (route.reasoningEffort !== undefined) expectString(route.reasoningEffort, 'route.reasoningEffort', true)
  if (route.maxTokens !== undefined) expectNonNegativeInteger(route.maxTokens, 'route.maxTokens')
}

function decodeOutputBudget(request: JsonRecord, route: ModelRoute): number | undefined {
  const hasMaxTokens = has(request, 'max_tokens') && request.max_tokens !== null
  const hasMaxCompletionTokens = has(request, 'max_completion_tokens') && request.max_completion_tokens !== null
  const maxTokens = hasMaxTokens ? expectNonNegativeInteger(request.max_tokens, 'max_tokens') : undefined
  const maxCompletionTokens = hasMaxCompletionTokens
    ? expectNonNegativeInteger(request.max_completion_tokens, 'max_completion_tokens')
    : undefined
  if (maxTokens !== undefined && maxCompletionTokens !== undefined && maxTokens !== maxCompletionTokens) {
    invalid('max_tokens', 'must equal max_completion_tokens when both are supplied')
  }
  return maxCompletionTokens ?? maxTokens ?? route.maxTokens
}

function decodeStop(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) invalid('stop', 'must be a string, an array of strings, or null')
  return value.map((entry, index) => expectString(entry, `stop[${index}]`))
}

function decodeTools(value: unknown): GenerateOptions['tools'] {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) invalid('tools', 'must be an array')
  return value.map((entry, index) => {
    const path = `tools[${index}]`
    const tool = expectRecord(entry, path)
    assertOnlyFields(tool, new Set(['type', 'function']), path)
    if (tool.type !== 'function') unsupported(`${path}.type`, 'only function tools are supported')
    const fn = expectRecord(tool.function, `${path}.function`)
    assertOnlyFields(fn, new Set(['name', 'description', 'parameters', 'strict']), `${path}.function`)
    if (fn.strict !== undefined && fn.strict !== false) {
      unsupported(`${path}.function.strict`, 'DSH does not expose OpenAI strict-mode tool validation')
    }
    const parameters = expectRecord(fn.parameters, `${path}.function.parameters`)
    return {
      name: expectString(fn.name, `${path}.function.name`, true),
      description: expectString(fn.description, `${path}.function.description`),
      parameters: cloneJson(parameters, `${path}.function.parameters`) as Record<string, unknown>,
    }
  })
}

function decodeTextParts(value: unknown, path: string): ContentBlock[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) invalid(path, 'must be a string or an array of text parts')
  return value.map((entry, index) => {
    const partPath = `${path}[${index}]`
    const part = expectRecord(entry, partPath)
    assertOnlyFields(part, new Set(['type', 'text']), partPath)
    if (part.type !== 'text') unsupported(`${partPath}.type`, 'only text is valid for this role')
    return { type: 'text', text: expectString(part.text, `${partPath}.text`) }
  })
}

async function decodeUserContent(
  value: unknown,
  path: string,
  resolveImage: DecodeChatRequestOptions['resolveImage'],
): Promise<ContentBlock[]> {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) invalid(path, 'must be a string or an array of content parts')

  const content: ContentBlock[] = []
  for (let index = 0; index < value.length; index += 1) {
    const partPath = `${path}[${index}]`
    const part = expectRecord(value[index], partPath)
    if (part.type === 'text') {
      assertOnlyFields(part, new Set(['type', 'text']), partPath)
      content.push({ type: 'text', text: expectString(part.text, `${partPath}.text`) })
      continue
    }
    if (part.type === 'image_url') {
      assertOnlyFields(part, new Set(['type', 'image_url']), partPath)
      const image = expectRecord(part.image_url, `${partPath}.image_url`)
      assertOnlyFields(image, new Set(['url']), `${partPath}.image_url`)
      if (!resolveImage) {
        unsupported(partPath, 'image_url requires the caller to supply resolveImage')
      }
      const resolved = await resolveImage(expectString(image.url, `${partPath}.image_url.url`, true))
      if (!resolved || resolved.type !== 'image') invalid(partPath, 'resolveImage must return an ImageBlock')
      content.push(resolved)
      continue
    }
    unsupported(`${partPath}.type`, 'only text and image_url content parts are supported')
  }
  return content
}

function decodeAssistantContent(value: unknown, path: string): ContentBlock[] {
  if (value === null) return []
  return decodeTextParts(value, path)
}

function decodeAssistantToolCalls(value: unknown, path: string): ContentBlock[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid(path, 'must be an array')
  return value.map((entry, index) => {
    const callPath = `${path}[${index}]`
    const call = expectRecord(entry, callPath)
    assertOnlyFields(call, new Set(['id', 'type', 'function']), callPath)
    if (call.type !== 'function') unsupported(`${callPath}.type`, 'only function tool calls are supported')
    const fn = expectRecord(call.function, `${callPath}.function`)
    assertOnlyFields(fn, new Set(['name', 'arguments']), `${callPath}.function`)
    return {
      type: 'tool-call' as const,
      id: expectString(call.id, `${callPath}.id`) as ToolCallId,
      name: expectString(fn.name, `${callPath}.function.name`),
      // Arguments are intentionally not parsed. Prime's adapter keeps this raw
      // string too, including malformed partial JSON in replayable history.
      arguments: expectString(fn.arguments, `${callPath}.function.arguments`),
    }
  })
}

async function decodeMessage(
  value: unknown,
  index: number,
  route: ModelRoute,
  options: DecodeChatRequestOptions,
): Promise<Message> {
  const path = `messages[${index}]`
  const message = expectRecord(value, path)
  const role = expectString(message.role, `${path}.role`) as WireRole

  switch (role) {
    case 'system': {
      assertOnlyFields(message, new Set(['role', 'content']), path)
      if (!has(message, 'content')) invalid(`${path}.content`, 'is required')
      const text = decodeTextParts(message.content, `${path}.content`)
        .map(block => block.type === 'text' ? block.text : '')
        .join('')
      return createSystemMessage(text)
    }
    case 'developer': {
      assertOnlyFields(message, new Set(['role', 'content']), path)
      if (!has(message, 'content')) invalid(`${path}.content`, 'is required')
      return createDeveloperMessage({
        content: decodeTextParts(message.content, `${path}.content`),
        source: pluginSource('developer'),
      })
    }
    case 'user': {
      assertOnlyFields(message, new Set(['role', 'content']), path)
      if (!has(message, 'content')) invalid(`${path}.content`, 'is required')
      return createUserMessage({
        content: await decodeUserContent(message.content, `${path}.content`, options.resolveImage),
        source: pluginSource('user'),
      })
    }
    case 'assistant': {
      assertOnlyFields(message, new Set([
        'role',
        'content',
        'tool_calls',
        'reasoning_content',
        'reasoning',
        'reasoning_text',
        'reasoning_details',
      ]), path)
      if (!has(message, 'content')) invalid(`${path}.content`, 'is required (use null for tool-only turns)')

      const content = decodeAssistantContent(message.content, `${path}.content`)
      const reasoningFields = ['reasoning_content', 'reasoning', 'reasoning_text'].filter(field => has(message, field))
      if (reasoningFields.length > 1) {
        invalid(path, 'must not send more than one of reasoning_content, reasoning, and reasoning_text')
      }
      const reasoningField = reasoningFields[0]
      if (reasoningField !== undefined) {
        content.push({ type: 'reasoning', text: expectString(message[reasoningField], `${path}.${reasoningField}`) })
      }
      content.push(...decodeAssistantToolCalls(message.tool_calls, `${path}.tool_calls`))

      if (has(message, 'reasoning_details')) {
        if (!Array.isArray(message.reasoning_details) || !message.reasoning_details.every(isRecord)) {
          invalid(`${path}.reasoning_details`, 'must be an array of objects')
        }
        if (!options.replayFor) {
          unsupported(`${path}.reasoning_details`, 'requires replayFor so opaque provider state is not discarded')
        }
      }

      const replayState = options.replayFor?.(cloneJson(message, path))
      if (has(message, 'reasoning_details') && replayState === undefined) {
        unsupported(`${path}.reasoning_details`, 'the replay hook did not return recoverable provider state')
      }
      return createAssistantMessage({
        content,
        source: {
          provider: route.provider,
          model: route.model,
          ...replayState === undefined ? {} : { replayState },
        },
      })
    }
    case 'tool': {
      assertOnlyFields(message, new Set(['role', 'tool_call_id', 'content']), path)
      if (!has(message, 'content')) invalid(`${path}.content`, 'is required')
      return createToolResultMessage({
        callId: expectString(message.tool_call_id, `${path}.tool_call_id`) as ToolCallId,
        content: [{ type: 'text', text: expectString(message.content, `${path}.content`) }],
        isError: false,
      })
    }
    default:
      unsupported(`${path}.role`, `role ${JSON.stringify(role)} is not supported`)
  }
}

/**
 * Decode the exact chat/completions subset Prime emits into one configured DSH
 * route. The surrounding loopback endpoint verifies Prime's fixed wire-model
 * sentinel; this decoder always dispatches through the configured DSH route.
 */
export async function decodeChatRequest(
  body: unknown,
  route: ModelRoute,
  options: DecodeChatRequestOptions = {},
): Promise<GenerateOptions> {
  validateRoute(route)
  const request = expectRecord(body, 'body')
  assertOnlyFields(request, REQUEST_FIELDS, 'body')

  // Prime's local provider exposes a stable wire model id (`selected`), while
  // route.model is the actual DSH model selected by the owning Agent. Validate
  // the wire field here; the endpoint owns sentinel matching before this call.
  expectString(request.model, 'model', true)
  if (!Array.isArray(request.messages)) invalid('messages', 'must be an array')
  if (request.stream !== undefined && request.stream !== true) {
    unsupported('stream', 'only stream: true is supported')
  }
  if (request.store !== undefined && request.store !== false) {
    unsupported('store', 'only store: false is supported')
  }
  if (request.stream_options !== undefined) {
    const streamOptions = expectRecord(request.stream_options, 'stream_options')
    assertOnlyFields(streamOptions, new Set(['include_usage']), 'stream_options')
    if (streamOptions.include_usage !== undefined && streamOptions.include_usage !== true) {
      unsupported('stream_options.include_usage', 'the bridge always needs OpenAI usage chunks')
    }
  }

  const messages: Message[] = []
  for (let index = 0; index < request.messages.length; index += 1) {
    messages.push(await decodeMessage(request.messages[index], index, route, options))
  }

  const reasoningEffort = expectOptionalString(request.reasoning_effort, 'reasoning_effort') ?? route.reasoningEffort
  const maxTokens = decodeOutputBudget(request, route)
  const stop = decodeStop(request.stop)
  const temperature = request.temperature === undefined
    ? undefined
    : expectFiniteNumber(request.temperature, 'temperature')
  const tools = decodeTools(request.tools)

  return {
    provider: route.provider,
    model: route.model,
    messages,
    ...reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as GenerateOptions['reasoningEffort'] },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...stop === undefined ? {} : { stop },
    ...temperature === undefined ? {} : { temperature },
    ...tools === undefined ? {} : { tools },
    ...options.signal === undefined ? {} : { signal: options.signal },
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId as GenerateOptions['sessionId'] },
  }
}

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function completionChunk(
  options: EncodeChatStreamOptions,
  delta: JsonRecord,
  finishReason: string | null,
): JsonRecord {
  return {
    id: options.id,
    object: 'chat.completion.chunk',
    model: options.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function usageChunk(options: EncodeChatStreamOptions, usage: TokenUsage): JsonRecord {
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  const promptTokens = usage.inputTokens + cacheReadTokens + cacheWriteTokens
  const promptDetails: JsonRecord = {}
  if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) {
    // Prime reconstructs cacheRead by subtracting cache_write_tokens from
    // cached_tokens. Sending their sum preserves DSH's disjoint buckets.
    promptDetails.cached_tokens = cacheReadTokens + cacheWriteTokens
    if (usage.cacheWriteTokens !== undefined) promptDetails.cache_write_tokens = cacheWriteTokens
  }
  const completionDetails: JsonRecord = {}
  if (usage.reasoningTokens !== undefined) completionDetails.reasoning_tokens = usage.reasoningTokens

  return {
    id: options.id,
    object: 'chat.completion.chunk',
    model: options.model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens ?? promptTokens + usage.outputTokens,
      ...Object.keys(promptDetails).length === 0 ? {} : { prompt_tokens_details: promptDetails },
      ...Object.keys(completionDetails).length === 0 ? {} : { completion_tokens_details: completionDetails },
    },
  }
}

function terminalFinishReason(chunk: Extract<StreamChunk, { type: 'finish' }>): string {
  switch (chunk.reason.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'error':
    case 'aborted': {
      const error = new Error(chunk.reason.failure.message)
      error.name = `Dsh${chunk.reason.kind === 'aborted' ? 'Abort' : 'Stream'}Error`
      throw error
    }
    default: {
      const unsupportedReason = chunk.reason as { kind?: unknown }
      throw new Error(`Unsupported DSH stream finish reason ${JSON.stringify(unsupportedReason.kind)}`)
    }
  }
}

function ensureBlock(
  blocks: Map<number, BlockAccumulator>,
  order: number[],
  index: number,
  blockType: string,
): BlockAccumulator {
  const existing = blocks.get(index)
  if (existing) {
    if (existing.blockType !== blockType) {
      throw new Error(`DSH stream changed block ${index} from ${existing.blockType} to ${blockType}`)
    }
    return existing
  }
  const block = { blockType, text: '' }
  blocks.set(index, block)
  order.push(index)
  return block
}

function addRole(delta: JsonRecord, roleSent: boolean): JsonRecord {
  return roleSent ? delta : { role: 'assistant', ...delta }
}

function toolCallDelta(tool: ToolAccumulator): JsonRecord {
  return {
    index: tool.callIndex,
    id: tool.id,
    type: 'function',
    function: { name: tool.name ?? '', arguments: tool.arguments },
  }
}

function suffixAfter(authoritative: string, streamed: string, block: number, field: string): string {
  if (!authoritative.startsWith(streamed)) {
    throw new Error(`DSH stream block ${block} ended with ${field} that does not extend its emitted delta`)
  }
  return authoritative.slice(streamed.length)
}

function requireOpenAiOutputBlock(block: ContentBlock, index: number): asserts block is OpenAiOutputBlock {
  if (block.type === 'text' || block.type === 'reasoning' || block.type === 'tool-call') return
  throw new Error(`DSH stream block ${index} has unsupported OpenAI completion type ${JSON.stringify(block.type)}`)
}

function completeBlock(block: BlockAccumulator, index: number): ContentBlock {
  if (block.block) return block.block
  switch (block.blockType) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': {
      const tool = block.tool
      if (!tool) throw new Error(`DSH stream tool block ${index} ended without a tool call`)
      return {
        type: 'tool-call',
        id: tool.id as ToolCallId,
        name: tool.name ?? '',
        arguments: tool.arguments,
      }
    }
    default: throw new Error(`DSH stream block ${index} has unknown type ${JSON.stringify(block.blockType)}`)
  }
}

function openAiAssistantMessage(blocks: readonly ContentBlock[]): JsonRecord {
  let sawText = false
  let text = ''
  let sawReasoning = false
  let reasoning = ''
  const toolCalls: JsonRecord[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        sawText = true
        text += block.text
        break
      case 'reasoning':
        sawReasoning = true
        reasoning += block.text
        break
      case 'tool-call':
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        })
        break
      default:
        throw new Error(`DSH stream cannot represent ${JSON.stringify(block.type)} in an OpenAI assistant message`)
    }
  }

  return {
    role: 'assistant',
    content: sawText ? text : null,
    ...sawReasoning ? { reasoning_content: reasoning } : {},
    ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
  }
}

/**
 * Re-encode DSH stream chunks as OpenAI chat-completions SSE. Successful
 * streams emit a finish chunk then exactly one `data: [DONE]` marker. An error
 * or abort throws instead, so an HTTP wrapper cannot mistake it for success.
 */
export async function* encodeChatStream(
  chunks: AsyncIterable<StreamChunk>,
  options: EncodeChatStreamOptions,
): AsyncIterable<string> {
  if (typeof options.id !== 'string' || options.id.length === 0) throw new TypeError('OpenAI stream id must be non-empty')
  if (typeof options.model !== 'string' || options.model.length === 0) throw new TypeError('OpenAI stream model must be non-empty')

  const blocks = new Map<number, BlockAccumulator>()
  const order: number[] = []
  let nextToolCallIndex = 0
  let roleSent = false
  let usage: TokenUsage | undefined
  let finished = false

  for await (const chunk of chunks) {
    if (finished) throw new Error('DSH stream produced a chunk after terminal finish')

    switch (chunk.type) {
      case 'block-start': {
        ensureBlock(blocks, order, chunk.index, chunk.blockType)
        break
      }
      case 'text-delta': {
        const block = ensureBlock(blocks, order, chunk.index, 'text')
        if (block.block) break
        block.text += chunk.text
        if (chunk.text !== '') {
          const delta = addRole({ content: chunk.text }, roleSent)
          roleSent = true
          yield sse(completionChunk(options, delta, null))
        }
        break
      }
      case 'reasoning-delta': {
        const block = ensureBlock(blocks, order, chunk.index, 'reasoning')
        if (block.block) break
        block.text += chunk.text
        // Reasoning deltas are provisional: the assembler may normalize or
        // revise the final block text (including trailing newlines). Buffer
        // them until block-end so the wire value is authoritative and can be
        // replayed byte-for-byte from onFinish.message.
        break
      }
      case 'tool-call-delta': {
        const block = ensureBlock(blocks, order, chunk.index, 'tool-call')
        if (block.block) break
        let tool = block.tool
        if (!tool) {
          tool = {
            callIndex: nextToolCallIndex,
            id: chunk.id,
            arguments: '',
          }
          nextToolCallIndex += 1
          block.tool = tool
        }
        if (tool.id !== chunk.id) throw new Error(`DSH stream changed tool call id for block ${chunk.index}`)
        if (chunk.name !== undefined) {
          if (tool.name !== undefined && tool.name !== chunk.name) {
            throw new Error(`DSH stream changed tool call name for block ${chunk.index}`)
          }
          tool.name = chunk.name
        }
        tool.arguments += chunk.argumentsDelta
        // Tool argument deltas may use a different JSON serialization from
        // the authoritative block-end. OpenAI SSE cannot retract already sent
        // bytes, so defer the complete call until that block closes.
        break
      }
      case 'block-end': {
        const ended = chunk.block
        requireOpenAiOutputBlock(ended, chunk.index)
        const block = ensureBlock(blocks, order, chunk.index, ended.type)
        if (block.block) break // The DSH assembler uses first-close-wins too.
        block.block = ended

        if (ended.type === 'text') {
          const remainder = suffixAfter(ended.text, block.text, chunk.index, ended.type)
          block.text = ended.text
          if (remainder !== '') {
            const delta = addRole(
              { content: remainder },
              roleSent,
            )
            roleSent = true
            yield sse(completionChunk(options, delta, null))
          }
          break
        }
        if (ended.type === 'reasoning') {
          // The final reasoning block is authoritative even when it does not
          // extend the provisional deltas emitted by the model adapter.
          block.text = ended.text
          if (ended.text !== '') {
            const delta = addRole({ reasoning_content: ended.text }, roleSent)
            roleSent = true
            yield sse(completionChunk(options, delta, null))
          }
          break
        }

        const streamed = block.tool
        const tool = streamed ?? {
          callIndex: nextToolCallIndex,
          id: ended.id,
          name: undefined,
          arguments: '',
        }
        if (!streamed) {
          nextToolCallIndex += 1
          block.tool = tool
        }
        if (tool.id !== ended.id) throw new Error(`DSH stream changed tool call id for block ${chunk.index}`)
        if (tool.name !== undefined && tool.name !== ended.name) {
          throw new Error(`DSH stream changed tool call name for block ${chunk.index}`)
        }
        tool.arguments = ended.arguments
        tool.name = ended.name
        const delta = addRole({ tool_calls: [toolCallDelta(tool)] }, roleSent)
        roleSent = true
        yield sse(completionChunk(options, delta, null))
        break
      }
      case 'usage': {
        if (usage !== undefined) throw new Error('DSH stream produced usage more than once')
        usage = chunk.usage
        yield sse(usageChunk(options, usage))
        break
      }
      case 'finish': {
        const finishReason = terminalFinishReason(chunk)
        finished = true
        // Preserve delta-only protocol compatibility on successful finish.
        // Error and abort finishes throw above without flushing provisional
        // reasoning or incomplete tool calls as successful output.
        for (const index of order) {
          const block = blocks.get(index) as BlockAccumulator
          if (block.block !== undefined) continue
          if (block.blockType === 'reasoning' && block.text !== '') {
            const delta = addRole({ reasoning_content: block.text }, roleSent)
            roleSent = true
            yield sse(completionChunk(options, delta, null))
          } else if (block.blockType === 'tool-call') {
            if (!block.tool) throw new Error(`DSH stream tool block ${index} ended without a tool call`)
            const delta = addRole({ tool_calls: [toolCallDelta(block.tool)] }, roleSent)
            roleSent = true
            yield sse(completionChunk(options, delta, null))
          }
        }
        const content = order.map(index => completeBlock(blocks.get(index) as BlockAccumulator, index))
        // This is the raw assistant shape Prime sends back in its next
        // chat/completions request. Keeping it here makes the caller's replay
        // key stable; decodeChatRequest turns it back into an immutable DSH
        // message and reattaches the opaque DSH replay envelope through replayFor.
        const message = openAiAssistantMessage(content)
        options.onFinish?.({
          message,
          ...chunk.replayState === undefined ? {} : { replayState: chunk.replayState },
          ...usage === undefined ? {} : { usage },
          finishReason,
        })
        yield sse(completionChunk(options, {}, finishReason))
        yield 'data: [DONE]\n\n'
        return
      }
      default: {
        const unrecognized = chunk as { type?: unknown }
        throw new Error(`Unsupported DSH stream chunk ${JSON.stringify(unrecognized.type)}`)
      }
    }
  }

  throw new Error('DSH stream ended without a terminal finish')
}
