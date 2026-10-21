import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RlmHost, type Owner, type StartInput } from './core.js'
import type { ModelRoute } from './model-wire.js'
import { nativeAutonomousSchema } from './execution.js'
import type { CancelInput, InspectInput, RlmUiStatus, SelfTestInput, SelfTestReport, RunSummary } from './ui-contract.js'

export const name = 'rlm'
export const inject = ['tools', 'llm', 'attachments']

const MAX_INPUT_BYTES = 64 * 1024 * 1024
const MAX_MODEL_REQUESTS = 1_000
const MAX_WALL_TIME_MS = 24 * 60 * 60 * 1_000
const DEFAULT_INPUT_BYTES = 16 * 1024 * 1024
const DEFAULT_MODEL_REQUESTS = 100
const DEFAULT_WALL_TIME_MS = 60 * 60 * 1_000
const MAX_TEXT_CHARS = 200_000
const MAX_LABEL_CHARS = 256
const MAX_PATH_CHARS = 4_096
const MAX_INPUT_FILES = 256

export interface Config {
  /** Maximum bytes copied into one run's immutable input snapshot. */
  readonly maxInputBytes: number
  /** Opt into Prime's original factory gate for ordinary RLM runs. */
  readonly factoryEnabled: boolean
  /** Preserve Prime's interactive /refine handling for resumed turns. */
  readonly harnessRefinements: boolean
  /** Maximum logical model requests admitted to one run. */
  readonly maxModelRequests: number
  /** Maximum wall time for one RLM turn. */
  readonly maxWallTimeMs: number
}

export const Config: z<Config> = z.object({
  maxInputBytes: z.number().step(1).min(1).max(MAX_INPUT_BYTES).default(DEFAULT_INPUT_BYTES),
  factoryEnabled: z.boolean().default(false),
  harnessRefinements: z.boolean().default(true),
  maxModelRequests: z.number().step(1).min(1).max(MAX_MODEL_REQUESTS).default(DEFAULT_MODEL_REQUESTS),
  maxWallTimeMs: z.number().step(1).min(1_000).max(MAX_WALL_TIME_MS).default(DEFAULT_WALL_TIME_MS),
})

const nonEmptyText = (max: number) => zod.string().min(1).max(max).refine(value => value.trim().length > 0, 'must not be blank')
const runId = zod.uuid()
const workspacePath = nonEmptyText(MAX_PATH_CHARS)
const taskText = nonEmptyText(MAX_TEXT_CHARS)
const labelText = nonEmptyText(MAX_LABEL_CHARS)
const inputName = nonEmptyText(MAX_PATH_CHARS)

export const startInputSchema = zod.strictObject({
  task: taskText,
  cwd: workspacePath,
  label: labelText.optional(),
  inputs: zod.array(inputName).max(MAX_INPUT_FILES).optional(),
  autonomous: nativeAutonomousSchema.optional(),
  maxModelRequests: zod.number().int().min(1).max(MAX_MODEL_REQUESTS),
  maxWallTimeMs: zod.number().int().min(1_000).max(MAX_WALL_TIME_MS),
})

export const inspectInputSchema = zod.strictObject({ runId })
export const checkInputSchema = zod.strictObject({ commandId: zod.uuid() })

export const controlInputSchema = zod.strictObject({
  runId,
  action: zod.enum(['continue', 'refine', 'cancel']),
  text: taskText.optional(),
}).superRefine((value, context) => {
  if (value.action === 'cancel' && value.text !== undefined) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'cancel does not accept text' })
  }
  if (value.action !== 'cancel' && value.text === undefined) {
    context.addIssue({ code: 'custom', path: ['text'], message: `${value.action} requires text` })
  }
  if (value.action === 'refine' && value.text !== undefined && !/^\/refine(?:\s|$)/.test(value.text)) {
    context.addIssue({ code: 'custom', path: ['text'], message: 'refine text must be the original /refine command' })
  }
})

type ControlInput = zod.infer<typeof controlInputSchema>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requireAgent(exec: ToolRunContext): NonNullable<ToolRunContext['agent']> {
  if (exec.agent === undefined) throw new Error('RLM_OWNER_REQUIRED: 需要当前会话的 Agent 路由。')
  return exec.agent
}

function sessionFromExec(exec: ToolRunContext): string {
  return String(requireAgent(exec).session.id)
}

/**
 * Capture the exact route selected by the current Agent. The signal is
 * intentionally omitted: a run continues after the receipt tool settles, and
 * the tool execution signal may be scoped to that one model turn.
 */
