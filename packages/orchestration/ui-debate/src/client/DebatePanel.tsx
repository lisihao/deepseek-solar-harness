import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useRef, useState } from 'react'
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
  const [runsOpen, setRunsOpen] = useState(false)
  const [insightsOpen, setInsightsOpen] = useState(false)
  const requestGeneration = useRef(0)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const generation = ++requestGeneration.current
    const next = await loadDebateDashboard(open ? selectedRunId : undefined, signal, browserRequest)
    if (generation !== requestGeneration.current) return
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
    const close = ({ key }: KeyboardEvent): void => {
      if (key !== 'Escape') return
      setRunsOpen(false)
      setInsightsOpen(false)
      setOpen(false)
    }
    window.addEventListener('keyup', close)
    return () => { window.removeEventListener('keyup', close) }
  }, [open])

  const active = dashboard?.runs.filter(run => isActive(run.state)).length ?? 0
  const attention = dashboard?.runs.filter(run => needsAttention(run.state)).length ?? 0
  const status = error !== undefined ? 'error' : attention > 0 ? 'warn' : active > 0 ? 'running' : 'idle'
  const selectedRun = selectedDashboardRun(dashboard, selectedRunId)

  const openPanel = useCallback(() => {
    requestGeneration.current += 1
    setSelectedRunId(undefined)
    setDashboard(undefined)
    setError(undefined)
    setRunsOpen(false)
    setInsightsOpen(false)
    setOpen(true)
  }, [])

  const closePanel = useCallback(() => {
    requestGeneration.current += 1
    setRunsOpen(false)
    setInsightsOpen(false)
    setOpen(false)
  }, [])

  const selectRun = useCallback((runId: string) => {
    setSelectedRunId(runId)
    setRunsOpen(false)
  }, [])

  const toggleRuns = useCallback(() => {
    setRunsOpen(value => !value)
    setInsightsOpen(false)
  }, [])

  const toggleInsights = useCallback(() => {
    setInsightsOpen(value => !value)
    setRunsOpen(false)
  }, [])

  const submit = useCallback(async (action: DesktopDebateControlAction) => {
    const run = selectedRun
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
  }, [browserRequest, refresh, selectedRun])

  const label = `Debate：${String(active)} 个运行中${attention > 0 ? `，${String(attention)} 个需处理` : ''}`
  return <>
    <button
      type="button"
      className="dshDesktopDebateAction"
      data-status={status}
      aria-label={label}
      title={label}
      onClick={openPanel}
    >
      <span className="dshDesktopDebateDot" aria-hidden="true" />
      <span>Debate</span>
    </button>
    {open && createPortal(
      <div className="dshDesktopDebateBackdrop" role="presentation" onMouseDown={closePanel}>
        <section
          className="dshDesktopDebatePanel"
          role="dialog"
          aria-modal="true"
          aria-label="多 Agent Debate"
          onMouseDown={(event) => { event.stopPropagation() }}
        >
          <header>
            <div><h2>多 Agent Debate</h2><p>独立主张 → 证伪 → 证据审计 → 决策裁判</p></div>
            <div className="dshDesktopDebateHeaderActions">
              <button
                type="button"
                className="dshDesktopDebateDrawerToggle dshDesktopDebateRunsToggle"
                aria-controls="dshDesktopDebateRuns"
                aria-expanded={runsOpen}
                onClick={toggleRuns}
              >运行列表</button>
              <button
                type="button"
                className="dshDesktopDebateDrawerToggle dshDesktopDebateInsightsToggle"
                aria-controls="dshDesktopDebateInsights"
                aria-expanded={insightsOpen}
                onClick={toggleInsights}
              >摘要</button>
              <button className="dshDesktopDebateClose" type="button" aria-label="关闭 Debate 面板" onClick={closePanel}>×</button>
            </div>
          </header>
          {error !== undefined && <div className="dshDesktopDebateError" role="alert">{error}</div>}
          <div className="dshDesktopDebateGrid">
            <RunList runs={dashboard?.runs ?? []} selectedRunId={selectedRunId} onSelect={selectRun} open={runsOpen} />
            <RunDetail
              run={selectedRun}
              events={selectedRun === undefined ? [] : dashboard?.events ?? []}
              pending={controlPending}
              onControl={submit}
            />
            <EvidenceColumn run={selectedRun} open={insightsOpen} />
          </div>
        </section>
      </div>,
      document.body,
    )}
  </>
}

