import { useEffect, useRef, useState } from 'react'
import type { BrowserRequest } from './ResidentOperatorsPanel.tsx'

/** One exact model or reasoning option observed in the ChatGPT Web page. */
export interface WebModelChoice {
  readonly id: string
  readonly label: string
}

/** The account-visible ChatGPT Web controls captured by an explicit refresh. */
export interface WebModelCatalog {
  readonly models: readonly WebModelChoice[]
  readonly efforts: readonly WebModelChoice[]
  readonly selectedModel?: string
  readonly selectedEffort?: string
  readonly observedAt: string
}

/** Session-owned ChatGPT Web overrides. Omitted fields follow the website. */
export interface WebModelPreferences {
  readonly model?: string
  readonly effort?: string
}

/** Server acknowledgment for one explicit ChatGPT Web profile change. */
export interface WebModelProfileResponse {
  readonly profile: WebModelPreferences
  readonly catalog?: WebModelCatalog
}

/** Optional Web profile fields embedded in the owner status response. */
export interface WebModelStatusFields {
  readonly profile?: WebModelPreferences
  readonly catalog?: WebModelCatalog
}

/** Props for the session-scoped ChatGPT Web model and reasoning controls. */
export interface WebModelControlsProps {
  readonly sessionId: string
  readonly request: BrowserRequest
  readonly catalog?: WebModelCatalog
  readonly profile?: WebModelPreferences
  readonly disabled: boolean
  readonly onChange: (profile: WebModelPreferences, catalog?: WebModelCatalog) => void
}

/** Parse one unknown JSON value as an observed ChatGPT Web catalog. */
export function parseWebModelCatalog(value: unknown): WebModelCatalog | undefined {
  if (!isRecord(value)) return undefined
  const models = parseChoices(value.models)
  const efforts = parseChoices(value.efforts)
  const observedAt = value.observedAt
  if (models === undefined || efforts === undefined || typeof observedAt !== 'string' || observedAt.trim() === '') {
    return undefined
  }
  const selectedModel = optionalText(value, 'selectedModel')
  const selectedEffort = optionalText(value, 'selectedEffort')
  if (selectedModel === INVALID_TEXT || selectedEffort === INVALID_TEXT) return undefined
  return {
    models,
    efforts,
    observedAt,
    ...(selectedModel === undefined ? {} : { selectedModel }),
    ...(selectedEffort === undefined ? {} : { selectedEffort }),
  }
}

/** Parse one unknown JSON value as a session-owned Web preference object. */
export function parseWebModelPreferences(value: unknown): WebModelPreferences | undefined {
  if (!isRecord(value)) return undefined
  const model = optionalText(value, 'model')
  const effort = optionalText(value, 'effort')
  if (model === INVALID_TEXT || effort === INVALID_TEXT) return undefined
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
  }
}

/** Parse status fields that may include the current profile and refreshed catalog. */
export function parseWebModelStatus(value: unknown): WebModelStatusFields | undefined {
  if (!isRecord(value)) return undefined
  const profile = hasOwn(value, 'profile') ? parseWebModelPreferences(value.profile) : undefined
  const catalog = hasOwn(value, 'catalog') ? parseWebModelCatalog(value.catalog) : undefined
  if (hasOwn(value, 'profile') && profile === undefined) return undefined
  if (hasOwn(value, 'catalog') && catalog === undefined) return undefined
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(catalog === undefined ? {} : { catalog }),
  }
}

/** Parse the acknowledgment returned after one explicit profile POST. */
export function parseWebModelProfileResponse(value: unknown): WebModelProfileResponse | undefined {
  if (!isRecord(value)) return undefined
  const profile = parseWebModelPreferences(value.profile)
  if (profile === undefined) return undefined
  const catalog = hasOwn(value, 'catalog') ? parseWebModelCatalog(value.catalog) : undefined
  if (hasOwn(value, 'catalog') && catalog === undefined) return undefined
  return { profile, ...(catalog === undefined ? {} : { catalog }) }
}

