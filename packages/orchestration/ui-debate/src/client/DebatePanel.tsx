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
  const floors = new Map<string, number>()
  let nextFloor = 1
  for (const round of run.rounds) {
    for (const turn of round.turnStates) {
      if (turn.role !== 'decision-judge') floors.set(`${String(round.round)}-${turn.slotId}`, nextFloor++)
    }
  }
  return <main className="dshDesktopDebateColumn dshDesktopDebateDetail">
    <section className="dshDesktopDebateTopic" aria-label="Debate 主题帖">
      <div className="dshDesktopDebateTopicHeading">
        <span className="dshDesktopDebatePinnedLabel">主题帖</span>
        <strong>{run.objective ?? '未提供公开议题'}</strong>
        <em>{lifecycleLabel(run.state)}</em>
      </div>
      <small>第 {String(run.currentRound)} 轮 · {run.unresolved.length > 0 ? `未决 ${String(run.unresolved.length)} 项` : '暂无未决问题'}</small>
      <details className="dshDesktopDebateTechDetails">
        <summary>技术详情</summary>
        <small>Run ID：{run.runId} · revision：{String(run.revision)} · Session：{run.sourceSessionId ?? 'N/A'}</small>
      </details>
    </section>
    <div className="dshDesktopDebateRunHeader">
      <div><h3>讨论楼层</h3><small>按轮次排列，每位 Agent 独立发言；引用只来自已记录的主张。</small></div>
      <RunControls run={run} resumable={resumable} pending={props.pending} onControl={props.onControl} />
    </div>
    <section className="dshDesktopDebateRoles" aria-label="参与 Agent 与角色职责">
      <details className="dshDesktopDebateRoster">
        <summary><strong>参与者名册</strong><span>{String(run.roles.length)} 位 Agent · 点击展开角色职责</span></summary>
        <div className="dshDesktopDebateRosterGrid">
          {run.roles.map(role => <RoleCard key={role.role} role={role} />)}
        </div>
      </details>
    </section>
    <section className="dshDesktopDebateRounds">
      <h3>逐轮讨论</h3>
      <p className="dshDesktopDebateSectionHint">每张卡片对应一个论坛楼层；只展示 Agent 明确提交的公开摘要，不展示私有指令或隐藏推理。</p>
      {run.rounds.map(round => <article key={round.round} data-state={round.state}>
        <div className="dshDesktopDebateRoundHeading"><strong>第 {String(round.round)} 轮</strong><em>{roundStateLabel(round.state)}</em></div>
        <div className="dshDesktopDebateTurnList">
          {round.turnStates.filter(turn => turn.role !== 'decision-judge' && terminalTurnState(turn.state)).length === 0
            ? <p className="dshDesktopDebateEmpty">参与者尚未提交公开发言。</p>
            : round.turnStates
              .filter(turn => turn.role !== 'decision-judge' && terminalTurnState(turn.state))
              .map(turn => <DebateTurnCard key={`${String(round.round)}-${turn.slotId}`} run={run} turn={turn} floor={floors.get(`${String(round.round)}-${turn.slotId}`) ?? 1} />)}
        </div>
        {round.convergence !== undefined && <p>
          {convergenceLabel(round.convergence.status)}
          {' · '}分数 {percent(round.convergence.score)} / 阈值 {percent(round.convergence.threshold)}
          {' · '}覆盖 {percent(round.convergence.coverage)}
          {' · '}高严重度未决 {String(round.convergence.unresolvedHighSeverity)}
        </p>}
      </article>)}
    </section>
    <EventTimeline events={props.events ?? []} />
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
      <strong>{roleLabel(role.role)}</strong>
      <em>{turnStateLabel(turn?.state ?? 'planned')}</em>
    </div>
    <p className="dshDesktopDebateRoleMandate">角色：{role.title}<br />职责：{role.mandate}</p>
    {turn !== undefined && <p>
      第 {String(turn.round)} 轮 · Attempt {String(turn.attempt ?? 1)} · Claim {String(turn.claimIds.length)}
      {' · '}Evidence {String(turn.evidenceRefs.length)}
    </p>}
    <details className="dshDesktopDebateTechDetails">
      <summary>角色技术详情</summary>
      <div className="dshDesktopDebateRoute" aria-label="算子路由">
        <small title={`${route.requestedOperatorId} · ${route.requestedModel}`}>请求：<span>{displayRouteValue(route.requestedOperatorId)} · {displayRouteValue(route.requestedModel)}</span></small>
        {route.actualOperatorId === undefined || route.actualModel === undefined
          ? <small>实际：尚未执行</small>
          : <small title={`${route.actualOperatorId} · ${route.actualModel}`}>实际：<span>{displayRouteValue(route.actualOperatorId)} · {displayRouteValue(route.actualModel)}</span></small>}
        <small>{role.source === 'native-subscription' ? '订阅套餐' : role.source}</small>
      </div>
      {turn?.routing?.fallbackReasonCode !== undefined && <p className="dshDesktopDebateFallback">
        回退：{turn.routing.fallbackReasonCode}
      </p>}
      {turn?.blockers !== undefined && <BlockerList blockers={turn.blockers} />}
    </details>
  </article>
}

