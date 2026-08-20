import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DesktopSidebarFooterActionOwnerProps } from './contracts.ts'
import type {
  DesktopOrchestrationControlRequest,
  DesktopOrchestrationDashboard,
  DesktopOrchestrationEvent,
  DesktopOrchestrationNode,
  DesktopOrchestrationRun,
} from '../orchestration-dashboard-contracts.ts'
import { ORCHESTRATION_DASHBOARD_PATH } from '../orchestration-dashboard-contracts.ts'
import { formatResidentTimestamp } from '../resident-presentation.ts'

/** Read one bounded orchestration projection from the same-origin Host endpoint. */
export async function loadOrchestrationDashboard(
  runId?: string,
  signal?: AbortSignal,
): Promise<DesktopOrchestrationDashboard> {
  const url = new URL(ORCHESTRATION_DASHBOARD_PATH, window.location.origin)
  if (runId !== undefined) url.searchParams.set('run_id', runId)
  const response = await fetch(url, { cache: 'no-store', ...(signal === undefined ? {} : { signal }) })
  if (!response.ok) {
    throw new Error(`编排状态读取失败 (${String(response.status)}): ${await response.text()}`)
  }
  return await response.json() as DesktopOrchestrationDashboard
}

/** Submit one revision-checked trusted control to the owner-local Host endpoint. */
export async function controlOrchestration(
  request: DesktopOrchestrationControlRequest,
): Promise<DesktopOrchestrationRun> {
  const response = await fetch(ORCHESTRATION_DASHBOARD_PATH, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-DSH-Orchestration-Control': '1',
    },
    body: JSON.stringify(request),
  })
  if (!response.ok) {
    const detail = await response.json().catch(() => undefined) as { message?: string } | undefined
    throw new Error(detail?.message ?? `编排控制失败 (${String(response.status)})`)
  }
  return await response.json() as DesktopOrchestrationRun
}

/** Sidebar entry and theme-coherent control surface for durable TaskGraphs. */
export function OrchestrationsPanel({ wide }: DesktopSidebarFooterActionOwnerProps) {
  const [open, setOpen] = useState(false)
  const [selectedRunId, setSelectedRunId] = useState<string>()
  const [dashboard, setDashboard] = useState<DesktopOrchestrationDashboard>()
  const [error, setError] = useState<string>()
  const [controlPending, setControlPending] = useState(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const next = await loadOrchestrationDashboard(open ? selectedRunId : undefined, signal)
    setDashboard(next)
    setError(undefined)
  }, [open, selectedRunId])

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

  useEffect(() => {
    if (!open || dashboard === undefined) return
    const selected = dashboard.runs.some(run => run.runId === selectedRunId)
    if (!selected) setSelectedRunId(dashboard.runs[0]?.runId)
  }, [dashboard, open, selectedRunId])

  useEffect(() => {
    if (!open) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('keydown', close) }
  }, [open])

  const selectedRun = dashboard?.runs.find(run => run.runId === selectedRunId)
  const active = dashboard?.runs.filter(run => ['running', 'paused'].includes(run.state)).length ?? 0
  const attention = dashboard?.runs.filter(run => (
    ['awaiting_approval', 'awaiting_clarification', 'indeterminate', 'failed'].includes(run.state)
  )).length ?? 0
  const status = error !== undefined ? 'error' : attention > 0 ? 'warn' : active > 0 ? 'running' : 'idle'

  const submit = useCallback(async (request: DesktopOrchestrationControlRequest) => {
    setControlPending(true)
    try {
      await controlOrchestration(request)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setControlPending(false)
    }
  }, [refresh])

  const label = `任务编排：${String(active)} 个运行中${attention > 0 ? `，${String(attention)} 个需处理` : ''}`
  return (
    <>
      <button
        type="button"
        className="dshDesktopOrchestrationAction"
        data-wide={wide || undefined}
        data-status={status}
        aria-label={label}
        title={label}
        onClick={() => { setOpen(true) }}
      >
        <span className="dshDesktopOrchestrationDot" aria-hidden="true" />
        {wide
          ? <><span>任务编排</span><span>{active > 0 ? `${String(active)} 运行中` : attention > 0 ? `${String(attention)} 待处理` : 'TaskGraph'}</span></>
          : <span>OG</span>}
      </button>
      {open && createPortal(
        <div className="dshDesktopOrchestrationBackdrop" role="presentation" onMouseDown={() => { setOpen(false) }}>
          <section
            className="dshDesktopOrchestrationPanel"
            role="dialog"
            aria-modal="true"
            aria-label="持久化任务编排"
            onMouseDown={event => { event.stopPropagation() }}
          >
            <header>
              <div>
                <h2>持久化任务编排</h2>
                <p>Intent → TaskGraph → Capsule → Context → ExecutionPlan → Resident 算子</p>
              </div>
              <button type="button" aria-label="关闭任务编排面板" onClick={() => { setOpen(false) }}>×</button>
            </header>
            {error !== undefined && <div className="dshDesktopOrchestrationError" role="alert">{error}</div>}
            <div className="dshDesktopOrchestrationGrid">
              <RunList
                runs={dashboard?.runs ?? []}
                selectedRunId={selectedRunId}
                onSelect={setSelectedRunId}
                generatedAt={dashboard?.generatedAt}
              />
              <GraphView
                run={selectedRun}
                events={dashboard?.events ?? []}
                controlPending={controlPending}
                onControl={submit}
              />
              <EventTimeline run={selectedRun} events={dashboard?.events ?? []} generatedAt={dashboard?.generatedAt} />
            </div>
          </section>
        </div>,
        document.body,
      )}
    </>
  )
}

