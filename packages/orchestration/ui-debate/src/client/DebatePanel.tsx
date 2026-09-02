import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  DEBATE_DASHBOARD_PATH,
  type DesktopDebateControlAction,
  type DesktopDebateControlRequest,
  type DesktopDebateDashboard,
  type DesktopDebateEvent,
  type DesktopDebateLifecycle,
  type DesktopDebateRole,
  type DesktopDebateRound,
  type DesktopDebateRun,
  type DesktopDebateRunSummary,
  type DesktopDebateTurnBlocker,
  type DesktopDebateTurnRouting,
  type DesktopDebateTurnUsage,
} from '../contracts.ts'

export type BrowserRequest = ConnectionHandle['request']

/** Load the list or one selected run plus its bounded event page. */
export async function loadDebateDashboard(
  runId?: string,
  signal?: AbortSignal,
  request: BrowserRequest = globalThis.fetch,
): Promise<DesktopDebateDashboard> {
  const url = new URL(DEBATE_DASHBOARD_PATH, window.location.origin)
  if (runId !== undefined) url.searchParams.set('run_id', runId)
  const response = await request(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`Debate 状态读取失败 (${String(response.status)}): ${await response.text()}`)
  return await response.json() as DesktopDebateDashboard
}

/** Submit one authenticated, revision-fenced Debate control. */
export async function controlDebate(
  intent: DesktopDebateControlRequest,
  request: BrowserRequest = globalThis.fetch,
): Promise<DesktopDebateRun> {
  const response = await request(DEBATE_DASHBOARD_PATH, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-DSH-Debate-Control': '1',
    },
    body: JSON.stringify(intent),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { message?: string } | undefined
    throw new Error(detail?.message ?? `Debate 控制失败 (${String(response.status)})`)
  }
  return await response.json() as DesktopDebateRun
}

function controlId(run: DesktopDebateRun, action: DesktopDebateControlAction): string {
  return `debate-ui-${action}-${run.runId}-${String(run.revision)}-${crypto.randomUUID()}`
}

/** Session-header trigger and theme-coherent Debate inspector. */
export function DebatePanel({ request: browserRequest }: { request: BrowserRequest }) {
  const [open, setOpen] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [dashboard, setDashboard] = useState<DesktopDebateDashboard>()
  const [error, setError] = useState<string>()
  const [controlPending, setControlPending] = useState(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await loadDebateDashboard(open ? selectedRunId : undefined, signal, browserRequest)
    setDashboard(next)
    setError(undefined)
  }, [browserRequest, open, selectedRunId])

  /* jscpd:ignore-start -- this polling lifecycle belongs to the independently
   * unloadable Debate client plugin; cross-plugin value imports are forbidden. */
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        await refresh(controller.signal)
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { void poll() }, open ? 2_000 : 15_000)
      }
    }
    void poll()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [open, refresh])
  /* jscpd:ignore-end */

  useEffect(() => {
    if (!open || dashboard === undefined || selectedRunId !== undefined) return
    setSelectedRunId(dashboard.runs[0]?.runId)
  }, [dashboard, open, selectedRunId])

  useEffect(() => {
    if (!open) return
    const close = ({ key }: KeyboardEvent): void => { if (key === 'Escape') setOpen(false) }
    window.addEventListener('keyup', close)
    return () => { window.removeEventListener('keyup', close) }
  }, [open])

  const active = dashboard?.runs.filter(run => isActive(run.state)).length ?? 0
  const attention = dashboard?.runs.filter(run => needsAttention(run.state)).length ?? 0
  const status = error !== undefined ? 'error' : attention > 0 ? 'warn' : active > 0 ? 'running' : 'idle'

  const submit = useCallback(async (action: DesktopDebateControlAction) => {
    const run = dashboard?.selectedRun
    if (run === undefined) return
    setControlPending(true)
    try {
      await controlDebate({
        version: 1,
        commandId: controlId(run, action),
        runId: run.runId,
        expectedRevision: run.revision,
        action,
        reason: `User selected ${action} in DSH Desktop Debate panel.`,
      }, browserRequest)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setControlPending(false)
    }
  }, [browserRequest, dashboard?.selectedRun, refresh])

  const label = `Debate：${String(active)} 个运行中${attention > 0 ? `，${String(attention)} 个需处理` : ''}`
  return <>
    <button
      type="button"
      className="dshDesktopDebateAction"
      data-status={status}
      aria-label={label}
      title={label}
      onClick={() => { setOpen(true) }}
    >
      <span className="dshDesktopDebateDot" aria-hidden="true" />
      <span>Debate</span>
    </button>
    {open && createPortal(
      <div className="dshDesktopDebateBackdrop" role="presentation" onMouseDown={() => { setOpen(false) }}>
        <section
          className="dshDesktopDebatePanel"
          role="dialog"
          aria-modal="true"
          aria-label="多 Agent Debate"
          onMouseDown={(event) => { event.stopPropagation() }}
        >
          <header>
            <div><h2>多 Agent Debate</h2><p>独立主张 → 证伪 → 证据审计 → 决策裁判</p></div>
            <button type="button" aria-label="关闭 Debate 面板" onClick={() => { setOpen(false) }}>×</button>
          </header>
          {error !== undefined && <div className="dshDesktopDebateError" role="alert">{error}</div>}
          <div className="dshDesktopDebateGrid">
            <RunList runs={dashboard?.runs ?? []} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
            <RunDetail run={dashboard?.selectedRun} events={dashboard?.events ?? []} pending={controlPending} onControl={submit} />
            <EvidenceColumn run={dashboard?.selectedRun} />
          </div>
        </section>
      </div>,
      document.body,
    )}
  </>
}

