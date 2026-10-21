import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Executor, GraphSnapshot, NodeSnapshot } from '@lisihao/dsh-solar-native-resident/contracts'
import {
  availableGraphActionsForSnapshot,
  canStartGraphControl,
  canStartNativeCheck,
  createControlInput,
  graphStatusLabel,
  isSettledNativeCheck,
  mergeGraphSnapshots,
  nativeCheckGraphId,
  nativeCheckVerdict,
  nodeStatusLabel,
  readinessRows,
  upsertGraphSnapshot,
  type GraphControlAction,
} from './client-helpers.js'
import { RPC_REMOTE } from './remote.js'
import { WorkflowStudioPanel, SessionModeControl } from './studio-client.js'
import type { StudioUiApi } from './studio-contract.js'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'

type StudioWire = { [K in keyof StudioUiApi]: (...args: Parameters<StudioUiApi[K]>) => Promise<RemoteResult<Awaited<ReturnType<StudioUiApi[K]>>>> }
function studioApi(wire: StudioWire): StudioUiApi {
  const unwrap = <T,>(result: RemoteResult<T>): T => { if (result.ok) return result.value; throw result.error }
  return {
    overview: async input => unwrap(await wire.overview(input)),
    refreshSource: async input => unwrap(await wire.refreshSource(input)),
    save: async input => unwrap(await wire.save(input)),
    validate: async input => unwrap(await wire.validate(input)),
    run: async input => unwrap(await wire.run(input)),
    inspect: async input => unwrap(await wire.inspect(input)),
    resume: async input => unwrap(await wire.resume(input)),
    setMode: async input => unwrap(await wire.setMode(input)),
  }
}
import type {
  GraphQuery,
  NativeControlInput,
  NativeTestInput,
  NativeUiStatus,
} from './ui-contract.js'

export const name = 'native-collaboration'
export const inject = ['slots', 'remote', 'connection']

type NativeControlRemote = {
  status(): Promise<RemoteResult<NativeUiStatus>>
  inspect(input: GraphQuery): Promise<RemoteResult<GraphSnapshot>>
  control(input: NativeControlInput): Promise<RemoteResult<GraphSnapshot>>
  test(input: NativeTestInput): Promise<RemoteResult<GraphSnapshot>>
}

interface RemoteAccessSnapshot {
  readonly api: NativeControlRemote | undefined
  readonly studio?: StudioUiApi
  readonly error: string | undefined
}

class RemoteAccessStore {
  private snapshot: RemoteAccessSnapshot = { api: undefined, error: undefined }
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): RemoteAccessSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setApi(api: NativeControlRemote, studio: StudioUiApi): void {
    this.snapshot = { api, studio, error: undefined }
    this.publish()
  }

  setError(error: string): void {
    this.snapshot = { api: undefined, error }
    this.publish()
  }

  clear(): void {
    this.snapshot = { api: undefined, error: undefined }
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

interface InspectionTarget {
  readonly graphId: string
  readonly label: string
  readonly reason: string
  readonly executor?: Executor
}

interface Notice {
  readonly tone: 'info' | 'error'
  readonly message: string
}

const panelStyle: CSSProperties = {
  display: 'grid',
  gap: 16,
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box',
  padding: 16,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
}

const sectionStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
  minWidth: 0,
  padding: 14,
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 10,
  background: 'var(--dsw-alias-settings-card-fill)',
}

const actionRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'center',
}

const buttonStyle: CSSProperties = {
  minHeight: 32,
  maxWidth: '100%',
  padding: '6px 10px',
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'inherit',
  cursor: 'pointer',
  overflowWrap: 'anywhere',
}

const mutedStyle: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary)',
  overflowWrap: 'anywhere',
}

const preStyle: CSSProperties = {
  margin: 0,
  maxHeight: '18rem',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  padding: 10,
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-module-platform)',
}

function useRemoteAccess(store: RemoteAccessStore): RemoteAccessSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

