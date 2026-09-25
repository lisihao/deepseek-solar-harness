const React = require('react')
const {
  IconRefreshOutline16,
} = require('@deepseek-ai/dsh-client-ui-primitives')

const { useCallback, useEffect, useRef, useState } = React
const h = React.createElement
const TRACE_PATH = '/code-harness/v1/trace'

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

function shortRef(value) {
  const text = String(value ?? 'N/A')
  const tail = text.includes(':') ? text.slice(text.lastIndexOf(':') + 1) : text
  return tail.length <= 10 ? tail : tail.slice(0, 10)
}

function governanceDecisionLabel(type) {
  return ({
    'operator.route-selected': '执行路由已决定',
    'orchestration.admitted': 'TaskGraph 已准入',
    'operator.dispatch-accepted': '算子回执已接受',
    'operator.receipt-terminal': '算子回执已终结',
  })[String(type)] ?? String(type)
}

function governanceDecisionCategory(category) {
  return ({ policy: '策略', admission: '准入', receipt: '回执' })[String(category)] ?? '决策'
}

function governanceDecisionDetail(event) {
  if (event.type === 'operator.route-selected') {
    return [collaborationPolicyLabel(event.policy), event.route, event.operatorId, event.reason]
      .filter(value => typeof value === 'string' && value !== '')
      .join(' · ')
  }
  if (event.type === 'orchestration.admitted') {
    return [
      collaborationPolicyLabel(event.policy),
      event.route,
      event.runId === undefined ? undefined : 'TaskGraph ' + shortRef(event.runId),
      event.maxParallel === undefined ? undefined : '并行上限 ' + String(event.maxParallel),
    ].filter(value => typeof value === 'string' && value !== '').join(' · ')
  }
  if (event.type === 'operator.dispatch-accepted') {
    return [
      event.operatorId,
      event.commandId === undefined ? undefined : 'receipt ' + shortRef(event.commandId),
      event.mode,
    ].filter(value => typeof value === 'string' && value !== '').join(' · ')
  }
  if (event.type === 'operator.receipt-terminal') {
    return [
      event.operatorId,
      event.commandId === undefined ? undefined : 'receipt ' + shortRef(event.commandId),
      event.code,
      event.stopReason,
    ].filter(value => typeof value === 'string' && value !== '').join(' · ')
  }
  return ''
}

function GovernanceDecisionEvent({ event }) {
  const detail = governanceDecisionDetail(event)
  return h('li', { className: 'dsh-governance-event dsh-governance-decision', 'data-category': event.category },
    h('div', { className: 'dsh-governance-event-head' },
      h('span', { className: 'dsh-governance-sequence' }, '#' + String(event.sequence)),
      h('strong', null, governanceDecisionLabel(event.type)),
      h('span', { className: 'dsh-governance-event-status' }, governanceDecisionCategory(event.category)),
    ),
    h('div', { className: 'dsh-governance-event-meta' }, formatTime(event.timestamp)),
    detail === '' ? null : h('div', { className: 'dsh-governance-event-detail' }, detail),
  )
}

function GovernanceTraceView({ sessionId }) {
  const [trace, setTrace] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const requestSequence = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++requestSequence.current
    setLoading(true)
    try {
      const response = await fetch(TRACE_PATH + '?sessionId=' + encodeURIComponent(sessionId))
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? 'HTTP ' + String(response.status))
      if (request !== requestSequence.current) return
      setTrace(body)
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
          h('h2', null, 'Code-as-Harness 治理 Trace'),
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
      h('section', { className: 'dsh-governance-evidence-section', 'data-testid': 'governance-evidence-panel' },
        h('h3', null, '治理证据'),
        trace !== null && trace.events.length === 0
          ? h('div', { className: 'dsh-governance-empty' }, '当前 DSH 会话尚未产生 Code-as-Harness 治理事件。')
          : h('ol', { className: 'dsh-governance-events' },
            ...(trace?.events ?? []).slice().reverse().map(event => h(TraceEvent, { event, key: event.sequence })),
          ),
      ),
      h('section', { className: 'dsh-governance-decisions-section', 'data-testid': 'governance-decisions-panel' },
        h('h3', null, '调度决策'),
        h('p', { className: 'dsh-governance-decision-hint' },
          '这里只记录策略、准入与回执；算子进度、工具和 Debate 发言请切换到“轨迹”标签查看。',
        ),
        h('div', { className: 'dsh-governance-summary' },
          h('span', null, trace === null ? '调度决策 N/A' : '调度决策 ' + String(trace.collaboration?.returnedEvents ?? 0) + '/' + String(trace.collaboration?.totalEvents ?? 0)),
          h('span', null, '执行详情请查看“轨迹”标签。'),
        ),
        (trace?.collaboration?.events ?? []).length === 0
          ? h('div', { className: 'dsh-governance-empty dsh-governance-decisions-empty' }, '当前会话尚未产生可展示的调度决策。')
          : h('ol', { className: 'dsh-governance-events' },
            ...(trace?.collaboration?.events ?? []).slice().reverse().map(event => h(GovernanceDecisionEvent, { event, key: 'decision-' + String(event.sequence) })),
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
