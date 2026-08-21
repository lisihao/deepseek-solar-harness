const React = require('react')
const {
  IconRefreshOutline16,
} = require('@deepseek-ai/dsh-client-ui-primitives')

const { useCallback, useEffect, useRef, useState } = React
const h = React.createElement
const TRACE_PATH = '/code-harness/v1/trace'
const ORCHESTRATION_PATH = '/api/orchestrations'

function phaseLabel(phase) {
  switch (phase) {
    case 'accepted': return '已验收'
    case 'blocked': return '已阻塞'
    case 'candidate': return '待验收'
    case 'rejected': return '验收拒绝'
    case 'invalidated': return '证明失效'
    case 'verified': return '已验证'
    case 'verifying': return '验证中'
    case 'planned': return '已规划'
    case 'open': return '开发中'
    default: return '未治理'
  }
}

function eventStatus(event) {
  if (event.decision !== undefined) return event.decision
  if (event.status !== undefined) return event.status
  return event.phaseAfter
}

function formatTime(value) {
  if (typeof value !== 'string') return 'N/A'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('zh-CN', { hour12: false })
}

function TraceEvent({ event }) {
  const detail = [
    event.kind === undefined ? null : `类型 ${String(event.kind)}`,
    event.gateId === undefined ? null : `门禁 ${String(event.gateId)}`,
    event.reasonCode === undefined ? null : `原因 ${String(event.reasonCode)}`,
  ].filter(Boolean).join(' · ')
  return h('li', { className: 'dsh-governance-event', 'data-decision': event.decision },
    h('div', { className: 'dsh-governance-event-head' },
      h('span', { className: 'dsh-governance-sequence' }, `#${String(event.sequence)}`),
      h('strong', null, String(event.type)),
      h('span', { className: 'dsh-governance-event-status' }, String(eventStatus(event))),
    ),
    h('div', { className: 'dsh-governance-event-meta' }, formatTime(event.timestamp)),
    detail === '' ? null : h('div', { className: 'dsh-governance-event-detail' }, detail),
    event.message === undefined ? null : h('div', { className: 'dsh-governance-event-message' }, String(event.message)),
  )
}

function collaborationPolicyLabel(policy) {
  return ({
    auto: '智能协作',
    direct: '仅主模型',
    codex: '优先 Codex',
    'claude-code': '优先 Claude Code',
  })[String(policy)] ?? '历史策略 N/A'
}

function runStateLabel(state) {
  return ({
    awaiting_clarification: '待澄清', awaiting_approval: '待批准', running: '运行中', paused: '已暂停',
    completed: '已完成', failed: '失败', cancelled: '已取消', indeterminate: '待确认',
  })[String(state)] ?? String(state ?? 'N/A')
}

function orchestrationEventLabel(type) {
  return ({
    'run.started': 'TaskGraph 已启动',
    'capsule.resolved': 'Context Capsule 已解析',
    'context.compiled': '上下文已编译',
    'execution_plan.sealed': 'ExecutionPlan 已封印',
    'node.dispatched': 'Resident 算子已派发',
    'node.operator.progress': 'Resident 执行进度',
    'node.evidence.accepted': 'Resident 结果与 Evidence',
    'node.failed': 'Resident 节点失败',
    'run.completed': 'TaskGraph 已完成',
    'run.failed': 'TaskGraph 失败',
  })[String(type)] ?? String(type)
}

function operatorProgressLabel(phase) {
  return ({
    connecting: '正在连接原生产品', session_ready: '原生会话已接通', reasoning: '正在推理与执行',
    tool_activity: '正在使用工具', finalizing: '正在整理结果',
  })[String(phase)] ?? '正在执行'
}

function shortRef(value) {
  const text = String(value ?? 'N/A')
  const tail = text.includes(':') ? text.slice(text.lastIndexOf(':') + 1) : text
  return tail.length <= 10 ? tail : tail.slice(0, 10)
}

