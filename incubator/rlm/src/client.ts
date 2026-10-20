import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { RPC_REMOTE } from './remote.js'
import type {
  CancelInput,
  InspectInput,
  RlmUiStatus,
  RunSummary,
  SelfTestInput,
  SelfTestReport,
} from './ui-contract.js'

export const name = 'rlm'
export const inject = ['slots', 'remote', 'connection']

type RlmControlRemote = {
  status(): Promise<RemoteResult<RlmUiStatus>>
  check(input: SelfTestInput): Promise<RemoteResult<SelfTestReport>>
  inspect(input: InspectInput): Promise<RemoteResult<RunSummary>>
  cancel(input: CancelInput): Promise<RemoteResult<RunSummary>>
}

interface RemoteAccessSnapshot {
  readonly api: RlmControlRemote | undefined
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

  setApi(api: RlmControlRemote): void {
    this.snapshot = { api, error: undefined }
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

const resultStyle: CSSProperties = {
  margin: 0,
  maxHeight: '12rem',
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
    .replace(/\b(?:rlm|run|command)[-_][A-Za-z0-9_-]+\b/gi, '该任务')
}

// Keep native diagnostic identities in the saved report, not the normal UI.
function checkDetail(value: string): string {
  return displayMessage(value, '未返回检查说明。')
    .replace(/运行时指纹 [0-9a-f]{16,64}/gi, '运行时指纹')
    .replace(/，refinement id 为 refine_[A-Za-z0-9_]+/g, '')
    .replace(/rollback 记录 refine_[A-Za-z0-9_]+/g, 'rollback 记录')
}

function errorMessage(error: unknown): string {
  const message = displayMessage(error instanceof Error ? error.message : undefined, 'RLM 控制通道暂不可用。')
  return `${message} 连接可能正在重连，请稍后重试。`
}

function remoteFailureMessage<T>(result: RemoteResult<T>): string {
  return result.ok ? '' : `${displayMessage(result.error.message, 'RLM 控制通道返回失败。')} 连接可能正在重连，请稍后重试。`
}

function commandId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  throw new Error('当前界面无法创建自检命令引用，请重新加载页面。')
}

function timeLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toLocaleString('zh-CN')
}

function runtimeMessage(status: RlmUiStatus | undefined): string {
  if (status === undefined) return '正在读取运行时状态…'
  const runtime = status.runtime
  return `运行时：${runtime.available ? '已就绪' : '不可用'}。${displayMessage(runtime.message, '未返回运行时说明。')}`
}

function runStateLabel(state: string): string {
  const labels: Readonly<Record<string, string>> = {
    preparing: '正在准备运行时',
    idle: '等待任务操作',
    queued: '等待调度',
    pending: '等待调度',
    running: '正在执行',
    paused: '已暂停后续调度',
    cancelling: '正在请求取消',
    'cancellation-requested': '正在请求取消，尚未确认停止',
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已取消',
    indeterminate: '结果未确认，请检查任务状态',
  }
  return labels[state] ?? '状态已返回，请查看任务说明'
}

function canRequestCancel(run: RunSummary): boolean {
  return !['completed', 'failed', 'cancelled', 'cancelling', 'cancellation-requested'].includes(run.state)
}

function runLabel(run: RunSummary): string {
  const label = run.label.trim()
  return label || '未命名 Prime RLM 任务'
}

function upsertRun(runs: readonly RunSummary[], run: RunSummary): readonly RunSummary[] {
  const index = runs.findIndex(item => item.runId === run.runId)
  if (index < 0) return [run, ...runs]
  const next = [...runs]
  next[index] = run
  return next
}

function reportStatusLabel(report: SelfTestReport): string {
  return report.status === 'passed' ? '自检结果：已通过' : '自检结果：未通过'
}

