import { useCallback, useEffect, useState } from 'react'
import type {
  DesktopRlmAgentsDashboardV1,
  DesktopRlmControlReceiptV1,
  DesktopRlmControlRequestV1,
} from '../contracts.ts'
import { ORCHESTRATION_RLM_AGENTS_PATH } from '../contracts.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'

export type BrowserRequest = ConnectionHandle['request']

/** Read the bounded, text-free RLM Agents projection from the same-origin Host. */
/* jscpd:ignore-start -- this independently unloadable plugin owns its endpoint
 * loader and cannot import the Resident plugin's superficially similar client. */
export async function loadRlmAgentsDashboard(
  sessionId?: string,
  signal?: AbortSignal,
  request: BrowserRequest = globalThis.fetch,
): Promise<DesktopRlmAgentsDashboardV1> {
  const url = new URL(ORCHESTRATION_RLM_AGENTS_PATH, window.location.origin)
  if (sessionId !== undefined) url.searchParams.set('session_id', sessionId)
  const response = await request(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw new Error(`RLM Agents 状态读取失败 (${String(response.status)}): ${await response.text()}`)
  }
  return await response.json() as DesktopRlmAgentsDashboardV1
}
/* jscpd:ignore-end */

/** Submit versioned RLM control intent while the Host retains the lease credential. */
export async function controlRlmAgents(
  control: DesktopRlmControlRequestV1,
  request: BrowserRequest = globalThis.fetch,
): Promise<DesktopRlmControlReceiptV1> {
  const response = await request(ORCHESTRATION_RLM_AGENTS_PATH, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-DSH-Orchestration-Control': '1',
    },
    body: JSON.stringify(control),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { message?: string } | undefined
    throw new Error(detail?.message ?? `RLM Agents 控制失败 (${String(response.status)})`)
  }
  return await response.json() as DesktopRlmControlReceiptV1
}

