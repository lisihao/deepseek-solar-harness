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
  type DesktopDebateRun,
  type DesktopDebateRunSummary,
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
    <section className="dshDesktopDebateRoles" aria-label="Debate 角色">
      {run.roles.map(role => <RoleCard key={role.role} role={role} />)}
    </section>
    <section className="dshDesktopDebateRounds">
      <h3>轮次与收敛</h3>
      {run.rounds.map(round => <article key={round.round} data-state={round.state}>
        <div><strong>第 {String(round.round)} 轮</strong><em>{roundStateLabel(round.state)}</em></div>
        <small>{round.turnStates.map(turn => `${roleLabel(turn.slotId)}：${turnStateLabel(turn.state)}`).join(' · ') || '尚未派发'}</small>
        {round.convergence !== undefined && <p>
          {convergenceLabel(round.convergence.status)}
          {' · '}分数 {percent(round.convergence.score)} / 阈值 {percent(round.convergence.threshold)}
          {' · '}覆盖 {percent(round.convergence.coverage)}
          {' · '}高严重度未决 {String(round.convergence.unresolvedHighSeverity)}
        </p>}
      </article>)}
    </section>
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
  return <article data-state={turn?.state ?? 'planned'}>
    <div>
      <span className="dshDesktopDebateDot" />
      <strong>{role.title}</strong>
      <em>{turnStateLabel(turn?.state ?? 'planned')}</em>
    </div>
    <small>{role.operatorId} · {role.model} · {role.source === 'native-subscription' ? '订阅套餐' : role.source}</small>
    {turn !== undefined && <p>
      第 {String(turn.round)} 轮 · Claim {String(turn.claimIds.length)}
      {' · '}Evidence {String(turn.evidenceRefs.length)}
    </p>}
  </article>
}

export function EvidenceColumn({ run }: { run?: DesktopDebateRun | undefined }) {
  if (run === undefined) return <aside className="dshDesktopDebateColumn" />
  return <aside className="dshDesktopDebateColumn dshDesktopDebateEvidence">
    <CostCard run={run} />
    <section><h3>最终综合</h3>
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
  return ({ planned: '待执行', dispatched: '运行中', settled: '已完成', failed: '失败', indeterminate: '不确定' } as Record<string, string>)[state] ?? state
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