function RunList(props: {
  runs: DesktopOrchestrationRun[]
  selectedRunId?: string | undefined
  onSelect: (runId: string) => void
  generatedAt?: string | undefined
}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return <div className="dshDesktopOrchestrationColumn dshDesktopOrchestrationRuns">
    <h3>编排任务</h3>
    {props.generatedAt !== undefined && <small>本机时区 {timeZone}</small>}
    {props.runs.length === 0 && <p className="dshDesktopOrchestrationEmpty">还没有持久化 TaskGraph。</p>}
    {props.runs.map(run => {
      const time = formatResidentTimestamp(run.updatedAt, props.generatedAt ?? run.updatedAt, timeZone)
      return <button
        key={run.runId}
        type="button"
        className="dshDesktopOrchestrationRun"
        data-selected={run.runId === props.selectedRunId || undefined}
        data-state={run.state}
        onClick={() => { props.onSelect(run.runId) }}
      >
        <span className="dshDesktopOrchestrationDot" />
        <span><strong>{run.title}</strong><small>{run.workspace}</small><small>{time.relative}</small></span>
        <em>{runStateLabel(run.state)}</em>
      </button>
    })}
  </div>
}

function GraphView(props: {
  run?: DesktopOrchestrationRun | undefined
  events: DesktopOrchestrationEvent[]
  controlPending: boolean
  onControl: (request: DesktopOrchestrationControlRequest) => Promise<void>
}) {
  const run = props.run
  const eventTypes = useMemo(() => new Set(props.events.map(event => event.type)), [props.events])
  if (run === undefined) {
    return <div className="dshDesktopOrchestrationColumn"><p className="dshDesktopOrchestrationEmpty">选择任务查看 DAG。</p></div>
  }
  const activeWorkers = run.nodes.filter(node => node.state === 'running').length
  const readyWorkers = run.nodes.filter(node => node.state === 'ready').length
  const cleanContext = props.events.some(event => event.type === 'capsule.resolved' && event.data.cleanContext === true)
  return <div className="dshDesktopOrchestrationColumn dshDesktopOrchestrationGraph">
    <div className="dshDesktopOrchestrationRunHeader">
      <div>
        <h3>{run.title}</h3>
        <small>Run {shortRef(run.runId)} · rev {String(run.revision)} · Graph rev {String(run.graphRevision)}</small>
      </div>
      <RunControls run={run} disabled={props.controlPending} onControl={props.onControl} />
    </div>
    <div
      className="dshDesktopCollaborationTrace"
      data-policy={run.admission?.policy ?? 'legacy'}
      aria-label="智能协作 Trace 摘要"
    >
      <p><strong>协作 Trace · {collaborationPolicyLabel(run.admission?.policy)}</strong></p>
      <p>路由：{run.admission?.route === 'taskgraph' ? '持久 TaskGraph' : '历史任务（无 admission 记录）'}</p>
      <p>并行：{String(activeWorkers)}/{String(run.maxParallel ?? 1)} worker 运行中 · {String(readyWorkers)} 个可派发</p>
      <p>上下文：{cleanContext ? 'Clean-task Capsule 已注入 · fresh native lane' : '等待 Capsule 解析'}</p>
    </div>
    <div className="dshDesktopOrchestrationPipeline" aria-label="编译流水线">
      <Stage label="Intent" complete={eventTypes.has('intent.compiled')} />
      <Stage label="Graph" complete={eventTypes.has('graph.compiled')} />
      <Stage label="Capsule" complete={eventTypes.has('capsule.resolved')} />
      <Stage label="Context" complete={eventTypes.has('context.compiled')} />
      <Stage label="Plan" complete={eventTypes.has('execution_plan.sealed')} />
      <Stage label="Operator" complete={eventTypes.has('node.dispatched')} />
    </div>
    {run.blockers.length > 0 && <Blockers blockers={run.blockers} />}
    <ol className="dshDesktopOrchestrationNodes">
      {run.nodes.map(node => <NodeCard
        key={node.id}
        node={node}
        run={run}
        disabled={props.controlPending}
        onControl={props.onControl}
      />)}
    </ol>
  </div>
}