function RunCard({
  run,
  pending,
  blockedCancelRunIds,
  onInspect,
  onCancel,
}: {
  readonly run: RunSummary
  readonly pending: ReadonlySet<string>
  readonly blockedCancelRunIds: ReadonlySet<string>
  readonly onInspect: (run: RunSummary) => void
  readonly onCancel: (run: RunSummary) => void
}): ReactElement {
  const inspectKey = `inspect:${run.runId}`
  const cancelKey = `cancel:${run.runId}`
  const createdAt = timeLabel(run.createdAt)
  const updatedAt = timeLabel(run.updatedAt)
  const blockedForConfirmation = blockedCancelRunIds.has(run.runId)
  const canCancel = canRequestCancel(run) && !blockedForConfirmation
  return createElement('article', { style: sectionStyle }, [
    createElement('div', { key: 'heading', style: { display: 'grid', gap: 4, minWidth: 0 } }, [
      createElement('strong', { key: 'label', style: { overflowWrap: 'anywhere' } }, runLabel(run)),
      createElement('span', { key: 'state', style: mutedStyle }, `运行状态：${runStateLabel(run.state)}`),
    ]),
    createElement('p', { key: 'message', style: mutedStyle }, `任务说明：${displayMessage(run.message, '未返回任务说明。')}`),
    blockedForConfirmation
      ? createElement('p', { key: 'cancel-confirmation', style: mutedStyle }, '取消请求的结果尚未确认，请先读取任务状态；界面不会自动重复停止。')
      : null,
    createElement('p', { key: 'requests', style: mutedStyle }, `模型请求次数：${run.modelRequests}`),
    createdAt === undefined ? null : createElement('p', { key: 'created', style: mutedStyle }, `创建时间：${createdAt}`),
    updatedAt === undefined ? null : createElement('p', { key: 'updated', style: mutedStyle }, `更新时间：${updatedAt}`),
    run.result === undefined || run.result.trim() === ''
      ? null
      : createElement('details', { key: 'result', style: { minWidth: 0 } }, [
        createElement('summary', { key: 'summary', style: { cursor: 'pointer' } }, '查看结果摘要'),
        createElement('pre', { key: 'value', style: resultStyle }, run.result),
      ]),
    createElement('div', { key: 'actions', style: actionRowStyle }, [
      createElement('button', {
        key: 'inspect',
        type: 'button',
        disabled: pending.has(inspectKey),
        onClick: () => onInspect(run),
        style: buttonStyle,
      }, pending.has(inspectKey) ? '正在读取任务状态…' : '读取任务状态'),
      createElement('button', {
        key: 'cancel',
        type: 'button',
        disabled: !canCancel || pending.has(cancelKey),
        onClick: () => onCancel(run),
        style: buttonStyle,
      }, pending.has(cancelKey) ? '正在请求取消…' : '请求取消任务'),
    ]),
  ])
}

