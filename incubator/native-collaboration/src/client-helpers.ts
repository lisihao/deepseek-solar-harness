import type { Executor, GraphSnapshot, GraphStatus, NodeStatus } from '@lisihao/dsh-solar-native-resident/contracts'
import { GRAPH_LABELS, type NativeControlInput } from './ui-contract.js'

export type GraphControlAction = NativeControlInput['action']

const terminalGraphStatuses: ReadonlySet<GraphStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'indeterminate',
])

const graphActions: Readonly<Record<GraphStatus, readonly GraphControlAction[]>> = {
  queued: ['pause', 'cancel'],
  running: ['pause', 'cancel'],
  paused: ['resume', 'cancel'],
  cancelling: [],
  completed: [],
  failed: [],
  cancelled: [],
  indeterminate: [],
}

const nodeLabels: Readonly<Record<NodeStatus, string>> = {
  pending: '等待依赖或调度',
  ready: '等待原生执行',
  running: '正在原生执行',
  cancelling: '正在请求中断',
  succeeded: '已完成',
  failed: '执行失败',
  blocked: '被前置结果阻塞',
  cancelled: '已取消',
  indeterminate: '执行结果未确认',
}

const nativeCheckMarkers: Readonly<Record<Executor, string>> = {
  codex: 'SOLAR_CODEX_OK',
  'claude-code': 'SOLAR_CLAUDE_OK',
}

export interface NativeCheckReference {
  readonly executor?: Executor
}

export interface NativeCheckVerdict {
  readonly kind: 'pending' | 'passed' | 'failed' | 'unconfirmed'
  readonly label: string
}

/**
 * An indeterminate graph may still contain a native attempt that needs time to
 * settle after a sibling became unknown. Keep observing while it is active.
 */
export function isTerminalGraphStatus(snapshot: GraphSnapshot): boolean {
  if (snapshot.status !== 'indeterminate') return terminalGraphStatuses.has(snapshot.status)
  return !snapshot.nodes.some(node => node.status === 'running' || node.status === 'cancelling')
}

/** Actions that are meaningful from the snapshot's currently observed status. */
export function availableGraphActions(status: GraphStatus): readonly GraphControlAction[] {
  return graphActions[status]
}

/** Resident permits cancelling outstanding work in an otherwise indeterminate graph. */
export function availableGraphActionsForSnapshot(snapshot: GraphSnapshot): readonly GraphControlAction[] {
  if (snapshot.status !== 'indeterminate') return availableGraphActions(snapshot.status)
  return snapshot.nodes.some(node => node.status === 'pending' || node.status === 'ready' || node.status === 'running' || node.status === 'cancelling')
    ? ['cancel']
    : []
}

export function graphStatusLabel(status: GraphStatus): string {
  return GRAPH_LABELS[status]
}

export function nodeStatusLabel(status: NodeStatus): string {
  return nodeLabels[status]
}

/**
 * A control can only start from the rendered revision when no earlier mutation
 * or unresolved mutation outcome owns this graph.
 */
export function canStartGraphControl(
  snapshot: GraphSnapshot,
  action: GraphControlAction,
  pendingGraphIds: ReadonlySet<string>,
  inspectionRequiredGraphIds: ReadonlySet<string>,
): boolean {
  const graphId = snapshot.graph.id
  return availableGraphActionsForSnapshot(snapshot).includes(action)
    && !pendingGraphIds.has(graphId)
    && !inspectionRequiredGraphIds.has(graphId)
}

/** Build the exact optimistic-concurrency request from the currently rendered snapshot. */
export function createControlInput(
  snapshot: GraphSnapshot,
  action: GraphControlAction,
  commandId: string,
): NativeControlInput | undefined {
  if (!availableGraphActionsForSnapshot(snapshot).includes(action)) return undefined
  return {
    graphId: snapshot.graph.id,
    commandId,
    expectedRevision: snapshot.revision,
    action,
  }
}

/** The Host assigns each explicit native check this deterministic graph identity. */
export function nativeCheckGraphId(commandId: string): string {
  return `native-check-${commandId}`
}

export function nativeCheckExecutor(snapshot: GraphSnapshot): Executor | undefined {
  if (!snapshot.graph.id.startsWith('native-check-')) return undefined
  const executor = snapshot.graph.nodes[0]?.executor
  if (executor === undefined || snapshot.graph.nodes.some(node => node.executor !== executor)) return undefined
  return executor
}