function displayMessage(value: string | undefined, fallback: string): string {
  const text = value?.trim()
  if (!text) return fallback
  return text
    .replace(/^[A-Z][A-Z0-9_/-]+:\s*/, '')
    .replace(/\bnative-check-[A-Za-z0-9-]+\b/g, '该任务')
    .replace(/\bnative-ui-test:[A-Za-z0-9-]+\b/g, '该操作')
}

function errorMessage(error: unknown): string {
  return displayMessage(error instanceof Error ? error.message : undefined, '本机控制通道没有返回可用结果。')
}

function remoteFailureMessage<T>(result: RemoteResult<T>): string {
  return result.ok ? '' : displayMessage(result.error.message, '本机控制请求未完成。')
}

function commandId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('当前界面无法生成一次性请求标识。')
  }
  return globalThis.crypto.randomUUID()
}

function graphLabel(snapshot: GraphSnapshot): string {
  return snapshot.graph.label.trim() || '未命名原生任务'
}

function timeLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleString('zh-CN')
}

function actionLabel(action: GraphControlAction): string {
  if (action === 'pause') return '暂停后续调度'
  if (action === 'resume') return '继续调度'
  return '取消任务'
}

function testLabel(executor: Executor): string {
  return executor === 'codex'
    ? 'Codex 原生连接测试'
    : 'Claude Code 原生连接测试'
}

function waitReasonLabel(reason: string): string {
  const labels: Readonly<Record<string, string>> = {
    failed: '执行失败', cancelled: '已取消',
    'cancellation-requested': '正在请求中断，尚未确认停止',
    'shutdown-cancellation-requested': '服务退出时已请求中断，尚未确认停止',
    'owner-retry': '所有者已明确允许再次尝试',
    'owner-failed': '所有者已将未确认结果裁决为失败',
    'owner-resolution-required': '执行结果未确认，需要所有者处理',
    'recovery-ready': '恢复后等待调度',
    BRIDGE_UNAVAILABLE: 'DSH 工具桥暂不可用',
    'session-busy': '原生会话正在执行其他任务',
    'session-fenced': '原生会话有未确认结果，暂不能继续',
    'scope-conflict': '相同文件范围正在被其他任务使用',
    'scope-conflict-indeterminate': '相同文件范围被未确认任务占用',
    'failed-dependency': '前置任务失败，当前节点不会执行',
    'admission-conflict': '执行身份冲突，需要检查任务记录',
    'retry-delay': '正在等待已配置的再次尝试时间',
  }
  return labels[reason] ?? '执行条件尚未满足，详细原因请查看任务记录。'
}

function GraphNode({ node, index }: { readonly node: NodeSnapshot; readonly index: number }): ReactElement {
  return createElement('details', { style: { minWidth: 0, padding: '8px 0' } }, [
    createElement('summary', { key: 'summary', style: { cursor: 'pointer', overflowWrap: 'anywhere' } }, `节点 ${index + 1} · ${nodeStatusLabel(node.status)}`),
    node.waitReason === undefined
      ? null
      : createElement('p', { key: 'wait', style: mutedStyle }, `任务说明：${waitReasonLabel(node.waitReason)}`),
    node.output === undefined
      ? null
      : createElement('div', { key: 'output', style: { display: 'grid', gap: 6, marginTop: 8 } }, [
        createElement('strong', { key: 'label' }, '输出'),
        createElement('pre', { key: 'value', style: preStyle }, node.output),
      ]),
    node.error === undefined
      ? null
      : createElement('div', { key: 'error', role: 'alert', style: { display: 'grid', gap: 6, marginTop: 8, color: 'var(--dsw-alias-state-error-primary)' } }, [
        createElement('strong', { key: 'label' }, '错误详情'),
        createElement('pre', { key: 'value', style: preStyle }, node.error.message),
      ]),
  ])
}

interface GraphCardProps {
  readonly snapshot: GraphSnapshot
  readonly pendingGraphIds: ReadonlySet<string>
  readonly inspectionRequiredGraphIds: ReadonlySet<string>
  readonly onControl: (snapshot: GraphSnapshot, action: GraphControlAction) => Promise<void>
}

