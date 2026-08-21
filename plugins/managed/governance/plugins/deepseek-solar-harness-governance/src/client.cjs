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

function GovernanceTraceView({ sessionId }) {
  const [trace, setTrace] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const requestSequence = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++requestSequence.current
    setLoading(true)
    try {
      const response = await fetch(`${TRACE_PATH}?sessionId=${encodeURIComponent(sessionId)}`)
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${String(response.status)}`)
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
      trace !== null && trace.events.length === 0
        ? h('div', { className: 'dsh-governance-empty' },
          '当前 DSH 会话尚未产生治理事件。治理 Trace 只记录本会话内的 governance_* 工具调用和交付守卫；外部 Codex 任务与 GitHub Actions 不会自动写入这里。')
        : h('ol', { className: 'dsh-governance-events' },
          ...(trace?.events ?? []).slice().reverse().map(event => h(TraceEvent, { event, key: event.sequence })),
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
