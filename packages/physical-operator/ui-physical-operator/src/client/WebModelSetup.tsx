import { useEffect, useState } from 'react'
import type { BrowserRequest } from './ResidentOperatorsPanel.tsx'
import {
  WebModelControls,
  parseWebModelStatus,
  type WebModelCatalog,
  type WebModelPreferences,
} from './WebModelControls.tsx'

/** Same-origin setup route owned by the ChatGPT Web physical-operator provider. */
export const CHATGPT_WEB_SETUP_PATH = '/api/chatgpt-web'

/** Props for the owner-local ChatGPT Web model setup panel. */
export interface WebModelSetupProps {
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
}

type PanelState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | {
    readonly kind: 'ready'
    readonly active: boolean
    readonly profile?: WebModelPreferences
    readonly catalog?: WebModelCatalog
  }
  | { readonly kind: 'unavailable'; readonly message: string }

/** Render the owner-local ChatGPT Web model and reasoning controls. */
export function WebModelSetup({
  request,
  open,
  selected,
  sessionId,
  locked,
  hidden = false,
  refreshVersion = 0,
}: WebModelSetupProps) {
  const [state, setState] = useState<PanelState>({ kind: 'idle' })

  useEffect(() => {
    if (!open || !selected) {
      setState({ kind: 'idle' })
      return
    }

    const controller = new AbortController()
    let active = true
    setState({ kind: 'loading' })
    const load = async (): Promise<void> => {
      try {
        const url = new URL(CHATGPT_WEB_SETUP_PATH, window.location.origin)
        if (sessionId !== undefined) url.searchParams.set('session_id', sessionId)
        const response = await request(url, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const value = await readJson(response)
        const modelFields = parseWebModelStatus(value)
        const busy = modelFields === undefined ? undefined : (value as Record<string, unknown>).active
        if (!active || controller.signal.aborted) return
        if (typeof busy !== 'boolean' || modelFields === undefined) throw new Error('ChatGPT Web 状态无效')
        setState({ kind: 'ready', active: busy, ...modelFields })
      } catch (reason: unknown) {
        if (!active || controller.signal.aborted) return
        setState({ kind: 'unavailable', message: webSetupError(reason) })
      }
    }
    void load()
    return () => {
      active = false
      controller.abort()
    }
  }, [open, request, selected, sessionId, refreshVersion])

  const onModelChange = (profile: WebModelPreferences, catalog?: WebModelCatalog): void => {
    setState(current => current.kind === 'ready'
      ? {
        ...current,
        profile,
        ...catalog === undefined ? {} : { catalog },
      }
      : current)
  }

  return (
    <section className="dshDesktopOperatorProfilePreferences" hidden={hidden} role="group" aria-label="ChatGPT 网页版模型设置">
      {state.kind === 'loading' && <p>正在读取 ChatGPT Web 模型设置…</p>}
      {state.kind === 'unavailable' && <p role="status">{state.message} 请更新 Host 后重试。</p>}
      {state.kind === 'ready' && (
        <>
          {state.active && <p role="status">当前有进行中的 ChatGPT Web 请求，完成后才能更改模型设置。</p>}
          {sessionId !== undefined && (
            <WebModelControls
              sessionId={sessionId}
              request={request}
              {...state.catalog === undefined ? {} : { catalog: state.catalog }}
              {...state.profile === undefined ? {} : { profile: state.profile }}
              disabled={locked || state.active}
              onChange={onModelChange}
            />
          )}
        </>
      )}
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

class WebSetupResponseError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`ChatGPT Web 模型设置请求失败（${String(status)}）`)
  }
}

function webSetupError(reason: unknown): string {
  if (reason instanceof WebSetupResponseError) {
    if (reason.status === 404) return '当前 Host 未提供 ChatGPT Web 模型设置。'
    return `${reason.message}${reason.body === '' ? '' : `：${reason.body}`}`
  }
  return reason instanceof Error ? reason.message : String(reason)
}