/** Render website-default and account-observed model and reasoning choices. */
export function WebModelControls({
  sessionId,
  request,
  catalog,
  profile,
  disabled,
  onChange,
}: WebModelControlsProps) {
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string>()
  const alive = useRef(true)
  const busyRef = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const savedModel = profile?.model
  const savedEffort = profile?.effort
  const selectedModel = savedModel ?? catalog?.selectedModel
  const modelKnown = savedModel !== undefined && catalog?.models.some(choice => choice.id === savedModel)
  const effortKnown = savedEffort !== undefined && catalog?.efforts.some(choice => choice.id === savedEffort)
  const modelCatalogMismatch = savedModel !== undefined
    && catalog !== undefined
    && catalog.selectedModel !== savedModel
  const modelDisabled = disabled || busy || reading || catalog === undefined || catalog.models.length === 0
  const effortDisabled = disabled || busy || reading || catalog === undefined || catalog.efforts.length === 0
    || selectedModel === undefined || modelCatalogMismatch
  const hasProfile = savedModel !== undefined || savedEffort !== undefined

  const readCatalog = async (): Promise<void> => {
    if (disabled || busyRef.current) return
    busyRef.current = true
    if (alive.current) {
      setReading(true)
      setError(undefined)
    }
    try {
      const url = new URL('/api/chatgpt-web', window.location.origin)
      url.searchParams.set('catalog', '1')
      url.searchParams.set('refresh', '1')
      url.searchParams.set('session_id', sessionId)
      const response = await request(url, { cache: 'no-store' })
      const parsed = parseWebModelStatus(await readResponse(response))
      if (parsed?.catalog === undefined) throw new Error('ChatGPT Web 模型目录响应无效。')
      if (!alive.current) return
      onChangeRef.current(parsed.profile ?? profile ?? {}, parsed.catalog)
    } catch (reason: unknown) {
      if (!alive.current) return
      setError(webCatalogReadError(reason))
    } finally {
      busyRef.current = false
      if (alive.current) setReading(false)
    }
  }

  const save = async (next: WebModelPreferences): Promise<void> => {
    if (disabled || busyRef.current) return
    busyRef.current = true
    if (alive.current) {
      setBusy(true)
      setError(undefined)
    }
    try {
      const url = new URL('/api/chatgpt-web', window.location.origin)
      url.searchParams.set('action', 'profile')
      url.searchParams.set('session_id', sessionId)
      if (next.model !== undefined) url.searchParams.set('model', next.model)
      if (next.effort !== undefined) url.searchParams.set('effort', next.effort)
      const response = await request(url, { method: 'POST', cache: 'no-store' })
      const value = await readResponse(response)
      const parsed = parseWebModelProfileResponse(value)
      if (parsed === undefined) throw new Error('ChatGPT Web 模型偏好响应无效，请刷新模型与算子后重试。')
      if (!alive.current) return
      onChangeRef.current(parsed.profile, parsed.catalog)
      setError(undefined)
    } catch (reason: unknown) {
      if (!alive.current) return
      setError(webModelSaveError(reason))
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }

  const chooseModel = (value: string): void => {
    if (value === '') {
      void save({})
      return
    }
    if (catalog?.models.some(choice => choice.id === value) !== true) return
    void save({ model: value })
  }

  const chooseEffort = (value: string): void => {
    if (selectedModel === undefined) return
    if (value !== '' && catalog?.efforts.some(choice => choice.id === value) !== true) return
    void save({
      model: selectedModel,
      ...(value === '' ? {} : { effort: value }),
    })
  }

  const clearEffort = (): void => {
    if (selectedModel === undefined) {
      void save({})
      return
    }
    void save({ model: selectedModel })
  }

  return (
    <section className="dshDesktopOperatorProfilePreferences" role="group" aria-label="ChatGPT Web 模型偏好">
      <div>
        <strong>ChatGPT Web 模型偏好</strong>
        <small>选项来自当前 ChatGPT 网页；部分推理档位会同时切换实际模型。按网站设置会清除对应的 DSH 偏好。</small>
      </div>
      {catalog === undefined && (
        <p role="status">尚未读取 ChatGPT Web 模型目录；读取会打开 ChatGPT 网页查看可选模型，不发送提示词。</p>
      )}
      <button type="button" disabled={disabled || busy || reading} onClick={() => { void readCatalog() }}>
        {reading ? '正在读取网页模型…' : catalog === undefined ? '读取网页模型与推理强度' : '重新读取网页模型'}
      </button>
      <label>
        <span>网页模型</span>
        <select
          aria-label="ChatGPT Web 模型"
          value={savedModel ?? ''}
          disabled={modelDisabled}
          onChange={(event) => { chooseModel(event.currentTarget.value) }}
        >
          <option value="">按网站设置</option>
          {savedModel !== undefined && modelKnown !== true && (
            <option value={savedModel}>已保存的模型不可用：{savedModel}</option>
          )}
          {catalog?.models.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
      </label>
      <label>
        <span>推理强度</span>
        <select
          aria-label="ChatGPT Web 推理强度"
          value={savedEffort ?? ''}
          disabled={effortDisabled}
          onChange={(event) => { chooseEffort(event.currentTarget.value) }}
        >
          <option value="">按网站设置</option>
          {savedEffort !== undefined && (effortKnown !== true || modelCatalogMismatch) && (
            <option value={savedEffort}>已保存的推理强度不可用：{savedEffort}</option>
          )}
          {!modelCatalogMismatch && catalog?.efforts.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
      </label>
      {modelCatalogMismatch && (
        <p role="status">当前保存的模型与 ChatGPT Web 目录不一致；请刷新后重新选择模型，推理强度暂不可用。</p>
      )}
      {catalog !== undefined && catalog.efforts.length === 0 && savedEffort !== undefined && (
        <button type="button" disabled={disabled || busy} onClick={clearEffort}>
          清除推理强度
        </button>
      )}
      {hasProfile && (
        <button type="button" disabled={disabled || busy} onClick={() => { void save({}) }}>
          清除模型与推理偏好
        </button>
      )}
      {catalog !== undefined && catalog.models.length === 0 && (
        <p role="status">ChatGPT Web 当前没有可用模型选择；请刷新后重试。</p>
      )}
      {catalog !== undefined && catalog.efforts.length === 0 && (
        <p role="status">ChatGPT Web 当前没有可用推理强度，推理强度控制已禁用。</p>
      )}
      {error !== undefined && <p role="alert">{error}</p>}
    </section>
  )
}

const INVALID_TEXT = Symbol('invalid web model text')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function optionalText(record: Record<string, unknown>, key: string): string | undefined | typeof INVALID_TEXT {
  if (!hasOwn(record, key)) return undefined
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') return INVALID_TEXT
  return value
}

function parseChoices(value: unknown): readonly WebModelChoice[] | undefined {
  if (!Array.isArray(value)) return undefined
  const choices: WebModelChoice[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim() === ''
      || typeof item.label !== 'string' || item.label.trim() === '') return undefined
    choices.push({ id: item.id, label: item.label })
  }
  return choices
}

async function readResponse(response: Response): Promise<unknown> {
  let value: unknown
  try {
    value = await response.json() as unknown
  } catch {
    value = undefined
  }
  if (!response.ok) throw new WebModelResponseError(response.status, value)
  return value
}

class WebModelResponseError extends Error {
  constructor(readonly status: number, readonly body: unknown) {
    super(`ChatGPT Web 模型偏好保存失败（HTTP ${String(status)}）`)
    this.name = 'WebModelResponseError'
  }
}

function webCatalogReadError(reason: unknown): string {
  if (reason instanceof WebModelResponseError) {
    if (reason.status === 409) return '当前有进行中的 ChatGPT Web 请求，请等待完成后再读取网页模型。'
    return `读取 ChatGPT Web 模型目录失败（HTTP ${String(reason.status)}）；请确认 ChatGPT 网页已登录后重试。`
  }
  return reason instanceof Error ? `读取 ChatGPT Web 模型目录失败：${reason.message}` : `读取 ChatGPT Web 模型目录失败：${String(reason)}`
}

function webModelSaveError(reason: unknown): string {
  if (reason instanceof WebModelResponseError) {
    if (reason.status === 409) return '当前有进行中的 ChatGPT Web 请求，请等待完成后再保存模型偏好。'
    const detail = isRecord(reason.body) && typeof reason.body.error === 'string' ? `：${reason.body.error}` : ''
    return `${reason.message}${detail} 请检查 ChatGPT Web 状态后重试。`
  }
  return reason instanceof Error ? `保存 ChatGPT Web 模型偏好失败：${reason.message}` : `保存 ChatGPT Web 模型偏好失败：${String(reason)}`
}
