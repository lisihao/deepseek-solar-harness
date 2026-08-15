window.__ModuleLoader__.load({ id: "@lisihao/dsh-code-harness-governance", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const __governanceCss = ".dsh-governance-trigger {\n  align-items: center;\n  background: transparent;\n  border: 0;\n  border-radius: 8px;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  display: flex;\n  font: inherit;\n  gap: 8px;\n  min-height: 32px;\n  padding: 6px 8px;\n  width: 100%;\n}\n\n.dsh-governance-trigger:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n  color: var(--dsw-alias-label-primary);\n}\n\n.dsh-governance-trigger-rail {\n  justify-content: center;\n  padding: 7px;\n}\n\n.dsh-governance-overlay {\n  inset: 0;\n  position: fixed;\n  z-index: 1000;\n}\n\n.dsh-governance-mask {\n  background: var(--dsw-alias-bg-mask-drop);\n  border: 0;\n  inset: 0;\n  position: absolute;\n  width: 100%;\n}\n\n.dsh-governance-panel {\n  background: var(--dsw-alias-bg-layer-1);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 14px;\n  bottom: 24px;\n  box-shadow: 0 20px 56px var(--dsw-alias-bg-mask-2);\n  color: var(--dsw-alias-label-primary);\n  display: flex;\n  flex-direction: column;\n  max-width: 760px;\n  overflow: hidden;\n  position: absolute;\n  right: 24px;\n  top: 24px;\n  width: calc(100vw - 48px);\n}\n\n.dsh-governance-header {\n  align-items: center;\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n  display: flex;\n  justify-content: space-between;\n  padding: 18px 20px;\n}\n\n.dsh-governance-header h2,\n.dsh-governance-header p {\n  margin: 0;\n}\n\n.dsh-governance-header h2 {\n  font-size: 17px;\n}\n\n.dsh-governance-header p {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n  margin-top: 4px;\n}\n\n.dsh-governance-actions {\n  display: flex;\n  gap: 6px;\n}\n\n.dsh-governance-actions button {\n  align-items: center;\n  background: transparent;\n  border: 0;\n  border-radius: 8px;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  display: flex;\n  justify-content: center;\n  padding: 8px;\n}\n\n.dsh-governance-actions button:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.dsh-governance-summary {\n  align-items: center;\n  background: var(--dsw-alias-bg-layer-2);\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n  color: var(--dsw-alias-label-secondary);\n  display: flex;\n  font-size: 12px;\n  gap: 12px;\n  padding: 10px 20px;\n}\n\n.dsh-governance-phase {\n  border-radius: 999px;\n  padding: 3px 8px;\n}\n\n.dsh-governance-phase-accepted {\n  background: var(--dsw-alias-state-success-secondary);\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.dsh-governance-phase-blocked {\n  background: var(--dsw-alias-state-error-secondary);\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.dsh-governance-error {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  color: var(--dsw-alias-state-error-primary);\n  margin: 16px 20px 0;\n  padding: 10px 12px;\n}\n\n.dsh-governance-events {\n  display: flex;\n  flex: 1;\n  flex-direction: column;\n  gap: 10px;\n  list-style: none;\n  margin: 0;\n  overflow: auto;\n  padding: 16px 20px 24px;\n}\n\n.dsh-governance-event {\n  background: var(--dsw-alias-bg-layer-2);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  padding: 12px;\n}\n\n.dsh-governance-event[data-decision='denied'] {\n  border-color: var(--dsw-alias-state-error-primary);\n}\n\n.dsh-governance-event-head {\n  align-items: center;\n  display: grid;\n  gap: 10px;\n  grid-template-columns: auto 1fr auto;\n}\n\n.dsh-governance-sequence,\n.dsh-governance-event-status {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n}\n\n.dsh-governance-event-meta,\n.dsh-governance-event-detail,\n.dsh-governance-event-message {\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  margin-top: 7px;\n}\n\n.dsh-governance-empty {\n  color: var(--dsw-alias-label-tertiary);\n  padding: 48px 20px;\n  text-align: center;\n}\n\n@media (max-width: 720px) {\n  .dsh-governance-panel {\n    border-radius: 0;\n    bottom: 0;\n    right: 0;\n    top: 0;\n    width: 100%;\n  }\n}\n";
const __governanceStyleId = "@lisihao/dsh-code-harness-governance/client.css";
if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(__governanceStyleId) + ']') === null) {
  const tag = document.createElement('style');
  tag.dataset.plugin = "@lisihao/dsh-code-harness-governance";
  tag.dataset.pluginCss = __governanceStyleId;
  tag.textContent = __governanceCss;
  document.head.appendChild(tag);
}
const React = require('react')
const {
  IconCloseOutline16,
  IconCodeOutline16,
  IconRefreshOutline16,
  Tooltip,
} = require('@deepseek-ai/dsh-client-ui-primitives')