function RunList(props: {
  runs: DesktopDebateRunSummary[]
  selectedRunId?: string | undefined
  onSelect: (runId: string) => void
}) {
  return <aside className="dshDesktopDebateColumn dshDesktopDebateRuns">
    <h3>Debate Run</h3>
    {props.runs.length === 0 && <p className="dshDesktopDebateEmpty">还没有 Debate Run。</p>}
    {props.runs.map(run => <button
      key={run.runId}
      type="button"
      className="dshDesktopDebateRun"
      data-selected={run.runId === props.selectedRunId || undefined}
      data-state={run.state}
      onClick={() => { props.onSelect(run.runId) }}
    >
      <span className="dshDesktopDebateDot" />
      <span><strong>{shortRef(run.runId)}</strong><small>第 {String(run.currentRound)} 轮 · {formatTime(run.updatedAt)}</small></span>
      <em>{lifecycleLabel(run.state)}</em>
    </button>)}
  </aside>
}

/** Main run/round/role/claim projection. */
export function RunDetail(props: {
  run?: DesktopDebateRun | undefined
  events?: DesktopDebateEvent[] | undefined
  pending: boolean
  onControl: (action: DesktopDebateControlAction) => Promise<void>
}) {
  const run = props.run
  if (run === undefined) return <main className="dshDesktopDebateColumn"><p className="dshDesktopDebateEmpty">选择一个 Run 查看辩论。</p></main>
  const lastStopped = [...(props.events ?? [])].reverse().find(event => event.type === 'debate.stopped')
  const resumable = lastStopped?.data.action === 'pause'
  return <main className="dshDesktopDebateColumn dshDesktopDebateDetail">
    <div className="dshDesktopDebateRunHeader">
      <div><h3>{run.objective ?? `Debate ${shortRef(run.runId)}`}</h3><small>rev {String(run.revision)} · 第 {String(run.currentRound)} 轮 · {lifecycleLabel(run.state)}</small></div>
      <RunControls run={run} resumable={resumable} pending={props.pending} onControl={props.onControl} />
    </div>
    <section className="dshDesktopDebateRoles" aria-label="参与 Agent 与角色职责">
      <h3>参与 Agent 与角色职责</h3>
      {run.roles.map(role => <RoleCard key={role.role} role={role} />)}
    </section>
    <section className="dshDesktopDebateRounds">
      <h3>逐轮讨论摘要与收敛</h3>
      <p className="dshDesktopDebateSectionHint">仅展示有界讨论摘要；完整结果保留在 Artifact，不展示私有指令或完整推理过程。</p>
      {run.rounds.map(round => <article key={round.round} data-state={round.state}>
        <div><strong>第 {String(round.round)} 轮</strong><em>{roundStateLabel(round.state)}</em></div>
        <div className="dshDesktopDebateTurnList">
          {round.turnStates.length === 0
            ? <p className="dshDesktopDebateEmpty">尚未派发 Agent。</p>
            : round.turnStates.map(turn => <DebateTurnCard key={`${String(round.round)}-${turn.slotId}`} run={run} turn={turn} />)}
        </div>
        {round.convergence !== undefined && <p>
          {convergenceLabel(round.convergence.status)}
          {' · '}分数 {percent(round.convergence.score)} / 阈值 {percent(round.convergence.threshold)}
          {' · '}覆盖 {percent(round.convergence.coverage)}
          {' · '}高严重度未决 {String(round.convergence.unresolvedHighSeverity)}
        </p>}
      </article>)}
    </section>
    <EventTimeline run={run} events={props.events ?? []} />
    <section className="dshDesktopDebateClaims">
      <h3>Claim Ledger · 覆盖 {percent(run.claimCoverage)}</h3>
      {run.claims.length === 0 && <p className="dshDesktopDebateEmpty">Claim Ledger 尚未生成。</p>}
      {run.claims.map(claim => <article key={claim.claimId} data-severity={claim.severity}>
        <div>
          <strong>{claim.statement}</strong>
          <em>{claimStatusLabel(claim.status)} · {severityLabel(claim.severity)} · {percent(claim.confidence)}</em>
        </div>
        {claim.rationale !== undefined && <p>{claim.rationale}</p>}
        <small>
          支持 {claim.supportingSlotIds.map(roleLabel).join('、') || 'N/A'}
          {' · '}反对 {claim.opposingSlotIds.map(roleLabel).join('、') || 'N/A'}
          {' · '}Evidence {String(claim.evidenceRefs.length)}
        </small>
      </article>)}
    </section>
  </main>
}