/** Return only the inspected Run matching the user's current selection. */
export function selectedDashboardRun(
  dashboard: DesktopDebateDashboard | undefined,
  selectedRunId: string | undefined,
): DesktopDebateRun | undefined {
  const run = dashboard?.selectedRun
  return selectedRunId !== undefined && run?.runId === selectedRunId ? run : undefined
}

function RunList(props: {
  runs: DesktopDebateRunSummary[]
  selectedRunId?: string | undefined
  onSelect: (runId: string) => void
  open: boolean
}) {
  return <aside id="dshDesktopDebateRuns" className="dshDesktopDebateColumn dshDesktopDebateRuns" data-open={props.open ? 'true' : 'false'}>
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
  const floors = publicFloorByTurn(run)
  return <main className="dshDesktopDebateColumn dshDesktopDebateDetail">
    <section className="dshDesktopDebateTopic" aria-label="Debate 主题帖">
      <div className="dshDesktopDebateTopicHeading">
        <span className="dshDesktopDebatePinnedLabel">主题帖</span>
        <strong>{topicTitle(run)}</strong>
        <em>{lifecycleLabel(run.state)}</em>
      </div>
      <RunStatusStrip run={run} />
    </section>
    <div className="dshDesktopDebateRunHeader">
      <div><h3>讨论楼层</h3><small>按轮次排列，每位 Agent 独立发言；引用只来自已记录的主张。</small></div>
      <RunControls run={run} resumable={resumable} pending={props.pending} onControl={props.onControl} />
    </div>
    <section className="dshDesktopDebateRoles" aria-label="参与 Agent 与角色职责">
      <RosterTable roles={run.roles} />
    </section>
    <section className="dshDesktopDebateRounds">
      <h3>逐轮讨论</h3>
      <p className="dshDesktopDebateSectionHint">每张卡片对应一个论坛楼层；只展示 Agent 明确提交的公开摘要，不展示私有指令或隐藏推理。</p>
      {run.rounds.map((round) => {
        const turns = visibleRoundTurns(run, round)
        return <article key={round.round} data-state={round.state}>
          <div className="dshDesktopDebateRoundHeading"><strong>第 {String(round.round)} 轮</strong><em>{roundStateLabel(round.state)}</em></div>
          <div className="dshDesktopDebateTurnList">
            {turns.length === 0
              ? <p className="dshDesktopDebateEmpty">参与者尚未提交公开发言。</p>
              : turns.map((turn) => {
                const floor = floors.get(`${String(round.round)}-${turn.slotId}`)
                return <DebateTurnCard key={`${String(round.round)}-${turn.slotId}`} run={run} turn={turn} {...(floor === undefined ? {} : { floor })} />
              })}
          </div>
          {round.convergence !== undefined && <ConvergenceSummary convergence={round.convergence} />}
        </article>
      })}
    </section>
    <section className="dshDesktopDebateClaims">
      <h3>主张账本 · 覆盖 {percent(run.claimCoverage)}</h3>
      {run.claims.length === 0 && <p className="dshDesktopDebateEmpty">主张账本尚未生成。</p>}
      {run.claims.map(claim => <article key={claim.claimId} data-severity={claim.severity}>
        <div>
          <strong>{claim.statement}</strong>
          <em>{claimStatusLabel(claim.status)} · {severityLabel(claim.severity)} · {percent(claim.confidence)}</em>
        </div>
        {claim.rationale !== undefined && <p>{claim.rationale}</p>}
        <small>
          支持 {claim.supportingSlotIds.map(slotId => displayRoleTitle(run.roles, slotId)).join('、') || 'N/A'}
          {' · '}反对 {claim.opposingSlotIds.map(slotId => displayRoleTitle(run.roles, slotId)).join('、') || 'N/A'}
          {' · '}Evidence {String(claim.evidenceRefs.length)}
        </small>
      </article>)}
    </section>
    <EventTimeline events={props.events ?? []} roles={run.roles} />
  </main>
}

function topicTitle(run: DesktopDebateRun): string {
  const topic = run.topic?.title.trim()
  if (topic !== undefined && topic.length > 0) return topic
  const objective = run.objective?.trim()
  if (objective !== undefined && objective.length > 0) return objective
  return '历史记录缺少公开议题'
}

