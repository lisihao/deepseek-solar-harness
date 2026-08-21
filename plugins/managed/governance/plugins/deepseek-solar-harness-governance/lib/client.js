window.__ModuleLoader__.load({ id: "@lisihao/dsh-code-harness-governance", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
const __governanceCss = ".dsh-governance-view {\n  box-sizing: border-box;\n  height: 100%;\n  overflow: auto;\n  padding: 20px;\n  width: 100%;\n}\n\n.dsh-governance-panel {\n  background: var(--dsw-alias-bg-layer-1);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 14px;\n  box-sizing: border-box;\n  color: var(--dsw-alias-label-primary);\n  display: flex;\n  flex-direction: column;\n  margin: 0 auto;\n  max-width: 900px;\n  min-height: 320px;\n  overflow: hidden;\n  width: 100%;\n}\n\n.dsh-governance-header {\n  align-items: center;\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n  display: flex;\n  justify-content: space-between;\n  padding: 18px 20px;\n}\n\n.dsh-governance-header h2,\n.dsh-governance-header p {\n  margin: 0;\n}\n\n.dsh-governance-header h2 {\n  font-size: 17px;\n}\n\n.dsh-governance-header p {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n  margin-top: 4px;\n}\n\n.dsh-governance-actions {\n  display: flex;\n  gap: 6px;\n}\n\n.dsh-governance-actions button {\n  align-items: center;\n  background: transparent;\n  border: 0;\n  border-radius: 8px;\n  color: var(--dsw-alias-label-secondary);\n  cursor: pointer;\n  display: flex;\n  justify-content: center;\n  padding: 8px;\n}\n\n.dsh-governance-actions button:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.dsh-governance-summary {\n  align-items: center;\n  background: var(--dsw-alias-bg-layer-2);\n  border-bottom: 1px solid var(--dsw-alias-border-l2);\n  color: var(--dsw-alias-label-secondary);\n  display: flex;\n  font-size: 12px;\n  gap: 12px;\n  padding: 10px 20px;\n}\n\n.dsh-governance-phase {\n  border-radius: 999px;\n  padding: 3px 8px;\n}\n\n.dsh-governance-phase-accepted {\n  background: var(--dsw-alias-state-success-secondary);\n  color: var(--dsw-alias-state-success-primary);\n}\n\n.dsh-governance-phase-blocked {\n  background: var(--dsw-alias-state-error-secondary);\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.dsh-governance-phase-rejected,\n.dsh-governance-phase-invalidated {\n  background: var(--dsw-alias-state-error-secondary);\n  color: var(--dsw-alias-state-error-primary);\n}\n\n.dsh-governance-error {\n  background: var(--dsw-alias-interactive-bg-hover-danger);\n  color: var(--dsw-alias-state-error-primary);\n  margin: 16px 20px 0;\n  padding: 10px 12px;\n}\n\n.dsh-governance-events {\n  display: flex;\n  flex-direction: column;\n  gap: 10px;\n  list-style: none;\n  margin: 0;\n  max-height: min(560px, 60vh);\n  overflow: auto;\n  padding: 16px 20px 24px;\n}\n\n.dsh-governance-event {\n  background: var(--dsw-alias-bg-layer-2);\n  border: 1px solid var(--dsw-alias-border-l2);\n  border-radius: 10px;\n  padding: 12px;\n}\n\n.dsh-governance-event[data-decision='denied'] {\n  border-color: var(--dsw-alias-state-error-primary);\n}\n\n.dsh-governance-event-head {\n  align-items: center;\n  display: grid;\n  gap: 10px;\n  grid-template-columns: auto 1fr auto;\n}\n\n.dsh-governance-sequence,\n.dsh-governance-event-status {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n}\n\n.dsh-governance-event-meta,\n.dsh-governance-event-detail,\n.dsh-governance-event-message {\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  margin-top: 7px;\n}\n\n.dsh-governance-empty {\n  align-items: center;\n  color: var(--dsw-alias-label-tertiary);\n  display: flex;\n  flex: 1;\n  justify-content: center;\n  min-height: 200px;\n  padding: 24px 20px;\n  text-align: center;\n}\n\n.dsh-collaboration-section {\n  border-top: 1px solid var(--dsw-alias-border-l2);\n}\n\n.dsh-collaboration-section > h3 {\n  font-size: 15px;\n  margin: 0;\n  padding: 16px 20px 10px;\n}\n\n.dsh-collaboration-empty {\n  min-height: 120px;\n}\n\n.dsh-collaboration-event .dsh-governance-event-message {\n  white-space: pre-wrap;\n}\n\n.dsh-orchestration-run {\n  border-top: 1px solid var(--dsw-alias-border-l2);\n}\n\n.dsh-orchestration-run > header {\n  align-items: center;\n  display: flex;\n  gap: 10px;\n  justify-content: space-between;\n  padding: 14px 20px 0;\n}\n\n.dsh-orchestration-run > header span {\n  color: var(--dsw-alias-label-tertiary);\n  font-size: 12px;\n}\n\n@media (max-width: 720px) {\n  .dsh-governance-view {\n    padding: 0;\n  }\n\n  .dsh-governance-panel {\n    border-radius: 0;\n    height: 100%;\n    max-height: none;\n    max-width: none;\n    min-height: 0;\n    width: 100%;\n  }\n}\n";
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
return module.exports; } });
