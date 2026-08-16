import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DesktopSidebarFooterActionOwnerProps } from './contracts.ts'
import type {
  DesktopResidentDashboard,
  DesktopResidentEvent,
  DesktopResidentSession,
} from '../resident-dashboard-contracts.ts'
import { RESIDENT_DASHBOARD_PATH } from '../resident-dashboard-contracts.ts'

/** Load one same-origin daemon projection for the Desktop Resident panel. */
export async function loadResidentDashboard(
  sessionId?: string,
  signal?: AbortSignal,
): Promise<DesktopResidentDashboard> {
  const url = new URL(RESIDENT_DASHBOARD_PATH, window.location.origin)
  if (sessionId !== undefined) url.searchParams.set('session_id', sessionId)
  const response = await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Resident Operator status failed (${String(response.status)}): ${message}`)
  }
  return await response.json() as DesktopResidentDashboard
}

/** Sidebar action and local read-only overlay for persistent physical operators. */
export function ResidentOperatorsPanel({ wide }: DesktopSidebarFooterActionOwnerProps) {
  const [open, setOpen] = useState(false)
  const [selectedSessionId, setSelectedSessionId] = useState<string>()
  const [dashboard, setDashboard] = useState<DesktopResidentDashboard>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      try {
        const next = await loadResidentDashboard(open ? selectedSessionId : undefined, controller.signal)
        setDashboard(next)
        setError(undefined)
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void refresh() }, open ? 2_000 : 10_000)
      }
    }
    void refresh()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [open, selectedSessionId])

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('keydown', close) }
  }, [open])

  const running = dashboard?.sessions.filter(session => session.lifecycle === 'running').length ?? 0
  const unavailable = dashboard?.providers.filter(provider => !provider.available).length ?? 0
  const status = error !== undefined ? 'error' : unavailable > 0 ? 'warn' : running > 0 ? 'running' : 'idle'
  const label = `物理算子：${String(running)} 个运行中${error === undefined ? '' : '，状态不可用'}`

  return (
    <>
      <button
        type="button"
        className="dshDesktopResidentAction"
        data-wide={wide || undefined}
        data-status={status}
        aria-label={label}
        title={label}
        onClick={() => { setOpen(true) }}
      >
        <span className="dshDesktopResidentDot" aria-hidden="true" />
        {wide ? <><span>物理算子</span><span>{running > 0 ? `${String(running)} 运行中` : 'Claude · Codex'}</span></> : <span>OP</span>}
      </button>
      {open && createPortal(
        <div className="dshDesktopResidentBackdrop" role="presentation" onMouseDown={() => { setOpen(false) }}>
          <section
            className="dshDesktopResidentPanel"
            role="dialog"
            aria-modal="true"
            aria-label="Resident 物理算子"
            onMouseDown={event => { event.stopPropagation() }}
          >
            <header>
              <div>
                <h2>Resident 物理算子</h2>
                <p>任务和原生会话由独立 daemon 持有，DSH 重启后仍可重新查看。</p>
              </div>
              <button type="button" aria-label="关闭物理算子面板" onClick={() => { setOpen(false) }}>×</button>
            </header>
            {error !== undefined && <div className="dshDesktopResidentError" role="alert">{error}</div>}
            <div className="dshDesktopResidentGrid">
              <div className="dshDesktopResidentColumn">
                <h3>可用算子</h3>
                <div className="dshDesktopResidentProviders">
                  {dashboard?.providers.map(provider => (
                    <div key={provider.operatorId} className="dshDesktopResidentProvider" data-ok={provider.available || undefined}>
                      <span className="dshDesktopResidentDot" />
                      <div><strong>{provider.product === 'claude-code' ? 'Claude Code' : 'Codex'}</strong><small>{provider.productVersion}</small></div>
                      <em>{provider.available ? '订阅可用' : '不可用'}</em>
                    </div>
                  )) ?? <p>正在连接 daemon…</p>}
                </div>
                <h3>如何调用</h3>
                <div className="dshDesktopResidentHelp">
                  <p>直接在对话中说明算子、常驻模式和任务：</p>
                  <code>使用 Codex 常驻物理算子，在当前工作区完成这个任务：…</code>
                  <code>让 Claude Code 以 resident 模式审查并继续修改：…</code>
                  <p>DSH 会通过 <code>physical_operator</code> 工具选择 <code>mode=resident</code>。插件则注入 <code>ctx.physicalOperators</code>，不需要知道 daemon 或 CLI。</p>
                </div>
              </div>
              <div className="dshDesktopResidentColumn dshDesktopResidentSessions">
                <h3>执行状态</h3>
                {(dashboard?.sessions.length ?? 0) === 0 && <p className="dshDesktopResidentEmpty">还没有 Resident 执行。</p>}
                {dashboard?.sessions.map(session => (
                  <SessionRow
                    key={session.sessionId}
                    session={session}
                    selected={session.sessionId === selectedSessionId}
                    onSelect={() => { setSelectedSessionId(session.sessionId) }}
                  />
                ))}
              </div>
              <div className="dshDesktopResidentColumn dshDesktopResidentEvents">
                <h3>最新进展</h3>
                {selectedSessionId === undefined
                  ? <p className="dshDesktopResidentEmpty">选择一个会话查看事件。</p>
                  : <EventTimeline events={dashboard?.events ?? []} />}
              </div>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  )
}

function SessionRow(props: { session: DesktopResidentSession; selected: boolean; onSelect: () => void }) {
  const phase = progressLabel(props.session.latestEvent)
  const workspace = useMemo(() => props.session.workspace.split(/[\\/]/u).filter(Boolean).at(-1) ?? props.session.workspace, [props.session.workspace])
  return (
    <button
      type="button"
      className="dshDesktopResidentSession"
      data-selected={props.selected || undefined}
      data-health={props.session.health}
      onClick={props.onSelect}
      title={props.session.workspace}
    >
      <span className="dshDesktopResidentDot" />
      <span><strong>{props.session.operatorId}</strong><small>{workspace}</small></span>
      <span><em>{props.session.lifecycle}</em><small>{phase}</small></span>
    </button>
  )
}

function EventTimeline({ events }: { events: DesktopResidentEvent[] }) {
  if (events.length === 0) return <p className="dshDesktopResidentEmpty">还没有结构化事件。</p>
  return (
    <ol>
      {[...events].reverse().slice(0, 40).map(event => (
        <li key={event.sequence}>
          <time>{new Date(event.time).toLocaleTimeString()}</time>
          <strong>{event.type}</strong>
          <span>{progressLabel(event)}</span>
        </li>
      ))}
    </ol>
  )
}

function progressLabel(event: DesktopResidentEvent | undefined): string {
  if (event === undefined) return '等待执行'
  const phase = typeof event.data.phase === 'string' ? event.data.phase : undefined
  if (phase !== undefined) {
    return ({
      connecting: '连接原生产品',
      session_ready: '原生会话已接通',
      reasoning: '正在推理/执行',
      tool_activity: '正在使用工具',
      finalizing: '正在整理结果',
    } as Record<string, string>)[phase] ?? phase
  }
  return ({
    'session.created': '会话已创建',
    'turn.accepted': '任务已接收',
    'turn.running': '任务已启动',
    'turn.settled': '任务已完成',
    'turn.failed': '任务失败',
    'turn.indeterminate': '结果待人工确认',
  } as Record<string, string>)[event.type] ?? event.type
}
