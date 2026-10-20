import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type FormEvent,
  type ReactElement,
} from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createWebUiApi, type WebUiWire } from './client-remote.js'
import { createWebModelCatalogApi, type WebModelCatalogWire } from './model-catalog-remote.js'
import type { WebModelCatalogApi } from './model-catalog.js'
import { RPC_REMOTE } from './remote.js'
import { PreferencesPanel, createPreferencesApi, type PreferencesClientApi, type PreferencesWire } from './preferences-client.js'
import {
  WEB_STAGE_LABELS,
  type ChatGptWebControlApi,
  type WebUiStatus,
} from './ui-contract.js'
import type { WebRunRecord, WebRunRequest, WebRunStage } from './store.js'

export const name = 'chatgpt-web'
export const inject = ['slots', 'remote', 'connection']

interface RemoteAccessSnapshot {
  readonly preferences?: PreferencesClientApi
  readonly modelCatalog?: WebModelCatalogApi
  readonly api: ChatGptWebControlApi | undefined
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

  setApi(api: ChatGptWebControlApi, preferences: PreferencesClientApi, modelCatalog?: WebModelCatalogApi): void {
    this.snapshot = { api, preferences, modelCatalog, error: undefined }
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

const fieldStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
  minWidth: 0,
}

const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  padding: '8px 10px',
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'inherit',
  font: 'inherit',
}

const actionRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'center',
  minWidth: 0,
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
  minWidth: 0,
  padding: 10,
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-module-platform)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

function useRemoteAccess(store: RemoteAccessStore): RemoteAccessSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error)
  const cleaned = value.trim()
    .replace(/^[A-Z][A-Z0-9_/-]+:\s*/, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '该任务')
  return cleaned || '本机控制通道没有返回可用说明。'
}

function commandId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('当前界面无法生成一次性请求标识。')
  }
  return globalThis.crypto.randomUUID()
}

function runLabel(record: WebRunRecord): string {
  const firstLine = record.request.prompt.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (firstLine.length === 0) return '未命名网页任务'
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine
}

function stageHint(stage: WebRunStage): string {
  switch (stage) {
    case 'submission-unknown':
    case 'submitted':
    case 'indeterminate':
      return '结果可能仍在网页端。请先读取该任务状态，不要重复提交。'
    case 'cancelled':
      return '本机已请求停止；这不保证网页端已经停止，请继续读取状态。'
    case 'blocked':
      return '该任务需要人工处理。界面不会自动重试或创建替代任务。'
    case 'failed':
      return '任务没有完成。若提交结果曾经不确定，请先读取状态再决定后续动作。'
    default:
      return ''
  }
}

function canCancel(stage: WebRunStage): boolean {
  return stage === 'prepared'
    || stage === 'ready'
    || stage === 'submission-unknown'
    || stage === 'submitted'
    || stage === 'indeterminate'
}

function isChatGptUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'chatgpt.com'
      || host.endsWith('.chatgpt.com')
      || host === 'chat.openai.com'
      || host.endsWith('.chat.openai.com')
  } catch {
    return false
  }
}

function safeConversationUrl(value: string | undefined): string | undefined {
  if (value === undefined || !isChatGptUrl(value)) return undefined
  return value
}

function upsertRun(runs: readonly WebRunRecord[], record: WebRunRecord): readonly WebRunRecord[] {
  const index = runs.findIndex(item => item.id === record.id)
  if (index < 0) return [...runs, record]
  const next = [...runs]
  next[index] = record
  return next
}

function mergeObservedStatus(status: WebUiStatus | undefined, record: WebRunRecord): WebUiStatus {
  if (status === undefined) {
    return { runs: [record], activeIds: canCancel(record.stage) ? [record.id] : [], errors: [] }
  }
  const activeIds = canCancel(record.stage)
    ? Array.from(new Set([...status.activeIds, record.id]))
    : status.activeIds.filter(id => id !== record.id)
  return {
    ...status,
    runs: upsertRun(status.runs, record),
    activeIds,
    errors: status.errors.filter(error => error.id !== record.id),
  }
}