export function ownerFromExec(exec: ToolRunContext): Owner {
  const agent = requireAgent(exec)
  const options = agent.options
  if (typeof options.provider !== 'string' || options.provider.trim() === '') {
    throw new Error('RLM_ROUTE_REQUIRED: 当前 Agent 没有 provider 路由。')
  }
  if (typeof options.model !== 'string' || options.model.trim() === '') {
    throw new Error('RLM_ROUTE_REQUIRED: 当前 Agent 没有 model 路由。')
  }
  const route: ModelRoute = { provider: options.provider, model: options.model }
  if (options.reasoningEffort !== undefined) route.reasoningEffort = options.reasoningEffort
  if (options.maxTokens !== undefined) route.maxTokens = options.maxTokens
  return { sessionId: String(agent.session.id), route }
}

function enforceRunLimits(input: StartInput, config: Config): void {
  if (input.maxModelRequests > config.maxModelRequests) {
    throw new Error(`RLM_BUDGET_LIMIT: maxModelRequests 不能超过配置上限 ${config.maxModelRequests}。`)
  }
  if (input.maxWallTimeMs > config.maxWallTimeMs) {
    throw new Error(`RLM_TIME_LIMIT: maxWallTimeMs 不能超过配置上限 ${config.maxWallTimeMs}。`)
  }
}

const runSummaryOutput = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      runId: { type: 'string' as const, required: true as const },
      label: { type: 'string' as const, required: true as const },
      state: { type: 'string' as const, required: true as const },
      message: { type: 'string' as const, required: true as const },
      createdAt: { type: 'string' as const, required: true as const },
      updatedAt: { type: 'string' as const, required: true as const },
      modelRequests: { type: 'integer' as const, required: true as const },
      result: { type: 'string' as const },
      traceRef: { type: 'string' as const },
    },
    // dsh-tools' value schema DSL marks required fields on each property.
    // A top-level JSON-Schema `required` array is rejected at registration.
  },
  render: (_args: unknown, value: RunSummary) => [{
    type: 'text' as const,
    text: JSON.stringify(value),
  }],
}

function runToolDescription(): string {
  return 'Start one bounded Prime RLM task using the current Agent provider, model, reasoning effort and max output tokens exactly as selected. Optional autonomous settings enable the original Prime bounded continuation and completion gate. The tool returns an asynchronous receipt; inspect it for progress and terminal state. The Prime process reads the admitted cwd with its normal file permissions. A completed receipt is not a quality proof.'
}

export function createRunTool(host: RlmHost, config: Config): ToolDefinition {
  return defineTool({
    name: 'solar_rlm_run',
    description: runToolDescription(),
    presentCall: () => ({ card: 'generic', kind: 'execute', title: '启动 Prime RLM 任务' }),
    presentResult: (_args, result) => result.isError
      ? { card: 'generic', title: 'Prime RLM 未启动', content: result.content }
      : { card: 'generic', title: 'Prime RLM 已提交', content: [{ type: 'text', text: '任务已提交；请继续检查任务状态和原生记录。提交回执不代表答案已完成或通过质量验收。' }] },
    parameters: {
      task: { type: 'string', required: true, description: '任务文本。' },
      cwd: { type: 'string', required: true, description: '已选择的工作目录。Prime 会按正常文件权限读取它。' },
      label: { type: 'string', description: '任务显示名称。' },
      inputs: { type: 'array', items: { type: 'string' }, description: '工作目录内的相对输入文件路径。' },
      autonomous: {
        type: 'object',
        additionalProperties: false,
        description: '显式启用 Prime 原生自主续轮；省略时保持普通原生模式。原生计数在冷恢复时重新开始，任务树请求总额不重置。',
        properties: {
          maxTurns: { type: 'integer', required: true, description: '原生 assistant turn 上限（1-1000）。' },
          maxTokens: { type: 'integer', required: true, description: '原生 autonomous token 上限（1-1000000000），不是单次输出上限。' },
          gate: { type: 'string', description: '可选原生完成检查命令；在任务工作目录按 Prime 原始机制执行。' },
          gateMaxRetries: { type: 'integer', description: '原生完成门禁重试上限（1-1000）；不增加整树模型请求预算。' },
          maxContinuations: { type: 'integer', description: '原生自主续轮上限（1-1000）；省略时使用 Prime 默认值，不增加整树模型请求预算。' },
        },
      },
      maxModelRequests: { type: 'integer', required: true, description: `整个任务树的逻辑模型请求上限（1-${MAX_MODEL_REQUESTS}）。` },
      maxWallTimeMs: { type: 'integer', required: true, description: `每轮原生执行的时间上限（1000-${MAX_WALL_TIME_MS} 毫秒）。` },
    },
    output: runSummaryOutput,
    async execute(args, exec) {
      const input = startInputSchema.parse(args)
      enforceRunLimits(input, config)
      return host.start(input, ownerFromExec(exec))
    },
  })
}

