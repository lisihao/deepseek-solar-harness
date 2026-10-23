import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ResidentApi } from '@lisihao/dsh-solar-native-resident/contracts'
import type { CollaborationModePort, CollaborationModeState } from './studio-contract.js'

const FORMAT_VERSION = 1 as const
const DATA_DIRECTORY = ['solar', 'native-collaboration'] as const
const RESIDENT_SERVICE = 'solarNativeResident'
const COORDINATE_TOOL = 'solar_coordinate'
const RESIDENT_TOOL = 'solar_resident'
const WAIT_TOOL = 'solar_wait'
const CHATGPT_WEB_PROVIDER = 'solar-chatgpt-web'
/** On-demand declaration loader registered by @lisihao/dsh-solar-tool-context; its name is fixed there. */
const TOOL_LOADER = 'solar_tool_load'
const SMART_SECTION = 'solar-native-collaboration:smart-mode'

export type CollaborationMode = CollaborationModeState['mode']

export type SessionModeErrorCode =
  | 'SESSION_MODE_INPUT_INVALID'
  | 'SESSION_MODE_CORRUPT'
  | 'SESSION_MODE_FORMAT_UNSUPPORTED'
  | 'SESSION_MODE_REVISION_CONFLICT'
  | 'SMART_MODE_AGENT_UNAVAILABLE'
  | 'SMART_MODE_RESIDENT_UNAVAILABLE'
  | 'SMART_MODE_TOOLS_UNAVAILABLE'
  | 'SMART_MODE_WEB_ROUTE_UNSUPPORTED'
  | 'SMART_MODE_ROUTE_UNAVAILABLE'
  | 'SMART_MODE_ROUTE_GUARD_INVALID'

/** Named errors let the caller distinguish stale state from damaged durable data. */
export class SessionModeError extends Error {
  constructor(readonly code: SessionModeErrorCode, message: string) {
    super(message)
    this.name = 'SessionModeError'
  }
}

export interface SessionModeControllerOptions {
  /** Development/test override; persisted data still stays below `<dshHome>/solar/native-collaboration`. */
  readonly dshHome?: string
}

type ModeListener = (state: CollaborationModeState) => void | Promise<void>
type SmartReadinessGuard = (sessionId: string) => Promise<void>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nodeErrorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === 'string' ? value.code : undefined
}

function assertSessionId(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || value.includes('\0')) {
    throw new SessionModeError('SESSION_MODE_INPUT_INVALID', '会话标识必须是长度不超过 1024 的非空字符串，且不能包含 NUL 字符。')
  }
  return value
}

function assertMode(value: unknown): CollaborationMode {
  if (value === 'ordinary' || value === 'smart') return value
  throw new SessionModeError('SESSION_MODE_INPUT_INVALID', '协同模式只能是 ordinary 或 smart。')
}

function assertRevision(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  throw new SessionModeError('SESSION_MODE_INPUT_INVALID', '模式修订号必须是非负安全整数。')
}

function defaultState(sessionId: string): CollaborationModeState {
  return { formatVersion: FORMAT_VERSION, sessionId, revision: 0, mode: 'ordinary' }
}

function decodeState(value: unknown, expectedSessionId: string): CollaborationModeState {
  if (!isRecord(value)) {
    throw new SessionModeError('SESSION_MODE_CORRUPT', '协同模式文件必须是对象。')
  }
  const allowed = new Set(['formatVersion', 'sessionId', 'revision', 'mode'])
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new SessionModeError('SESSION_MODE_CORRUPT', '协同模式文件含有未识别字段。')
  }
  if (typeof value.formatVersion === 'number' && Number.isSafeInteger(value.formatVersion) && value.formatVersion !== FORMAT_VERSION) {
    throw new SessionModeError('SESSION_MODE_FORMAT_UNSUPPORTED', `不支持协同模式文件格式版本 ${value.formatVersion}。`)
  }
  if (value.formatVersion !== FORMAT_VERSION) {
    throw new SessionModeError('SESSION_MODE_CORRUPT', '协同模式文件缺少有效的 formatVersion。')
  }
  if (typeof value.sessionId !== 'string' || value.sessionId !== expectedSessionId) {
    throw new SessionModeError('SESSION_MODE_CORRUPT', '协同模式文件的会话标识不匹配。')
  }
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new SessionModeError('SESSION_MODE_CORRUPT', '协同模式文件的 revision 无效。')
  }
  if (value.mode !== 'ordinary' && value.mode !== 'smart') {
    throw new SessionModeError('SESSION_MODE_CORRUPT', '协同模式文件的 mode 无效。')
  }
  return {
    formatVersion: FORMAT_VERSION,
    sessionId: value.sessionId,
    revision: value.revision,
    mode: value.mode,
  }
}