interface WebRunCardProps {
  readonly record: WebRunRecord
  readonly pending: boolean
  readonly onObserve: (record: WebRunRecord) => void
  readonly onCancel: (record: WebRunRecord) => void
}

function WebRunCard({ record, pending, onObserve, onCancel }: WebRunCardProps): ReactElement {
  const conversationUrl = safeConversationUrl(record.resource?.conversationUrl)
  const hint = stageHint(record.stage)
  return createElement('article', { style: sectionStyle }, [
    createElement('div', { key: 'heading', style: { display: 'grid', gap: 4, minWidth: 0 } }, [
      createElement('strong', { key: 'label', style: { overflowWrap: 'anywhere' } }, runLabel(record)),
      createElement('span', { key: 'stage', style: mutedStyle }, WEB_STAGE_LABELS[record.stage]),
    ]),
    hint.length === 0 ? null : createElement('p', { key: 'hint', style: mutedStyle }, hint),
    createElement('div', { key: 'models', style: { display: 'grid', gap: 4, minWidth: 0 } }, [
      createElement('div', { key: 'request-model', style: mutedStyle }, `请求模型档位：${record.request.modelLabel?.trim() || '网页当前选择'}`),
      createElement('div', { key: 'request-effort', style: mutedStyle }, `请求推理强度：${record.request.effortLabel?.trim() || '网页当前选择'}`),
      createElement('div', { key: 'observed-model', style: mutedStyle }, `提交前确认的模型：${record.observed?.modelLabel?.trim() || '尚未观测到'}`),
      createElement('div', { key: 'observed-effort', style: mutedStyle }, `提交前确认的推理强度：${record.observed?.effortLabel?.trim() || '尚未观测到'}`),
    ]),
    record.resource?.pageLabel === undefined
      ? null
      : createElement('p', { key: 'resource', style: mutedStyle }, `网页任务空间：${record.resource.pageLabel}`),
    conversationUrl === undefined
      ? null
      : createElement('p', { key: 'conversation', style: { ...mutedStyle, minWidth: 0 } }, [
        createElement('a', {
          key: 'link',
          href: conversationUrl,
          target: '_blank',
          rel: 'noreferrer',
          style: { overflowWrap: 'anywhere' },
        }, '打开原始 ChatGPT 会话'),
      ]),
    record.error === undefined
      ? null
      : createElement('div', { key: 'error', role: 'alert', style: { display: 'grid', gap: 4, minWidth: 0, color: 'var(--dsw-alias-state-error-primary)' } }, [
        createElement('strong', { key: 'label' }, '任务说明'),
        createElement('p', { key: 'message', style: { ...mutedStyle, color: 'inherit' } }, errorText(record.error.message)),
      ]),
    record.output === undefined
      ? null
      : createElement('div', { key: 'output', style: { display: 'grid', gap: 6, minWidth: 0 } }, [
        createElement('strong', { key: 'label' }, '完整回答'),
        createElement('pre', { key: 'text', style: preStyle }, record.output.text),
        record.output.markdown === record.output.text
          ? null
          : createElement('details', { key: 'markdown', style: { minWidth: 0 } }, [
            createElement('summary', { key: 'summary', style: { cursor: 'pointer', overflowWrap: 'anywhere' } }, '查看 Markdown 原文'),
            createElement('pre', { key: 'value', style: preStyle }, record.output.markdown),
          ]),
      ]),
    createElement('div', { key: 'actions', style: actionRowStyle }, [
      createElement('button', {
        key: 'observe',
        type: 'button',
        disabled: pending,
        onClick: () => onObserve(record),
        style: buttonStyle,
      }, pending ? '正在读取状态…' : '读取最新状态'),
      createElement('button', {
        key: 'cancel',
        type: 'button',
        disabled: pending || !canCancel(record.stage),
        onClick: () => onCancel(record),
        style: buttonStyle,
      }, pending ? '正在处理…' : '请求本机停止'),
    ]),
  ])
}

interface PendingSubmissionProps {
  readonly pending: boolean
  readonly onObserve: () => void
}