function RoleCard({ role }: { role: DesktopDebateRole }) {
  const turn = role.latestTurn
  const route = turnRoute(role, turn)
  return <article data-state={turn?.state ?? 'planned'}>
    <div>
      <span className="dshDesktopDebateDot" />
      <strong>{role.title}</strong>
      <em>{turnStateLabel(turn?.state ?? 'planned')}</em>
    </div>
    <div className="dshDesktopDebateRoute" aria-label="算子路由">
      <small title={`${route.requestedOperatorId} · ${route.requestedModel}`}>请求：<span>{displayRouteValue(route.requestedOperatorId)} · {displayRouteValue(route.requestedModel)}</span></small>
      {route.actualOperatorId === undefined || route.actualModel === undefined
        ? <small>实际：尚未执行</small>
        : <small title={`${route.actualOperatorId} · ${route.actualModel}`}>实际：<span>{displayRouteValue(route.actualOperatorId)} · {displayRouteValue(route.actualModel)}</span></small>}
      <small>{role.source === 'native-subscription' ? '订阅套餐' : role.source}</small>
    </div>
    <p className="dshDesktopDebateRoleMandate">职责：{role.mandate}</p>
    {turn !== undefined && <p>
      第 {String(turn.round)} 轮 · Attempt {String(turn.attempt ?? 1)} · Claim {String(turn.claimIds.length)}
      {' · '}Evidence {String(turn.evidenceRefs.length)}
    </p>}
    {turn?.routing?.fallbackReasonCode !== undefined && <p className="dshDesktopDebateFallback">
      回退：{turn.routing.fallbackReasonCode}
    </p>}
    {turn?.blockers !== undefined && <BlockerList blockers={turn.blockers} />}
  </article>
}

