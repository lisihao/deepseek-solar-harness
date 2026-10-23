import { NativeControl } from './control.js'
import { createHash } from 'node:crypto'
import { WorkflowStudio, buildStudioDeliveryPrompt, buildStudioSourceDeliveryPrompt } from './studio.js'
import { StudioControl } from './studio-control.js'
import { SessionModeController, installSessionMode } from './session-mode.js'
import { createNativeStudioProvider, nativeGraphToStudio, nativeSnapshotToStudioRun } from './studio-native.js'
import { createWaitTool } from './wait.js'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import z from '@deepseek-ai/schemastery'
import type { GraphStatus, ResidentApi } from '@lisihao/dsh-solar-native-resident/contracts'
import { coordinateResident, type AllocationProfile, type CoordinateOutput, coordinateGraphDescription } from './coordinate.js'
import { dispatchCollaboration, type DelegationOutput } from './dispatch.js'
import { disposeOwnedActivations, trackOwnedActivation } from './lifecycle.js'
import type { NormalizedCollaborationInput } from './validation.js'

const RESIDENT_SERVICE = 'solarNativeResident'
function requiredResident(ctx: Context): ResidentApi {
  const resident = ctx.get(RESIDENT_SERVICE) as ResidentApi | undefined
  if (resident?.protocolVersion !== 1) throw new Error('RESIDENT_UNAVAILABLE: 请启用 Resident 后再执行协同任务。')
  return resident
}

export const name = 'native-collaboration'
export const inject = ['tools', 'subagents', 'agents', 'systemPrompt']

export interface Config {
  /** Registered public subagent provider id for the Codex executor. */
  readonly codexProvider: string
  /** Registered public subagent provider id for the Claude Code executor. */
  readonly claudeCodeProvider: string
  /** Model-visible Solar tool name. */
  readonly toolName: string
  /** Model-visible graph collaboration tool name. */
  readonly coordinateToolName: string
  /** Named explicit native allocation profiles. */
  readonly allocationProfiles: Readonly<Record<string, AllocationProfile>>
  /** Role-to-profile mapping used when a graph node declares a role. */
  readonly roleMapping: Readonly<Record<string, string>>
}

export const Config: z<Config> = z.object({
  codexProvider: z.string().min(1).default('codex'),
  claudeCodeProvider: z.string().min(1).default('claude-code'),
  toolName: z.string().min(1).default('solar_delegate'),
  coordinateToolName: z.string().min(1).default('solar_coordinate'),
  allocationProfiles: z.dict(z.object({
    executor: z.union(['codex', 'claude-code'] as const),
    model: z.string(),
    reasoningEffort: z.string(),
  })).default({}),
  roleMapping: z.dict(z.string()).default({}),
})

const GRAPH_STATUSES: readonly GraphStatus[] = [
  'queued',
  'running',
  'paused',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'indeterminate',
]

function providerFor(config: Config, executor: NormalizedCollaborationInput['executor']): string {
  return executor === 'codex' ? config.codexProvider : config.claudeCodeProvider
}

function residentFrom(ctx: Context): ResidentApi | undefined {
  return ctx.get(RESIDENT_SERVICE) as ResidentApi | undefined
}

type ResidentBridgeContext = Omit<ResidentApi, 'bindBridge'> & {
  bindBridge?: (bridgeId: string, owner: ToolRunContext, allowedTools?: readonly string[]) => Promise<void>
}

function renderOutput(_args: unknown, value: DelegationOutput): [{ type: 'text'; text: string }] {
  if (value.kind === 'activation') {
    return [{
      type: 'text',
      text: `已接收 ${value.executor} 原生任务。子任务引用：${value.childId ?? '(未返回)'}。终态结果由官方子任务运行时交付给父任务。`,
    }]
  }
  return [{
    type: 'text',
    text: `已提交 ${value.executor} Resident 任务图。任务图引用：${value.graphId ?? '(未返回)'}。请使用该引用查询 Resident 状态和结果；当前返回的是提交回执，不代表最终成功。`,
  }]
}

function renderCoordinateOutput(_args: unknown, value: CoordinateOutput): [{ type: 'text'; text: string }] {
  const assignments = value.assignments.map((assignment) => {
    const model = assignment.model ?? '(native default)'
    const effort = assignment.reasoningEffort ?? '(native default)'
    return `${assignment.nodeId} → ${assignment.executor}/${model} (${effort})`
  }).join('; ')
  return [{
    type: 'text',
    text: `已提交 Resident 协作任务图。任务图引用：${value.graphId}。分配结果：${assignments || '(无节点分配)'}。请使用该引用等待并核对结果；提交回执不代表最终成功。${value.uiNotice ?? ''}`,
  }]
}