/**
 * Durable, session-scoped mode state. Raw session ids never become path
 * components: filenames are SHA-256 digests and the embedded id is checked on
 * every read.
 */
export class SessionModeController implements CollaborationModePort {
  private readonly root: string
  private readonly locks = new Map<string, Promise<void>>()
  private readonly listeners = new Set<ModeListener>()
  private readonly smartReadiness = new Set<SmartReadinessGuard>()

  constructor(options: SessionModeControllerOptions = {}) {
    this.root = join(resolveDshHome(options.dshHome), ...DATA_DIRECTORY)
  }

  /** Notify a local integration after a selection has passed its durable CAS. */
  onChange(listener: ModeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Install a Host-only readiness fence for later `smart` selections. */
  addSmartReadinessGuard(guard: SmartReadinessGuard): () => void {
    this.smartReadiness.add(guard)
    return () => this.smartReadiness.delete(guard)
  }

  async read(sessionId: string): Promise<CollaborationModeState> {
    const checkedSessionId = assertSessionId(sessionId)
    return this.withLock(checkedSessionId, () => this.readUnchecked(checkedSessionId))
  }

  async select(sessionId: string, mode: CollaborationMode, expectedRevision: number): Promise<CollaborationModeState> {
    const checkedSessionId = assertSessionId(sessionId)
    const checkedMode = assertMode(mode)
    const checkedRevision = assertRevision(expectedRevision)
    const next = await this.withLock(checkedSessionId, async () => {
      const current = await this.readUnchecked(checkedSessionId)
      if (current.revision !== checkedRevision) {
        throw new SessionModeError(
          'SESSION_MODE_REVISION_CONFLICT',
          '协同模式已被其他操作更新；请读取最新修订后再选择模式。',
        )
      }
      if (checkedMode === 'smart') {
        for (const guard of this.smartReadiness) await guard(checkedSessionId)
      }
      const next = current.mode === checkedMode
        ? current
        : { ...current, revision: current.revision + 1, mode: checkedMode }
      if (next !== current) await this.writeUnchecked(next)
      return next
    })
    // Listeners may read the durable state to reconcile a later concurrent
    // selection, so run them after releasing this session's CAS lock.
    for (const listener of this.listeners) await listener(next)
    return next
  }

  private fileFor(sessionId: string): string {
    const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex')
    return join(this.root, `session-mode-${digest}.json`)
  }

  private async readUnchecked(sessionId: string): Promise<CollaborationModeState> {
    const file = this.fileFor(sessionId)
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return defaultState(sessionId)
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch {
      throw new SessionModeError('SESSION_MODE_CORRUPT', '协同模式文件不是有效 JSON。')
    }
    return decodeState(parsed, sessionId)
  }

  private async writeUnchecked(state: CollaborationModeState): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const file = this.fileFor(state.sessionId)
    const temporary = join(this.root, `.session-mode-${randomUUID()}.tmp`)
    let committed = false
    try {
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await rename(temporary, file)
      committed = true
    } finally {
      if (!committed) await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  private async withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.locks.set(sessionId, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.locks.get(sessionId) === current) this.locks.delete(sessionId)
    }
  }
}

interface ToolLookup {
  get(name: string): unknown
}

interface ResidentAvailability extends Pick<ResidentApi, 'protocolVersion' | 'list'> {}

interface ProjectionReader {
  projections(request: { readonly sessionId: unknown }, signal: AbortSignal): Promise<unknown>
}

export interface SessionModeRouteInput {
  readonly sessionId: string
  readonly agent: Agent
}