function DebateTurnCard({ run, turn }: { run: DesktopDebateRun; turn: DesktopDebateRound['turnStates'][number] }) {
  const role = run.roles.find(entry => entry.role === turn.role || entry.role === turn.slotId)
  const title = role?.title ?? roleLabel(turn.role)
  const route = turnRoute(role, turn)
  const claimText = turn.claimIds.length > 0 ? turn.claimIds.join('、') : 'N/A'
  const evidenceText = turn.evidenceRefs.length > 0 ? turn.evidenceRefs.join('、') : 'N/A'
  const blockerSummary = turn.blockers?.[0]?.message
  return <article className="dshDesktopDebateTurn" data-state={turn.state}>
    <div className="dshDesktopDebateTurnHeader">
      <strong>{title}</strong>
      <em>{turnStateLabel(turn.state)}</em>
    </div>
    <div className="dshDesktopDebateRoute" aria-label="本轮算子路由">
      <small title={`${route.requestedOperatorId} · ${route.requestedModel}`}>请求：<span>{displayRouteValue(route.requestedOperatorId)} · {displayRouteValue(route.requestedModel)}</span></small>
      {route.actualOperatorId === undefined || route.actualModel === undefined
        ? <small>实际：尚未执行</small>
        : <small title={`${route.actualOperatorId} · ${route.actualModel}`}>实际：<span>{displayRouteValue(route.actualOperatorId)} · {displayRouteValue(route.actualModel)}</span></small>}
      {turn.attempt !== undefined && <small>Attempt {String(turn.attempt)}</small>}
    </div>
    <p className="dshDesktopDebateTurnSummary"><strong>讨论摘要：</strong>{turn.outputPreview ?? (blockerSummary === undefined ? '尚未返回讨论摘要。' : `未产生输出：${blockerSummary}`)}</p>
    {turn.outputRef !== undefined && <code title={turn.outputRef}>Artifact · {turn.outputRef}</code>}
    <small>Claim {claimText} · Evidence {evidenceText}</small>
    {turn.usage !== undefined && <small>{turnUsageLabel(turn.usage)}</small>}
    {(turn.startedAt !== undefined || turn.settledAt !== undefined) && <div className="dshDesktopDebateTurnTimes">
      {turn.startedAt !== undefined && <time dateTime={turn.startedAt} title={turn.startedAt}>开始 {formatTime(turn.startedAt)}</time>}
      {turn.settledAt !== undefined && <time dateTime={turn.settledAt} title={turn.settledAt}>完成 {formatTime(turn.settledAt)}</time>}
    </div>}
    {turn.errorCode !== undefined && <p className="dshDesktopDebateTurnError">错误：{turn.errorCode}</p>}
    {turn.routing?.fallbackReasonCode !== undefined && <p className="dshDesktopDebateFallback">回退：{turn.routing.fallbackReasonCode}</p>}
    {turn.blockers !== undefined && <BlockerList blockers={turn.blockers} />}
  </article>
}

function BlockerList({ blockers }: { blockers: DesktopDebateTurnBlocker[] }) {
  return <div className="dshDesktopDebateBlockers" aria-label="阻断原因">
    {blockers.map((blocker, index) => <article key={`${blocker.code}-${String(index)}`}>
      <strong>{blocker.code}</strong>
      <p title={blocker.message}>{blocker.message}</p>
      {blocker.nodeId !== undefined && <small title={blocker.nodeId}>节点 {displayRouteValue(blocker.nodeId)}</small>}
    </article>)}
  </div>
}

function turnRoute(
  role: DesktopDebateRole | undefined,
  turn: { operatorId?: string; model?: string; routing?: DesktopDebateTurnRouting } | undefined,
): {
  requestedOperatorId: string
  requestedModel: string
  actualOperatorId?: string
  actualModel?: string
} {
  const routing = turn?.routing
  const actualOperatorId = routing?.actualOperatorId ?? turn?.operatorId
  const actualModel = routing?.actualModel ?? turn?.model
  return {
    requestedOperatorId: routing?.requestedOperatorId ?? role?.operatorId ?? turn?.operatorId ?? 'N/A',
    requestedModel: routing?.requestedModel ?? role?.model ?? turn?.model ?? 'N/A',
    ...(actualOperatorId === undefined ? {} : { actualOperatorId }),
    ...(actualModel === undefined ? {} : { actualModel }),
  }
}

function displayRouteValue(value: string): string {
  return value.length <= 42 ? value : `${value.slice(0, 18)}…${value.slice(-20)}`
}

function EventTimeline({ run, events }: { run: DesktopDebateRun; events: DesktopDebateEvent[] }) {
  const visibleEvents = events.slice(-40)
  return <section className="dshDesktopDebateEvents" aria-label="Debate 事件时间线">
    <h3>事件时间线</h3>
    {visibleEvents.length === 0
      ? <p className="dshDesktopDebateEmpty">还没有 Debate 事件。</p>
      : <ol>{visibleEvents.map(event => <li key={event.sequence}>
        <time dateTime={event.createdAt} title={event.createdAt}>{formatTime(event.createdAt)}</time>
        <strong>{debateEventLabel(event.type)}</strong>
        <span>{debateEventContext(run, event)}</span>
        <small>{debateEventDetail(event)}</small>
      </li>)}</ol>}
  </section>
}

