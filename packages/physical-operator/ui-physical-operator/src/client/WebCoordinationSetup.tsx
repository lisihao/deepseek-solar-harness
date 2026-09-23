import { useEffect, useRef, useState } from 'react'
import type { BrowserRequest } from './ResidentOperatorsPanel.tsx'
import {
  WebModelControls,
  parseWebModelStatus,
  type WebModelCatalog,
  type WebModelPreferences,
} from './WebModelControls.tsx'

/** Same-origin setup route owned by the ChatGPT Web physical-operator provider. */
export const CHATGPT_WEB_SETUP_PATH = '/api/chatgpt-web'

/** Local ChatGPT Web execution mode selected by the owner. */
export type WebCoordinationMode = 'direct' | 'coordinator'

/** Public ChatGPT Web coordination status returned by the authenticated Host. */
export interface WebCoordinationStatus {
  readonly mode: WebCoordinationMode
  readonly active: boolean
  readonly connectorName: string
  readonly lastVerifiedAt?: string
}

/** Props for the owner-local ChatGPT Web coordination setup panel. */
export interface WebCoordinationSetupProps {
  /** Authenticated same-origin request from the shared browser Connection seam. */
  readonly request: BrowserRequest
  /** Whether the routing dialog is currently open. */
  readonly open: boolean
  /** Whether the selected primary model is ChatGPT Web. */
  readonly selected: boolean
  /** Current DSH Session id used to read and persist session-scoped Web preferences. */
  readonly sessionId?: string | undefined
  /** Session/input lock inherited from the routing dialog. */
  readonly locked: boolean
  /** Hides the setup controls on the advanced routing page without stopping status refresh. */
  readonly hidden?: boolean
  /** Re-read cached status after the parent completes an explicit catalog refresh. */
  readonly refreshVersion?: number
  /** Reports a verified status so the parent can gate downstream controls. */
  readonly onStatusChange: (status: WebCoordinationStatus | undefined) => void
}

type PanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | {
    readonly kind: 'ready'
    readonly status: WebCoordinationStatus
    readonly profile?: WebModelPreferences
    readonly catalog?: WebModelCatalog
  }
  | { readonly kind: 'unavailable'; readonly message: string }

interface SetupResponse extends WebCoordinationStatus {
  readonly mcpUrl: string
}