export interface SessionModeInstallConfig {
  /** Name registered for the model-visible TaskGraph admission tool. */
  readonly coordinateToolName?: string
  /** Name registered for the model-visible Resident status tool. */
  readonly residentToolName?: string
  /**
   * Optional Host binding for the session's selected main provider. It must use
   * durable/public selection state, not an inferred route from prompt text.
   */
  readonly selectedProvider?: (input: SessionModeRouteInput) => string | undefined | Promise<string | undefined>
  /**
   * Optional cached marker for the current, queued Studio completion delivery.
   * The adapter must match the exact request to a stored Studio record; a
   * historical completed run or user message text is never proof.
   */
  readonly hasTrustedWorkflowCompletion?: (input: SessionModeRouteInput) => boolean
}

export type SessionModeInstallation = (() => void) & {
  readonly ready: Promise<void>
  readonly refresh: (sessionId: string) => Promise<void>
}

/**
 * Exact, logged policy for a smart session. It does not steer or wake an Agent,
 * so a selection affects only future prompt assembly.
 */
export function smartCollaborationSystemPrompt(
  coordinateToolName = COORDINATE_TOOL,
  residentToolName = RESIDENT_TOOL,
  waitToolName = WAIT_TOOL,
  options: { readonly toolLoaderName?: string } = {},
): string {
  return [
    '当前会话启用了智能协同。主模型仍负责理解需求、规划、协调、核对证据和最终交付；不得改变主模型、账户、推理设置或路由。',
    `用户打开智能协同，就是希望把工作分给执行者完成。收到任务先判断能否拆分：只要能分成两个以上互相独立、各自需要多步操作（读多个文件、改代码、跑测试、调研等）的部分，就形成有界、可验证的 TaskGraph，调用 \`${coordinateToolName}\` 提交，不要自己逐个完成。只有一两步就能完成、或各部分紧密耦合无法分开的任务才直接做，并用一句话说明为什么没拆。`,
    `每个节点写清完整目标、预期产物和验证方式。有依赖的节点用 \`dependsOn\` 声明，需要前序产物时用 \`inputFrom\`（必须是 \`dependsOn\` 的子集）交接。要并行的节点必须声明 \`scope\`：只读的声明 \`scope.read\`，写文件的声明互不重叠的 \`scope.write\`，并把 \`maxParallel\` 设为不少于并行分支数；不声明 \`scope\` 的节点会排队串行。需要修改文件的节点必须声明 \`scope.write\`，否则执行者只有只读权限，改不了任何文件。字段以 \`${coordinateToolName}\` 的参数说明为准，不得编造字段。`,
    ...(options.toolLoaderName === undefined
      ? []
      : [`当前工具清单只列出部分工具的完整声明。如果看不到 \`${coordinateToolName}\`、\`${waitToolName}\`、\`${residentToolName}\` 的声明，先用 \`${options.toolLoaderName}\` 按名字一次加载这三个工具，再构造调用。`]),
    `提交只是回执，不是完成。提交后优先调用 \`${waitToolName}\` 在有界本地等待窗口内观察；超过该窗口要明确说明任务仍在运行，且不取消远端任务。随后读取 \`${residentToolName}\` 的真实终态、节点输出、失败、取消或 unknown/indeterminate 状态，再核对证据并汇总。简单或不宜拆分的任务可以说明原因后直接完成。`,
    '异常、额度耗尽、未确认外部效果和 unknown 必须如实呈现；不得换账户、自动重发或把提交回执写成成功。不要借 `turn-stopping` 反复 steer 来消耗模型。',
    '节点状态为 succeeded 只表示执行者结束了这一轮，不代表产物存在；交付前核对节点输出、文件改动和测试结果。最终回复必须写明每个节点的结果：哪些节点失败、被拒绝或没有产出及其原因，以及哪些工作是你自己补做的；不得把你补做的部分写成执行者完成。',
    '流程编辑器通过宿主回写已保存产物时，请按该条请求只检查、汇总和交付已有证据，不再生成 TaskGraph、重复派单或重新执行任务。文本本身不构成流程已完成的证明；核对真实的持久化任务记录，未知状态必须保留。',
  ].join('\n')
}

export const SMART_COLLABORATION_SYSTEM_PROMPT = smartCollaborationSystemPrompt()

function isResidentAvailable(value: unknown): value is ResidentAvailability {
  return isRecord(value)
    && value.protocolVersion === FORMAT_VERSION
    && typeof value.list === 'function'
}

function toolLookup(agent: Agent): ToolLookup | undefined {
  const value = agent.ctx.get('tools') as unknown
  return isRecord(value) && typeof value.get === 'function' ? value as unknown as ToolLookup : undefined
}