export function EvidenceColumn({ run }: { run?: DesktopDebateRun | undefined }) {
  if (run === undefined) return <aside className="dshDesktopDebateColumn" />
  return <aside className="dshDesktopDebateColumn dshDesktopDebateEvidence">
    <CostCard run={run} />
    <section aria-label="主持人总结 / 决策裁判"><h3>主持人总结 / 决策裁判</h3>
      {run.synthesis === undefined
        ? <p className="dshDesktopDebateEmpty">尚未生成综合结果。</p>
        : <>
          <p><strong>{synthesisLabel(run.synthesis.state)}</strong> · 保留异议 {String(run.synthesis.dissentCount)}</p>
          {run.synthesis.outputPreview !== undefined && <p>{run.synthesis.outputPreview}</p>}
          {run.synthesis.artifactRef !== undefined && <code title={run.synthesis.artifactRef}>{run.synthesis.artifactRef}</code>}
        </>}
    </section>
    <section><h3>未决问题</h3>
      {run.unresolved.length === 0 && <p className="dshDesktopDebateEmpty">无未决问题。</p>}
      {run.unresolved.map(item => <article key={item.claimId} data-severity={item.severity}>
        <strong>{item.blocking ? '阻断 · ' : ''}{item.description}</strong>
        <p>{item.reason}</p>
        <small>{severityLabel(item.severity)} · 缺失 Evidence {String(item.requiredEvidenceRefs.length)}</small>
      </article>)}
    </section>
    <section><h3>保留异议</h3>
      {run.dissent.length === 0 && <p className="dshDesktopDebateEmpty">没有保留异议。</p>}
      {run.dissent.map((item, index) => <article key={`${item.claimId}-${item.slotId}-${String(index)}`}>
        <strong>{roleLabel(item.slotId)} · {percent(item.confidence)}</strong><p>{item.position}</p><small>{item.reason}</small>
      </article>)}
    </section>
  </aside>
}

function CostCard({ run }: { run: DesktopDebateRun }) {
  const cost = run.cost
  return <section className="dshDesktopDebateCost" data-usage-status={cost.usageStatus} data-cost-status={cost.costStatus}>
    <h3>Usage / Cost</h3>
    <p><strong>用量{accountingLabel(cost.usageStatus)} · 费用{accountingLabel(cost.costStatus)}</strong></p>
    <div>
      <span>输入 {formatOptionalNumber(cost.inputTokens)}</span>
      <span>输出 {formatOptionalNumber(cost.outputTokens)}</span>
      <span>缓存命中 {formatOptionalNumber(cost.cacheReadInputTokens)}</span>
      <span>费用 {formatOptionalCost(cost.costUsd)}</span>
    </div>
    {(cost.unknownUsageTurns > 0 || cost.unknownCostTurns > 0) && <small>
      未归集 usage {String(cost.unknownUsageTurns)} 轮 · 未归集费用 {String(cost.unknownCostTurns)} 轮
    </small>}
  </section>
}

function RunControls(props: {
  run: DesktopDebateRun
  resumable: boolean
  pending: boolean
  onControl: (action: DesktopDebateControlAction) => Promise<void>
}) {
  const actions = controlActions(props.run.state, props.resumable)
  if (actions.length === 0) return null
  return <div className="dshDesktopDebateControls">
    {actions.map(action => <button key={action} type="button" disabled={props.pending} onClick={() => { void props.onControl(action) }}>{controlLabel(action)}</button>)}
  </div>
}

function controlActions(state: DesktopDebateLifecycle, resumable: boolean): DesktopDebateControlAction[] {
  if (state === 'awaiting_approval') return ['approve', 'stop']
  if (state === 'stopped') return resumable ? ['resume'] : []
  if (isActive(state)) return ['pause', 'stop']
  return []
}

function isActive(state: DesktopDebateLifecycle): boolean {
  return ['planned', 'admitting', 'round_running', 'reviewing', 'converged', 'next_round', 'synthesizing'].includes(state)
}

function needsAttention(state: DesktopDebateLifecycle): boolean {
  return ['awaiting_approval', 'budget_limited', 'max_rounds', 'failed', 'indeterminate'].includes(state)
}

