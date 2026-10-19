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