function selectedProviderFromProjection(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.values)) return undefined
  const selection = value.values.modelSelection
  if (!isRecord(selection) || !isRecord(selection.next)) return undefined
  return typeof selection.next.provider === 'string' && selection.next.provider.length > 0
    ? selection.next.provider
    : undefined
}

async function selectedProviderFromHost(ctx: Context, sessionId: string): Promise<string | undefined> {
  const candidate = ctx.get('sessionController') as unknown
  if (!isRecord(candidate) || typeof candidate.projections !== 'function') return undefined
  const reader = candidate as unknown as ProjectionReader
  try {
    return selectedProviderFromProjection(await reader.projections({ sessionId }, new AbortController().signal))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new SessionModeError(
      'SMART_MODE_ROUTE_UNAVAILABLE',
      `无法读取当前会话的公开模型选择，不能确认是否支持 DSH 工具调用：${detail}`,
    )
  }
}

function configuredToolName(value: string | undefined, fallback: string, field: string): string {
  const name = value ?? fallback
  if (typeof name !== 'string' || name.trim().length === 0 || name.includes('\0')) {
    throw new SessionModeError('SESSION_MODE_INPUT_INVALID', `${field} 必须是非空且不包含 NUL 的工具名称。`)
  }
  return name
}

function promptFor(
  agent: Agent,
  sessionId: string,
  config: SessionModeInstallConfig,
  toolNames: Readonly<{ coordinate: string; resident: string; wait: string }>,
): (context: { readonly agent?: Agent }) => string {
  return (context) => {
    if (context.agent !== agent) return ''
    const trusted = config.hasTrustedWorkflowCompletion?.({ sessionId, agent }) === true
    const loader = toolLookup(agent)?.get(TOOL_LOADER) === undefined ? {} : { toolLoaderName: TOOL_LOADER }
    const base = smartCollaborationSystemPrompt(toolNames.coordinate, toolNames.resident, toolNames.wait, loader)
    return trusted
      ? `${base}\n当前有 Studio 已核验的完成结果等待交付；只检查、汇总和交付已保存的证据，不再派单或执行。`
      : base
  }
}

/**
 * Bind one durable controller to the Host's live Agent lifecycle. The returned
 * callable is an idempotent disposer; `ready` covers synchronization of Agents
 * that already existed before this plugin was enabled.
 */