function GraphCard({ snapshot, pendingGraphIds, inspectionRequiredGraphIds, onControl }: GraphCardProps): ReactElement {
  const actions = availableGraphActionsForSnapshot(snapshot)
  const blockedForInspection = inspectionRequiredGraphIds.has(snapshot.graph.id)
  const busy = pendingGraphIds.has(snapshot.graph.id)
  const verdict = nativeCheckVerdict(snapshot)
  return createElement('article', { style: sectionStyle }, [
    createElement('div', { key: 'header', style: { display: 'grid', gap: 4, minWidth: 0 } }, [
      createElement('strong', { key: 'label', style: { overflowWrap: 'anywhere' } }, graphLabel(snapshot)),
      createElement('span', { key: 'status', style: mutedStyle }, graphStatusLabel(snapshot.status)),
    ]),
    blockedForInspection
      ? createElement('p', { key: 'inspection', style: mutedStyle }, '上一次控制请求的结果尚未确认。请先在下方检查该任务状态；界面不会自动重试。')
      : null,
    verdict === undefined
      ? null
      : createElement('p', {
        key: 'verdict',
        style: {
          ...mutedStyle,
          color: verdict.kind === 'passed'
            ? 'var(--dsw-alias-state-success-primary)'
            : verdict.kind === 'failed' || verdict.kind === 'unconfirmed'
              ? 'var(--dsw-alias-state-error-primary)'
              : mutedStyle.color,
        },
      }, `连接测试：${verdict.label}`),
    actions.length === 0
      ? null
      : createElement('div', { key: 'actions', style: actionRowStyle }, actions.map(action => createElement('button', {
        key: action,
        type: 'button',
        disabled: busy || blockedForInspection || !canStartGraphControl(snapshot, action, pendingGraphIds, inspectionRequiredGraphIds),
        onClick: () => { void onControl(snapshot, action) },
        style: buttonStyle,
      }, actionLabel(action)))),
    snapshot.nodes.length === 0
      ? createElement('p', { key: 'empty', style: mutedStyle }, '任务图尚未返回节点详情。')
      : createElement('div', { key: 'nodes', style: { display: 'grid', gap: 4, minWidth: 0 } }, [
        createElement('strong', { key: 'title' }, '节点详情'),
        ...snapshot.nodes.map((node, index) => createElement(GraphNode, { key: `${snapshot.graph.id}:${index}`, node, index })),
      ]),
  ])
}