const { useCallback, useEffect, useRef, useState } = React
const h = React.createElement
const TRACE_PATH = '/code-harness/v1/trace'

function phaseLabel(phase) {
  switch (phase) {
    case 'accepted': return '已验收'
    case 'blocked': return '已阻塞'
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

function GovernanceTraceEntry({ wide, useSessions }) {
  const currentSession = useSessions(state => state.current)
  const [open, setOpen] = useState(false)
  const [trace, setTrace] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const requestSequence = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++requestSequence.current
    if (currentSession === undefined) {
      setTrace(null)
      setError('请先打开一个开发任务')
      return
    }
    setLoading(true)
    try {
      const response = await fetch(`${TRACE_PATH}?sessionId=${encodeURIComponent(currentSession)}`)
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
  }, [currentSession])

  useEffect(() => {
    if (!open) return undefined
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 3000)
    return () => { window.clearInterval(timer) }
  }, [open, refresh])

  const close = useCallback(() => { setOpen(false) }, [])
  return h(React.Fragment, null,
    h(Tooltip, { label: '治理 Trace', delayMs: 500, disabled: wide },
      h('button', {
        type: 'button',
        className: `dsh-governance-trigger${wide ? '' : ' dsh-governance-trigger-rail'}`,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': '治理 Trace',
        'data-testid': 'governance-trace-entry',
        onClick: () => { setOpen(true) },
      },
      h(IconCodeOutline16, { size: wide ? 16 : 18 }),
      wide ? h('span', null, '治理 Trace') : null,
      ),
    ),
    open ? h('div', { className: 'dsh-governance-overlay', role: 'presentation' },
      h('button', { className: 'dsh-governance-mask', type: 'button', 'aria-label': '关闭治理 Trace', onClick: close }),
      h('section', {
        className: 'dsh-governance-panel',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Code-as-Harness 治理 Trace',
        'data-testid': 'governance-trace-panel',
      },
      h('header', { className: 'dsh-governance-header' },
        h('div', null,
          h('h2', null, 'Code-as-Harness 治理 Trace'),
          h('p', null, currentSession === undefined ? '未选择任务' : `任务 ${String(currentSession)}`),
        ),
        h('div', { className: 'dsh-governance-actions' },
          h('button', { type: 'button', 'aria-label': '刷新治理 Trace', onClick: () => { void refresh() }, disabled: loading },
            h(IconRefreshOutline16, { size: 16 }),
          ),
          h('button', { type: 'button', 'aria-label': '关闭治理 Trace', onClick: close },
            h(IconCloseOutline16, { size: 16 }),
          ),
        ),
      ),
      h('div', { className: 'dsh-governance-summary' },
        h('span', { className: `dsh-governance-phase dsh-governance-phase-${String(trace?.phase ?? 'unmanaged')}` }, phaseLabel(trace?.phase)),
        h('span', null, trace === null ? '事件 N/A' : `事件 ${String(trace.returnedEvents)}/${String(trace.totalEvents)}`),
        loading ? h('span', null, '刷新中…') : null,
      ),
      error === null ? null : h('div', { className: 'dsh-governance-error', role: 'alert' }, error),
      trace !== null && trace.events.length === 0
        ? h('div', { className: 'dsh-governance-empty' }, '当前任务还没有治理事件。')
        : h('ol', { className: 'dsh-governance-events' },
          ...(trace?.events ?? []).slice().reverse().map(event => h(TraceEvent, { event, key: event.sequence })),
        ),
      ),
    ) : null,
  )
}

exports.inject = ['slots']
exports.apply = function apply(ctx) {
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'code-harness-governance-trace',
    order: 80,
    label: '治理 Trace',
  }, GovernanceTraceEntry))
}
return module.exports; } });