function Stage(props: { label: string; complete: boolean }) {
  return <span data-complete={props.complete || undefined}>{props.label}</span>
}

function NodeCard(props: {
  node: DesktopOrchestrationNode
  run: DesktopOrchestrationRun
  disabled: boolean
  onControl: (request: DesktopOrchestrationControlRequest) => Promise<void>
}) {
  const node = props.node
  const profile = node.operatorProfile
  const profileLabel = profile === undefined
    ? node.operatorId ?? '算子待解析'
    : `${node.operatorId ?? '算子'} · ${profile.model ?? '默认模型'} · ${profile.effort ?? '默认强度'}`
  return <li data-state={node.state}>
    <div className="dshDesktopOrchestrationNodeTitle">
      <span className="dshDesktopOrchestrationDot" />
      <div><strong>{node.id} · {node.title}</strong><small>{node.role} · {profileLabel}</small></div>
      <em>{nodeStateLabel(node.state)}</em>
    </div>
    <div className="dshDesktopOrchestrationDependencies">
      {node.dependsOn.length === 0 ? '起点' : `依赖 ${node.dependsOn.join(' → ')}`}
    </div>
    {node.waitReason !== undefined && <div className="dshDesktopOrchestrationDependencies">
      调度等待 · {waitReasonLabel(node.waitReason.code)}
    </div>}
    <div className="dshDesktopOrchestrationMeta">
      <span>Attempt {String(node.attempt)}</span>
      <span>Generation {String(node.capabilityGeneration)}</span>
      <span>Evidence {String(node.evidenceRefs.length)}</span>
    </div>
    <div className="dshDesktopOrchestrationRefs">
      <ArtifactState label="Capsule" value={node.capabilityPlanRef} />
      <ArtifactState label="Context" value={node.contextPacketRef} />
      <ArtifactState label="ExecutionPlan" value={node.executionPlanRef} />
    </div>
    {node.blockers.length > 0 && <Blockers blockers={node.blockers} />}
    {node.state === 'indeterminate' && <div className="dshDesktopOrchestrationControls">
      <button disabled={props.disabled} type="button" onClick={() => { void props.onControl(control(node, props.run, 'retry')) }}>新 Attempt 重试</button>
      <button disabled={props.disabled} type="button" onClick={() => { void props.onControl(control(node, props.run, 'abandon')) }}>放弃结果</button>
    </div>}
  </li>
}

function ArtifactState(props: { label: string; value?: string | undefined }) {
  return <span data-ready={props.value !== undefined || undefined} title={props.value}>{props.label} {props.value === undefined ? '待生成' : shortRef(props.value)}</span>
}

function Blockers(props: { blockers: DesktopOrchestrationRun['blockers'] }) {
  return <ul className="dshDesktopOrchestrationBlockers">
    {props.blockers.map((blocker, index) => <li key={`${blocker.code}:${String(index)}`}>
      <strong>{blocker.code}</strong><span>{blocker.message}</span>
    </li>)}
  </ul>
}

function RunControls(props: {
  run: DesktopOrchestrationRun
  disabled: boolean
  onControl: (request: DesktopOrchestrationControlRequest) => Promise<void>
}) {
  const run = props.run
  const control = (action: DesktopOrchestrationControlRequest['action']): void => {
    if (['cancel', 'reject'].includes(action) && !window.confirm(`确认${action === 'cancel' ? '取消' : '拒绝'}这个编排任务？`)) return
    void props.onControl({ action, runId: run.runId, expectedRevision: run.revision, reason: 'DSH Desktop 用户操作' })
  }
  return <div className="dshDesktopOrchestrationControls">
    {run.state === 'running' && <button disabled={props.disabled} type="button" onClick={() => { control('pause') }}>暂停</button>}
    {run.state === 'paused' && <button disabled={props.disabled} type="button" onClick={() => { control('resume') }}>继续</button>}
    {run.state === 'awaiting_approval' && <>
      <button disabled={props.disabled} type="button" onClick={() => { control('approve') }}>批准</button>
      <button disabled={props.disabled} type="button" onClick={() => { control('reject') }}>拒绝</button>
    </>}
    {!['completed', 'failed', 'cancelled'].includes(run.state) && (
      <button disabled={props.disabled} type="button" onClick={() => { control('cancel') }}>取消</button>
    )}
  </div>
}