function NativeCollaborationPanel({ remoteStore }: { readonly remoteStore: RemoteAccessStore }): ReactElement {
  const remote = useRemoteAccess(remoteStore)
  const [status, setStatus] = useState<NativeUiStatus | undefined>()
  const [graphs, setGraphs] = useState<readonly GraphSnapshot[]>([])
  const [notice, setNotice] = useState<Notice | undefined>()
  const [refreshing, setRefreshing] = useState(false)
  const [pendingGraphIds, setPendingGraphIds] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingTests, setPendingTests] = useState<ReadonlySet<Executor>>(() => new Set())
  const [pendingInspectionIds, setPendingInspectionIds] = useState<ReadonlySet<string>>(() => new Set())
  const [inspectionTargets, setInspectionTargets] = useState<readonly InspectionTarget[]>([])
  const locks = useRef(new Set<string>())
  const inspectionRequiredGraphIds = useMemo(
    () => new Set(inspectionTargets.map(target => target.graphId)),
    [inspectionTargets],
  )

  const lock = useCallback((key: string): boolean => {
    if (locks.current.has(key)) return false
    locks.current.add(key)
    return true
  }, [])

  const unlock = useCallback((key: string): void => {
    locks.current.delete(key)
  }, [])

  const markPendingGraph = useCallback((graphId: string, pending: boolean): void => {
    setPendingGraphIds(current => {
      const next = new Set(current)
      if (pending) next.add(graphId)
      else next.delete(graphId)
      return next
    })
  }, [])

  const markPendingTest = useCallback((executor: Executor, pending: boolean): void => {
    setPendingTests(current => {
      const next = new Set(current)
      if (pending) next.add(executor)
      else next.delete(executor)
      return next
    })
  }, [])

  const markPendingInspection = useCallback((graphId: string, pending: boolean): void => {
    setPendingInspectionIds(current => {
      const next = new Set(current)
      if (pending) next.add(graphId)
      else next.delete(graphId)
      return next
    })
  }, [])

  const retainForInspection = useCallback((target: InspectionTarget): void => {
    setInspectionTargets(current => {
      const existing = current.findIndex(item => item.graphId === target.graphId)
      if (existing < 0) return [...current, target]
      const next = [...current]
      next[existing] = target
      return next
    })
  }, [])

  const clearInspection = useCallback((graphId: string): void => {
    setInspectionTargets(current => current.filter(target => target.graphId !== graphId))
  }, [])

  const recordGraph = useCallback((snapshot: GraphSnapshot): void => {
    setGraphs(current => upsertGraphSnapshot(current, snapshot))
  }, [])

  const refresh = useCallback(async (announce: boolean): Promise<void> => {
    const api = remote.api
    if (api === undefined || !lock('status')) return
    setRefreshing(true)
    try {
      const result = await api.status()
      if (!result.ok) {
        setNotice({ tone: 'error', message: `无法读取本机状态：${remoteFailureMessage(result)}` })
        return
      }
      setStatus(result.value)
      setGraphs(current => mergeGraphSnapshots(current, result.value.graphs))
      setInspectionTargets(current => current.filter(target => {
        if (target.executor === undefined) return true
        const observed = result.value.graphs.find(snapshot => snapshot.graph.id === target.graphId)
        return observed === undefined || !isSettledNativeCheck(observed)
      }))
      if (announce) setNotice({ tone: 'info', message: '已刷新注册与任务状态；此操作未提交原生执行。' })
    } catch (error) {
      setNotice({ tone: 'error', message: `无法读取本机状态：${errorMessage(error)}` })
    } finally {
      setRefreshing(false)
      unlock('status')
    }
  }, [lock, remote.api, unlock])

  useEffect(() => {
    if (remote.api !== undefined) void refresh(false)
  }, [refresh, remote.api])

  const runTest = useCallback(async (executor: Executor): Promise<void> => {
    const api = remote.api
    const lockKey = `test:${executor}`
    if (api === undefined || !canStartNativeCheck(executor, graphs, pendingTests, inspectionTargets) || !lock(lockKey)) return
    let markedPending = false
    let target: InspectionTarget | undefined
    try {
      const id = commandId()
      const graphId = nativeCheckGraphId(id)
      const testTarget: InspectionTarget = {
        graphId,
        label: testLabel(executor),
        reason: '测试提交结果尚未确认。',
        executor,
      }
      target = testTarget
      markedPending = true
      markPendingTest(executor, true)
      const result = await api.test({ commandId: id, executor })
      if (!result.ok) {
        retainForInspection({ ...testTarget, reason: remoteFailureMessage(result) })
        setNotice({ tone: 'error', message: '测试提交未得到可用回执。请先检查该任务状态；界面不会自动重试。' })
        return
      }
      recordGraph(result.value)
      clearInspection(graphId)
      setNotice({ tone: 'info', message: `${testLabel(executor)}已提交。请查看任务图中的节点输出和最终状态。` })
    } catch (error) {
      if (target !== undefined) retainForInspection({ ...target, reason: errorMessage(error) })
      setNotice({ tone: 'error', message: `无法提交${testLabel(executor)}：${errorMessage(error)}` })
    } finally {
      if (markedPending) markPendingTest(executor, false)
      unlock(lockKey)
    }
  }, [clearInspection, graphs, inspectionTargets, lock, markPendingTest, pendingTests, recordGraph, remote.api, retainForInspection, unlock])

  const controlGraph = useCallback(async (snapshot: GraphSnapshot, action: GraphControlAction): Promise<void> => {
    const api = remote.api
    const graphId = snapshot.graph.id
    if (api === undefined || !canStartGraphControl(snapshot, action, pendingGraphIds, inspectionRequiredGraphIds)) return
    const lockKey = `control:${graphId}`
    if (!lock(lockKey)) return
    let markedPending = false
    try {
      const input = createControlInput(snapshot, action, commandId())
      if (input === undefined) return
      markedPending = true
      markPendingGraph(graphId, true)
      const result = await api.control(input)
      if (!result.ok) {
        retainForInspection({
          graphId,
          label: graphLabel(snapshot),
          reason: remoteFailureMessage(result),
        })
        setNotice({ tone: 'error', message: `${actionLabel(action)}未得到可用回执。请先检查该任务状态；界面不会自动重试。` })
        return
      }
      recordGraph(result.value)
      clearInspection(graphId)
      setNotice({ tone: 'info', message: `${actionLabel(action)}已提交，当前状态已更新。` })
    } catch (error) {
      retainForInspection({
        graphId,
        label: graphLabel(snapshot),
        reason: errorMessage(error),
      })
      setNotice({ tone: 'error', message: `${actionLabel(action)}未确认。请先检查该任务状态；界面不会自动重试。` })
    } finally {
      if (markedPending) markPendingGraph(graphId, false)
      unlock(lockKey)
    }
  }, [clearInspection, inspectionRequiredGraphIds, lock, markPendingGraph, pendingGraphIds, recordGraph, remote.api, retainForInspection, unlock])

  const inspectGraph = useCallback(async (target: InspectionTarget): Promise<void> => {
    const api = remote.api
    const lockKey = `inspect:${target.graphId}`
    if (api === undefined || !lock(lockKey)) return
    let markedPending = false
    try {
      markedPending = true
      markPendingInspection(target.graphId, true)
      const result = await api.inspect({ graphId: target.graphId })
      if (!result.ok) {
        retainForInspection({ ...target, reason: remoteFailureMessage(result) })
        setNotice({ tone: 'error', message: `无法确认“${target.label}”的状态：${remoteFailureMessage(result)}` })
        return
      }
      recordGraph(result.value)
      clearInspection(target.graphId)
      setNotice({ tone: 'info', message: `已读取“${target.label}”的当前状态。` })
    } catch (error) {
      retainForInspection({ ...target, reason: errorMessage(error) })
      setNotice({ tone: 'error', message: `无法确认“${target.label}”的状态：${errorMessage(error)}` })
    } finally {
      if (markedPending) markPendingInspection(target.graphId, false)
      unlock(lockKey)
    }
  }, [clearInspection, lock, markPendingInspection, recordGraph, remote.api, retainForInspection, unlock])

  const checkedAt = timeLabel(status?.checkedAt)
  const resident = status?.resident
  const rows = status === undefined ? undefined : readinessRows(status, graphs, value => new Date(value).toLocaleString('zh-CN'))
  const codexCheckAvailable = canStartNativeCheck('codex', graphs, pendingTests, inspectionTargets)
  const claudeCodeCheckAvailable = canStartNativeCheck('claude-code', graphs, pendingTests, inspectionTargets)
  return createElement('main', { style: panelStyle }, [
    createElement('header', { key: 'header', style: { display: 'grid', gap: 6, minWidth: 0 } }, [
      createElement('h1', { key: 'title', style: { margin: 0, fontSize: '1.25rem' } }, '智能协同'),
      createElement('p', { key: 'summary', style: mutedStyle }, '开启后，主模型遇到适合拆分的复杂任务时，会把它拆成几个步骤交给本机的 Codex 或 Claude Code 执行，再汇总结果。在对话输入框左侧点「智能协同」即可为当前会话开启，切换本身不会调用模型；执行过程在会话的「执行流程」里查看。'),
    ]),
    remote.error === undefined
      ? null
      : createElement('p', { key: 'mount-error', role: 'alert', style: { ...sectionStyle, color: 'var(--dsw-alias-state-error-primary)' } }, `无法连接智能协同服务：${remote.error}`),
    notice === undefined
      ? null
      : createElement('p', {
        key: 'notice',
        role: notice.tone === 'error' ? 'alert' : 'status',
        style: { ...sectionStyle, color: notice.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'inherit' },
      }, notice.message),
    createElement('section', { key: 'readiness', style: sectionStyle }, [
      createElement('div', { key: 'heading', style: { display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap' } }, [
        createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '就绪状态'),
        createElement('button', {
          key: 'refresh',
          type: 'button',
          disabled: remote.api === undefined || refreshing,
          onClick: () => { void refresh(true) },
          style: buttonStyle,
        }, refreshing ? '正在刷新…' : '刷新状态'),
      ]),
      rows === undefined
        ? createElement('p', { key: 'loading', style: mutedStyle }, remote.api === undefined ? '正在连接智能协同服务…' : '正在读取状态…')
        : createElement('dl', { key: 'rows', style: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '8px 16px', margin: 0, minWidth: 0 } }, rows.flatMap(row => [
          createElement('dt', { key: `${row.key}:title`, style: { margin: 0, color: 'var(--dsw-alias-label-secondary)' } }, row.title),
          createElement('dd', { key: `${row.key}:value`, style: { margin: 0, display: 'grid', gap: 4, minWidth: 0 } }, [
            createElement('span', {
              key: 'text',
              style: {
                overflowWrap: 'anywhere',
                color: row.tone === 'ok'
                  ? 'var(--dsw-alias-state-success-primary)'
                  : row.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
              },
            }, row.text),
            row.hint === undefined ? null : createElement('span', { key: 'hint', style: mutedStyle }, row.hint),
          ]),
        ])),
      checkedAt === undefined ? null : createElement('p', { key: 'checked-at', style: { ...mutedStyle, fontSize: 12 } }, `状态读取于 ${checkedAt}`),
    ]),
    createElement('section', { key: 'tests', style: sectionStyle }, [
      createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '连接测试'),
      createElement('p', { key: 'copy', style: mutedStyle }, '点击后向对应工具发一条只要求回复固定标记的测试，会消耗少量订阅额度；测试不读写文件、不使用工具。打开本页和刷新状态不会调用模型。'),
      createElement('div', { key: 'buttons', style: actionRowStyle }, [
        createElement('button', {
          key: 'codex',
          type: 'button',
          disabled: remote.api === undefined || resident?.available !== true || !codexCheckAvailable,
          onClick: () => { void runTest('codex') },
          style: buttonStyle,
        }, pendingTests.has('codex') ? 'Codex 测试正在提交…' : '测试 Codex'),
        createElement('button', {
          key: 'claude',
          type: 'button',
          disabled: remote.api === undefined || resident?.available !== true || !claudeCodeCheckAvailable,
          onClick: () => { void runTest('claude-code') },
          style: buttonStyle,
        }, pendingTests.has('claude-code') ? 'Claude Code 测试正在提交…' : '测试 Claude Code'),
      ]),
    ]),
    inspectionTargets.length === 0
      ? null
      : createElement('section', { key: 'inspection', style: sectionStyle }, [
        createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '待确认的任务状态'),
        createElement('p', { key: 'copy', style: mutedStyle }, '这些请求没有得到可用回执。请先读取状态；界面不会自动重试提交或控制操作。'),
        ...inspectionTargets.map(target => createElement('div', { key: target.graphId, style: { display: 'grid', gap: 6, minWidth: 0 } }, [
          createElement('strong', { key: 'label', style: { overflowWrap: 'anywhere' } }, target.label),
          createElement('p', { key: 'reason', style: mutedStyle }, displayMessage(target.reason, '上一次请求的结果尚未确认。')),
          createElement('div', { key: 'actions', style: actionRowStyle }, [
            createElement('button', {
              key: 'inspect',
              type: 'button',
              disabled: remote.api === undefined || pendingInspectionIds.has(target.graphId),
              onClick: () => { void inspectGraph(target) },
              style: buttonStyle,
            }, pendingInspectionIds.has(target.graphId) ? '正在检查状态…' : '检查该任务状态'),
          ]),
        ])),
      ]),
    createElement('details', { key: 'details', style: { ...sectionStyle, display: 'block' } }, [
      createElement('summary', { key: 'summary', style: { cursor: 'pointer', fontWeight: 600 } }, `最近协同任务与技术详情（${graphs.length} 个任务）`),
      createElement('div', { key: 'body', style: { display: 'grid', gap: 12, marginTop: 12, minWidth: 0 } }, [
        status === undefined
          ? null
          : createElement('div', { key: 'registration', style: { display: 'grid', gap: 4 } }, [
            createElement('strong', { key: 'title' }, '官方子智能体注册（单次委派用）'),
            ...status.providers.map(provider => createElement('div', { key: provider.name, style: mutedStyle }, `${provider.label}：${provider.available ? '已注册' : '未注册'}`)),
            createElement('p', { key: 'resident', style: mutedStyle }, `调度器说明：${displayMessage(status.resident.message, '未返回说明。')}`),
          ]),
        graphs.length === 0
          ? createElement('p', { key: 'empty', style: mutedStyle }, '还没有协同任务。')
          : createElement('div', { key: 'list', style: { display: 'grid', gap: 10, minWidth: 0 } }, graphs.map(snapshot => createElement(GraphCard, {
            key: snapshot.graph.id,
            snapshot,
            pendingGraphIds,
            inspectionRequiredGraphIds,
            onControl: controlGraph,
          }))),
      ]),
    ]),
  ])
}

