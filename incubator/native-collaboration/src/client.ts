import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Executor, GraphSnapshot } from '@lisihao/dsh-solar-native-resident/contracts'
import {
  availableGraphActionsForSnapshot,
  canStartGraphControl,
  canStartNativeCheck,
  createControlInput,
  graphStatusLabel,
  isSettledNativeCheck,
  mergeGraphSnapshots,
  nativeCheckGraphId,
  activeGraphs,
  collaborationAvailability,
  executorReadiness,
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

/** Remote handles shared by the client views; exported for the browser fixture. */
export class RemoteAccessStore {
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

export function NativeCollaborationPanel({ remoteStore }: { readonly remoteStore: RemoteAccessStore }): ReactElement {
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
  const availability = status === undefined ? undefined : collaborationAvailability(status)
  const executors = status === undefined ? undefined : executorReadiness(graphs, shortTime)
  const running = activeGraphs(graphs)
  const testAvailable = (executor: Executor): boolean => remote.api !== undefined
    && resident?.available === true
    && canStartNativeCheck(executor, graphs, pendingTests, inspectionTargets)
  const dot = (tone: 'ok' | 'error' | 'muted' | 'busy') => createElement('span', { key: 'dot', className: `solar-collab-settings__dot solar-collab-settings__dot--${tone}`, 'aria-hidden': true })
  return createElement('main', { className: 'solar-collab-settings' }, [
    createElement('style', { key: 'style' }, settingsCss),
    createElement('h2', { key: 'title', className: 'solar-collab-settings__heading' }, '智能协同'),
    createElement('p', { key: 'intro', className: 'solar-collab-settings__intro' }, '让主模型把复杂任务拆给本机的 Codex、Claude Code 去做。在对话输入框左侧打开「智能协同」。'),
    remote.error === undefined
      ? null
      : createElement('p', { key: 'mount-error', role: 'alert', className: 'solar-collab-settings__alert' }, `无法连接智能协同服务：${remote.error}`),
    notice === undefined
      ? null
      : createElement('p', { key: 'notice', role: notice.tone === 'error' ? 'alert' : 'status', className: notice.tone === 'error' ? 'solar-collab-settings__alert' : 'solar-collab-settings__note' }, notice.message),
    createElement('section', { key: 'status', className: 'solar-collab-settings__card', 'aria-label': '智能协同状态' }, [
      createElement('div', { key: 'overall', className: 'solar-collab-settings__row' }, [
        dot(availability === undefined ? 'muted' : availability.usable ? 'ok' : 'error'),
        createElement('div', { key: 'main', className: 'solar-collab-settings__main' }, [
          createElement('span', { key: 'name', className: 'solar-collab-settings__name' }, availability === undefined ? '正在读取状态…' : availability.usable ? '可以使用' : '暂时不能用'),
          availability?.action === undefined ? null : createElement('span', { key: 'action', className: 'solar-collab-settings__text' }, availability.action),
        ]),
        createElement('button', {
          key: 'refresh',
          type: 'button',
          className: 'solar-collab-settings__button',
          title: checkedAt === undefined ? '重新读取状态，不会调用模型' : `状态读取于 ${checkedAt}；重新读取不会调用模型`,
          disabled: remote.api === undefined || refreshing,
          onClick: () => { void refresh(true) },
        }, refreshing ? '刷新中…' : '刷新'),
      ]),
      ...(executors ?? []).map(item => createElement('div', { key: item.executor, className: 'solar-collab-settings__row' }, [
        dot(item.state === 'ready' ? 'ok' : item.state === 'failed' ? 'error' : item.state === 'testing' ? 'busy' : 'muted'),
        createElement('div', { key: 'main', className: 'solar-collab-settings__main' }, [
          createElement('span', { key: 'name', className: 'solar-collab-settings__name' }, item.title),
          createElement('span', { key: 'text', className: 'solar-collab-settings__text' }, item.text),
          item.action === undefined ? null : createElement('span', { key: 'action', className: 'solar-collab-settings__hint' }, item.action),
          item.detail === undefined ? null : createElement('details', { key: 'detail', className: 'solar-collab-settings__detail' }, [
            createElement('summary', { key: 'summary' }, '原始错误'),
            createElement('code', { key: 'code' }, item.detail),
          ]),
        ]),
        createElement('button', {
          key: 'test',
          type: 'button',
          className: 'solar-collab-settings__button',
          title: `向 ${item.title} 发一条只回复固定标记的测试，会消耗少量订阅额度`,
          disabled: !testAvailable(item.executor),
          onClick: () => { void runTest(item.executor) },
        }, pendingTests.has(item.executor) ? '测试中…' : item.state === 'untested' ? '测试' : '重新测试'),
      ])),
    ]),
    createElement('p', { key: 'foot', className: 'solar-collab-settings__foot' }, '「测试」会让对应工具回复一个固定标记，消耗少量订阅额度；打开本页和刷新不会调用模型。'),
    inspectionTargets.length === 0
      ? null
      : createElement('section', { key: 'inspection', className: 'solar-collab-settings__card solar-collab-settings__block' }, [
        createElement('h3', { key: 'title', className: 'solar-collab-settings__subheading' }, '有请求没有得到回执'),
        createElement('p', { key: 'copy', className: 'solar-collab-settings__text' }, '请先查看它的状态再决定下一步；界面不会自动重试。'),
        ...inspectionTargets.map(target => createElement('div', { key: target.graphId, className: 'solar-collab-settings__row' }, [
          dot('error'),
          createElement('div', { key: 'main', className: 'solar-collab-settings__main' }, [
            createElement('span', { key: 'label', className: 'solar-collab-settings__name' }, target.label),
            createElement('span', { key: 'reason', className: 'solar-collab-settings__text' }, displayMessage(target.reason, '上一次请求的结果尚未确认。')),
          ]),
          createElement('button', {
            key: 'inspect',
            type: 'button',
            className: 'solar-collab-settings__button',
            disabled: remote.api === undefined || pendingInspectionIds.has(target.graphId),
            onClick: () => { void inspectGraph(target) },
          }, pendingInspectionIds.has(target.graphId) ? '查看中…' : '查看状态'),
        ])),
      ]),
    running.length === 0
      ? null
      : createElement('section', { key: 'running', className: 'solar-collab-settings__card solar-collab-settings__block' }, [
        createElement('h3', { key: 'title', className: 'solar-collab-settings__subheading' }, '正在运行的协同任务'),
        ...running.map(snapshot => createElement('div', { key: snapshot.graph.id, className: 'solar-collab-settings__row' }, [
          dot('busy'),
          createElement('div', { key: 'main', className: 'solar-collab-settings__main' }, [
            createElement('span', { key: 'name', className: 'solar-collab-settings__name' }, runningTitle(snapshot)),
            createElement('span', { key: 'text', className: 'solar-collab-settings__text' }, `${shortTime(snapshot.createdAt)} 开始 · ${graphStatusLabel(snapshot.status)}`),
          ]),
          ...availableGraphActionsForSnapshot(snapshot).map(action => createElement('button', {
            key: action,
            type: 'button',
            className: 'solar-collab-settings__button',
            disabled: pendingGraphIds.has(snapshot.graph.id)
              || inspectionRequiredGraphIds.has(snapshot.graph.id)
              || !canStartGraphControl(snapshot, action, pendingGraphIds, inspectionRequiredGraphIds),
            onClick: () => { void controlGraph(snapshot, action) },
          }, actionLabel(action))),
        ])),
      ]),
  ])
}

const settingsCss = `
.solar-collab-settings { display: flex; flex-direction: column; gap: 12px; max-width: 760px; min-width: 0; color: var(--dsw-alias-label-primary); }
.solar-collab-settings__heading { margin: 0; font-size: 18px; font-weight: 600; }
.solar-collab-settings__subheading { margin: 0; font-size: 14px; font-weight: 600; }
.solar-collab-settings__intro, .solar-collab-settings__foot { margin: 0; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.solar-collab-settings__foot { font-size: 12px; }
.solar-collab-settings__card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; overflow: hidden; }
.solar-collab-settings__block { display: grid; gap: 8px; }
.solar-collab-settings__block.solar-collab-settings__card { padding: 12px 0 0; }
.solar-collab-settings__block.solar-collab-settings__card > h3, .solar-collab-settings__block.solar-collab-settings__card > p { padding: 0 14px; }
.solar-collab-settings__row { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; min-width: 0; }
.solar-collab-settings__row + .solar-collab-settings__row { border-top: 1px solid var(--dsw-alias-border-l2); }
.solar-collab-settings__dot { flex: none; width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); }
.solar-collab-settings__dot--ok { background: var(--dsw-alias-state-success-primary, #2ea043); }
.solar-collab-settings__dot--error { background: var(--dsw-alias-state-error-primary, #d93026); }
.solar-collab-settings__dot--busy { background: var(--dsw-alias-brand-primary, #4d6bfe); }
.solar-collab-settings__main { flex: 1; min-width: 0; display: grid; gap: 2px; }
.solar-collab-settings__name { font-size: 14px; font-weight: 500; }
.solar-collab-settings__text { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.solar-collab-settings__hint { font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
.solar-collab-settings__detail { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.solar-collab-settings__detail summary { cursor: pointer; width: fit-content; }
.solar-collab-settings__detail code { display: block; margin-top: 4px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--dsw-font-mono, ui-monospace, monospace); }
.solar-collab-settings__button { flex: none; height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 13px; white-space: nowrap; cursor: pointer; }
.solar-collab-settings__button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.solar-collab-settings__button:disabled { cursor: default; opacity: .5; }
.solar-collab-settings__alert { margin: 0; font-size: 13px; color: var(--dsw-alias-state-error-primary); }
.solar-collab-settings__note { margin: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); }
`

/** A coordinated graph carries the generic tool label; show it as a plain task title. */
function runningTitle(snapshot: GraphSnapshot): string {
  const label = snapshot.graph.label.trim()
  return label.length === 0 || label === 'Solar coordinated collaboration' ? '协同任务' : label
}

function shortTime(value: number): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
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