/** Build the one model-visible tool; exported for focused registration tests. */
export function createDelegateTool(
  ctx: Context,
  config: Config,
  trackActivation: (activation: SubagentActivation) => void,
): ToolDefinition {
  return defineTool({
    name: config.toolName,
    presentCall: args => ({ card: 'generic', kind: 'execute', title: args.executor === 'claude-code' ? '委派给 Claude Code' : '委派给 Codex' }),
    presentResult: (_args, result) => result.isError
      ? { card: 'generic', title: '任务委派未完成', content: result.content }
      : { card: 'generic', title: '任务已提交', content: [{ type: 'text', text: '这是一条提交回执。请继续查看子任务结果或持久化任务状态。' }] },
    description:
      'Delegate one self-contained task to the explicitly selected native Codex or Claude Code executor. '
      + 'Provide the working directory, scope, expected result, and verification request. '
      + 'This tool never changes the main model, account, reasoning setting, or provider, and it does not accept per-call model overrides. '
      + 'Single mode returns an acknowledgement while the official child runtime owns terminal result delivery; resident mode requires the optional native-resident service and returns a graph reference for later status/result queries.',
    parameters: {
      executor: {
        type: 'string',
        enum: ['codex', 'claude-code'],
        required: true,
        description: 'The native executor to use.',
      },
      mode: {
        type: 'string',
        enum: ['single', 'resident'],
        required: true,
        description: 'single uses one official activation; resident submits one durable Resident graph node.',
      },
      task: {
        type: 'string',
        required: true,
        description: 'The complete task statement for a fresh native executor.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory. Single mode may omit it to inherit the parent Agent directory; resident mode requires it.',
      },
      scope: {
        type: 'object',
        additionalProperties: false,
        properties: {
          read: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relative paths the executor may read.',
          },
          write: {
            type: 'array',
            items: { type: 'string' },
            description: 'Relative paths the executor may write.',
          },
        },
        description: 'Declared path scope; a scope declaration is not filesystem isolation.',
      },
      expected_result: {
        type: 'string',
        required: true,
        description: 'What the executor must return or leave ready for the parent.',
      },
      verification: {
        type: 'string',
        required: true,
        description: 'Checks the executor must run and report, including checks it could not run.',
      },
      session_key: {
        type: 'string',
        description: 'Resident-only stable native session key; single mode rejects it.',
      },
      profile: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string' },
          reasoning_effort: { type: 'string' },
        },
        description: 'Resident-only explicit native model profile; single mode rejects arbitrary model overrides.',
      },
      dsh_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Resident-only explicit DSH tool names to expose through the bound parent Agent bridge.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['activation', 'resident-graph'], required: true },
          executor: { type: 'string', enum: ['codex', 'claude-code'], required: true },
          mode: { type: 'string', enum: ['single', 'resident'], required: true },
          handoff: { type: 'string', required: true },
          childId: { type: 'string' },
          graphId: { type: 'string' },
          status: { type: 'string', enum: [...GRAPH_STATUSES] },
          revision: { type: 'integer' },
        },
      },
      render: renderOutput,
    },
    async execute(args, exec) {
      return dispatchCollaboration(args, exec, {
        subagents: ctx.subagents,
        resident: () => residentFrom(ctx) as ResidentBridgeContext | undefined,
        trackActivation,
      }, (executor) => providerFor(config, executor))
    },
  })
}

export function createCoordinateTool(ctx: Context, config: Config): ToolDefinition {
  return defineTool({
    name: config.coordinateToolName,
    presentCall: () => ({ card: 'generic', kind: 'execute', title: '分配并提交协作任务图' }),
    presentResult: (_args, result) => result.isError
      ? { card: 'generic', title: '协作任务图未提交', content: result.content }
      : { card: 'generic', title: '协作任务图已提交', content: [{ type: 'text', text: '模型与执行者分配已记录，具体执行结果请查看持久化任务状态。' }] },
    description:
      'Coordinate a bounded Resident TaskGraph with explicit or advertised native executor/model allocation. '
      + 'Resident remains the only graph scheduler. The tool never changes the main model, account, quota, or provider, and automatic allocation fails when the Resident model catalog is unavailable. '
      + 'Optional dsh_tools binds only the named DSH tools to the calling Agent; no bridge endpoint or arbitrary tool set is exposed to the graph.',
    parameters: {
      graph: {
        type: 'json',
        required: true,
        description: coordinateGraphDescription(),
      },
      allocation: {
        type: 'json',
        description: 'Optional explicit profile, role-to-profile, or node allocation hints.',
      },
      dsh_tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional non-empty allowlist of DSH tool names to bridge through the calling Agent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'resident-graph', required: true },
          graphId: { type: 'string', required: true },
          status: { type: 'string', enum: [...GRAPH_STATUSES], required: true },
          revision: { type: 'integer', required: true },
          uiNotice: { type: 'string' },
          assignments: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                nodeId: { type: 'string', required: true },
                executor: { type: 'string', enum: ['codex', 'claude-code'], required: true },
                model: { type: 'string' },
                reasoningEffort: { type: 'string' },
                profile: { type: 'string' },
              },
            },
          },
        },
      },
      render: renderCoordinateOutput,
    },
    async execute(args, exec) {
      const resident = residentFrom(ctx) as ResidentBridgeContext | undefined
      if (resident === undefined) {
        throw new Error('solar_coordinate requires the solarNativeResident service; install and enable the native-resident plugin')
      }
      const output = await coordinateResident(args.graph, args.allocation, args.dsh_tools, exec, {
        allocationProfiles: config.allocationProfiles,
        roleMapping: config.roleMapping,
      }, {
        resident,
        bindBridge: resident.bindBridge === undefined
          ? undefined
          : (bridgeId, owner, allowedTools) => resident.bindBridge!(bridgeId, owner, allowedTools),
      })
      const studio = ctx.get('solarWorkflowStudio') as WorkflowStudio | undefined
      if (exec.agent !== undefined && typeof studio?.capture === 'function') {
        try {
          const snapshot = await resident.inspect(output.graphId)
          const sessionId = String(exec.agent.session.id)
          await studio.capture({ id: stableUuid(`native-source:${sessionId}:${output.graphId}`), graph: nativeGraphToStudio(snapshot.graph, sessionId), runId: output.graphId, run: nativeSnapshotToStudioRun(snapshot, sessionId, output.graphId, new Date()) })
        } catch (error) {
          return { ...output, uiNotice: `任务图已提交，但当前会话的流程图记录未能保存：${error instanceof Error ? error.message : String(error)}。请保留原任务引用，不要重复提交。` }
        }
      }
      return output
    },
  })
}