function RunStatusStrip({ run }: { run: DesktopDebateRun }) {
  const round = run.rounds.find(item => item.round === run.currentRound) ?? run.rounds.at(-1)
  return <dl className="dshDesktopDebateStatusStrip">
    <div><dt>运行状态</dt><dd data-state={run.state}>{lifecycleLabel(run.state)}</dd></div>
    <div><dt>当前轮次</dt><dd>{round === undefined ? `第 ${String(run.currentRound)} 轮` : `第 ${String(round.round)} 轮 · ${roundStateLabel(round.state)}`}</dd></div>
    <div><dt>未决问题</dt><dd>{run.unresolved.length === 0 ? '无' : `${String(run.unresolved.length)} 项`}</dd></div>
    {round?.convergence !== undefined && <div><dt>收敛检查</dt><dd>{convergenceLabel(round.convergence.status)}</dd></div>}
  </dl>
}

function ConvergenceSummary({ convergence }: { convergence: NonNullable<DesktopDebateRound['convergence']> }) {
  return <dl className="dshDesktopDebateConvergence">
    <div><dt>本轮结论</dt><dd>{convergenceLabel(convergence.status)}</dd></div>
    <div><dt>收敛分数</dt><dd>{percent(convergence.score)} / 阈值 {percent(convergence.threshold)}</dd></div>
    <div><dt>证据覆盖</dt><dd>{percent(convergence.coverage)}</dd></div>
    <div><dt>高严重度未决</dt><dd>{String(convergence.unresolvedHighSeverity)} 项</dd></div>
  </dl>
}

function RosterTable({ roles }: { roles: readonly DesktopDebateRole[] }) {
  return <section className="dshDesktopDebateRoster">
    <div className="dshDesktopDebateRosterHeading"><h3>参与者名册</h3><small>{String(roles.length)} 位 Agent · 名称、职责与执行状态</small></div>
    <div className="dshDesktopDebateRosterScroller">
      <table>
        <colgroup>
          <col className="dshDesktopDebateRosterRoleColumn" />
          <col className="dshDesktopDebateRosterMandateColumn" />
          <col className="dshDesktopDebateRosterOperatorColumn" />
          <col className="dshDesktopDebateRosterModelColumn" />
          <col className="dshDesktopDebateRosterStateColumn" />
        </colgroup>
        <thead><tr><th scope="col">角色</th><th scope="col">职责</th><th scope="col">算子</th><th scope="col">模型</th><th scope="col">状态</th></tr></thead>
        <tbody>{roles.map(role => <RosterRow key={role.role} role={role} />)}</tbody>
      </table>
    </div>
  </section>
}

function RosterRow({ role }: { role: DesktopDebateRole }) {
  const turn = role.latestTurn
  const route = turnRoute(role, turn)
  const display = displayRoute(route)
  return <tr data-state={turn?.state ?? 'planned'}>
    <th scope="row"><strong>{displayRoleTitle([role], role.role)}</strong></th>
    <td>{role.mandate}</td>
    <td>{display.operator}</td>
    <td>{display.model}</td>
    <td><span className="dshDesktopDebateStateBadge" data-state={turn?.state ?? 'planned'}>{turnStateLabel(turn?.state ?? 'planned')}</span>{display.fallback && <small>{fallbackDisplayLabel(route)}</small>}</td>
  </tr>
}

