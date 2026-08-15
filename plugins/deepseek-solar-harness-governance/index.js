import { randomUUID } from 'node:crypto'
import { GovernanceService } from './lib/service.js'
import { registerGovernanceTraceRoute } from './lib/web.js'

export const name = 'code-harness-governance'
export const inject = ['tools', 'sessions']

const PLUGIN_SOURCE = Object.freeze({ kind: 'plugin', plugin: name })
const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function continuationMessage(text) {
  const content = Object.freeze([Object.freeze({ type: 'text', text })])
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content,
    source: PLUGIN_SOURCE,
  })
}

function output() {
  return {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
}

function traceOutput() {
  return {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => {
      const header = `governance trace phase=${String(value.phase)} work_id=${String(value.workId ?? 'N/A')} events=${String(value.returnedEvents)}/${String(value.totalEvents)}`
      const rows = Array.isArray(value.events)
        ? value.events.map(event => [
            `#${String(event.sequence)}`,
            String(event.timestamp ?? 'N/A'),
            String(event.type),
            `phase=${String(event.phaseAfter)}`,
            event.decision === undefined ? null : `decision=${String(event.decision)}`,
            event.gateId === undefined ? null : `gate=${String(event.gateId)}:${String(event.status)}`,
            event.reasonCode === undefined ? null : `reason=${String(event.reasonCode)}`,
          ].filter(Boolean).join(' '))
        : []
      return [{ type: 'text', text: [header, ...rows].join('\n') }]
    },
  }
}

function objectParameters(properties = {}, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

function requireAgent(exec) {
  if (exec.agent === undefined) throw new Error('governance tools require an agent-scoped execution')
  return exec.agent
}

function validateOptions(args) {
  if (args.level !== undefined && args.level !== 'quick' && args.level !== 'full') {
    throw new TypeError('level must be quick or full')
  }
  if (args.scope !== undefined && (typeof args.scope !== 'string' || args.scope.trim() === '')) {
    throw new TypeError('scope must be a non-empty string')
  }
  if (args.changed_from !== undefined && typeof args.changed_from !== 'string') {
    throw new TypeError('changed_from must be a string')
  }
  return {
    level: args.level,
    scope: args.scope,
    changedFrom: args.changed_from,
  }
}

function governanceContext(state) {
  const gates = state.gates.length === 0
    ? 'none'
    : state.gates.map(gate => `${gate.id}:${gate.status}`).join(', ')
  const text = [
    '[Code-as-Harness governance]',
    `phase=${state.phase}`,
    `work_id=${state.workId ?? 'N/A'}`,
    `gates=${gates}`,
    `accepted_head=${state.attestation?.gitHead ?? 'N/A'}`,
    state.phase === 'accepted'
      ? 'This work has fresh local governance acceptance. Remote CI and protected-branch status remain independent.'
      : 'Do not claim completion. Run governance_plan, governance_verify with level full, then governance_submit_completion. Use governance_trace to inspect durable evidence and guard decisions.',
  ].join('\n')
  return { content: [{ type: 'text', text }], source: PLUGIN_SOURCE }
}

export function apply(ctx, config = {}) {
  const governance = new GovernanceService(ctx, config)
  ctx.provide('governance', governance)
  registerGovernanceTraceRoute(ctx, governance)

  ctx.tools.register({
    name: 'governance_status',
    description: 'Read the durable Code-as-Harness certification state. Conversation or Goal completion is not certification.',
    parameters: objectParameters(),
    output: output(),
    async execute(_args, exec) {
      const agent = requireAgent(exec)
      governance.ensureWork(agent)
      governance.invalidateIfStale(agent)
      return governance.publicState(agent)
    },
  })

  ctx.tools.register({
    name: 'governance_plan',
    description: 'Audit project governance and record the exact gates selected for the current worktree.',
    parameters: objectParameters({
      level: { type: 'string', enum: ['quick', 'full'] },
      scope: { type: 'string' },
      changed_from: { type: 'string' },
    }),
    output: output(),
    async execute(args, exec) {
      return governance.plan(requireAgent(exec), validateOptions(args))
    },
  })

  ctx.tools.register({
    name: 'governance_verify',
    description: 'Execute selected project-native gates without a shell and issue change-bound evidence. Use full before completion.',
    parameters: objectParameters({
      level: { type: 'string', enum: ['quick', 'full'] },
      scope: { type: 'string' },
      changed_from: { type: 'string' },
    }),
    output: output(),
    timeoutMs: governance.config.timeoutMs + 60_000,
    async execute(args, exec) {
      return governance.verify(requireAgent(exec), validateOptions(args))
    },
  })

  ctx.tools.register({
    name: 'governance_submit_completion',
    description: 'Request completion certification. The service independently rechecks full evidence; the model cannot set accepted directly.',
    parameters: objectParameters(),
    output: output(),
    async execute(_args, exec) {
      return governance.requestCompletion(requireAgent(exec))
    },
  })

  ctx.tools.register({
    name: 'governance_trace',
    description: 'Read the durable governance event trace, including gate evidence and commit or delivery admission decisions.',
    parameters: objectParameters({
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: governance.config.maxTraceEvents,
      },
    }),
    output: traceOutput(),
    async execute(args, exec) {
      return governance.trace(requireAgent(exec), args.limit)
    },
  })

  ctx.tools.guard(exec => governance.guardExecution(exec))

  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined || result.isError || exec.name.startsWith('governance_')) return
    const kind = governance.classifyExecution(exec)
    if (kind === 'mutation' || kind === 'commit') governance.markMutation(exec.agent, exec.name)
  })

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const current = governance.state(agent)
    const directUserRequest = messages.some(message => message?.source?.kind === 'user')
    governance.ensureWork(agent, current.phase === 'accepted' && directUserRequest)
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    return {
      kind: 'enter',
      messages: [...decision.messages, governanceContext(governance.publicState(agent))],
    }
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    governance.invalidateIfStale(agent)
    const result = governance.rejectStop(agent)
    await ctx.sessions.flush(agent.session)
    if (!result.continue) return
    agent.steer(continuationMessage(
      'Code-as-Harness rejected completion. Inspect governance_status, fix or verify the work, run full governance_verify, and submit completion.',
    ))
  })
}