function shortRef(value: string): string { return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-5)}` }
function percent(value: number): string { return `${String(Math.round(value * 100))}%` }
function formatOptionalNumber(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat().format(value) : 'N/A'
}
function formatOptionalCost(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(4)}` : 'N/A'
}
function formatTime(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) }

function turnUsageLabel(usage: DesktopDebateTurnUsage): string {
  return `Usage 输入 ${formatOptionalNumber(usage.inputTokens)} · 输出 ${formatOptionalNumber(usage.outputTokens)} · 缓存命中 ${formatOptionalNumber(usage.cacheReadInputTokens)} · 费用 ${formatOptionalCost(usage.costUsd)}`
}

function debateEventContext(run: DesktopDebateRun, event: DesktopDebateEvent): string {
  const roleId = typeof event.data.role === 'string' ? event.data.role : event.slotId
  const role = roleId === undefined ? undefined : run.roles.find(entry => entry.role === roleId || entry.role === event.slotId)
  const round = event.round ?? eventNumber(event.data.round)
  return [
    round === undefined ? 'Run' : `第 ${String(round)} 轮`,
    role?.title ?? (roleId === undefined ? undefined : roleLabel(roleId)),
    `#${String(event.sequence)}`,
  ].filter((value): value is string => value !== undefined).join(' · ')
}

function debateEventDetail(event: DesktopDebateEvent): string {
  if (event.type === 'debate.planned') return `模式 ${eventValue(event, 'mode')} · Agent ${eventValue(event, 'rosterSize')}`
  if (event.type === 'debate.roster.qualified') return `角色 ${eventList(event, 'roles')} · 每轮最多 ${eventValue(event, 'maxAgentsPerRound')}`
  if (event.type === 'debate.roster.rejected') return `角色 ${eventList(event, 'roles')} · ${eventValue(event, 'reason', '准入未通过')}`
  if (event.type === 'debate.admitted') return `准入动作：${eventValue(event, 'action')}`
  if (event.type === 'debate.round.started') return `阶段 ${eventValue(event, 'phase')} · ${eventList(event, 'slotIds')}`
  if (event.type === 'debate.agent.dispatched') return `${eventValue(event, 'role', event.slotId ?? 'Agent')} · ${eventValue(event, 'model')}`
  if (event.type === 'debate.agent.settled') return `Claim ${eventValue(event, 'claimCount', '0')} · Evidence ${eventValue(event, 'evidenceCount', '0')} · 置信度 ${eventValue(event, 'confidence')}`
  if (event.type === 'debate.agent.blocked') return `阻断 ${eventValue(event, 'errorCode')} · ${eventValue(event, 'blockerMessages', '等待资源')}${eventRoutingDetail(event)}`
  if (event.type === 'debate.agent.failed' || event.type === 'debate.agent.indeterminate') return `错误 ${eventValue(event, 'errorCode')}`
  if (event.type === 'debate.claims.compiled') return `Claim ${eventValue(event, 'claimCount', '0')} · 异议 ${eventValue(event, 'dissentCount', '0')} · 未决 ${eventValue(event, 'unresolvedCount', '0')}`
  if (event.type === 'debate.convergence.evaluated') return `${eventValue(event, 'status')} · 分数 ${eventValue(event, 'score')} · ${eventValue(event, 'reason')}`
  if (event.type === 'debate.synthesis.started') return '主持人综合已启动'
  if (event.type === 'debate.synthesis.settled') return `未决 ${eventList(event, 'unresolvedClaimIds')} · 异议 ${eventValue(event, 'dissentCount', '0')}`
  if (event.type === 'debate.cost.accounted') return `用量 ${eventValue(event, 'usageStatus')} · 费用 ${eventValue(event, 'costStatus')}`
  if (event.type === 'debate.stopped') return `${eventValue(event, 'action')} · ${eventValue(event, 'reason')}`
  if (event.type === 'debate.failed' || event.type === 'debate.indeterminate') return `错误 ${eventValue(event, 'errorCode')}`
  return eventValue(event, 'reason', '状态已记录')
}