function PendingSubmission({ pending, onObserve }: PendingSubmissionProps): ReactElement {
  return createElement('article', { style: sectionStyle }, [
    createElement('strong', { key: 'label' }, '上一次网页提交'),
    createElement('p', { key: 'copy', style: mutedStyle }, '提交结果未确认。请读取该任务状态，不要再次提交相同请求。'),
    createElement('div', { key: 'actions', style: actionRowStyle }, [
      createElement('button', {
        key: 'observe',
        type: 'button',
        disabled: pending,
        onClick: onObserve,
        style: buttonStyle,
      }, pending ? '正在读取状态…' : '读取该任务状态'),
    ]),
  ])
}

function ChatGptWebPanel({ remoteStore }: { readonly remoteStore: RemoteAccessStore }): ReactElement {
  const fieldId = useId()
  const remote = useRemoteAccess(remoteStore)
  const [status, setStatus] = useState<WebUiStatus | undefined>()
  const [notice, setNotice] = useState<Notice | undefined>()
  const [prompt, setPrompt] = useState('')
  const [modelLabel, setModelLabel] = useState('')
  const [effortLabel, setEffortLabel] = useState('')
  const [launching, setLaunching] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set())
  const [pendingActions, setPendingActions] = useState<ReadonlySet<string>>(() => new Set())
  const refreshLock = useRef(false)
  const actionLocks = useRef(new Set<string>())
  const runs = status?.runs ?? []
  const hasOpenRun = runs.some(run => canCancel(run.stage))
  const hasUnresolvedError = (status?.errors ?? []).some(error => {
    const record = runs.find(run => run.id === error.id)
    return record === undefined || canCancel(record.stage)
  })

  const addPendingId = useCallback((id: string): void => {
    setPendingIds(current => {
      const next = new Set(current)
      next.add(id)
      return next
    })
  }, [])

  const removePendingId = useCallback((id: string): void => {
    setPendingIds(current => {
      if (!current.has(id)) return current
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }, [])

  const setActionPending = useCallback((id: string, pending: boolean): void => {
    setPendingActions(current => {
      const next = new Set(current)
      if (pending) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const refresh = useCallback(async (announce: boolean): Promise<void> => {
    const api = remote.api
    if (api === undefined || refreshLock.current) return
    refreshLock.current = true
    setRefreshing(true)
    try {
      const next = await api.status()
      setStatus(next)
      const observedIds = new Set(next.runs.map(run => run.id))
      setPendingIds(current => {
        const remaining = [...current].filter(id => !observedIds.has(id))
        return remaining.length === current.size ? current : new Set(remaining)
      })
      if (announce) setNotice({ tone: 'info', message: '已读取网页任务状态；此操作没有提交模型请求。' })
    } catch (error) {
      setNotice({ tone: 'error', message: `无法读取网页任务状态：${errorText(error)}` })
    } finally {
      refreshLock.current = false
      setRefreshing(false)
    }
  }, [remote.api])

  useEffect(() => {
    if (remote.api !== undefined) void refresh(false)
  }, [refresh, remote.api])

  const activeKey = useMemo(() => status?.activeIds.join('\u001f') ?? '', [status?.activeIds])
  useEffect(() => {
    if (remote.api === undefined || activeKey.length === 0) return
    const timer = setInterval(() => { void refresh(false) }, 1_500)
    return () => clearInterval(timer)
  }, [activeKey, refresh, remote.api])

  const launch = useCallback(async (): Promise<void> => {
    const api = remote.api
    if (api === undefined || status === undefined || launching || refreshing || actionLocks.current.has('launch') || status.activeIds.length !== 0 || pendingIds.size !== 0 || hasOpenRun || hasUnresolvedError) return
    if (prompt.trim().length === 0) {
      setNotice({ tone: 'error', message: '请输入要提交给 ChatGPT 网页的文本。' })
      return
    }
    let id: string
    try {
      id = commandId()
    } catch (error) {
      setNotice({ tone: 'error', message: errorText(error) })
      return
    }
    const request: WebRunRequest = {
      prompt,
      ...(modelLabel.trim().length === 0 ? {} : { modelLabel: modelLabel.trim() }),
      ...(effortLabel.trim().length === 0 ? {} : { effortLabel: effortLabel.trim() }),
    }
    // Use one stable lock key: two click events can arrive before React has
    // rendered the `launching` state, so a per-UUID key would not prevent a
    // duplicate submission in that small window.
    if (actionLocks.current.has('launch')) return
    actionLocks.current.add('launch')
    addPendingId(id)
    setLaunching(true)
    try {
      const result = await api.launch({ id, request })
      if (result.id !== id) throw new Error('网页任务返回了不一致的请求标识。')
      setNotice({ tone: 'info', message: '已提交 ChatGPT 网页任务，正在读取状态。请勿重复提交。' })
      await refresh(false)
    } catch (error) {
      setNotice({ tone: 'error', message: `网页任务提交结果未确认：${errorText(error)}。请读取该任务状态，不要重复提交。` })
    } finally {
      setLaunching(false)
      actionLocks.current.delete('launch')
    }
  }, [addPendingId, effortLabel, hasOpenRun, hasUnresolvedError, launching, modelLabel, pendingIds.size, prompt, refreshing, refresh, remote.api, status?.activeIds.length])

  const observe = useCallback(async (recordId: string, label: string): Promise<void> => {
    const api = remote.api
    const lockKey = `observe:${recordId}`
    if (api === undefined || actionLocks.current.has(lockKey)) return
    actionLocks.current.add(lockKey)
    setActionPending(recordId, true)
    try {
      const record = await api.observe({ id: recordId })
      setStatus(current => mergeObservedStatus(current, record))
      removePendingId(recordId)
      setNotice({ tone: 'info', message: `已读取“${label}”的当前状态；此操作没有重新提交。` })
    } catch (error) {
      setNotice({ tone: 'error', message: `无法读取“${label}”的状态：${errorText(error)}` })
    } finally {
      setActionPending(recordId, false)
      actionLocks.current.delete(lockKey)
    }
  }, [removePendingId, remote.api, setActionPending])

  const cancel = useCallback(async (record: WebRunRecord): Promise<void> => {
    const api = remote.api
    const lockKey = `cancel:${record.id}`
    if (api === undefined || actionLocks.current.has(lockKey) || !canCancel(record.stage)) return
    actionLocks.current.add(lockKey)
    setActionPending(record.id, true)
    try {
      const observed = await api.cancel({ id: record.id })
      setStatus(current => mergeObservedStatus(current, observed))
      removePendingId(record.id)
      setNotice({ tone: 'info', message: `已请求本机等待“${runLabel(record)}”停止。网页端是否已停止仍需读取状态确认。` })
    } catch (error) {
      setNotice({ tone: 'error', message: `停止“${runLabel(record)}”的请求未确认：${errorText(error)}。请读取状态，不要重复提交。` })
    } finally {
      setActionPending(record.id, false)
      actionLocks.current.delete(lockKey)
    }
  }, [removePendingId, remote.api, setActionPending])

  const onSubmit = useCallback((event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void launch()
  }, [launch])

  const pendingUnknownIds = [...pendingIds].filter(id => !runs.some(run => run.id === id))
  const statusErrors = status?.errors ?? []
  const canLaunch = remote.api !== undefined
    && status !== undefined
    && !launching
    && !refreshing
    && pendingIds.size === 0
    && status.activeIds.length === 0
    && !hasOpenRun
    && !hasUnresolvedError
  return createElement('main', { style: panelStyle }, [
    createElement('header', { key: 'header', style: { display: 'grid', gap: 6, minWidth: 0 } }, [
      createElement('h1', { key: 'title', style: { margin: 0, fontSize: '1.25rem', overflowWrap: 'anywhere' } }, 'ChatGPT 网页算子'),
      createElement('p', { key: 'summary', style: mutedStyle }, '本面板将文本提交到已登录的 ChatGPT 网页。加载和刷新面板不会调用模型；点击提交按钮会使用 ChatGPT 订阅额度。'),
    ]),
    remote.error === undefined
      ? null
      : createElement('p', { key: 'mount-error', role: 'alert', style: { ...sectionStyle, color: 'var(--dsw-alias-state-error-primary)' } }, `无法连接 ChatGPT 网页控制通道：${remote.error}`),
    notice === undefined
      ? null
      : createElement('p', {
        key: 'notice',
        role: notice.tone === 'error' ? 'alert' : 'status',
        style: { ...sectionStyle, color: notice.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'inherit' },
      }, notice.message),
    createElement('section', { key: 'form', style: sectionStyle }, [
      createElement('div', { key: 'form-heading', style: { display: 'grid', gap: 4, minWidth: 0 } }, [
        createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '提交网页任务'),
        createElement('p', { key: 'description', style: mutedStyle }, '填写后会在提交前选择并核对对应档位。留空使用插件默认；未配置默认时沿用网页选择。实际档位以任务观察结果为准。'),
      ]),
      createElement('form', { key: 'fields', onSubmit }, [
        createElement('div', { key: 'prompt', style: fieldStyle }, [
          createElement('label', { key: 'label', htmlFor: `${fieldId}-prompt` }, '请求文本'),
          createElement('textarea', {
            key: 'input',
            id: `${fieldId}-prompt`,
            value: prompt,
            onChange: (event: { target: { value: string } }) => setPrompt(event.target.value),
            rows: 7,
            spellCheck: false,
            style: { ...inputStyle, resize: 'vertical' },
          }),
        ]),
        createElement('div', { key: 'model', style: fieldStyle }, [
          createElement('label', { key: 'label', htmlFor: `${fieldId}-model` }, '模型档位（可选）'),
          createElement('input', {
            key: 'input',
            id: `${fieldId}-model`,
            value: modelLabel,
            onChange: (event: { target: { value: string } }) => setModelLabel(event.target.value),
            placeholder: '留空使用插件默认；未配置默认时沿用网页选择',
            style: inputStyle,
          }),
        ]),
        createElement('div', { key: 'effort', style: fieldStyle }, [
          createElement('label', { key: 'label', htmlFor: `${fieldId}-effort` }, '推理强度标识（可选）'),
          createElement('input', {
            key: 'input',
            id: `${fieldId}-effort`,
            value: effortLabel,
            onChange: (event: { target: { value: string } }) => setEffortLabel(event.target.value),
            placeholder: '留空使用插件默认；未配置默认时沿用网页选择',
            style: inputStyle,
          }),
        ]),
        createElement('div', { key: 'actions', style: actionRowStyle }, [
          createElement('button', {
            key: 'submit',
            type: 'submit',
            disabled: !canLaunch,
            style: buttonStyle,
          }, launching ? '正在提交 ChatGPT 网页任务…' : '提交到 ChatGPT（使用订阅额度）'),
        ]),
      ]),
    ]),
    createElement('section', { key: 'status', style: sectionStyle }, [
      createElement('div', { key: 'heading', style: { display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 } }, [
        createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '网页任务状态'),
        createElement('button', {
          key: 'refresh',
          type: 'button',
          disabled: remote.api === undefined || refreshing,
          onClick: () => { void refresh(true) },
          style: buttonStyle,
        }, refreshing ? '正在读取…' : '刷新状态'),
      ]),
      status === undefined
        ? createElement('p', { key: 'loading', style: mutedStyle }, remote.api === undefined ? '正在连接网页控制通道…' : '正在读取网页任务状态…')
        : createElement('p', { key: 'summary', style: mutedStyle }, status.activeIds.length === 0
          ? `已读取 ${runs.length} 条任务记录；当前没有正在等待网页状态的任务。`
          : `已读取 ${runs.length} 条任务记录；当前有 ${status.activeIds.length} 个任务正在等待网页状态。`),
    ]),
    pendingUnknownIds.length === 0
      ? null
      : createElement('section', { key: 'pending', style: sectionStyle }, [
        createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '待确认的网页提交'),
        createElement('p', { key: 'copy', style: mutedStyle }, '上一次提交没有得到完整回执。请读取原任务状态，界面不会自动重发。'),
        ...pendingUnknownIds.map(id => createElement(PendingSubmission, {
          key: id,
          pending: pendingActions.has(id),
          onObserve: () => { void observe(id, '上一次网页提交') },
        })),
      ]),
    statusErrors.length === 0
      ? null
      : createElement('section', { key: 'errors', style: sectionStyle }, [
        createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '需要确认的状态'),
        createElement('p', { key: 'copy', style: mutedStyle }, '这些状态包含本机控制通道返回的错误说明。请读取对应任务，不要因为错误提示而重复提交。'),
        ...statusErrors.map(item => {
          const record = runs.find(run => run.id === item.id)
          const label = record === undefined ? '网页任务' : runLabel(record)
          return createElement('article', { key: item.id, style: { display: 'grid', gap: 6, minWidth: 0 } }, [
            createElement('strong', { key: 'label', style: { overflowWrap: 'anywhere' } }, label),
            createElement('p', { key: 'message', role: 'alert', style: { ...mutedStyle, color: 'var(--dsw-alias-state-error-primary)' } }, errorText(item.message)),
            createElement('div', { key: 'actions', style: actionRowStyle }, [
              createElement('button', {
                key: 'observe',
                type: 'button',
                disabled: pendingActions.has(item.id),
                onClick: () => { void observe(item.id, label) },
                style: buttonStyle,
              }, pendingActions.has(item.id) ? '正在读取状态…' : '读取该任务状态'),
            ]),
          ])
        }),
      ]),
    createElement('section', { key: 'runs', style: { display: 'grid', gap: 10, minWidth: 0 } }, [
      createElement('h2', { key: 'title', style: { margin: 0, fontSize: '1rem' } }, '任务记录'),
      runs.length === 0
        ? createElement('p', { key: 'empty', style: mutedStyle }, '尚未观察到网页任务记录。')
        : createElement('div', { key: 'list', style: { display: 'grid', gap: 10, minWidth: 0 } }, runs.map(record => createElement(WebRunCard, {
          key: record.id,
          record,
          pending: pendingActions.has(record.id),
          onObserve: item => { void observe(item.id, runLabel(item)) },
          onCancel: item => { void cancel(item) },
        }))),
    ]),
  ])
}

/** Mount the owner-only Remote namespace, then expose the same view in both official slots. */
export function apply(ctx: Context): void {
  const remoteStore = new RemoteAccessStore()
  let disposed = false
  let disposeRemote: (() => Promise<void>) | undefined

  ctx.effect(() => {
    void ctx.remote.$mount(RPC_REMOTE).then(async disposer => {
      if (disposed) {
        await disposer()
        return
      }
      const wire = ctx.get('remote.solarChatGptWebControl') as unknown as WebUiWire | undefined
      if (wire === undefined) {
        await disposer()
        remoteStore.setError('本机没有提供 ChatGPT 网页控制服务。')
        return
      }
      disposeRemote = disposer
      const preferencesWire = ctx.get('remote.solarWebPreferences') as unknown as PreferencesWire | undefined
      if (!preferencesWire) { await disposer(); remoteStore.setError('本机没有提供网页与洞察设置服务。'); return }
      const catalogWire = ctx.get('remote.solarWebModelCatalog') as unknown as WebModelCatalogWire | undefined
      const modelCatalog = catalogWire !== undefined
        && typeof catalogWire.read === 'function'
        && typeof catalogWire.refresh === 'function'
        ? createWebModelCatalogApi(catalogWire)
        : undefined
      remoteStore.setApi(createWebUiApi(wire), createPreferencesApi(preferencesWire), modelCatalog)
    }).catch((error: unknown) => {
      if (!disposed) remoteStore.setError(errorText(error))
    })
    return () => {
      disposed = true
      remoteStore.clear()
      if (disposeRemote !== undefined) void disposeRemote()
    }
  }, 'chatgpt-web: remote')

  const Settings = (): ReactElement => {
    const remote = useRemoteAccess(remoteStore)
    return createElement('main', {}, [
      createElement(PreferencesPanel, { key: 'preferences', api: remote.preferences, modelCatalog: remote.modelCatalog }),
      createElement('details', { key: 'diagnostics' }, [
        createElement('summary', { key: 'title' }, '网页连接诊断与历史记录'),
        createElement(ChatGptWebPanel, { key: 'panel', remoteStore }),
      ]),
    ])
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'solar-chatgpt-web', order: 46, label: () => '网页与洞察' }, Settings))
}
