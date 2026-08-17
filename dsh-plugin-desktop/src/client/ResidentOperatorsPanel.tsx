import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DesktopSidebarFooterActionOwnerProps } from './contracts.ts'
import type {
  DesktopResidentDashboard,
  DesktopResidentActivity,
  DesktopResidentEvent,
  DesktopResidentSession,
} from '../resident-dashboard-contracts.ts'
import { RESIDENT_DASHBOARD_PATH } from '../resident-dashboard-contracts.ts'
import { formatResidentTimestamp } from '../resident-presentation.ts'

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
    if (!open || dashboard === undefined) return
    const selectionExists = dashboard.sessions.some(session => session.sessionId === selectedSessionId)
    if (!selectionExists) setSelectedSessionId(dashboard.sessions[0]?.sessionId)
  }, [dashboard, open, selectedSessionId])

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
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const generatedTime = dashboard === undefined
    ? undefined
    : formatResidentTimestamp(dashboard.generatedAt, dashboard.generatedAt, timeZone)

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
                <p>这里展示持久任务，而不是底层 daemon 日志；DSH 重启后仍可继续查看。</p>
                <small>本机时区：{timeZone} · {generatedTime === undefined ? '正在刷新' : `${generatedTime.absolute} 更新`}</small>
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
                      <div>
                        <strong>{provider.product === 'claude-code' ? 'Claude Code' : 'Codex'}</strong>
                        <small>{provider.productVersion} · {String(provider.models.length)} 个模型</small>
                      </div>
                      <em>{provider.available ? '订阅可用' : '不可用'}</em>
                    </div>
                  )) ?? <p>正在连接 daemon…</p>}
                </div>
                <h3>如何调用</h3>
                <div className="dshDesktopResidentHelp">
                  <p>模型选择旁的“算子”菜单缺省为“智能自动”。主 Agent 会在每个非简单任务开始时主动判断，不再要求你点名 Codex 或 Claude Code。</p>
                  <code>智能自动：实现/调试/测试通常交给 Codex；架构/审查/长上下文通常交给 Claude Code。</code>
                  <code>手动覆盖：可选择 Codex、Claude Code 或“仅当前模型”。策略按当前对话持久保存。</code>
                  <p>仓库修改、多轮任务和需要跨 DSH 重启继续的工作会优先使用 <code>mode=resident</code>。插件仍只依赖 <code>ctx.physicalOperators</code>，无需知道 daemon 或 CLI。</p>
                </div>
              </div>
              <div className="dshDesktopResidentColumn dshDesktopResidentSessions">
                <h3>持久任务</h3>
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
                <h3>任务记录</h3>
                {selectedSessionId === undefined
                  ? <p className="dshDesktopResidentEmpty">选择一个持久任务查看记录。</p>
                  : <ActivityTimeline
                      activities={dashboard?.activities ?? []}
                      generatedAt={dashboard?.generatedAt ?? new Date().toISOString()}
                      timeZone={timeZone}
                    />}
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
  const taskLabel = props.session.latestTurn?.taskLabel ?? '历史任务（升级前未记录摘要）'
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
      <span>
        <strong>{operatorLabel(props.session.operatorId)} · {taskLabel}</strong>
        <small>{props.session.workspaceDisplay}</small>
        <small>{profileLabel(props.session)}</small>
      </span>
      <span><em>{lifecycleLabel(props.session.lifecycle)}</em><small>{phase}</small></span>
    </button>
  )
}

function profileLabel(session: DesktopResidentSession): string {
  const profile = session.executionProfile
  if (profile === undefined) return '模型待首轮锁定'
  const source = session.executionProfileSource === 'manual'
    ? '手动'
    : session.executionProfileSource === 'mixed'
      ? '混合'
      : '智能'
  return `${profile.model} · ${profile.effort ?? '默认强度'} · ${source}`
}

function ActivityTimeline(props: { activities: DesktopResidentActivity[]; generatedAt: string; timeZone: string }) {
  if (props.activities.length === 0) return <p className="dshDesktopResidentEmpty">还没有任务记录。</p>
  return (
    <ol>
      {props.activities.slice(0, 20).map(activity => {
        const time = formatResidentTimestamp(activity.updatedAt, props.generatedAt, props.timeZone)
        return <li key={activity.turnId}>
          <time title={time.absolute}>{time.relative}</time>
          <strong>{activity.taskLabel}</strong>
          <span>{activityLabel(activity)}</span>
        </li>
      })}
    </ol>
  )
}

function activityLabel(activity: DesktopResidentActivity): string {
  if (activity.status === 'running' && activity.phase !== undefined) {
    return progressPhaseLabel(activity.phase)
  }
  return ({
    queued: '等待启动',
    running: '正在执行',
    completed: '已完成',
    interrupted: '已中断，可继续或重置',
    failed: '执行失败',
    indeterminate: '状态待人工确认，未自动重放',
  } as const)[activity.status]
}

function progressLabel(event: DesktopResidentEvent | undefined): string {
  if (event === undefined) return '等待执行'
  const phase = typeof event.data.phase === 'string' ? event.data.phase : undefined
  if (phase !== undefined) {
    return progressPhaseLabel(phase)
  }
  return ({
    'session.created': '会话已创建',
    'turn.accepted': '任务已接收',
    'turn.running': '任务已启动',
    'turn.settled': '任务已完成',
    'turn.failed': '任务失败',
    'turn.indeterminate': '结果待人工确认',
  } as Record<string, string>)[event.type] ?? '状态已更新'
}

function progressPhaseLabel(phase: string): string {
  return ({
    connecting: '正在连接原生产品',
    session_ready: '原生会话已接通',
    reasoning: '正在推理与执行',
    tool_activity: '正在使用工具',
    finalizing: '正在整理结果',
  } as Record<string, string>)[phase] ?? '正在执行'
}

function operatorLabel(operatorId: string): string {
  return operatorId === 'claude-code' ? 'Claude Code' : operatorId === 'codex' ? 'Codex' : operatorId
}

function lifecycleLabel(lifecycle: DesktopResidentSession['lifecycle']): string {
  return ({
    starting: '启动中',
    idle: '空闲',
    running: '运行中',
    draining: '收尾中',
    stopped: '已停止',
  } as const)[lifecycle]
}