function debateEventLabel(type: string): string {
  return ({
    'debate.planned': 'Debate 已规划',
    'debate.roster.qualified': '参与 Agent 已确认',
    'debate.roster.rejected': '参与 Agent 未通过准入',
    'debate.admitted': 'Debate 已准入',
    'debate.round.started': '轮次已开始',
    'debate.agent.dispatched': 'Agent 已派发',
    'debate.agent.settled': 'Agent 输出已完成',
    'debate.agent.blocked': 'Agent 等待资源',
    'debate.agent.failed': 'Agent 输出失败',
    'debate.agent.indeterminate': 'Agent 输出待确认',
    'debate.claims.compiled': 'Claim Ledger 已编译',
    'debate.convergence.evaluated': '收敛已评估',
    'debate.synthesis.started': '主持人总结已启动',
    'debate.synthesis.settled': '主持人总结已完成',
    'debate.cost.accounted': '用量与费用已归集',
    'debate.stopped': 'Debate 已停止',
    'debate.failed': 'Debate 失败',
    'debate.indeterminate': 'Debate 待确认',
  } as Record<string, string>)[type] ?? type
}

function eventValue(event: DesktopDebateEvent, key: string, fallback = 'N/A'): string {
  const value = event.data[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return fallback
}

function eventList(event: DesktopDebateEvent, key: string, fallback = 'N/A'): string {
  const value = event.data[key]
  if (!Array.isArray(value)) return fallback
  const strings = value.filter((entry): entry is string => typeof entry === 'string')
  return strings.length > 0 ? strings.join('、') : fallback
}

function eventRoutingDetail(event: DesktopDebateEvent): string {
  const fallback = eventValue(event, 'fallbackReasonCode', '')
  if (fallback.length === 0) return ''
  const actual = [eventValue(event, 'actualOperatorId', ''), eventValue(event, 'actualModel', '')].filter(Boolean).join('/')
  return actual.length === 0 ? ` · 回退 ${fallback}` : ` · 回退 ${fallback} → ${actual}`
}

function eventNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function lifecycleLabel(state: DesktopDebateLifecycle): string {
  return ({
    planned: '已规划', awaiting_approval: '等待批准', admitting: '准入中', round_running: '辩论中', reviewing: '审查中',
    converged: '已收敛', next_round: '准备下一轮', budget_limited: '预算停止', max_rounds: '达到轮次上限', synthesizing: '综合中',
    completed: '已完成', stopped: '已暂停/停止', failed: '失败', indeterminate: '状态不确定',
  } as const)[state]
}

function roleLabel(role: string): string {
  return ({
    'constructive-proposer': '建议者', 'skeptical-falsifier': '证伪者', 'evidence-auditor': '证据审计者', 'decision-judge': '决策裁判',
  } as Record<string, string>)[role] ?? role
}

function turnStateLabel(state: string): string {
  return ({ planned: '待执行', dispatched: '运行中', settled: '已完成', blocked: '已阻断', failed: '失败', indeterminate: '不确定' } as Record<string, string>)[state] ?? state
}

function roundStateLabel(state: string): string {
  return ({ planned: '待开始', running: '进行中', reviewing: '审查中', completed: '已完成', failed: '失败', indeterminate: '不确定' } as Record<string, string>)[state] ?? state
}

function convergenceLabel(state: string): string {
  return ({ converged: '已收敛', continue: '继续辩论', budget_limited: '预算停止', max_rounds: '轮次上限' } as Record<string, string>)[state] ?? state
}

function claimStatusLabel(state: string): string {
  return ({ open: '开放', supported: '支持', refuted: '反驳', settled: '已裁定', unresolved: '未决' } as Record<string, string>)[state] ?? state
}

function severityLabel(value: string): string {
  return ({ low: '低', medium: '中', high: '高', critical: '关键' } as Record<string, string>)[value] ?? value
}

function synthesisLabel(value: string): string {
  return ({ pending: '等待综合', running: '综合中', settled: '综合完成', failed: '综合失败' } as Record<string, string>)[value] ?? value
}

function accountingLabel(value: DesktopDebateRun['cost']['usageStatus']): string {
  return ({ known: '归集完整', partial: '部分归集', unknown: '归集未知' } as const)[value]
}

function controlLabel(action: DesktopDebateControlAction): string {
  return ({ approve: '批准', reject: '拒绝', pause: '暂停', resume: '恢复', stop: '终止' } as const)[action]
}