/** Mount the owner-only Remote namespace once, then contribute the same view to both official slots. */
export function apply(ctx: Context): void {
  const remoteStore = new RemoteAccessStore()
  let disposed = false
  let disposeRemote: (() => Promise<void>) | undefined

  ctx.effect(() => {
    void ctx.remote.$mount(RPC_REMOTE).then(async (disposer) => {
      if (disposed) {
        await disposer()
        return
      }
      const api = ctx.get('remote.solarNativeControl') as unknown as NativeControlRemote | undefined
      if (api === undefined) {
        await disposer()
        remoteStore.setError('本机没有提供智能协同控制服务。')
        return
      }
      disposeRemote = disposer
      const studioWire = ctx.get('remote.solarWorkflowControl') as unknown as StudioWire | undefined
      if (!studioWire) { await disposer(); remoteStore.setError('本机没有提供会话流程服务。'); return }
      remoteStore.setApi(api, studioApi(studioWire))
    }).catch((error: unknown) => {
      if (!disposed) remoteStore.setError(errorMessage(error))
    })
    return () => {
      disposed = true
      remoteStore.clear()
      if (disposeRemote !== undefined) void disposeRemote()
    }
  }, 'native-collaboration: remote')

  const Diagnostics = (): ReactElement => createElement(NativeCollaborationPanel, { remoteStore })
  const FlowView = (props: PropsRuntime<'conversation.view'>): ReactElement => {
    const remote = useRemoteAccess(remoteStore)
    return createElement(WorkflowStudioPanel, { sessionId: String(props.sessionId), api: remote.studio, error: remote.error })
  }
  const ModeView = (props: PropsRuntime<'conversation.input.left'>): ReactElement => {
    const remote = useRemoteAccess(remoteStore)
    return createElement(SessionModeControl, { sessionId: String(props.sessionId), api: remote.studio, error: remote.error })
  }
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'solar-native-collaboration', order: 45, label: () => '执行流程' }, FlowView))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ name: 'conversation.input.left', id: 'solar-session-collaboration-mode', order: 45, label: () => '智能协同' }, ModeView))
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'solar-native-collaboration', order: 45, label: () => '智能协同' }, Diagnostics))
}