function DebateTurnCard({ run, turn, floor }: { run: DesktopDebateRun; turn: DesktopDebateRound['turnStates'][number]; floor?: number }) {
  const role = run.roles.find(entry => entry.role === turn.role || entry.role === turn.slotId)
  const title = displayRoleTitle(run.roles, role?.role ?? turn.role)
  const route = turnRoute(role, turn)
  const display = displayRoute(route)
  const isPublicTurn = turn.state === 'settled'
  const claims = isPublicTurn ? claimStatements(run, turn.claimIds) : []
  const evidenceText = isPublicTurn && turn.evidenceRefs.length > 0 ? `${String(turn.evidenceRefs.length)} 项` : 'N/A'
  const blockerSummary = turn.blockers?.[0]?.message
  const output = !isPublicTurn || turn.outputPreview === undefined ? undefined : publicMarkdown(turn.outputPreview)
  return <article className="dshDesktopDebateTurn" data-state={turn.state}>
    <div className="dshDesktopDebateTurnHeader">
      <strong>{floor === undefined ? null : <span className="dshDesktopDebateFloor">{String(floor)} 楼</span>}{title}</strong>
      <em>{turnStateLabel(turn.state)}</em>
    </div>
    <small className="dshDesktopDebateTurnRoute">执行：{display.operator} · {display.model}{display.fallback && <> · {fallbackDisplayLabel(route)}</>}</small>
    {!isPublicTurn
      ? <p className="dshDesktopDebateReplyRef">未提交公开发言</p>
      : turn.round === 1
        ? <p className="dshDesktopDebateReplyRef">首轮独立发言</p>
        : <p className="dshDesktopDebateReplyRef">Claim Ledger 后续发言</p>}
    {output === undefined || output.length === 0
      ? <p className="dshDesktopDebateTurnSummary">{blockerSummary === undefined ? '尚未记录公开输出。' : `未产生公开输出：${blockerSummary}`}</p>
      : <div className="dshDesktopDebateTurnSummary"><MarkdownText text={output} /></div>}
    {claims.length > 0 && <section className="dshDesktopDebateTurnClaims"><strong>本楼提交主张</strong><ol>{claims.map((claim, index) => <li key={`${String(index)}-${claim}`}>{claim}</li>)}</ol></section>}
    {isPublicTurn && turn.evidenceRefs.length > 0 && <p className="dshDesktopDebateReplyRef">已关联证据：{evidenceText}</p>}
    {turn.errorCode !== undefined && <p className="dshDesktopDebateTurnError">未完成：{turn.errorCode}</p>}
    <details className="dshDesktopDebateTechDetails">
      <summary>技术详情</summary>
      <div className="dshDesktopDebateRoute" aria-label="本轮算子路由">
        <small>请求：<span>{friendlyOperator(route.requestedOperatorId)} · {friendlyModel(route.requestedModel)}</span></small>
        {route.actualOperatorId === undefined || route.actualModel === undefined
          ? <small>实际：尚未执行</small>
          : <small>实际：<span>{friendlyOperator(route.actualOperatorId)} · {friendlyModel(route.actualModel)}</span></small>}
        {turn.attempt !== undefined && <small>执行尝试：{String(turn.attempt)}</small>}
      </div>
      {turn.outputRef !== undefined && <code title={turn.outputRef}>输出 Artifact · {turn.outputRef}</code>}
      {turn.evidenceRefs.length > 0 && <small>Evidence refs：{turn.evidenceRefs.join('、')}</small>}
      {turn.usage !== undefined && <small>{turnUsageLabel(turn.usage)}</small>}
      {(turn.startedAt !== undefined || turn.settledAt !== undefined) && <div className="dshDesktopDebateTurnTimes">
        {turn.startedAt !== undefined && <time dateTime={turn.startedAt} title={turn.startedAt}>开始 {formatTime(turn.startedAt)}</time>}
        {turn.settledAt !== undefined && <time dateTime={turn.settledAt} title={turn.settledAt}>完成 {formatTime(turn.settledAt)}</time>}
      </div>}
      {turn.routing?.fallbackReasonCode !== undefined && <p className="dshDesktopDebateFallback">回退：{fallbackReasonLabel(turn.routing.fallbackReasonCode)}</p>}
      {turn.blockers !== undefined && <BlockerList attempt={turn.attempt} blockers={turn.blockers} />}
    </details>
  </article>
}

function BlockerList({ blockers, attempt }: { blockers: readonly DesktopDebateTurnBlocker[]; attempt?: number | undefined }) {
  const uniqueBlockers = dedupeTurnBlockers(blockers, attempt)
  return <div className="dshDesktopDebateBlockers" aria-label="阻断原因">
    {uniqueBlockers.map((blocker, index) => <article key={`${blocker.code}-${String(index)}`}>
      <strong>{blockerLabel(blocker.code)}</strong>
      <p title={blocker.message}>{blocker.message}</p>
    </article>)}
  </div>
}