/** Render owner-local ChatGPT Web mode and the explicit Custom MCP setup action. */
export function WebCoordinationSetup({
  request,
  open,
  selected,
  sessionId,
  locked,
  hidden = false,
  refreshVersion = 0,
  onStatusChange,
}: WebCoordinationSetupProps) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' })
  const [endpoint, setEndpoint] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const callback = useRef(onStatusChange)
  callback.current = onStatusChange

  useEffect(() => {
    if (!open || !selected) {
      callback.current(undefined)
      setState({ kind: 'idle' })
      setEndpoint(undefined)
      setError(undefined)
      setCopied(false)
      return
    }

    const controller = new AbortController()
    let active = true
    setState({ kind: 'loading' })
    setEndpoint(undefined)
    setError(undefined)
    setCopied(false)
    const load = async (): Promise<void> => {
      try {
        const url = new URL(CHATGPT_WEB_SETUP_PATH, window.location.origin)
        addSessionId(url, sessionId)
        const response = await request(url, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const value = await readJson(response)
        const status = parseStatus(value)
        const modelFields = parseWebModelStatus(value)
        if (!active || controller.signal.aborted) return
        if (status === undefined || modelFields === undefined) throw new Error('ChatGPT Web 协作状态无效')
        setState({ kind: 'ready', status, ...modelFields })
        callback.current(status)
      } catch (reason: unknown) {
        if (!active || controller.signal.aborted) return
        const message = webSetupError(reason)
        setState({ kind: 'unavailable', message })
        callback.current(undefined)
      }
    }
    void load()
    return () => {
      active = false
      controller.abort()
      callback.current(undefined)
    }
  }, [open, request, selected, sessionId, refreshVersion])

  const status = state.kind === 'ready' ? state.status : undefined
  const modelProfile = state.kind === 'ready' ? state.profile : undefined
  const modelCatalog = state.kind === 'ready' ? state.catalog : undefined
  const onModelChange = (profile: WebModelPreferences, catalog?: WebModelCatalog): void => {
    setState(current => current.kind === 'ready'
      ? {
        ...current,
        profile,
        ...catalog === undefined ? {} : { catalog },
      }
      : current)
    if (status !== undefined) onStatusChange(status)
  }
  const selectMode = async (mode: WebCoordinationMode): Promise<void> => {
    if (locked || saving || status === undefined || status.active || status.mode === mode) return
    setSaving(true)
    setError(undefined)
    try {
      const url = new URL(CHATGPT_WEB_SETUP_PATH, window.location.origin)
      addSessionId(url, sessionId)
      url.searchParams.set('mode', mode)
      const response = await request(url, { method: 'POST', cache: 'no-store' })
      const value = await readJson(response)
      const next = parseStatus(value)
      if (next === undefined) throw new Error('ChatGPT Web 协作状态无效')
      setState(current => current.kind === 'ready'
        ? { ...current, status: next }
        : { kind: 'ready', status: next })
      callback.current(next)
    } catch (reason: unknown) {
      setError(webSetupError(reason))
    } finally {
      setSaving(false)
    }
  }

  const revealEndpoint = async (): Promise<void> => {
    if (locked || saving || status === undefined) return
    setSaving(true)
    setError(undefined)
    setEndpoint(undefined)
    setCopied(false)
    try {
      const url = new URL(CHATGPT_WEB_SETUP_PATH, window.location.origin)
      addSessionId(url, sessionId)
      url.searchParams.set('setup', '1')
      const response = await request(url, { cache: 'no-store' })
      const value = await readJson(response)
      const next = parseSetupResponse(value)
      if (next === undefined) throw new Error('ChatGPT Web 连接设置无效')
      setEndpoint(next.mcpUrl)
      setState(current => current.kind === 'ready'
        ? { ...current, status: next }
        : { kind: 'ready', status: next })
      callback.current(next)
    } catch (reason: unknown) {
      setError(webSetupError(reason))
    } finally {
      setSaving(false)
    }
  }

  const copyEndpoint = async (): Promise<void> => {
    const clipboard = 'clipboard' in navigator ? navigator.clipboard : undefined
    if (endpoint === undefined || clipboard?.writeText === undefined) {
      setError('当前浏览器不支持复制连接地址，请手动复制。')
      return
    }
    try {
      await clipboard.writeText(endpoint)
      setCopied(true)
      setError(undefined)
    } catch (reason: unknown) {
      setError(webSetupError(reason))
    }
  }

  return (
    <section className="dshDesktopOperatorProfilePreferences" hidden={hidden} role="group" aria-label="ChatGPT 网页版协作设置">
      <div>
        <strong>ChatGPT 网页版协作</strong>
        <small>工具协作需要在 ChatGPT 自定义连接器中配置 Custom MCP；连接地址只在你点击“连接设置”后显示。</small>
      </div>
      <div role="group" aria-label="ChatGPT 网页版协作模式">
        <button
          type="button"
          aria-pressed={status?.mode === 'direct'}
          disabled={locked || saving || status === undefined || status.active}
          onClick={() => { void selectMode('direct') }}
        >
          独立问答
        </button>
        <button
          type="button"
          aria-pressed={status?.mode === 'coordinator'}
          disabled={locked || saving || status === undefined || status.active}
          onClick={() => { void selectMode('coordinator') }}
        >
          工具协作
        </button>
      </div>
      {state.kind === 'loading' && <p>正在读取 ChatGPT Web 协作设置…</p>}
      {state.kind === 'unavailable' && <p role="status">{state.message} 请更新 Host 后重试。</p>}
      {status !== undefined && (
        <>
          <p>连接器：{status.connectorName}</p>
          <p>最近一次经过验证的 MCP 调用：{status.lastVerifiedAt ?? '尚未验证'}</p>
          {status.active && <p role="status">当前有进行中的 ChatGPT Web 请求，完成后才能切换协作模式。</p>}
          {sessionId !== undefined && (
            <WebModelControls
              sessionId={sessionId}
              request={request}
              {...modelCatalog === undefined ? {} : { catalog: modelCatalog }}
              {...modelProfile === undefined ? {} : { profile: modelProfile }}
              disabled={locked || status.active}
              onChange={onModelChange}
            />
          )}
          <button type="button" disabled={locked || saving} onClick={() => { void revealEndpoint() }}>
            连接设置
          </button>
          {endpoint !== undefined && (
            <div>
              <code>{endpoint}</code>
              <button type="button" disabled={locked} onClick={() => { void copyEndpoint() }}>
                {copied ? '已复制连接地址' : '复制连接地址'}
              </button>
            </div>
          )}
        </>
      )}
      {status?.mode === 'coordinator' && status.lastVerifiedAt === undefined && (
        <p>已选择工具协作，但尚未验证 Custom MCP 调用；完成一次连接器工具调用后才会记录验证时间。</p>
      )}
      {error !== undefined && <p role="status">{error}</p>}
    </section>
  )
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const body = await response.text()
    throw new WebSetupResponseError(response.status, body)
  }
  return await response.json() as unknown
}

function parseStatus(value: unknown): WebCoordinationStatus | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if ((record.mode !== 'direct' && record.mode !== 'coordinator')
    || typeof record.active !== 'boolean'
    || typeof record.connectorName !== 'string') return undefined
  return {
    mode: record.mode,
    active: record.active,
    connectorName: record.connectorName,
    ...typeof record.lastVerifiedAt === 'string' ? { lastVerifiedAt: record.lastVerifiedAt } : {},
  }
}

function parseSetupResponse(value: unknown): SetupResponse | undefined {
  const status = parseStatus(value)
  const mcpUrl = typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>).mcpUrl
    : undefined
  if (status === undefined || typeof mcpUrl !== 'string') return undefined
  return { ...status, mcpUrl }
}

function addSessionId(url: URL, sessionId: string | undefined): void {
  if (sessionId !== undefined) url.searchParams.set('session_id', sessionId)
}

class WebSetupResponseError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`ChatGPT Web 协作设置请求失败（${String(status)}）`)
  }
}

function webSetupError(reason: unknown): string {
  if (reason instanceof WebSetupResponseError) {
    if (reason.status === 404) return '当前 Host 未提供 ChatGPT Web 协作设置。'
    if (reason.status === 409) return '当前有进行中的 ChatGPT Web 请求，完成后才能切换协作模式。'
    return `${reason.message}${reason.body === '' ? '' : `：${reason.body}`}`
  }
  return reason instanceof Error ? reason.message : String(reason)
}