function DebateTurnCard({ run, turn, floor }: { run: DesktopDebateRun; turn: DesktopDebateRound['turnStates'][number]; floor: number }) {
  const role = run.roles.find(entry => entry.role === turn.role || entry.role === turn.slotId)
  const title = roleLabel(role?.role ?? turn.role)
  const route = turnRoute(role, turn)
  const claimText = claimReferences(run, turn.claimIds)
  const evidenceText = turn.evidenceRefs.length > 0 ? `${String(turn.evidenceRefs.length)} 项` : 'N/A'
  const blockerSummary = turn.blockers?.[0]?.message
  return <article className="dshDesktopDebateTurn" data-state={turn.state}>
    <div className="dshDesktopDebateTurnHeader">
      <strong><span className="dshDesktopDebateFloor">{String(floor)} 楼</span>{title}</strong>
      <em>{turnStateLabel(turn.state)}</em>
    </div>
    {turn.round === 1
      ? <p className="dshDesktopDebateReplyRef">首轮独立发言</p>
      : <p className="dshDesktopDebateReplyRef">Claim Ledger 后续发言</p>}
    <p className="dshDesktopDebateTurnSummary"><strong>公开发言：</strong>{turn.outputPreview ?? (blockerSummary === undefined ? '尚未记录公开输出。' : `未产生公开输出：${blockerSummary}`)}</p>
    {turn.claimIds.length > 0 && <p className="dshDesktopDebateReplyRef">本楼提交主张：{claimText}</p>}
    {turn.evidenceRefs.length > 0 && <p className="dshDesktopDebateReplyRef">已关联证据：{evidenceText}</p>}
    {turn.errorCode !== undefined && <p className="dshDesktopDebateTurnError">未完成：{turn.errorCode}</p>}
    <details className="dshDesktopDebateTechDetails">
      <summary>技术详情</summary>
      <div className="dshDesktopDebateRoute" aria-label="本轮算子路由">
        <small title={`${route.requestedOperatorId} · ${route.requestedModel}`}>请求：<span>{displayRouteValue(route.requestedOperatorId)} · {displayRouteValue(route.requestedModel)}</span></small>
        {route.actualOperatorId === undefined || route.actualModel === undefined
          ? <small>实际：尚未执行</small>
          : <small title={`${route.actualOperatorId} · ${route.actualModel}`}>实际：<span>{displayRouteValue(route.actualOperatorId)} · {displayRouteValue(route.actualModel)}</span></small>}
        {turn.attempt !== undefined && <small>Attempt {String(turn.attempt)}</small>}
      </div>
      {turn.outputRef !== undefined && <code title={turn.outputRef}>输出 Artifact · {turn.outputRef}</code>}
      {turn.claimIds.length > 0 && <small>Claim refs：{turn.claimIds.join('、')}</small>}
      {turn.evidenceRefs.length > 0 && <small>Evidence refs：{turn.evidenceRefs.join('、')}</small>}
      {turn.usage !== undefined && <small>{turnUsageLabel(turn.usage)}</small>}
      {(turn.startedAt !== undefined || turn.settledAt !== undefined) && <div className="dshDesktopDebateTurnTimes">
        {turn.startedAt !== undefined && <time dateTime={turn.startedAt} title={turn.startedAt}>开始 {formatTime(turn.startedAt)}</time>}
        {turn.settledAt !== undefined && <time dateTime={turn.settledAt} title={turn.settledAt}>完成 {formatTime(turn.settledAt)}</time>}
      </div>}
      {turn.routing?.fallbackReasonCode !== undefined && <p className="dshDesktopDebateFallback">回退：{turn.routing.fallbackReasonCode}</p>}
      {turn.blockers !== undefined && <BlockerList blockers={turn.blockers} />}
    </details>
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

function EventTimeline({ events }: { events: DesktopDebateEvent[] }) {
  const visibleEvents = dedupeDebateEvents(events).slice(-40)
  return <section className="dshDesktopDebateEvents" aria-label="Debate 讨论动态">
    <h3>讨论动态</h3>
    {visibleEvents.length === 0
      ? <p className="dshDesktopDebateEmpty">还没有讨论动态。</p>
      : <ol>{visibleEvents.map(event => <li key={debateEventIdentity(event)}>
        <time dateTime={event.createdAt} title={event.createdAt}>{formatTime(event.createdAt)}</time>
        <strong>{debateEventLabel(event.type)}</strong>
        <span>{debateEventContext(event)}</span>
        <small>{debateEventSummary(event)}</small>
        {debateEventTechnicalDetail(event) !== undefined && <details className="dshDesktopDebateTechDetails"><summary>技术详情</summary><small>{debateEventTechnicalDetail(event)}</small></details>}
      </li>)}</ol>}
  </section>
}

function dedupeDebateEvents(events: readonly DesktopDebateEvent[]): DesktopDebateEvent[] {
  const seen = new Set<string>()
  return events.filter((event) => {
    if (!isDebateErrorEvent(event.type)) return true
    const key = debateEventIdentity(event)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function debateEventIdentity(event: DesktopDebateEvent): string {
  const attempt = eventValue(event, 'attempt', '')
  const blockers = Array.isArray(event.data.blockers) ? event.data.blockers : []
  const nodeIds = blockers.map((blocker) => {
    if (blocker === null || typeof blocker !== 'object') return ''
    const nodeId = (blocker as { readonly nodeId?: unknown }).nodeId
    return typeof nodeId === 'string' ? nodeId : ''
  }).join('\u0001')
  const messages = blockers.map((blocker) => {
    if (blocker === null || typeof blocker !== 'object') return ''
    const message = (blocker as { readonly message?: unknown }).message
    return typeof message === 'string' ? message : ''
  }).join('\u0001') || eventValue(event, 'error', eventValue(event, 'reason', ''))
  return [event.runId, event.sequence, attempt, nodeIds, messages].join('\u0000')
}

function isDebateErrorEvent(type: string): boolean {
  return type === 'debate.agent.blocked' || type === 'debate.agent.failed' || type === 'debate.agent.indeterminate'
    || type === 'debate.failed' || type === 'debate.indeterminate'
}

export function EvidenceColumn({ run }: { run?: DesktopDebateRun | undefined }) {
  if (run === undefined) return <aside className="dshDesktopDebateColumn" />
  const moderatorTurn = [...run.rounds]
    .reverse()
    .flatMap(round => [...round.turnStates].reverse())
    .find(turn => turn.role === 'decision-judge')
  return <aside className="dshDesktopDebateColumn dshDesktopDebateEvidence">
    <CostCard run={run} />
    <section className="dshDesktopDebatePinned" aria-label="置顶 · 主持人总结 / 决策裁判"><h3><span className="dshDesktopDebatePinnedLabel">置顶</span> 主持人总结 / 决策裁判</h3>
      {run.synthesis === undefined
        ? <>
          <p className="dshDesktopDebateEmpty">尚未生成综合结果。</p>
          {moderatorTurn !== undefined && <p>主持人状态：{turnStateLabel(moderatorTurn.state)}</p>}
          {moderatorTurn?.blockers !== undefined && <BlockerList blockers={moderatorTurn.blockers} />}
        </>
        : <>
          <p><strong>{synthesisLabel(run.synthesis.state)}</strong> · 保留异议 {String(run.synthesis.dissentCount)}</p>
          {run.synthesis.outputPreview !== undefined && <p>{run.synthesis.outputPreview}</p>}
          {run.synthesis.artifactRef !== undefined && <details className="dshDesktopDebateTechDetails"><summary>总结技术详情</summary><code title={run.synthesis.artifactRef}>{run.synthesis.artifactRef}</code></details>}
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

function debateEventContext(event: DesktopDebateEvent): string {
  const roleId = typeof event.data.role === 'string' ? event.data.role : event.slotId
  const round = event.round ?? eventNumber(event.data.round)
  return [
    round === undefined ? 'Run' : `第 ${String(round)} 轮`,
    roleId === undefined ? undefined : roleLabel(roleId),
    `#${String(event.sequence)}`,
  ].filter((value): value is string => value !== undefined).join(' · ')
}

function debateEventSummary(event: DesktopDebateEvent): string {
  if (event.type === 'debate.planned') return '讨论主题已建立，等待参与者进入。'
  if (event.type === 'debate.roster.qualified') return '参与者已通过准入检查。'
  if (event.type === 'debate.roster.rejected') return '部分参与者未通过准入，讨论无法按原计划进行。'
  if (event.type === 'debate.admitted') return '讨论已获得执行准入。'
  if (event.type === 'debate.round.started') return `第 ${eventValue(event, 'round', event.round === undefined ? 'N/A' : String(event.round))} 轮已开始。`
  if (event.type === 'debate.agent.dispatched') return `${roleLabel(eventValue(event, 'role', event.slotId ?? 'Agent'))} 已开始发言。`
  if (event.type === 'debate.agent.settled') return `${roleLabel(eventValue(event, 'role', event.slotId ?? 'Agent'))} 已提交公开发言。`
  if (event.type === 'debate.agent.blocked') return `${roleLabel(eventValue(event, 'role', event.slotId ?? 'Agent'))} 暂未完成，正在等待资源。`
  if (event.type === 'debate.agent.failed') return `${roleLabel(eventValue(event, 'role', event.slotId ?? 'Agent'))} 未完成本轮发言。`
  if (event.type === 'debate.agent.indeterminate') return `${roleLabel(eventValue(event, 'role', event.slotId ?? 'Agent'))} 的结果需要确认。`
  if (event.type === 'debate.claims.compiled') return '本轮主张、异议和未决问题已整理。'
  if (event.type === 'debate.convergence.evaluated') return `本轮判断：${convergenceLabel(eventValue(event, 'status'))}。`
  if (event.type === 'debate.synthesis.started') return '主持人正在综合各楼层发言。'
  if (event.type === 'debate.synthesis.settled') return '主持人已提交最终综合结果。'
  if (event.type === 'debate.cost.accounted') return '本轮用量与费用已更新。'
  if (event.type === 'debate.stopped') return `讨论已${eventValue(event, 'action') === 'pause' ? '暂停' : '停止'}。`
  if (event.type === 'debate.failed') return '讨论失败，未能完成全部流程。'
  if (event.type === 'debate.indeterminate') return '讨论状态不确定，需要人工确认。'
  return '状态已记录。'
}

function debateEventTechnicalDetail(event: DesktopDebateEvent): string | undefined {
  const details: string[] = []
  if (event.type === 'debate.agent.dispatched' || event.type === 'debate.agent.settled'
    || event.type === 'debate.agent.blocked' || event.type === 'debate.agent.failed'
    || event.type === 'debate.agent.indeterminate') {
    details.push(`角色 ID：${eventValue(event, 'role', event.slotId ?? 'N/A')}`)
    details.push(`请求算子/模型：${eventValue(event, 'requestedOperatorId', eventValue(event, 'operatorId'))}/${eventValue(event, 'requestedModel', eventValue(event, 'model'))}`)
    const actual = [eventValue(event, 'actualOperatorId', ''), eventValue(event, 'actualModel', '')].filter(Boolean).join('/')
    if (actual.length > 0) details.push(`实际算子/模型：${actual}`)
    const fallback = eventValue(event, 'fallbackReasonCode', '')
    if (fallback.length > 0) details.push(`回退原因：${fallback}`)
    const attempt = eventValue(event, 'attempt', '')
    if (attempt.length > 0) details.push(`Attempt：${attempt}`)
    const errorCode = eventValue(event, 'errorCode', '')
    if (errorCode.length > 0) details.push(`错误码：${errorCode}`)
  }
  if (event.type === 'debate.planned') details.push(`模式：${eventValue(event, 'mode')} · 阵容数量：${eventValue(event, 'rosterSize')}`)
  if (event.type === 'debate.roster.qualified') details.push(`角色：${eventList(event, 'roles')} · 每轮上限：${eventValue(event, 'maxAgentsPerRound')}`)
  if (event.type === 'debate.roster.rejected') details.push(`角色：${eventList(event, 'roles')} · 原因：${eventValue(event, 'reason', 'N/A')}`)
  if (event.type === 'debate.round.started') details.push(`阶段：${eventValue(event, 'phase')} · 槽位：${eventList(event, 'slotIds')}`)
  if (event.type === 'debate.agent.settled') details.push(`Claim 数：${eventValue(event, 'claimCount', '0')} · Evidence 数：${eventValue(event, 'evidenceCount', '0')} · 置信度：${eventValue(event, 'confidence')}`)
  if (event.type === 'debate.agent.blocked') details.push(`阻断信息：${eventValue(event, 'blockerMessages', eventValue(event, 'error', 'N/A'))}`)
  if (event.type === 'debate.claims.compiled') details.push(`Claim：${eventValue(event, 'claimCount', '0')} · 异议：${eventValue(event, 'dissentCount', '0')} · 未决：${eventValue(event, 'unresolvedCount', '0')}`)
  if (event.type === 'debate.convergence.evaluated') details.push(`分数：${eventValue(event, 'score')} · 阈值：${eventValue(event, 'threshold')} · 原因：${eventValue(event, 'reason')}`)
  if (event.type === 'debate.synthesis.settled') details.push(`未决 Claim：${eventList(event, 'unresolvedClaimIds')} · 异议：${eventValue(event, 'dissentCount', '0')}`)
  if (event.type === 'debate.cost.accounted') details.push(`用量：${eventValue(event, 'usageStatus')} · 费用：${eventValue(event, 'costStatus')} · 输入：${eventValue(event, 'inputTokens')} · 输出：${eventValue(event, 'outputTokens')}`)
  if (event.type === 'debate.stopped') details.push(`动作：${eventValue(event, 'action')} · 原因：${eventValue(event, 'reason')}`)
  if (event.type === 'debate.failed' || event.type === 'debate.indeterminate') details.push(`错误码：${eventValue(event, 'errorCode')} · 原因：${eventValue(event, 'reason', eventValue(event, 'error'))}`)
  return details.length === 0 ? undefined : details.join(' · ')
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
    'constructive-proposer': '建设性提案者', 'skeptical-falsifier': '怀疑式证伪者', 'evidence-auditor': '证据审计员', 'decision-judge': '决策裁判（主持人）',
  } as Record<string, string>)[role] ?? role
}

function claimReferences(run: DesktopDebateRun, ids: readonly string[]): string {
  return ids.slice(0, 8).map((id) => {
    const claim = run.claims.find(item => item.claimId === id)
    return claim === undefined ? `编号 ${id}` : `“${claim.statement}”`
  }).join('、') || 'N/A'
}

function turnStateLabel(state: string): string {
  return ({ planned: '待执行', dispatched: '运行中', settled: '已完成', blocked: '已阻断', failed: '失败', indeterminate: '不确定' } as Record<string, string>)[state] ?? state
}

function terminalTurnState(state: string): boolean {
  return state === 'settled' || state === 'blocked' || state === 'failed' || state === 'indeterminate'
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