function orchestrationEventDetail(event) {
  if (event.type === 'run.started') {
    return `${collaborationPolicyLabel(event.data?.admission?.policy)} · 并行上限 ${String(event.data?.maxParallel ?? 'N/A')}`
  }
  if (event.type === 'node.dispatched') {
    return `${String(event.data?.operatorId ?? 'N/A')} · ${String(event.data?.contextIsolation ?? 'N/A')} · lane ${shortRef(event.data?.laneId)}`
  }
  if (event.type === 'node.operator.progress') {
    return `${String(event.data?.operatorId ?? 'N/A')} · ${operatorProgressLabel(event.data?.phase)}`
  }
  if (event.type === 'node.evidence.accepted' || (event.type === 'node.failed' && typeof event.data?.outputPreview === 'string')) {
    const output = String(event.data?.outputPreview ?? '')
    const truncated = event.data?.outputTruncated === true ? '\n…输出已截断，完整结果保留在 Evidence 产物中。' : ''
    return `${String(event.data?.operatorId ?? 'N/A')} · ${String(event.data?.stopReason ?? 'N/A')} · Evidence ${shortRef(event.data?.evidenceRef)}\n${output}${truncated}`
  }
  return ''
}

function SessionCollaborationEvent({ event }) {
  const detail = event.type === 'physical-operator/routing-decision'
    ? `${collaborationPolicyLabel(event.policy)} · ${String(event.route ?? 'N/A')} · ${String(event.reason ?? '')}`
    : event.type === 'physical-operator/dispatch'
      ? `${String(event.operatorId ?? 'N/A')} · command ${shortRef(event.commandId)}`
      : event.type === 'physical-operator/dispatch-terminal'
        ? `${String(event.code ?? 'N/A')} · command ${shortRef(event.commandId)}`
        : event.type === 'orchestration/admission'
          ? `${collaborationPolicyLabel(event.policy)} · TaskGraph ${shortRef(event.runId)} · 并行上限 ${String(event.maxParallel ?? 'N/A')}`
          : `${String(event.operatorId ?? 'N/A')}\n${String(event.outputPreview ?? '')}${event.outputTruncated === true ? '\n…输出已截断。' : ''}`
  return h('li', { className: 'dsh-governance-event dsh-collaboration-event' },
    h('div', { className: 'dsh-governance-event-head' },
      h('span', { className: 'dsh-governance-sequence' }, `#${String(event.sequence)}`),
      h('strong', null, String(event.type)),
      h('span', { className: 'dsh-governance-event-status' }, event.type === 'physical-operator/dispatch-terminal' ? '失败' : '会话'),
    ),
    h('div', { className: 'dsh-governance-event-meta' }, formatTime(event.timestamp)),
    h('div', { className: 'dsh-governance-event-message' }, detail),
  )
}

function OrchestrationEvent({ event }) {
  return h('li', { className: 'dsh-governance-event dsh-collaboration-event' },
    h('div', { className: 'dsh-governance-event-head' },
      h('span', { className: 'dsh-governance-sequence' }, `#${String(event.sequence)}`),
      h('strong', null, orchestrationEventLabel(event.type)),
      h('span', { className: 'dsh-governance-event-status' }, event.nodeId === undefined ? 'Run' : String(event.nodeId)),
    ),
    h('div', { className: 'dsh-governance-event-meta' }, formatTime(event.time)),
    orchestrationEventDetail(event) === '' ? null : h('div', { className: 'dsh-governance-event-message' }, orchestrationEventDetail(event)),
  )
}

async function fetchSessionOrchestrations(sessionId) {
  const listResponse = await fetch(`${ORCHESTRATION_PATH}?include_diagnostics=1`)
  const list = await listResponse.json()
  if (!listResponse.ok) throw new Error(list?.message ?? `HTTP ${String(listResponse.status)}`)
  const runs = (list.runs ?? []).filter(run => run.admission?.sourceSessionId === sessionId)
  return Promise.all(runs.map(async run => {
    const response = await fetch(`${ORCHESTRATION_PATH}?run_id=${encodeURIComponent(run.runId)}&include_diagnostics=1`)
    const detail = await response.json()
    if (!response.ok) throw new Error(detail?.message ?? `HTTP ${String(response.status)}`)
    return { run: (detail.runs ?? []).find(value => value.runId === run.runId) ?? run, events: detail.events ?? [] }
  }))
}