function dedupeTurnBlockers(
  blockers: readonly DesktopDebateTurnBlocker[],
  attempt: number | undefined,
): DesktopDebateTurnBlocker[] {
  const seen = new Set<string>()
  return blockers.filter((blocker) => {
    const key = JSON.stringify([attempt ?? null, blocker.nodeId ?? '', blocker.code, blocker.message])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function turnRoute(
  role: DesktopDebateRole | undefined,
  turn: { operatorId?: string; model?: string; routing?: DesktopDebateTurnRouting } | undefined,
): {
  requestedOperatorId: string
  requestedModel: string
  actualOperatorId?: string
  actualModel?: string
  fallbackReasonCode?: string
} {
  const routing = turn?.routing
  const actualOperatorId = routing?.actualOperatorId ?? turn?.operatorId
  const actualModel = routing?.actualModel ?? turn?.model
  return {
    requestedOperatorId: routing?.requestedOperatorId ?? role?.operatorId ?? turn?.operatorId ?? 'N/A',
    requestedModel: routing?.requestedModel ?? role?.model ?? turn?.model ?? 'N/A',
    ...(actualOperatorId === undefined ? {} : { actualOperatorId }),
    ...(actualModel === undefined ? {} : { actualModel }),
    ...(routing?.fallbackReasonCode === undefined ? {} : { fallbackReasonCode: routing.fallbackReasonCode }),
  }
}

function displayRoute(route: ReturnType<typeof turnRoute>): { operator: string; model: string; fallback: boolean } {
  const operatorId = route.actualOperatorId ?? route.requestedOperatorId
  const model = route.actualModel ?? route.requestedModel
  return {
    operator: friendlyOperator(operatorId),
    model: friendlyModel(model),
    fallback: route.fallbackReasonCode !== undefined
      || (route.actualOperatorId !== undefined && route.actualOperatorId !== route.requestedOperatorId),
  }
}

function fallbackDisplayLabel(route: ReturnType<typeof turnRoute>): string {
  const requested = fallbackModelLabel(route.requestedModel)
  const operatorId = route.actualOperatorId ?? route.requestedOperatorId
  const model = route.actualModel ?? route.requestedModel
  const target = fallbackTargetLabel(operatorId, model)
  if (route.fallbackReasonCode === 'AUTHENTICATION_UNQUALIFIED') return requested + ' 尚未通过订阅资格确认，已改用 ' + target
  if (route.fallbackReasonCode === 'MODEL_UNAVAILABLE') return requested + ' 当前不可用，已改用 ' + target
  return requested + ' 已改用 ' + target
}

function fallbackModelLabel(value: string): string {
  const canonical = value.endsWith('[1m]') ? value.slice(0, -4) : value
  return ({
    'gpt-5.6-sol': 'Codex Sol',
    'gpt-5.6-terra': 'Codex Terra',
    'gpt-5.6-luna': 'Codex Luna',
    'claude-opus-5': 'Claude Opus',
    'claude-fable-5': 'Claude Fable',
    'claude-sonnet-5': 'Claude Sonnet',
  } as Record<string, string>)[canonical] ?? friendlyModel(value)
}

function fallbackTargetLabel(operatorId: string, model: string): string {
  const canonical = model.endsWith('[1m]') ? model.slice(0, -4) : model
  const target = ({
    'codex:gpt-5.6-sol': 'Codex Sol',
    'codex:gpt-5.6-terra': 'Codex Terra',
    'codex:gpt-5.6-luna': 'Codex Luna',
    'claude-code:claude-opus-5': 'Claude Opus',
    'claude-code:claude-fable-5': 'Claude Fable',
    'claude-code:claude-sonnet-5': 'Claude Sonnet',
  } as Record<string, string>)[operatorId + ':' + canonical]
  return target ?? friendlyOperator(operatorId) + ' ' + friendlyModel(model)
}

function friendlyOperator(value: string): string {
  return ({ codex: 'Codex', 'claude-code': 'Claude Code', deepseek: 'DeepSeek' } as Record<string, string>)[value] ?? value
}

function friendlyModel(value: string): string {
  const hasOneMillionContext = value.endsWith('[1m]')
  const canonical = hasOneMillionContext ? value.slice(0, -4) : value
  const label = ({
    'gpt-5.6-sol': 'GPT-5.6 Sol',
    'gpt-5.6-terra': 'GPT-5.6 Terra',
    'gpt-5.6-luna': 'GPT-5.6 Luna',
    'claude-opus-5': 'Claude Opus 5',
    'claude-fable-5': 'Claude Fable 5',
    'claude-sonnet-5': 'Claude Sonnet 5',
  } as Record<string, string>)[canonical] ?? canonical
  return hasOneMillionContext ? label + ' · 1M 上下文' : label
}

function fallbackReasonLabel(value: string): string {
  return ({
    MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE · 请求模型当前不可用。',
    AUTHENTICATION_UNQUALIFIED: 'AUTHENTICATION_UNQUALIFIED · 请求模型尚未通过订阅资格确认。',
  } as Record<string, string>)[value] ?? '未识别回退原因 · ' + value
}

function blockerLabel(value: string): string {
  return ({
    MODEL_UNAVAILABLE: '模型不可用',
    AUTHENTICATION_UNQUALIFIED: '模型资格未确认',
    EXPLICIT_MODEL_UNAVAILABLE: '指定模型不可用',
    DEBATE_INTERRUPTED: '讨论已中断',
  } as Record<string, string>)[value] ?? '执行受阻'
}

function visibleRoundTurns(run: DesktopDebateRun, round: DesktopDebateRound): DesktopDebateRound['turnStates'] {
  // Keep failures/blockers visible for diagnosis, but only settled turns receive
  // a BBS floor and a public-speaking interpretation.
  return orderedRoundTurns(run, round).filter(turn => terminalTurnState(turn.state))
}

function orderedRoundTurns(run: DesktopDebateRun, round: DesktopDebateRound): DesktopDebateRound['turnStates'] {
  const roleOrder = new Map<string, number>(run.roles.map((role, index) => [role.role, index] as const))
  return round.turnStates
    .map((turn, index) => ({ turn, index }))
    .sort((left, right) => {
      const leftOrder = roleOrder.get(left.turn.role) ?? roleOrder.get(left.turn.slotId) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = roleOrder.get(right.turn.role) ?? roleOrder.get(right.turn.slotId) ?? Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || left.index - right.index
    })
    .map(({ turn }) => turn)
}

/** Stable floor positions derive from roster order and round, never completion order. */
function publicFloorByTurn(run: DesktopDebateRun): Map<string, number> {
  const floors = new Map<string, number>()
  const roleOrder = new Map<string, number>(run.roles.map((role, index) => [role.role, index] as const))
  const roleCount = run.roles.length
  let fallbackFloor = 1
  for (const round of [...run.rounds].sort((left, right) => left.round - right.round)) {
    const base = roleCount > 0 ? Math.max(0, round.round - 1) * roleCount : fallbackFloor - 1
    let unknownOffset = roleCount
    for (const turn of orderedRoundTurns(run, round)) {
      if (turn.state !== 'settled') continue
      const rosterOffset = roleOrder.get(turn.role) ?? roleOrder.get(turn.slotId)
      const floor = rosterOffset === undefined ? base + unknownOffset + 1 : base + rosterOffset + 1
      if (rosterOffset === undefined) unknownOffset += 1
      floors.set(`${String(round.round)}-${turn.slotId}`, floor)
      fallbackFloor = Math.max(fallbackFloor, floor + 1)
    }
  }
  return floors
}

/** Render durable public output as safe Markdown without legacy raw-HTML wrappers. */
function publicMarkdown(value: string): string {
  return value
    .replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '')
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(^|[\s，。；;])([Pp][0-3])\s*[：:]\s*/g, (_match, prefix: string, priority: string) => `${prefix}\n\n### ${priority.toUpperCase()}\n\n`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function claimStatements(run: DesktopDebateRun, ids: readonly string[]): string[] {
  return ids.map(id => run.claims.find(item => item.claimId === id)?.statement ?? '一项已记录主张')
}

function EventTimeline({ events, roles }: { events: DesktopDebateEvent[]; roles: readonly DesktopDebateRole[] }) {
  const visibleEvents = dedupeDebateEvents(events).slice(-40)
  return <details className="dshDesktopDebateEvents" aria-label="Debate 讨论动态">
    <summary><span>讨论动态</span><small>最近 {String(visibleEvents.length)} 条</small></summary>
    {visibleEvents.length === 0
      ? <p className="dshDesktopDebateEmpty">还没有讨论动态。</p>
      : <ol>{visibleEvents.map(event => <li key={debateEventIdentity(event)}>
        <time dateTime={event.createdAt} title={event.createdAt}>{formatTime(event.createdAt)}</time>
        <strong>{debateEventLabel(event.type)}</strong>
        <span>{debateEventContext(event, roles)}</span>
        <small>{debateEventSummary(event, roles)}</small>
      </li>)}</ol>}
  </details>
}

function dedupeDebateEvents(events: readonly DesktopDebateEvent[]): DesktopDebateEvent[] {
  const seen = new Set<string>()
  return events.filter((event) => {
    if (!isDebateErrorEvent(event.type) && event.type !== 'debate.agent.progress') return true
    const key = event.type === 'debate.agent.progress' ? progressEventIdentity(event) : debateEventIdentity(event)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function progressEventIdentity(event: DesktopDebateEvent): string {
  const sourceId = eventValue(event, 'orchestrationRunId', '')
  const sourceSequence = eventNumber(event.data.orchestrationSequence)
  if (sourceId !== '' && sourceSequence !== undefined) {
    return [event.runId, event.round ?? '', event.slotId ?? '', sourceId, sourceSequence].join('\u0000')
  }
  // A legacy projection without a source cursor can only be safely
  // de-duplicated by its durable event sequence.
  return [event.runId, event.sequence, event.round ?? '', event.slotId ?? ''].join('\u0000')
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

export function EvidenceColumn({ run, open = false }: { run?: DesktopDebateRun | undefined; open?: boolean }) {
  if (run === undefined) return <aside id="dshDesktopDebateInsights" className="dshDesktopDebateColumn dshDesktopDebateEvidence" data-open={open ? 'true' : 'false'} />
  const moderatorTurn = [...run.rounds]
    .reverse()
    .flatMap(round => [...round.turnStates].reverse())
    .find(turn => turn.role === 'decision-judge')
  return <aside id="dshDesktopDebateInsights" className="dshDesktopDebateColumn dshDesktopDebateEvidence" data-open={open ? 'true' : 'false'}>
    <CostCard run={run} />
    <section className="dshDesktopDebatePinned" aria-label="置顶 · 主持人总结 / 决策裁判"><h3><span className="dshDesktopDebatePinnedLabel">置顶</span> 主持人总结 / 决策裁判</h3>
      {run.synthesis === undefined
        ? <>
          <p className="dshDesktopDebateEmpty">尚未生成综合结果。</p>
          {moderatorTurn !== undefined && <p>主持人状态：{turnStateLabel(moderatorTurn.state)}</p>}
          {moderatorTurn?.blockers !== undefined && <BlockerList attempt={moderatorTurn.attempt} blockers={moderatorTurn.blockers} />}
        </>
        : <>
          <p><strong>{synthesisLabel(run.synthesis.state)}</strong> · 保留异议 {String(run.synthesis.dissentCount)}</p>
          {run.synthesis.outputPreview !== undefined && <div className="dshDesktopDebateSynthesis"><MarkdownText text={publicMarkdown(run.synthesis.outputPreview)} /></div>}
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
        <strong>{displayRoleTitle(run.roles, item.slotId)} · {percent(item.confidence)}</strong>
        <p>{item.position}</p><small>{item.reason}</small>
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

function debateEventContext(event: DesktopDebateEvent, roles: readonly DesktopDebateRole[]): string {
  const roleId = typeof event.data.role === 'string' ? event.data.role : event.slotId
  const round = event.round ?? eventNumber(event.data.round)
  return [
    round === undefined ? 'Run' : `第 ${String(round)} 轮`,
    roleId === undefined ? undefined : displayRoleTitle(roles, roleId),
  ].filter((value): value is string => value !== undefined).join(' · ')
}

function debateEventSummary(event: DesktopDebateEvent, roles: readonly DesktopDebateRole[] = []): string {
  if (event.type === 'debate.planned') return '讨论主题已建立，等待参与者进入。'
  if (event.type === 'debate.roster.qualified') return '参与者已通过准入检查。'
  if (event.type === 'debate.roster.rejected') return '部分参与者未通过准入，讨论无法按原计划进行。'
  if (event.type === 'debate.admitted') return '讨论已获得执行准入。'
  if (event.type === 'debate.round.started') return `第 ${eventValue(event, 'round', event.round === undefined ? 'N/A' : String(event.round))} 轮已开始。`
  if (event.type === 'debate.agent.dispatched') return `${displayRoleTitle(roles, eventValue(event, 'role', event.slotId ?? ''))} 已开始发言。`
  if (event.type === 'debate.agent.settled') return `${displayRoleTitle(roles, eventValue(event, 'role', event.slotId ?? ''))} 已提交公开发言。`
  if (event.type === 'debate.agent.blocked') return `${displayRoleTitle(roles, eventValue(event, 'role', event.slotId ?? ''))} 暂未完成，正在等待资源。`
  if (event.type === 'debate.agent.failed') return `${displayRoleTitle(roles, eventValue(event, 'role', event.slotId ?? ''))} 未完成本轮发言。`
  if (event.type === 'debate.agent.indeterminate') return `${displayRoleTitle(roles, eventValue(event, 'role', event.slotId ?? ''))} 的结果需要确认。`
  if (event.type === 'debate.agent.progress') return debateProgressSummary(event)
  if (event.type === 'debate.claims.compiled') return '本轮主张、异议和未决问题已整理。'
  if (event.type === 'debate.convergence.evaluated') return `本轮判断：${convergenceLabel(eventValue(event, 'status'))}。`
  if (event.type === 'debate.synthesis.started') return '主持人正在综合各楼层发言。'
  if (event.type === 'debate.synthesis.settled') return '主持人已提交最终综合结果。'
  if (event.type === 'debate.cost.accounted') return '本轮用量与费用已更新。'
  if (event.type === 'debate.stopped') return `讨论已${eventValue(event, 'action') === 'pause' ? '暂停' : '停止'}。`
  if (event.type === 'debate.failed') return '讨论失败，未能完成全部流程。'
  if (event.type === 'debate.indeterminate') return '讨论状态不确定，需要人工确认。'
  return '相关生命周期信息已更新。'
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
    'debate.agent.progress': 'Agent 执行进展',
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
  } as Record<string, string>)[type] ?? '其他 Debate 事件'
}

function debateProgressSummary(event: DesktopDebateEvent): string {
  const kind = eventValue(event, 'kind', '')
  if (kind === 'phase') return `阶段：${progressPhaseLabel(eventValue(event, 'phase', '执行中'))}`
  if (kind === 'public-output') return `公开进展：${publicProgressText(eventValue(event, 'publicOutputPreview', '已收到公开输出。'))}`
  if (kind === 'tool-started') return `开始调用工具：${publicProgressText(eventValue(event, 'toolName', '工具'))}`
  if (kind === 'tool-completed') return `工具已完成：${publicProgressText(eventValue(event, 'toolName', '工具'))}`
  if (kind === 'approval-required') {
    const preview = eventValue(event, 'approvalPreview', '')
    return `等待批准：${publicProgressText(eventValue(event, 'approvalKind', '需要批准'))}${preview === '' ? '' : ` · ${publicProgressText(preview)}`}`
  }
  if (kind === 'usage-updated') {
    const usage = event.data.usage
    if (usage !== null && typeof usage === 'object') {
      const values = usage as Record<string, unknown>
      const input = formatOptionalNumber(typeof values.inputTokens === 'number' ? values.inputTokens : undefined)
      const output = formatOptionalNumber(typeof values.outputTokens === 'number' ? values.outputTokens : undefined)
      return `用量更新：输入 ${input} · 输出 ${output}`
    }
    return '用量更新：已收到新的归集信息。'
  }
  return '执行进展已更新。'
}

function progressPhaseLabel(value: string): string {
  return ({
    connecting: '连接执行器', connected: '原生会话已接通', reasoning: '推理中',
    tool_activity: '工具执行中', finalizing: '整理结果', working: '执行中',
  } as Record<string, string>)[value] ?? '执行中'
}

function publicProgressText(value: string): string {
  const cleaned = publicMarkdown(value).replace(/\s+/g, ' ').trim()
  if (cleaned.length <= 240) return cleaned
  return `${cleaned.slice(0, 237)}…`
}

function eventValue(event: DesktopDebateEvent, key: string, fallback = 'N/A'): string {
  const value = event.data[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return fallback
}

function eventNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function displayRoleTitle(roles: readonly DesktopDebateRole[], roleId: string): string {
  const role = roles.find(entry => entry.role === roleId)
  const title = role?.title.trim()
  // A legacy projection may repeat the internal role ID as its title. Keep
  // that identifier out of the reader-facing Debate surface.
  if (title !== undefined && title.length > 0 && title !== role?.role) return title
  return roleLabel(role?.role ?? roleId)
}

function lifecycleLabel(state: DesktopDebateLifecycle): string {
  return ({
    planned: '已规划', awaiting_approval: '等待批准', admitting: '准入中', round_running: '辩论中', reviewing: '审查中',
    converged: '已收敛', next_round: '准备下一轮', budget_limited: '达到预算上限', max_rounds: '达到轮次上限', synthesizing: '综合中',
    completed: '已完成', stopped: '已暂停/停止', failed: '失败', indeterminate: '状态不确定',
  } as const)[state]
}

function roleLabel(role: string): string {
  return ({
    'constructive-proposer': '建设性提案者', 'skeptical-falsifier': '怀疑式证伪者', 'evidence-auditor': '证据审计员', 'decision-judge': '决策裁判（主持人）',
  } as Record<string, string>)[role] ?? '参与者'
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
  return ({ converged: '已收敛', continue: '继续辩论', budget_limited: '本轮达到预算上限', max_rounds: '达到轮次上限' } as Record<string, string>)[state] ?? state
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