export function installSessionMode(
  ctx: Context,
  controller: SessionModeController,
  config: SessionModeInstallConfig = {},
): SessionModeInstallation {
  const toolNames = {
    coordinate: configuredToolName(config.coordinateToolName, COORDINATE_TOOL, 'coordinateToolName'),
    resident: configuredToolName(config.residentToolName, RESIDENT_TOOL, 'residentToolName'),
    wait: WAIT_TOOL,
  }
  const sectionDisposers = new Map<string, () => void>()
  const requestGuards = new Map<string, { readonly agent: Agent; readonly dispose: () => void }>()
  let active = true

  const removeSection = (sessionId: string): void => {
    const dispose = sectionDisposers.get(sessionId)
    sectionDisposers.delete(sessionId)
    dispose?.()
  }

  const removeRequestGuard = (sessionId: string): void => {
    const registered = requestGuards.get(sessionId)
    requestGuards.delete(sessionId)
    registered?.dispose()
  }

  const resolveAgent = (sessionId: string): Agent | undefined => ctx.agents.get(sessionId as Agent['id'])

  const ensureRequestGuard = (agent: Agent, sessionId: string): void => {
    const registered = requestGuards.get(sessionId)
    if (registered?.agent === agent) return
    removeRequestGuard(sessionId)
    const dispose = agent.ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      const state = await controller.read(sessionId)
      if (state.mode !== 'smart') return resolved
      if (resolved.provider === CHATGPT_WEB_PROVIDER) {
        throw new SessionModeError(
          'SMART_MODE_WEB_ROUTE_UNSUPPORTED',
          '当前会话仍处于智能协同模式，但 ChatGPT 网页主会话路由不支持 DSH 工具调用。请改为普通模式，或切换到支持 DSH 工具的主模型后重试。',
        )
      }
      // The selection-time check ran against an earlier Agent; a later preset
      // or plugin change can leave Smart selected without its tools.
      const tools = toolLookup(agent)
      const missing = [toolNames.coordinate, toolNames.resident, toolNames.wait].filter(name => tools?.get(name) === undefined)
      if (missing.length > 0) {
        throw new SessionModeError(
          'SMART_MODE_TOOLS_UNAVAILABLE',
          `当前会话仍处于智能协同模式，但当前 Agent 没有它需要的工具：${missing.join('、')}。请在输入框左侧关闭「智能协同」，或切换到包含这些工具的模式后重试。`,
        )
      }
      return resolved
    })
    requestGuards.set(sessionId, { agent, dispose })
  }

  const refresh = async (sessionId: string): Promise<void> => {
    if (!active) return
    const agent = resolveAgent(sessionId)
    if (agent === undefined) return
    const state = await controller.read(sessionId)
    if (!active || resolveAgent(sessionId) !== agent) return
    ensureRequestGuard(agent, sessionId)
    removeSection(sessionId)
    if (state.mode !== 'smart') return
    const dispose = agent.ctx.systemPrompt.section({
      name: SMART_SECTION,
      order: agent.ctx.systemPrompt.getSectionOrder('TEAM_POLICY'),
      text: promptFor(agent, sessionId, config, toolNames),
      interpolate: false,
    })
    if (!active || resolveAgent(sessionId) !== agent) {
      dispose()
      return
    }
    sectionDisposers.set(sessionId, dispose)
  }

  const assertSmartReady = async (sessionId: string): Promise<void> => {
    const agent = resolveAgent(sessionId)
    if (agent === undefined) {
      throw new SessionModeError('SMART_MODE_AGENT_UNAVAILABLE', '当前会话没有可用的 Agent，不能启用智能协同。')
    }
    const provider = config.selectedProvider === undefined
      ? await selectedProviderFromHost(ctx, sessionId)
      : await config.selectedProvider({ sessionId, agent })
    if (provider !== undefined && typeof provider !== 'string') {
      throw new SessionModeError('SMART_MODE_ROUTE_GUARD_INVALID', '宿主提供的会话模型选择守卫返回了无效值。')
    }
    if (provider === CHATGPT_WEB_PROVIDER) {
      throw new SessionModeError(
        'SMART_MODE_WEB_ROUTE_UNSUPPORTED',
        '当前会话使用 ChatGPT 网页主会话路由；该路由不支持 DSH 工具调用，不能启用智能协同。请切换到支持 DSH 工具的主模型后再选择智能协同。',
      )
    }
    const resident = ctx.get(RESIDENT_SERVICE) as unknown
    if (!isResidentAvailable(resident)) {
      throw new SessionModeError('SMART_MODE_RESIDENT_UNAVAILABLE', '智能协同需要已启用且可连接的 Resident；请检查 native-resident 插件后重试。')
    }
    try {
      await resident.list()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new SessionModeError('SMART_MODE_RESIDENT_UNAVAILABLE', `Resident 当前不可用，不能启用智能协同：${detail}`)
    }
    const tools = toolLookup(agent)
    const missing = [toolNames.coordinate, toolNames.resident, toolNames.wait].filter(name => tools?.get(name) === undefined)
    if (missing.length > 0) {
      throw new SessionModeError(
        'SMART_MODE_TOOLS_UNAVAILABLE',
        `智能协同需要当前会话可用的 DSH 工具：${missing.join('、')}。请检查相关插件是否已启用。`,
      )
    }
  }

  const removeReadiness = controller.addSmartReadinessGuard(assertSmartReady)
  const removeChangeListener = controller.onChange(state => refresh(state.sessionId))
  const removeCreated = ctx.on('agent/created', async ({ agent }) => {
    await refresh(agent.id)
  })
  const removeDisposed = ctx.on('agent/disposed', ({ agent }) => {
    removeSection(agent.id)
    removeRequestGuard(agent.id)
  })
  const ready = Promise.all(ctx.agents.list().map(agent => refresh(agent.id))).then(() => undefined)
  void ready.catch(error => ctx.logger.warn(`native-collaboration: failed to restore a session collaboration mode: ${String(error)}`))
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    active = false
    removeDisposed()
    removeCreated()
    removeChangeListener()
    removeReadiness()
    for (const disposeSection of sectionDisposers.values()) disposeSection()
    sectionDisposers.clear()
    for (const registered of requestGuards.values()) registered.dispose()
    requestGuards.clear()
  }
  return Object.assign(dispose, { ready, refresh })
}
