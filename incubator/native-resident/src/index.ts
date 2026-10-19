import { Service, type Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { ResidentClient } from './client.js'
import { HostToolBridge } from './bridge.js'
import { ResidentError, type ResidentApi, type TaskGraph } from './contracts.js'

export const name = 'native-resident'
export const inject = ['tools']

export interface Config {
  readonly dshHome?: string
  readonly codexExecutable?: string
  readonly claudeExecutable?: string
  readonly startupTimeoutMs?: number
  readonly requestTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string().min(1),
  codexExecutable: z.string().min(1),
  claudeExecutable: z.string().min(1),
  startupTimeoutMs: z.number().step(1).min(100).max(60_000).default(10_000),
  requestTimeoutMs: z.number().step(1).min(100).max(120_000).default(30_000),
})

export class SolarNativeResident extends Service implements ResidentApi {
  readonly protocolVersion = 1 as const
  constructor(ctx: Context, readonly client: ResidentClient, readonly bridge: HostToolBridge) {
    super(ctx, 'solarNativeResident')
  }
  submit(request: Parameters<ResidentApi['submit']>[0]) { return this.client.submit(request) }
  inspect(graphId: string) { return this.client.inspect(graphId) }
  list() { return this.client.list() }
  control(request: Parameters<ResidentApi['control']>[0]) { return this.client.control(request) }
  resolve(request: Parameters<ResidentApi['resolve']>[0]) { return this.client.resolve(request) }
  events(graphId: string, after?: number, limit?: number) { return this.client.events(graphId, after, limit) }
  models(cwd: string) { return this.client.models(cwd) }
  async bindBridge(bridgeId: string, owner: object, allowedTools?: readonly string[]): Promise<void> {
    const candidate = owner as Partial<ToolRunContext>
    if (!candidate.agent || !candidate.signal || !candidate.callId || !candidate.token) throw new ResidentError('BRIDGE_OWNER_REQUIRED', 'DSH tool bridging requires the actual calling Agent and execution context.')
    const descriptor = await this.bridge.bind(bridgeId, candidate as ToolRunContext, allowedTools)
    await this.client.call('bindBridge', { descriptor })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { solarNativeResident: SolarNativeResident }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ResidentError('INVALID_REQUEST', `${field} is required.`)
  return value
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const root = join(resolveDshHome(config.dshHome), 'solar', 'native-resident')
  const client = new ResidentClient(root, config)
  await client.ensureStarted()
  const bridge = new HostToolBridge(ctx)
  const resident = new SolarNativeResident(ctx, client, bridge)
  ctx.effect(() => () => bridge.close())
  const tool = defineTool({
    name: 'solar_resident',
    description: 'Manage persistent native TaskGraphs. Read results with inspect/events; pause prevents new work, cancel requests interruption. A completed native turn is not task acceptance. Unknown effects require explicit resolution and are never automatically replayed.',
    presentCall: args => ({ card: 'generic', kind: 'execute', title: ({ submit: '提交持久化任务', list: '查看持久化任务', inspect: '查看任务状态', events: '查看执行记录', models: '查看原生模型', pause: '暂停后续调度', resume: '恢复任务调度', cancel: '请求中断任务', resolve_retry: '确认重新执行', resolve_fail: '确认结束未决任务' } as Record<string, string>)[args.action] ?? '管理持久化任务' }),
    presentResult: (_args, result) => {
      if (result.isError) return { card: 'generic', title: '持久化操作未完成', content: result.content }
      const text = result.content.find(block => block.type === 'text')
      try {
        const value = JSON.parse(text && text.type === 'text' ? text.text : 'null')
        if (value && typeof value.status === 'string' && value.graph) {
          const labels: Record<string, string> = { queued: '等待调度', running: '正在执行', paused: '已暂停后续调度', cancelling: '正在请求中断，尚未确认停止', completed: '原生执行已结束，仍需核对验收结果', failed: '执行失败', cancelled: '已取消', indeterminate: '执行结果尚未确认，需要人工处理' }
          return { card: 'generic', title: value.graph.label, content: [{ type: 'text', text: labels[value.status] ?? '请查看执行记录中的状态说明。' }] }
        }
        if (Array.isArray(value)) return { card: 'generic', title: '持久化查询已完成', content: [{ type: 'text', text: `已返回 ${value.length} 条记录。` }] }
      } catch { /* Retain the actual model result if an older log cannot be projected. */ }
      return { card: 'generic', title: '持久化操作已响应', content: result.content }
    },
    parameters: {
      action: { type: 'string', enum: ['submit', 'list', 'inspect', 'events', 'models', 'pause', 'resume', 'cancel', 'resolve_retry', 'resolve_fail'], required: true },
      graph: { type: 'json', description: 'Version-1 TaskGraph for submit; nodes include id, executor, prompt, dependencies and optional sessionKey/profile/scope/notBefore/retry.' },
      graph_id: { type: 'string' },
      command_id: { type: 'string', description: 'Stable mutation identity; reuse only with identical input.' },
      node_id: { type: 'string' },
      expected_revision: { type: 'integer', description: 'Exact revision from a recent inspection for controls and resolution.' },
      cwd: { type: 'string', description: 'Native model discovery working directory.' },
      after: { type: 'integer' },
      limit: { type: 'integer' },
      dsh_tools: { type: 'array', items: { type: 'string' }, description: 'Explicit visible DSH tools to bridge for a submitted graph; omitted keeps native tools only.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      switch (args.action) {
        case 'list': return resident.list() as never
        case 'inspect': return resident.inspect(requiredString(args.graph_id, 'graph_id')) as never
        case 'events': return resident.events(requiredString(args.graph_id, 'graph_id'), args.after, args.limit) as never
        case 'models': return resident.models(requiredString(args.cwd, 'cwd')) as never
        case 'submit': {
          if (!args.graph || typeof args.graph !== 'object' || Array.isArray(args.graph)) throw new ResidentError('INVALID_GRAPH', 'graph must be a TaskGraph object.')
          const graph = args.graph as unknown as TaskGraph
          let requestGraph = graph
          if (args.dsh_tools?.length) {
            const bridgeId = `graph:${requiredString(graph.id, 'graph.id')}`
            await resident.bindBridge(bridgeId, exec, args.dsh_tools)
            requestGraph = { ...graph, bridgeId }
          }
          return resident.submit({ commandId: requiredString(args.command_id, 'command_id'), graph: requestGraph }) as never
        }
        case 'pause': case 'resume': case 'cancel': {
          if (!Number.isSafeInteger(args.expected_revision)) throw new ResidentError('INVALID_REVISION', 'expected_revision must be an exact inspected revision.')
          return resident.control({ commandId: requiredString(args.command_id, 'command_id'), graphId: requiredString(args.graph_id, 'graph_id'), expectedRevision: args.expected_revision!, action: args.action }) as never
        }
        case 'resolve_retry': case 'resolve_fail': {
          if (!Number.isSafeInteger(args.expected_revision)) throw new ResidentError('INVALID_REVISION', 'expected_revision must be an exact inspected revision.')
          return resident.resolve({ commandId: requiredString(args.command_id, 'command_id'), graphId: requiredString(args.graph_id, 'graph_id'), nodeId: requiredString(args.node_id, 'node_id'), expectedRevision: args.expected_revision!, decision: args.action === 'resolve_retry' ? 'retry' : 'fail' }) as never
        }
        default: throw new ResidentError('INVALID_REQUEST', 'Unsupported Resident action.')
      }
    },
  })
  ctx.effect(() => ctx.tools.register(tool))
}