function GovernanceTraceView({ sessionId }) {
  const [trace, setTrace] = useState(null)
  const [orchestrations, setOrchestrations] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const requestSequence = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++requestSequence.current
    setLoading(true)
    try {
      const [response, sessionOrchestrations] = await Promise.all([
        fetch(`${TRACE_PATH}?sessionId=${encodeURIComponent(sessionId)}`),
        fetchSessionOrchestrations(sessionId),
      ])
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${String(response.status)}`)
      if (request !== requestSequence.current) return
      setTrace(body)
      setOrchestrations(sessionOrchestrations)
      setError(null)
    } catch (caught) {
      if (request !== requestSequence.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === requestSequence.current) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 3000)
    return () => { window.clearInterval(timer) }
  }, [refresh])

  return h('div', { className: 'dsh-governance-view', 'data-testid': 'governance-trace-view' },
    h('section', {
        className: 'dsh-governance-panel',
        role: 'region',
        'aria-label': 'Code-as-Harness 治理 Trace',
        'data-testid': 'governance-trace-panel',
      },
      h('header', { className: 'dsh-governance-header' },
        h('div', null,
          h('h2', null, 'Code-as-Harness 治理与智能协作 Trace'),
          h('p', null, `DSH 会话 ${String(sessionId)}`),
        ),
        h('div', { className: 'dsh-governance-actions' },
          h('button', { type: 'button', 'aria-label': '刷新治理 Trace', onClick: () => { void refresh() }, disabled: loading },
            h(IconRefreshOutline16, { size: 16 }),
          ),
        ),
      ),
      h('div', { className: 'dsh-governance-summary' },
        h('span', { className: `dsh-governance-phase dsh-governance-phase-${String(trace?.phase ?? 'unmanaged')}` }, phaseLabel(trace?.phase)),
        h('span', null, trace === null ? '治理事件 N/A' : `治理事件 ${String(trace.returnedEvents)}/${String(trace.totalEvents)}`),
        h('span', null, `来源 ${String(trace?.source ?? 'N/A')}`),
        loading ? h('span', null, '刷新中…') : null,
      ),
      error === null ? null : h('div', { className: 'dsh-governance-error', role: 'alert' }, error),
      trace !== null && trace.events.length === 0
        ? h('div', { className: 'dsh-governance-empty' },
          '当前 DSH 会话尚未产生 Code-as-Harness 治理事件。')
        : h('ol', { className: 'dsh-governance-events' },
          ...(trace?.events ?? []).slice().reverse().map(event => h(TraceEvent, { event, key: event.sequence })),
        ),
      h('section', { className: 'dsh-collaboration-section', 'data-testid': 'collaboration-trace-panel' },
        h('h3', null, '智能协作与 Resident 子代理'),
        h('div', { className: 'dsh-governance-summary' },
          h('span', null, trace === null ? '会话协作事件 N/A' : `会话协作事件 ${String(trace.collaboration?.returnedEvents ?? 0)}/${String(trace.collaboration?.totalEvents ?? 0)}`),
          h('span', null, `TaskGraph ${String(orchestrations.length)}`),
        ),
        (trace?.collaboration?.events ?? []).length === 0 && orchestrations.length === 0
          ? h('div', { className: 'dsh-governance-empty dsh-collaboration-empty' }, '当前会话尚未派发 Codex、Claude Code 或持久 TaskGraph。')
          : h(React.Fragment, null,
            (trace?.collaboration?.events ?? []).length === 0 ? null : h('ol', { className: 'dsh-governance-events' },
              ...trace.collaboration.events.slice().reverse().map(event => h(SessionCollaborationEvent, { event, key: `session-${String(event.sequence)}` })),
            ),
            ...orchestrations.map(({ run, events }) => h('article', { className: 'dsh-orchestration-run', key: run.runId },
              h('header', null,
                h('strong', null, String(run.title)),
                h('span', null, `${collaborationPolicyLabel(run.admission?.policy)} · ${runStateLabel(run.state)} · ${String(run.nodes?.length ?? 0)} 节点`),
              ),
              h('ol', { className: 'dsh-governance-events' },
                ...events.slice().reverse().map(event => h(OrchestrationEvent, { event, key: `${String(run.runId)}-${String(event.sequence)}` })),
              ),
            )),
          ),
      ),
      ),
    )
}

exports.inject = ['slots']
exports.apply = function apply(ctx) {
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'code-harness-governance-trace',
    order: 15,
    label: '治理 Trace',
  }, GovernanceTraceView))
}