export function createInspectTool(host: RlmHost): ToolDefinition {
  return defineTool({
    name: 'solar_rlm_inspect',
    description: 'Inspect one Prime RLM task owned by the current Agent session. A running or indeterminate state requires the original record and process evidence; inspection never replays a task.',
    presentCall: () => ({ card: 'generic', kind: 'execute', title: '检查 Prime RLM 状态' }),
    presentResult: (_args, result) => result.isError
      ? { card: 'generic', title: 'Prime RLM 状态读取失败', content: result.content }
      : { card: 'generic', title: 'Prime RLM 状态已返回', content: result.content },
    parameters: { runId: { type: 'string', required: true, description: '任务引用。' } },
    output: runSummaryOutput,
    async execute(args, exec) {
      const input = inspectInputSchema.parse(args)
      return host.inspect(input.runId, sessionFromExec(exec))
    },
  })
}

export function createControlTool(host: RlmHost): ToolDefinition {
  return defineTool({
    name: 'solar_rlm_control',
    description: 'Control one owned Prime RLM task. cancel requests native shutdown; continue sends one new text turn through the same durable Prime session; refine uses the same continue path with the original /refine command. Control returns an asynchronous receipt and does not prove answer quality.',
    presentCall: args => ({ card: 'generic', kind: 'execute', title: args.action === 'cancel' ? '请求停止 Prime RLM' : args.action === 'refine' ? '发送 Prime RLM refine' : '继续 Prime RLM 任务' }),
    presentResult: (_args, result) => result.isError
      ? { card: 'generic', title: 'Prime RLM 控制未完成', content: result.content }
      : { card: 'generic', title: 'Prime RLM 控制已返回', content: result.content },
    parameters: {
      runId: { type: 'string', required: true, description: '任务引用。' },
      action: { type: 'string', enum: ['continue', 'refine', 'cancel'], required: true, description: '控制动作。refine 的 text 必须是原始 /refine 命令。' },
      text: { type: 'string', description: 'continue 或 refine 的原始文本；cancel 不接受。' },
    },
    output: runSummaryOutput,
    async execute(args, exec) {
      const input = controlInputSchema.parse(args) as ControlInput
      if (input.action === 'cancel') return host.cancel(input.runId, sessionFromExec(exec))
      const owner = ownerFromExec(exec)
      return host.continue(input.runId, input.text!, owner)
    },
  })
}

export class SolarRlmControl extends TypertRemoteService {
  constructor(ctx: Context, readonly host: RlmHost) {
    super(ctx, 'solarRlm', { namespace: 'solarRlmControl' })
  }

  private owner(): void {
    const invocation = this.ctx.invocation
    if (invocation !== undefined && invocation.peer.principal.kind !== 'owner') {
      throw new Error('LOCAL_OWNER_REQUIRED: Prime RLM 控制界面仅允许本机所有者操作。')
    }
  }

  @Remote
  async status(): Promise<RlmUiStatus> {
    this.owner()
    return this.host.status()
  }

  @Remote
  async check(input: SelfTestInput): Promise<SelfTestReport> {
    this.owner()
    const value = checkInputSchema.parse(input)
    return this.host.check(value.commandId)
  }

  @Remote
  async inspect(input: InspectInput): Promise<RunSummary> {
    this.owner()
    const value = inspectInputSchema.parse(input)
    return this.host.inspect(value.runId)
  }

  @Remote
  async cancel(input: CancelInput): Promise<RunSummary> {
    this.owner()
    const value = inspectInputSchema.parse(input)
    return this.host.cancel(value.runId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    solarRlm: SolarRlmControl
  }
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

export function apply(ctx: Context, config: Config): void {
  const dataRoot = join(resolveDshHome(), 'solar', 'rlm')
  const host = new RlmHost(ctx, dataRoot, packageRoot(), config.maxInputBytes, {
    factoryEnabled: config.factoryEnabled,
    harnessRefinements: config.harnessRefinements,
  })
  new SolarRlmControl(ctx, host)

  ctx.effect(() => {
    const unregisterRun = ctx.tools.register(createRunTool(host, config))
    const unregisterInspect = ctx.tools.register(createInspectTool(host))
    const unregisterControl = ctx.tools.register(createControlTool(host))
    return () => {
      unregisterControl()
      unregisterInspect()
      unregisterRun()
    }
  }, 'rlm: tools')

  ctx.effect(() => async () => {
    await host.dispose()
  }, 'rlm: host')
}
