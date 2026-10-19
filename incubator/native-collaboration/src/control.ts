import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { ResidentApi, GraphSnapshot } from '@lisihao/dsh-solar-native-resident/contracts'
import type { NativeUiStatus, GraphQuery, NativeControlInput, NativeTestInput } from './ui-contract.js'

const id = z.string().min(1).max(180).regex(/^[A-Za-z0-9:_-]+$/)
const graphId = z.string().min(1).max(256).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), 'graphId contains unsupported whitespace or control characters')
export const querySchema = z.strictObject({ graphId })
export const controlSchema = z.strictObject({ graphId, commandId: id, expectedRevision: z.number().int().nonnegative(), action: z.enum(['pause', 'resume', 'cancel']) })
export const testSchema = z.strictObject({ commandId: z.uuid(), executor: z.enum(['codex', 'claude-code']) })
export const CHECK_MARKERS = { codex: 'SOLAR_CODEX_OK', 'claude-code': 'SOLAR_CLAUDE_OK' } as const

export class NativeControl extends TypertRemoteService {
  constructor(ctx: Context, readonly providerNames: { codex: string; claudeCode: string }, readonly toolNames: readonly string[]) { super(ctx, 'solarNativeControl') }
  private owner(): void {
    const invocation = this.ctx.invocation
    if (invocation !== undefined && invocation.peer.principal.kind !== 'owner') throw new Error('LOCAL_OWNER_REQUIRED: 智能协同界面仅允许本机所有者操作。')
  }
  private resident(): ResidentApi {
    const service = this.ctx.get('solarNativeResident') as ResidentApi | undefined
    if (!service || service.protocolVersion !== 1) throw new Error('RESIDENT_UNAVAILABLE: 请先安装并启用 Resident。')
    return service
  }
  @Remote
  async status(): Promise<NativeUiStatus> {
    this.owner()
    let available = false
    let message = 'Resident 尚未连接，请检查插件是否启用。'
    let graphs: readonly GraphSnapshot[] = []
    try { graphs = await this.resident().list(); available = true; message = 'Resident 已连接，任务查询正常。' }
    catch (error) { message = error instanceof Error ? error.message : String(error) }
    return {
      checkedAt: new Date().toISOString(), resident: { available, message }, graphs,
      tools: ['solar_resident', ...this.toolNames].map(name => ({ name, available: this.ctx.tools.get(name) !== undefined })),
      providers: [ { name: this.providerNames.codex, label: '官方 Codex 子智能体', available: this.ctx.subagents.getProvider(this.providerNames.codex) !== undefined }, { name: this.providerNames.claudeCode, label: '官方 Claude Code 子智能体', available: this.ctx.subagents.getProvider(this.providerNames.claudeCode) !== undefined } ],
    }
  }
  @Remote
  async inspect(input: GraphQuery): Promise<GraphSnapshot> {
    this.owner(); const value = querySchema.parse(input)
    return this.resident().inspect(value.graphId)
  }
  @Remote
  async control(input: NativeControlInput): Promise<GraphSnapshot> {
    this.owner(); const value = controlSchema.parse(input)
    return this.resident().control(value)
  }
  @Remote
  async test(input: NativeTestInput): Promise<GraphSnapshot> {
    this.owner(); const value = testSchema.parse(input)
    const resident = this.resident()
    const cwd = join(resolveDshHome(), 'solar', 'native-collaboration', 'check-workspace')
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const marker = CHECK_MARKERS[value.executor]
    return resident.submit({ commandId: `native-ui-test:${value.commandId}`, graph: {
      formatVersion: 1, id: `native-check-${value.commandId}`, label: value.executor === 'codex' ? 'Codex 原生连接测试' : 'Claude Code 原生连接测试', cwd, maxParallel: 1,
      nodes: [{ id: 'check', executor: value.executor, prompt: `This is a bounded native connection check. Reply with exactly ${marker} and nothing else. Do not read, create or modify files, run commands, access the network, delegate, or use any tools.`, scope: { read: [], write: [] } }],
    } })
  }
}

declare module '@deepseek-ai/cordis' { interface Context { solarNativeControl: NativeControl } }