function EventTimeline(props: {
  run?: DesktopOrchestrationRun | undefined
  events: DesktopOrchestrationEvent[]
  generatedAt?: string | undefined
}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return <div className="dshDesktopOrchestrationColumn dshDesktopOrchestrationEvents">
    <h3>事件与溯源</h3>
    {props.run === undefined
      ? <p className="dshDesktopOrchestrationEmpty">选择任务查看事件。</p>
      : props.events.length === 0
        ? <p className="dshDesktopOrchestrationEmpty">还没有编排事件。</p>
        : <ol>{[...props.events].reverse().slice(0, 40).map(event => {
          const time = formatResidentTimestamp(event.time, props.generatedAt ?? event.time, timeZone)
          return <li key={event.sequence}>
            <time title={time.absolute}>{time.relative}</time>
            <strong>{eventLabel(event.type)}</strong>
            <span>{event.nodeId === undefined ? `Run · #${String(event.sequence)}` : `${event.nodeId} · A${String(event.attempt ?? 0)} · G${String(event.generation ?? 0)}`}</span>
            <small>{eventDetail(event)}</small>
          </li>
        })}</ol>}
  </div>
}

/** Present the exact collaboration preference persisted at TaskGraph admission. */
export function collaborationPolicyLabel(policy: 'auto' | 'direct' | 'codex' | 'claude-code' | undefined): string {
  return ({
    auto: '智能协作',
    direct: '仅主模型',
    codex: '优先 Codex',
    'claude-code': '优先 Claude Code',
  } as Record<string, string>)[String(policy)] ?? '历史策略 N/A'
}

/** Summarize collaboration decisions that matter in the visible Trace. */
export function eventDetail(event: DesktopOrchestrationEvent): string {
  if (event.type === 'run.started') {
    const admission = event.data.admission as { policy?: string } | null | undefined
    const policy = admission?.policy
    return `${collaborationPolicyLabel(policy === 'auto' || policy === 'direct' || policy === 'codex' || policy === 'claude-code' ? policy : undefined)} · 并行上限 ${String(event.data.maxParallel ?? 'N/A')}`
  }
  if (event.type === 'capsule.resolved') {
    return event.data.cleanContext === true ? 'Clean-task Context Capsule 已注入' : 'Capsule 未确认干净上下文'
  }
  if (event.type === 'node.dispatched') {
    return `${String(event.data.operatorId ?? 'N/A')} · ${String(event.data.contextIsolation ?? 'N/A')} · lane ${shortRef(String(event.data.laneId ?? 'N/A'))}`
  }
  return ''
}

function control(
  node: DesktopOrchestrationNode,
  run: DesktopOrchestrationRun,
  action: 'abandon' | 'retry',
): DesktopOrchestrationControlRequest {
  return {
    action,
    runId: run.runId,
    nodeId: node.id,
    expectedRevision: run.revision,
    reason: 'DSH Desktop 用户确认不确定执行结果',
  }
}

function shortRef(value: string): string {
  const tail = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value
  return tail.length <= 10 ? tail : tail.slice(0, 10)
}

function runStateLabel(state: DesktopOrchestrationRun['state']): string {
  return ({
    awaiting_clarification: '待澄清', awaiting_approval: '待批准', running: '运行中', paused: '已暂停',
    completed: '已完成', failed: '失败', cancelled: '已取消', indeterminate: '待确认',
  } as const)[state]
}

function nodeStateLabel(state: DesktopOrchestrationNode['state']): string {
  return ({
    pending: '等待依赖', ready: '可派发', awaiting_recompile: '待重编译', awaiting_approval: '待批准',
    running: '运行中', retry_wait: '等待重试', passed: '通过', failed: '失败', blocked: '阻断',
    indeterminate: '待确认', cancelled: '已取消',
  } as const)[state]
}

function waitReasonLabel(code: string): string {
  return ({
    DEPENDENCIES_PENDING: '依赖尚未完成',
    SCOPE_CONFLICT: '读写或 effect 冲突，串行执行',
    MAX_PARALLEL_REACHED: '已达到并行上限',
  } as Record<string, string>)[code] ?? code
}

function eventLabel(type: string): string {
  return ({
    'intent.compiled': 'Intent 已编译', 'graph.compiled': 'Graph 已认证', 'capsule.resolved': 'Capsule 已解析',
    'context.compiled': 'Context 已编译', 'execution_plan.sealed': 'ExecutionPlan 已封存',
    'node.dispatched': '已派发 Resident 算子', 'node.evidence.accepted': 'Evidence 已验收',
    'node.failed': '节点失败', 'node.retry_scheduled': '已安排重试', 'run.completed': '任务已完成',
    'capability_update.proposed': '能力更新已提出', 'capability_update.applied': '能力更新已应用',
    'scheduler.waiting.updated': '调度等待已更新',
  } as Record<string, string>)[type] ?? type
}
