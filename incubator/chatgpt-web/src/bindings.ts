import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WebController } from './controller.js'
import type { WebRunRecord, WebRunRequest } from './store.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_PROMPT_BYTES = 128 * 1024

const WEB_ABORT_DIAGNOSTIC =
  'ChatGPT Web 等待已取消；已停止本机等待，不保证网站端任务已经停止。'

type WebControllerLike = Pick<WebController, 'start' | 'read' | 'list' | 'observe' | 'cancel' | 'dispose'>

export interface WebBindingDefaults {
  readonly modelLabel?: string
  readonly effortLabel?: string
}

type NormalizedDefaults = Readonly<{
  modelLabel?: string
  effortLabel?: string
}>

type WebSessionId = SubagentRun['id']

type WebToolAction = 'run' | 'inspect' | 'observe' | 'cancel' | 'list'

interface RunToolInput {
  readonly action: 'run'
  readonly commandId: string
  readonly prompt: string
  readonly modelLabel?: string
  readonly effortLabel?: string
}

interface CommandToolInput {
  readonly action: 'inspect' | 'observe' | 'cancel'
  readonly commandId: string
}

interface ListToolInput {
  readonly action: 'list'
}

type ParsedToolInput = RunToolInput | CommandToolInput | ListToolInput

interface NamedToolError {
  readonly code: string
  readonly message: string
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

interface WebToolValue {
  readonly action: WebToolAction
  readonly commandId?: string
  readonly record?: JsonValue
  readonly records?: JsonValue[]
  readonly error?: NamedToolError
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  const keys = new Set(allowed)
  const unknown = Object.keys(value).filter(key => !keys.has(key))
  if (unknown.length > 0) {
    throw new Error(`${context} 含有未支持字段：${unknown.join(', ')}`)
  }
}

function normalizeDefaults(defaults: WebBindingDefaults | undefined): NormalizedDefaults {
  if (defaults === undefined) return {}
  if (!isRecord(defaults)) throw new Error('ChatGPT Web 默认选择必须是对象')
  assertAllowedKeys(defaults, ['modelLabel', 'effortLabel'], 'ChatGPT Web 默认选择')
  if (hasOwn(defaults, 'modelLabel') && defaults.modelLabel !== undefined && typeof defaults.modelLabel !== 'string') {
    throw new Error('ChatGPT Web 默认模型必须是字符串')
  }
  if (hasOwn(defaults, 'effortLabel') && defaults.effortLabel !== undefined && typeof defaults.effortLabel !== 'string') {
    throw new Error('ChatGPT Web 默认强度必须是字符串')
  }
  const modelLabel = defaults.modelLabel as string | undefined
  const effortLabel = defaults.effortLabel as string | undefined
  return {
    ...(modelLabel === undefined ? {} : { modelLabel }),
    ...(effortLabel === undefined ? {} : { effortLabel }),
  }
}

function assertController(controller: WebControllerLike): void {
  if (!isRecord(controller)) throw new Error('ChatGPT Web controller 不可用')
  for (const method of ['start', 'read', 'list', 'observe', 'cancel', 'dispose'] as const) {
    if (typeof controller[method] !== 'function') {
      throw new Error(`ChatGPT Web controller 缺少 ${method} 方法`)
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error(WEB_ABORT_DIAGNOSTIC)
  error.name = 'AbortError'
  throw error
}

function abortResult(): SubagentResult {
  return {
    output: [],
    stopReason: 'aborted',
    diagnostic: WEB_ABORT_DIAGNOSTIC,
  }
}

function textFromPrompt(prompt: readonly ContentBlock[]): string {
  if (!Array.isArray(prompt)) throw new Error('chatgpt-web 只接受文本 ContentBlock 数组')
  const chunks: string[] = []
  for (const block of prompt) {
    if (!isRecord(block) || block.type !== 'text') {
      const kind = isRecord(block) && typeof block.type === 'string' ? block.type : 'unknown'
      throw new Error(`chatgpt-web 只接受文本输入；拒绝 ContentBlock 类型 ${kind}`)
    }
    const keys = Object.keys(block)
    if (keys.some(key => key !== 'type' && key !== 'text') || typeof block.text !== 'string') {
      throw new Error('chatgpt-web 拒绝未验证的文本 ContentBlock')
    }
    chunks.push(block.text)
  }
  const text = chunks.join('')
  assertPrompt(text, 'chatgpt-web.prompt')
  return text
}

function assertPrompt(prompt: string, field: string): void {
  if (prompt.length === 0) throw new Error(`${field} 不能为空`)
  if (new TextEncoder().encode(prompt).byteLength > MAX_PROMPT_BYTES) {
    throw new Error(`${field} 超过 128 KiB 限制`)
  }
}

function webRequestFromStart(
  request: ResolvedSubagentStartRequest,
  defaults: NormalizedDefaults,
): WebRunRequest {
  if (!isRecord(request) || !request.signal || typeof request.signal.addEventListener !== 'function') {
    throw new Error('chatgpt-web start 缺少有效取消信号')
  }
  throwIfAborted(request.signal)
  const prompt = textFromPrompt(request.prompt)
  // The resolved cwd/parent are intentionally not read: this provider has no
  // filesystem or parent-context capability. Explicit start options are rejected
  // by the upstream subagent manager because every capability below is false.
  return {
    prompt,
    ...(defaults.modelLabel === undefined ? {} : { modelLabel: defaults.modelLabel }),
    ...(defaults.effortLabel === undefined ? {} : { effortLabel: defaults.effortLabel }),
  }
}

function outputBlocks(record: WebRunRecord): readonly ContentBlock[] {
  const markdown = record.output?.markdown
  return markdown === undefined ? [] : [{ type: 'text', text: markdown }]
}

function safeRecordDiagnostic(record: WebRunRecord): string {
  const code = record.error?.code !== undefined && /^WEB_[A-Za-z0-9_.:-]{1,120}$/.test(record.error.code)
    ? record.error.code
    : undefined
  if (record.stage === 'completed' && record.output === undefined) {
    return 'ChatGPT Web 记录标记为 completed，但没有完整输出，不能视为成功。'
  }
  if (record.stage === 'abandoned') return 'ChatGPT Web 已结束本地跟踪，远端结果仍未知；没有自动重试。'
  if (record.stage === 'indeterminate') {
    return `ChatGPT Web 结果为 indeterminate，未确认完成${code === undefined ? '' : `（${code}）`}。`
  }
  if (record.stage === 'cancelled') {
    return WEB_ABORT_DIAGNOSTIC
  }
  return `ChatGPT Web 未完成（阶段：${record.stage}${code === undefined ? '' : `；错误：${code}`}）。`
}

function resultFromRecord(record: WebRunRecord): SubagentResult {
  if (record.stage === 'completed' && record.output !== undefined) {
    return {
      output: outputBlocks(record),
      stopReason: 'completed',
    }
  }
  return {
    output: outputBlocks(record),
    stopReason: record.stage === 'cancelled' ? 'aborted' : 'error',
    diagnostic: safeRecordDiagnostic(record),
  }
}

function safeControllerError(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const code = isRecord(error) && typeof error.code === 'string' && /^[A-Za-z0-9_.:-]+$/.test(error.code)
    ? error.code
    : 'WEB_CONTROLLER_ERROR'
  return new Error(`ChatGPT Web controller 操作失败（${code}）`)
}

function createOwnedRun(
  controller: WebControllerLike,
  id: string,
  request: WebRunRequest,
  signal: AbortSignal,
): SubagentRun {
  const localAbort = new AbortController()
  let disposed = false
  let abortRequested = false
  let settled = false
  let startFinished = false
  let cancelPromise: Promise<void> | undefined
  let disposePromise: Promise<void> | undefined
  let resolveResult!: (result: SubagentResult) => void
  let rejectResult!: (error: unknown) => void
  const result = new Promise<SubagentResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const settle = (value: SubagentResult): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }

  const requestCancel = (): Promise<void> => {
    if (cancelPromise !== undefined) return cancelPromise
    if (startFinished) {
      cancelPromise = Promise.resolve()
      return cancelPromise
    }
    try {
      cancelPromise = Promise.resolve(controller.cancel(id)).then(() => undefined)
    } catch (error) {
      cancelPromise = Promise.reject(error)
    }
    // Cancellation is a local wait operation. A rejected cancellation must not
    // turn an already-settled provider result into a remote success claim.
    void cancelPromise.catch(() => undefined)
    return cancelPromise
  }

  const onAbort = (): void => {
    if (disposed) return
    abortRequested = true
    localAbort.abort(signal.reason)
    void requestCancel().catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const unlink = (): void => signal.removeEventListener('abort', onAbort)
  if (signal.aborted) onAbort()

  let startPromise: Promise<WebRunRecord>
  try {
    startPromise = controller.start(id, request, localAbort.signal)
  } catch (error) {
    unlink()
    rejectResult(safeControllerError(error))
    startPromise = Promise.reject(error)
  }
  void startPromise.then(
    record => {
      startFinished = true
      if (disposed || abortRequested || signal.aborted) settle(abortResult())
      else settle(resultFromRecord(record))
    },
    error => {
      startFinished = true
      if (disposed || abortRequested || signal.aborted) settle(abortResult())
      else rejectResult(safeControllerError(error))
    },
  ).finally(unlink)

  const dispose = async (): Promise<void> => {
    if (disposePromise !== undefined) return disposePromise
    disposed = true
    localAbort.abort()
    settle(abortResult())
    unlink()
    disposePromise = (async () => {
      let cancellationFailure: unknown
      try {
        await requestCancel()
      } catch (error) {
        cancellationFailure = error
      }
      // The controller owns only bounded local browser-process waiting. Await
      // its start promise so the local handle reaches quiescence, while never
      // creating a second request or waiting for remote website generation.
      try {
        await startPromise
      } catch {
        // The result promise already carries an infrastructure rejection when
        // appropriate; disposal still completes local cleanup below.
      }
      if (cancellationFailure !== undefined) throw safeControllerError(cancellationFailure)
    })()
    return disposePromise
  }

  return {
    id: id as unknown as WebSessionId,
    result,
    dispose,
  }
}

export function createWebProvider(
  controller: WebControllerLike,
  defaults: WebBindingDefaults = {},
): SubagentProvider {
  assertController(controller)
  const normalizedDefaults = normalizeDefaults(defaults)
  return {
    name: 'chatgpt-web',
    capabilities: {
      agentOptions: false,
      agentPreset: false,
      outputSchema: false,
      depthLimit: false,
    },
    inheritsParentContext: false,
    async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
      const webRequest = webRequestFromStart(request, normalizedDefaults)
      const id = randomUUID()
      return createOwnedRun(controller, id, webRequest, request.signal)
    },
  }
}

function parseCommandId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${field} 必须是 UUID`)
  }
  return value
}

function parseToolInput(raw: unknown, defaults: NormalizedDefaults): ParsedToolInput {
  if (!isRecord(raw)) throw new Error('solar_chatgpt_web 参数必须是对象')
  assertAllowedKeys(raw, ['action', 'command_id', 'prompt', 'model_label', 'effort_label'], 'solar_chatgpt_web 参数')
  if (typeof raw.action !== 'string') throw new Error('solar_chatgpt_web.action 必须是字符串')
  const action = raw.action as WebToolAction
  if (!['run', 'inspect', 'observe', 'cancel', 'list'].includes(action)) {
    throw new Error(`solar_chatgpt_web 不支持动作 ${raw.action}`)
  }

  if (action === 'list') {
    if (Object.keys(raw).length !== 1) throw new Error('list 不接受 command_id、prompt 或模型选择')
    return { action: 'list' }
  }

  const commandId = parseCommandId(raw.command_id, 'command_id')
  if (action !== 'run') {
    if (hasOwn(raw, 'prompt') || hasOwn(raw, 'model_label') || hasOwn(raw, 'effort_label')) {
      throw new Error(`${action} 不接受 prompt 或模型选择`)
    }
    return { action, commandId }
  }

  if (typeof raw.prompt !== 'string') throw new Error('run.prompt 是必填字符串')
  assertPrompt(raw.prompt, 'run.prompt')
  if (hasOwn(raw, 'model_label') && typeof raw.model_label !== 'string') {
    throw new Error('run.model_label 必须是字符串')
  }
  if (hasOwn(raw, 'effort_label') && typeof raw.effort_label !== 'string') {
    throw new Error('run.effort_label 必须是字符串')
  }
  return {
    action: 'run',
    commandId,
    prompt: raw.prompt,
    ...(hasOwn(raw, 'model_label') ? { modelLabel: raw.model_label as string } : defaults.modelLabel === undefined ? {} : { modelLabel: defaults.modelLabel }),
    ...(hasOwn(raw, 'effort_label') ? { effortLabel: raw.effort_label as string } : defaults.effortLabel === undefined ? {} : { effortLabel: defaults.effortLabel }),
  }
}

function recordError(record: WebRunRecord | undefined): NamedToolError | undefined {
  if (record?.error === undefined) return undefined
  return { code: record.error.code, message: record.error.message }
}

function namedError(code: string, message: string): NamedToolError {
  return { code, message }
}

async function executeWebTool(
  input: ParsedToolInput,
  controller: WebControllerLike,
  exec: ToolRunContext,
): Promise<WebToolValue> {
  if (input.action === 'list') {
    throwIfAborted(exec.signal)
    const records = await controller.list()
    throwIfAborted(exec.signal)
    return { action: input.action, records: records.map(jsonValue) }
  }

  if (input.action === 'run') {
    throwIfAborted(exec.signal)
    const record = await controller.start(input.commandId, {
      prompt: input.prompt,
      ...(input.modelLabel === undefined ? {} : { modelLabel: input.modelLabel }),
      ...(input.effortLabel === undefined ? {} : { effortLabel: input.effortLabel }),
    }, exec.signal)
    return { action: input.action, commandId: input.commandId, record: jsonValue(record), error: recordError(record) }
  }

  if (input.action === 'inspect') {
    throwIfAborted(exec.signal)
    const record = await controller.read(input.commandId)
    throwIfAborted(exec.signal)
    return record === undefined
      ? { action: input.action, commandId: input.commandId, error: namedError('WEB_RUN_NOT_FOUND', '未找到该命令记录') }
      : { action: input.action, commandId: input.commandId, record: jsonValue(record), error: recordError(record) }
  }

  if (input.action === 'observe') {
    throwIfAborted(exec.signal)
    const record = await controller.observe(input.commandId, exec.signal)
    return { action: input.action, commandId: input.commandId, record: jsonValue(record), error: recordError(record) }
  }

  throwIfAborted(exec.signal)
  const record = await controller.cancel(input.commandId)
  return { action: input.action, commandId: input.commandId, record: jsonValue(record), error: recordError(record) }
}

function selectionLabel(value: string | undefined): string {
  return value === undefined ? '未指定' : value
}

function renderRecord(record: WebRunRecord): string {
  const lines = [
    `命令 ID：${record.id}`,
    `阶段：${record.stage}`,
    `请求模型：${selectionLabel(record.request.modelLabel)}`,
    `请求强度：${selectionLabel(record.request.effortLabel)}`,
    `实际模型：${selectionLabel(record.observed?.modelLabel)}`,
    `实际强度：${selectionLabel(record.observed?.effortLabel)}`,
    `请求提示：\n${record.request.prompt}`,
  ]
  if (record.resource !== undefined) {
    lines.push(`原始资源：space=${record.resource.spaceId}；页面=${record.resource.pageLabel}${record.resource.conversationUrl === undefined ? '' : `；会话=${record.resource.conversationUrl}`}`)
  }
  if (record.output !== undefined) {
    lines.push(record.stage === 'completed'
      ? `完整输出 Markdown：\n${record.output.markdown}`
      : `已观测输出（阶段未完成，可能部分）：\n${record.output.markdown}`)
  } else {
    lines.push('完整输出 Markdown：\n（当前记录没有完整输出）')
  }
  if (record.error !== undefined) {
    lines.push(`命名错误：${record.error.code}：${record.error.message}`)
  }
  if (record.stage === 'indeterminate') {
    lines.push('结论：indeterminate，不代表成功，也未自动重试或改用其他 provider。')
  }
  if (record.stage === 'cancelled') {
    lines.push('取消说明：仅停止本机等待，不保证网站端任务已经停止。')
  }
  return lines.join('\n')
}

function renderToolValue(value: unknown): ContentBlock[] {
  if (!isRecord(value)) return [{ type: 'text', text: 'solar_chatgpt_web 返回了无法识别的记录。' }]
  const typed = value as unknown as WebToolValue
  const parts = [`动作：${typed.action}`]
  if (typed.commandId !== undefined) parts.push(`命令 ID：${typed.commandId}`)
  if (typed.record !== undefined) parts.push(renderRecord(typed.record as unknown as WebRunRecord))
  if (typed.records !== undefined) {
    parts.push(typed.records.length === 0
      ? '记录列表为空。'
      : typed.records.map(value => renderRecord(value as unknown as WebRunRecord)).join('\n\n'))
  }
  if (typed.error !== undefined) parts.push(`命名错误：${typed.error.code}：${typed.error.message}`)
  return [{ type: 'text', text: parts.join('\n') }]
}

function actionTitle(action: WebToolAction | undefined): string {
  switch (action) {
    case 'run': return '运行 ChatGPT Web'
    case 'inspect': return '读取 ChatGPT Web 记录'
    case 'observe': return '观察 ChatGPT Web 原始资源'
    case 'cancel': return '取消本机 ChatGPT Web 等待'
    case 'list': return '列出 ChatGPT Web 记录'
    default: return 'ChatGPT Web 操作'
  }
}

export function createWebTool(
  controller: WebControllerLike,
  defaults: WebBindingDefaults = {},
): ToolDefinition {
  assertController(controller)
  const normalizedDefaults = normalizeDefaults(defaults)
  return defineTool({
    name: 'solar_chatgpt_web',
    description:
      '运行或观察 ChatGPT Web 的一个有稳定 command_id 的文本任务。run 会消耗用户已登录的 ChatGPT 网页订阅额度；本工具不会自动 fallback、重试或改用其他 provider。'
      + ' inspect/list 只读本地记录且不会启动浏览器；observe 只观察同一原始资源；cancel 只停止本机等待，不保证网站端停止。',
    parameters: {
      action: {
        type: 'string',
        enum: ['run', 'inspect', 'observe', 'cancel', 'list'],
        required: true,
        description: '动作：run、inspect、observe、cancel 或 list。',
      },
      command_id: {
        type: 'string',
        description: 'run/inspect/observe/cancel 使用的稳定 UUID；同一 UUID 只能复用完全相同的请求。',
      },
      prompt: {
        type: 'string',
        description: '仅 run 接受的纯文本提示。',
      },
      model_label: {
        type: 'string',
        description: '仅 run 可选的网页模型标签；省略时使用插件默认，不能用来强制网页选择。',
      },
      effort_label: {
        type: 'string',
        description: '仅 run 可选的网页强度标签；省略时使用插件默认，实际选择以网页观察为准。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['run', 'inspect', 'observe', 'cancel', 'list'] },
          commandId: { type: 'string' },
          record: { type: 'json' },
          records: { type: 'array', items: { type: 'json' } },
          error: {
            type: 'object',
            additionalProperties: false,
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => renderToolValue(value),
    },
    presentCall: (args) => {
      try {
        const input = parseToolInput(args, normalizedDefaults)
        return { card: 'generic', kind: input.action === 'list' || input.action === 'inspect' || input.action === 'observe' ? 'read' : 'execute', title: actionTitle(input.action) }
      } catch {
        return { card: 'generic', kind: 'other', title: 'ChatGPT Web 操作' }
      }
    },
    presentResult: (args, result) => {
      let action: WebToolAction | undefined
      try { action = parseToolInput(args, normalizedDefaults).action } catch { /* replay-only fallback */ }
      return {
        card: 'generic',
        title: result.isError ? 'ChatGPT Web 操作失败' : `${actionTitle(action)}结果`,
        content: result.content,
      }
    },
    async execute(args, exec) {
      const input = parseToolInput(args, normalizedDefaults)
      try {
        return await executeWebTool(input, controller, exec)
      } catch (error) {
        throw safeControllerError(error)
      }
    },
  })
}