/** Compact session, child, and message-status projection with server-authoritative RLM controls. */
export function RlmAgentsView(props: { request: BrowserRequest; preferredSessionId?: string | undefined }) {
  const [selectedSessionId, setSelectedSessionId] = useState<string>()
  const [dashboard, setDashboard] = useState<DesktopRlmAgentsDashboardV1>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [pending, setPending] = useState(false)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<'auto' | 'steer' | 'follow_up'>('auto')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await loadRlmAgentsDashboard(selectedSessionId, signal, props.request)
    setDashboard(next)
    setError(undefined)
  }, [props.request, selectedSessionId])

  /* jscpd:ignore-start -- RLM Agents owns an independent polling projection;
   * importing another plugin's lifecycle would violate unloadability. */
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        await refresh(controller.signal)
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, 2_000)
      }
    }
    void poll()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [refresh])
  /* jscpd:ignore-end */

  useEffect(() => {
    if (dashboard === undefined) return
    const preferred = props.preferredSessionId !== undefined
      && dashboard.sessions.some(session => session.sessionId === props.preferredSessionId)
      ? props.preferredSessionId
      : dashboard.sessions[0]?.sessionId
    if (selectedSessionId === undefined || !dashboard.sessions.some(session => session.sessionId === selectedSessionId)) {
      setSelectedSessionId(preferred)
    }
  }, [dashboard, props.preferredSessionId, selectedSessionId])

  const selected = dashboard?.sessions.find(session => session.sessionId === selectedSessionId)
  const control = dashboard?.control
  const invoke = useCallback(async (controlRequest: DesktopRlmControlRequestV1): Promise<boolean> => {
    setPending(true)
    try {
      const receipt = await controlRlmAgents(controlRequest, props.request)
      setNotice(receipt.action === 'input'
        ? `输入已${receipt.message?.deliveryStatus === 'delivered' ? '送达' : '排队'}，未在投影中回显正文。`
        : receipt.attachment === 'attached' ? 'RLM 控制已附着。' : 'RLM 控制已解除。')
      await refresh()
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setPending(false)
    }
  }, [props.request, refresh])

  const attach = (): void => {
    if (selected === undefined) return
    void invoke({ version: 1, action: 'attach', commandId: crypto.randomUUID(), sessionId: selected.sessionId })
  }
  const detach = (): void => {
    if (selected === undefined) return
    void invoke({ version: 1, action: 'detach', commandId: crypto.randomUUID(), sessionId: selected.sessionId })
  }
  const submitInput = (): void => {
    if (selected === undefined || draft.trim().length === 0) return
    void invoke({
      version: 1,
      action: 'input',
      commandId: crypto.randomUUID(),
      sessionId: selected.sessionId,
      text: draft,
      mode,
    }).then((accepted) => {
      if (accepted) setDraft('')
    })
  }

  return <section className="dshDesktopRlmAgents" aria-label="RLM Agents View">
    <div className="dshDesktopRlmAgentsHeader">
      <div><h4>RLM Agents View</h4><small>Runtime 持有控制租约；消息投影不包含正文。</small></div>
      {control !== undefined && <small>
        租约：{control.attachment === 'attached' ? '本终端已附着' : '本终端未附着'}
        · 控制者：{control.controller === 'current_trusted_user' ? '当前可信用户' : '由 Runtime 判定'}
      </small>}
    </div>
    {error !== undefined && <p className="dshDesktopRlmAgentsError" role="alert">{error}</p>}
    {notice !== undefined && <p className="dshDesktopRlmAgentsNotice">{notice}</p>}
    {dashboard?.sessions.length === 0 && <p className="dshDesktopOrchestrationEmpty">还没有可投影的 RLM Session。</p>}
    <div className="dshDesktopRlmAgentsSessions" role="list" aria-label="RLM Session 列表">
      {(dashboard?.sessions ?? []).map(session => <button
        key={session.sessionId}
        type="button"
        role="listitem"
        data-selected={session.sessionId === selectedSessionId || undefined}
        onClick={() => { setSelectedSessionId(session.sessionId) }}
      >
        <strong>{session.parentSessionId === undefined ? 'Root' : 'Child'} · {shortRef(session.sessionId)}</strong>
        <small>{session.lifecycle} · depth {String(session.depth)} · {session.model.operatorId}/{session.model.model}</small>
      </button>)}
    </div>
    {selected !== undefined && <>
      <div className="dshDesktopRlmAgentsControls">
        {control?.canControl !== true && <span>当前可信范围只能查看，不能控制。</span>}
        {control?.canControl === true && control.attachment === 'attached'
          ? <button disabled={pending} type="button" onClick={detach}>解除控制</button>
          : <button disabled={pending || control?.canControl !== true} type="button" onClick={attach}>附着控制</button>}
      </div>
      <div className="dshDesktopRlmAgentsChildren">
        <h5>子 Agent</h5>
        {selected.children.length === 0
          ? <p>尚未录入子 Agent。</p>
          : <ul>{selected.children.map(child => <li key={child.rlmChildId}>
            <span>{shortRef(child.sessionId)} · depth {String(child.depth)}</span>
            <strong>{child.lifecycle}</strong>
            <small>{child.model.operatorId}/{child.model.model}</small>
          </li>)}</ul>}
      </div>
      <div className="dshDesktopRlmAgentsMessages">
        <h5>消息投影</h5>
        {dashboard?.messages.length === 0
          ? <p>没有可显示的消息元数据。</p>
          : <ul>{dashboard?.messages.slice(-12).map(message => <li key={message.messageId}>
            <span>{message.source === 'control' ? '控制输入' : 'Agent 消息'} · {message.effectiveMode}</span>
            <strong>{message.deliveryStatus}</strong>
            <small>{shortRef(message.fromSessionId)} → {shortRef(message.toSessionId)} · Artifact {String(message.artifactCount)}</small>
          </li>)}</ul>}
      </div>
      <div className="dshDesktopRlmAgentsInput">
        <label htmlFor="dsh-rlm-agents-input">向已附着 Session 提交输入</label>
        <textarea
          id="dsh-rlm-agents-input"
          value={draft}
          disabled={pending || control?.attachment !== 'attached' || !control.canControl}
          onChange={(event) => { setDraft(event.currentTarget.value) }}
          placeholder="正文仅提交给 Runtime，不会在消息投影中回显"
        />
        <select value={mode} disabled={pending || control?.attachment !== 'attached' || !control.canControl} onChange={(event) => {
          setMode(event.currentTarget.value as 'auto' | 'steer' | 'follow_up')
        }}>
          <option value="auto">自动</option>
          <option value="steer">引导</option>
          <option value="follow_up">跟进</option>
        </select>
        <button disabled={pending || draft.trim().length === 0 || control?.attachment !== 'attached' || !control.canControl} type="button" onClick={submitInput}>提交输入</button>
      </div>
    </>}
  </section>
}

function shortRef(value: string): string {
  const tail = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value
  return tail.length <= 10 ? tail : tail.slice(0, 10)
}