function stableUuid(input: string): string {
  const h = createHash('sha256').update(input).digest('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}

export function apply(ctx: Context, config: Config): void {
  const shutdown = new AbortController()
  ctx.effect(() => () => shutdown.abort())
  const modes = new SessionModeController()
  const studio = new WorkflowStudio(ctx, modes, {
    onSourceCompleted: async source => {
      if(!source.runId || !source.run) throw new Error('STUDIO_SOURCE_RESULT_MISSING: 原流程缺少执行结果。')
      const sessionController=ctx.get('sessionController')
      if(!sessionController)throw new Error('STUDIO_DELIVERY_UNAVAILABLE: 当前 Host 没有会话回写服务；流程产物已保留。')
      await sessionController.prompt({
        requestId: stableUuid(`studio-delivery:${source.runId}`) as Parameters<typeof ctx.sessionController.prompt>[0]['requestId'],
        sessionId: source.graph.sessionId as Parameters<typeof ctx.sessionController.prompt>[0]['sessionId'],
        mode:'queue',content:[{type:'text',text:buildStudioSourceDeliveryPrompt(source)}],
      },shutdown.signal)
    },
    onCompleted: async record => {
      const sessionController=ctx.get('sessionController')
      if(!sessionController)throw new Error('STUDIO_DELIVERY_UNAVAILABLE: 当前 Host 没有会话回写服务；流程产物已保留。')
      await sessionController.prompt({
        requestId: stableUuid(`studio-delivery:${record.commandId}`) as Parameters<typeof ctx.sessionController.prompt>[0]['requestId'],
        sessionId: record.graph.sessionId as Parameters<typeof ctx.sessionController.prompt>[0]['sessionId'],
        mode: 'queue', content: [{ type: 'text', text: buildStudioDeliveryPrompt(record) }],
      }, shutdown.signal)
    },
  })
  new StudioControl(ctx, studio)
  const residentProxy = {
    submit: (request: Parameters<ResidentApi['submit']>[0]) => requiredResident(ctx).submit(request),
    inspect: (id: string) => requiredResident(ctx).inspect(id),
  }
  const nativeProvider = createNativeStudioProvider({ resident: residentProxy, label: '原生协同任务' })
  ctx.effect(() => studio.register({
    ...nativeProvider,
    validate: async graph => {
      const issues = [...await nativeProvider.validate(graph)]
      if (residentFrom(ctx) === undefined) issues.push({ message: '请先启用 Resident，再执行原生协同流程。' })
      return issues
    },
    observeSource: async source => {
      const snapshot = await requiredResident(ctx).inspect(source.graph.id)
      return nativeSnapshotToStudioRun(snapshot, source.graph.sessionId, source.runId ?? snapshot.graph.id, new Date())
    },
  }))
  ctx.effect(async () => {
    const installation = installSessionMode(ctx, modes, { coordinateToolName: config.coordinateToolName })
    try { await installation.ready } catch (error) { installation(); throw error }
    return installation
  })
  const activations = new Set<SubagentActivation>()
  const trackActivation = (activation: SubagentActivation): void => {
    trackOwnedActivation(activations, activation, (message) => {
      ctx.logger.warn(`native-collaboration: ${message}`)
    })
  }

  ctx.effect(() => {
    const unregisterDelegate = ctx.tools.register(createDelegateTool(ctx, config, trackActivation))
    const unregisterCoordinate = ctx.tools.register(createCoordinateTool(ctx, config))
    const unregisterWait = ctx.tools.register(createWaitTool(() => requiredResident(ctx)))
    return () => {
      unregisterWait()
      unregisterCoordinate()
      unregisterDelegate()
    }
  })

  new NativeControl(ctx, { codex: config.codexProvider, claudeCode: config.claudeCodeProvider }, [config.toolName, config.coordinateToolName, 'solar_wait'])

  ctx.effect(() => () => {
    return disposeOwnedActivations(activations)
  })
}