/** A native check remains a blocker until Resident has recorded a known non-indeterminate terminal state. */
export function isSettledNativeCheck(snapshot: GraphSnapshot): boolean {
  return nativeCheckExecutor(snapshot) !== undefined
    && (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled')
}

/**
 * One executor may have at most one unresolved native check. An acknowledgement
 * is only a graph snapshot, not proof that the underlying native turn settled.
 */
export function canStartNativeCheck(
  executor: Executor,
  snapshots: readonly GraphSnapshot[],
  pendingExecutors: ReadonlySet<Executor>,
  inspectionTargets: readonly NativeCheckReference[],
): boolean {
  if (pendingExecutors.has(executor)) return false
  if (inspectionTargets.some(target => target.executor === executor)) return false
  return !snapshots.some(snapshot => nativeCheckExecutor(snapshot) === executor && !isSettledNativeCheck(snapshot))
}

/**
 * A completed task graph alone is not a connection pass. The canary passes
 * only after its succeeded node returns its executor's exact trimmed marker.
 */
export function nativeCheckVerdict(snapshot: GraphSnapshot): NativeCheckVerdict | undefined {
  const executor = nativeCheckExecutor(snapshot)
  if (executor === undefined) return undefined
  if (snapshot.status === 'indeterminate') return { kind: 'unconfirmed', label: '结果未确认' }
  if (snapshot.status === 'completed') {
    const expected = nativeCheckMarkers[executor]
    const passed = snapshot.nodes.some(node => node.status === 'succeeded' && node.output?.trim() === expected)
    return passed
      ? { kind: 'passed', label: '连接测试通过' }
      : { kind: 'failed', label: '连接测试失败：未收到预期标记' }
  }
  if (snapshot.status === 'failed') return { kind: 'failed', label: '连接测试失败' }
  if (snapshot.status === 'cancelled') return { kind: 'failed', label: '连接测试已取消' }
  return { kind: 'pending', label: '正在等待原生执行结果' }
}

/**
 * Keep a newer local response when an earlier read completes afterwards. This
 * prevents a stale status response from making a completed control look pending.
 */
export function upsertGraphSnapshot(
  snapshots: readonly GraphSnapshot[],
  incoming: GraphSnapshot,
): readonly GraphSnapshot[] {
  const index = snapshots.findIndex(snapshot => snapshot.graph.id === incoming.graph.id)
  if (index < 0) return [...snapshots, incoming]
  const existing = snapshots[index]
  if (existing !== undefined && existing.revision > incoming.revision) return snapshots
  const next = [...snapshots]
  next[index] = incoming
  return next
}

/** Merge a status read without allowing it to regress a newer direct response. */
export function mergeGraphSnapshots(
  current: readonly GraphSnapshot[],
  incoming: readonly GraphSnapshot[],
): readonly GraphSnapshot[] {
  return incoming.reduce<readonly GraphSnapshot[]>(
    (snapshots, snapshot) => upsertGraphSnapshot(snapshots, snapshot),
    current,
  )
}

/** Whether smart collaboration can be switched on, and what to do when it cannot. */
export interface CollaborationAvailability {
  readonly usable: boolean
  readonly action?: string
}

/** Minimal status fields the Settings summary reads. */
export interface AvailabilityStatus {
  readonly resident: { readonly available: boolean; readonly message: string }
  readonly tools: readonly { readonly name: string; readonly available: boolean }[]
}

/** One executor as the Settings page presents it. */
export interface ExecutorReadiness {
  readonly executor: Executor
  readonly title: string
  readonly state: 'ready' | 'failed' | 'untested' | 'testing'
  /** Short status phrase shown beside the state dot. */
  readonly text: string
  /** What the user can do, for a failure with a known cause. */
  readonly action?: string
  /** Raw failure text, kept for a collapsed detail. */
  readonly detail?: string
}

/** A failure message as a short phrase plus the action that fixes it. */
export interface FailureExplanation {
  readonly summary: string
  readonly action?: string
}

const COLLABORATION_TOOLS = ['solar_resident', 'solar_coordinate', 'solar_wait']

/** Smart mode needs the scheduler and its three tools; anything else is not a reason to block. */
export function collaborationAvailability(status: AvailabilityStatus): CollaborationAvailability {
  if (!status.resident.available) {
    return { usable: false, action: '协同调度器没有运行。请完全退出并重新打开 DeepSeek Harness。' }
  }
  const missing = COLLABORATION_TOOLS.filter(name => !status.tools.some(tool => tool.name === name && tool.available))
  if (missing.length > 0) {
    return { usable: false, action: '协同工具没有加载。请确认已启用 native-resident 插件，然后重新打开 DeepSeek Harness。' }
  }
  return { usable: true }
}

/** Explain a native failure by its cause; an unknown cause keeps the raw text as the summary. */
export function explainFailure(message: string): FailureExplanation {
  const text = message.replace(/^(Claude|Codex) native turn failed:\s*/i, '').trim()
  if (/connection refused|econnrefused|proxy|firewall|enotfound|etimedout|network/i.test(text)) {
    return { summary: '网络连不上', action: 'DSH 不读取系统代理：在 ~/.dsh/.env 写入 https_proxy=http://127.0.0.1:<端口>，再重新打开 DeepSeek Harness 后重新测试。' }
  }
  if (/limit|quota|额度/i.test(text)) {
    return { summary: '订阅额度已用完', action: '等额度重置后重新测试。' }
  }
  if (/log ?in|auth|unauthori[sz]ed|401|credential/i.test(text)) {
    return { summary: '登录已失效', action: '在终端重新登录该命令行工具后重新测试。' }
  }
  return { summary: text.length > 0 ? text : '执行失败' }
}

interface ExecutorEvidence {
  readonly at: number
  readonly kind: 'passed' | 'failed' | 'pending'
  readonly source: 'check' | 'collaboration'
  readonly message?: string
}

function evidenceFor(executor: Executor, snapshot: GraphSnapshot): ExecutorEvidence | undefined {
  if (nativeCheckExecutor(snapshot) === executor) {
    const verdict = nativeCheckVerdict(snapshot)
    if (verdict === undefined) return undefined
    const message = snapshot.nodes.find(node => node.error !== undefined)?.error?.message ?? verdict.label
    if (verdict.kind === 'passed') return { at: snapshot.updatedAt, kind: 'passed', source: 'check' }
    if (verdict.kind === 'pending') return { at: snapshot.updatedAt, kind: 'pending', source: 'check' }
    return { at: snapshot.updatedAt, kind: 'failed', source: 'check', message }
  }
  if (snapshot.graph.id.startsWith('native-check-')) return undefined
  const ids = new Set(snapshot.graph.nodes.filter(node => node.executor === executor).map(node => node.id))
  const nodes = snapshot.nodes.filter(node => ids.has(node.id))
  const failed = nodes.find(node => node.status === 'failed')
  if (failed !== undefined) return { at: snapshot.updatedAt, kind: 'failed', source: 'collaboration', message: failed.error?.message ?? '执行失败' }
  if (nodes.some(node => node.status === 'succeeded')) return { at: snapshot.updatedAt, kind: 'passed', source: 'collaboration' }
  return undefined
}

/**
 * Each executor's state from its newest evidence: a connection check or a
 * node it ran in a real collaboration, whichever settled last. Registration
 * alone is never evidence.
 */
export function executorReadiness(
  snapshots: readonly GraphSnapshot[],
  formatTime: (value: number) => string,
): readonly ExecutorReadiness[] {
  return (['codex', 'claude-code'] as const).map(executor => {
    const title = executor === 'codex' ? 'Codex' : 'Claude Code'
    let latest: ExecutorEvidence | undefined
    for (const snapshot of snapshots) {
      const evidence = evidenceFor(executor, snapshot)
      if (evidence !== undefined && (latest === undefined || evidence.at > latest.at)) latest = evidence
    }
    if (latest === undefined) return { executor, title, state: 'untested', text: '还没验证过' }
    if (latest.kind === 'pending') return { executor, title, state: 'testing', text: '测试中' }
    const when = formatTime(latest.at)
    if (latest.kind === 'passed') {
      return { executor, title, state: 'ready', text: `可用 · ${when} ${latest.source === 'check' ? '测试通过' : '协同成功'}` }
    }
    const explanation = explainFailure(latest.message ?? '')
    return explanation.action === undefined
      ? { executor, title, state: 'failed', text: `${when} 失败：${explanation.summary}` }
      : { executor, title, state: 'failed', text: `${when} 失败：${explanation.summary}`, action: explanation.action, detail: latest.message }
  })
}

/** Graphs the user may still need to pause or cancel. */
export function activeGraphs(snapshots: readonly GraphSnapshot[]): readonly GraphSnapshot[] {
  return snapshots.filter(snapshot => !isTerminalGraphStatus(snapshot))
}