function RlmPanel({ remoteStore }: { readonly remoteStore: RemoteAccessStore }): ReactElement {
  const remote = useRemoteAccess(remoteStore)
  const [status, setStatus] = useState<RlmUiStatus | undefined>()
  const [selfTest, setSelfTest] = useState<SelfTestReport | undefined>()
  const [notice, setNotice] = useState<Notice | undefined>()
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [blockedCancelRunIds, setBlockedCancelRunIds] = useState<ReadonlySet<string>>(() => new Set())
  const [loadingStatus, setLoadingStatus] = useState(false)
  const locks = useRef(new Set<string>())

  const lock = useCallback((key: string): boolean => {
    if (locks.current.has(key)) return false
    locks.current.add(key)
    setPending(current => new Set(current).add(key))
    return true
  }, [])

  const unlock = useCallback((key: string): void => {
    locks.current.delete(key)
    setPending(current => {
      const next = new Set(current)
      next.delete(key)
      return next
    })
  }, [])

  const refreshStatus = useCallback(async (announce: boolean): Promise<void> => {
    const api = remote.api
    const key = 'status'
    if (api === undefined || !lock(key)) return
    setLoadingStatus(true)
    try {
      const result = await api.status()
      if (!result.ok) {
        setNotice({ tone: 'error', message: `无法读取 Prime RLM 运行时状态：${remoteFailureMessage(result)}` })
        return
      }
      setStatus(result.value)
      setSelfTest(current => result.value.selftest ?? current)
      if (announce) setNotice({ tone: 'info', message: '已读取 Prime RLM 运行时和任务状态；未提交模型请求。' })
    } catch (error) {
      setNotice({ tone: 'error', message: `无法读取 Prime RLM 运行时状态：${errorMessage(error)}` })
    } finally {
      setLoadingStatus(false)
      unlock(key)
    }
  }, [lock, remote.api, unlock])

  useEffect(() => {
    if (remote.api !== undefined) void refreshStatus(false)
  }, [refreshStatus, remote.api])

  const runSelfTest = useCallback(async (): Promise<void> => {
    const api = remote.api
    const key = 'check'
    if (api === undefined || !lock(key)) return
    try {
      const input: SelfTestInput = { commandId: commandId() }
      const result = await api.check(input)
      if (!result.ok) {
        setNotice({ tone: 'error', message: `本地自检未得到可用回执：${remoteFailureMessage(result)}` })
        return
      }
      setSelfTest(result.value)
      setNotice({
        tone: result.value.status === 'passed' ? 'info' : 'error',
        message: result.value.status === 'passed'
          ? '本地自检已通过；该检查没有请求真实模型。'
          : '本地自检已返回未通过结果；该检查没有请求真实模型。',
      })
    } catch (error) {
      setNotice({ tone: 'error', message: `本地自检未完成：${errorMessage(error)}` })
    } finally {
      unlock(key)
    }
  }, [lock, remote.api, unlock])

  const updateRun = useCallback((run: RunSummary): void => {
    setStatus(current => current === undefined ? current : { ...current, runs: upsertRun(current.runs, run) })
  }, [])

  const inspectRun = useCallback(async (run: RunSummary): Promise<void> => {
    const api = remote.api
    const key = `inspect:${run.runId}`
    if (api === undefined || !lock(key)) return
    try {
      const result = await api.inspect({ runId: run.runId })
      if (!result.ok) {
        setNotice({ tone: 'error', message: `无法读取“${runLabel(run)}”的状态：${remoteFailureMessage(result)}` })
        return
      }
      updateRun(result.value)
      setBlockedCancelRunIds(current => {
        if (!current.has(result.value.runId)) return current
        const next = new Set(current)
        next.delete(result.value.runId)
        return next
      })
      setNotice({ tone: 'info', message: `已读取“${runLabel(result.value)}”的当前状态。` })
    } catch (error) {
      setNotice({ tone: 'error', message: `无法读取“${runLabel(run)}”的状态：${errorMessage(error)}` })
    } finally {
      unlock(key)
    }
  }, [lock, remote.api, unlock, updateRun])

  const cancelRun = useCallback(async (run: RunSummary): Promise<void> => {
    const api = remote.api
    const key = `cancel:${run.runId}`
    if (api === undefined || !canRequestCancel(run) || blockedCancelRunIds.has(run.runId) || !lock(key)) return
    try {
      const result = await api.cancel({ runId: run.runId })
      if (!result.ok) {
        setBlockedCancelRunIds(current => new Set(current).add(run.runId))
        setNotice({ tone: 'error', message: `无法请求取消“${runLabel(run)}”：${remoteFailureMessage(result)}` })
        return
      }
      updateRun(result.value)
      setBlockedCancelRunIds(current => new Set(current).add(result.value.runId))
      setNotice({ tone: 'info', message: `已提交“${runLabel(result.value)}”的取消请求；最终状态仍需读取确认。` })
    } catch (error) {
      setBlockedCancelRunIds(current => new Set(current).add(run.runId))
      setNotice({ tone: 'error', message: `无法请求取消“${runLabel(run)}”：${errorMessage(error)}` })
    } finally {
      unlock(key)
    }
  }, [blockedCancelRunIds, lock, remote.api, unlock, updateRun])

  const report = selfTest ?? status?.selftest
  return createElement('main', { style: panelStyle }, [
    createElement('header', { key: 'header', style: { display: 'grid', gap: 6, minWidth: 0 } }, [
      createElement('h1', { key: 'title', style: { margin: 0, fontSize: '1.25rem' } }, 'Prime RLM'),
      createElement('p', { key: 'summary', style: mutedStyle }, '这里显示 Prime RLM 运行时和任务状态。真实任务由会话中的 solar_rlm_run 工具启动；本页面不会自动自检、轮询或请求模型。'),
    ]),
    remote.error === undefined
      ? null
      : createElement('p', { key: 'mount-error', role: 'alert', style: { ...sectionStyle, color: 'var(--dsw-alias-state-error-primary)' } }, `无法连接 Prime RLM 控制通道：${remote.error}`),
    notice === undefined
      ? null
      : createElement('p', {
        key: 'notice',
        role: notice.tone === 'error' ? 'alert' : 'status',
        style: { ...sectionStyle, color: notice.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'inherit' },
      }, notice.message),
    createElement('section', { key: 'runtime', style: sectionStyle }, [
      createElement('div', { key: 'heading', style: { display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap' } }, [
        createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '运行时状态'),
        createElement('button', {
          key: 'refresh',
          type: 'button',
          disabled: remote.api === undefined || loadingStatus || pending.has('status'),
          onClick: () => { void refreshStatus(true) },
          style: buttonStyle,
        }, loadingStatus ? '正在读取…' : '读取运行时状态'),
      ]),
      createElement('p', { key: 'runtime-message', style: mutedStyle }, runtimeMessage(status)),
      status === undefined
        ? null
        : createElement('details', { key: 'version', style: { minWidth: 0 } }, [
          createElement('summary', { key: 'summary', style: { cursor: 'pointer' } }, '查看原始机制版本'),
          createElement('p', { key: 'commit', style: mutedStyle }, `Prime 机制版本记录：${status.runtime.primeCommit.trim() || '未提供'}`),
        ]),
    ]),
    createElement('section', { key: 'selftest', style: sectionStyle }, [
      createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '本地自检'),
      createElement('p', { key: 'copy', style: mutedStyle }, '只有点击下方按钮才会运行一次使用本地脚本替身的自检；页面加载和状态读取不会触发自检。'),
      createElement('div', { key: 'actions', style: actionRowStyle }, [
        createElement('button', {
          key: 'check',
          type: 'button',
          disabled: remote.api === undefined || pending.has('check'),
          onClick: () => { void runSelfTest() },
          style: buttonStyle,
        }, pending.has('check') ? '本地自检正在运行…' : '运行本地自检（不请求真实模型）'),
      ]),
      report === undefined
        ? createElement('p', { key: 'empty', style: mutedStyle }, '尚未运行本地自检。')
        : createElement('div', { key: 'report', style: { display: 'grid', gap: 6, minWidth: 0 } }, [
          createElement('strong', { key: 'status' }, reportStatusLabel(report)),
          createElement('p', { key: 'requests', style: mutedStyle }, `真实提供方请求：${report.modelRequests} 次；本地脚本响应：${report.localModelRequests ?? 0} 次。`),
          ...report.checks.map((check, index) => createElement('p', { key: `${index}:${check.id}`, style: mutedStyle }, `检查项 ${index + 1}：${check.passed ? '通过' : '未通过'}。${checkDetail(check.detail)}`)),
        ]),
    ]),
    createElement('section', { key: 'runs', style: { display: 'grid', gap: 10, minWidth: 0 } }, [
      createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '任务状态'),
      status?.runs.length === 0 || status === undefined
        ? createElement('p', { key: 'empty', style: mutedStyle }, status === undefined ? '尚未读取任务列表。' : '当前没有已记录的 Prime RLM 任务。')
        : createElement('div', { key: 'list', style: { display: 'grid', gap: 10, minWidth: 0 } }, status.runs.map(run => createElement(RunCard, {
          key: run.runId,
          run,
          pending,
          blockedCancelRunIds,
          onInspect: inspectRun,
          onCancel: cancelRun,
        }))),
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
      const api = ctx.get('remote.solarRlmControl') as unknown as RlmControlRemote | undefined
      if (api === undefined) {
        await disposer()
        remoteStore.setError('本机没有提供 Prime RLM 控制服务。')
        return
      }
      disposeRemote = disposer
      remoteStore.setApi(api)
    }).catch((error: unknown) => {
      if (!disposed) remoteStore.setError(errorMessage(error))
    })
    return () => {
      disposed = true
      remoteStore.clear()
      if (disposeRemote !== undefined) void disposeRemote()
    }
  }, 'solar-rlm: remote')

  const View = (): ReactElement => createElement(RlmPanel, { remoteStore })
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'solar-rlm',
    order: 45,
    label: () => 'Prime RLM',
  }, View))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'solar-rlm',
    order: 45,
    label: () => 'Prime RLM',
  }, View))
}
