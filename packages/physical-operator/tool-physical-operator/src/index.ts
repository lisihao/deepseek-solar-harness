/**
 * Model-facing `physical_operator` consumer. The model discovers stable
 * operator ids and invokes one without selecting a subprocess, SDK, model, or
 * provider transport. All execution remains on `ctx.physicalOperators`.
 *
 * @module @deepseek-ai/dsh-tool-physical-operator
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  isAgentLoopRequest,
  LlmAdapter,
  type ContentBlock,
  type GenerateOptions,
  type LlmCallConfig,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import type {
  PhysicalOperatorExecutionPreference,
  PhysicalOperatorReasoningEffort,
  PhysicalOperatorResult,
  PhysicalOperatorRun,
  PhysicalOperatorStatus,
} from '@deepseek-ai/dsh-physical-operator'
import { PhysicalOperatorExecutionId } from '@deepseek-ai/dsh-physical-operator'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  PhysicalOperatorRoutingOption,
  PhysicalOperatorRoutingPolicy,
  PhysicalOperatorRoutingSelect,
  PhysicalOperatorProfileOwner,
  PhysicalOperatorProfilePreferences,
  PhysicalOperatorProfilePreferencesSelect,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole-value physical-operator routing preference for subsequent model requests.
     * @param policy The selected automatic, direct, Codex, or Claude Code policy.
     */
    'physical-operator/policy': { policy: PhysicalOperatorRoutingPolicy }
    /** Whole-value preference update for one native Resident product. */
    'physical-operator/profile': {
      operatorId: PhysicalOperatorProfileOwner
      profile: PhysicalOperatorExecutionPreference | null
    }
    /** Durable collaboration admission decision for one user request. */
    'physical-operator/routing-decision': {
      policy: PhysicalOperatorRoutingPolicy
      route: 'primary-model' | 'resident' | 'taskgraph-candidate'
      requestedByMessageId: string
      reason: string
      operatorId?: string
    }
    /** Durable host decision that binds one DSH message to one Resident command. */
    'physical-operator/dispatch': {
      commandId: string
      operatorId: string
      promptMessageId: string
      requestedByMessageId: string
      turn: number
      step: number
      recovered: boolean
      residentProfile?: PhysicalOperatorExecutionPreference
      fallbackConfig?: LlmCallConfig
    }
    /** Non-cancellation terminal failure; prevents an endless cold-resume loop. */
    'physical-operator/dispatch-terminal': {
      commandId: string
      code: string
    }
  }
}

export const name = 'tool-physical-operator'
export const inject = ['tools', 'physicalOperators', 'systemPrompt', 'llm', 'agents']

const ROUTER_PROVIDER = 'dsh-physical-operator'
const RESUME_SOURCE = 'physical-operator-resume'

interface PendingHostRoute {
  readonly commandId: string
  readonly operatorId: string
  readonly promptMessageId: string
  readonly requestedByMessageId: string
  readonly recovered: boolean
  readonly residentProfile?: PhysicalOperatorExecutionPreference
  readonly fallbackConfig?: LlmCallConfig
}

interface DispatchRecord extends PendingHostRoute {
  readonly turn: number
  readonly step: number
  readonly seq: number
}

interface HostRouteMessage {
  readonly id: string
  readonly content: readonly ContentBlock[]
  readonly source: { readonly kind: string; readonly plugin?: string }
}

interface HostRoutingDecision {
  readonly policy: PhysicalOperatorRoutingPolicy
  readonly route: 'primary-model' | 'resident' | 'taskgraph-candidate'
  readonly requestedByMessageId: string
  readonly reason: string
  readonly operatorId?: string
  readonly hostRoute?: PendingHostRoute
}

type ToolRequest = {
  readonly action: string
  readonly operator_id?: string
  readonly description?: string
  readonly prompt?: string
  readonly mode?: 'ephemeral' | 'resident'
}

type OperatorListValue = {
  readonly operatorId: string
  readonly displayName: string
  readonly description: string
  readonly tags: string[]
  readonly state: PhysicalOperatorStatus['state']
  readonly active: number
  readonly maxConcurrency: number
  readonly executionModes: Array<'ephemeral' | 'resident'>
  readonly unavailableReason?: string
}

type ToolValue =
  | { readonly kind: 'list'; readonly operators: OperatorListValue[] }
  | {
    readonly kind: 'run'
    readonly operatorId: string
    readonly executionId: string
    readonly output: JsonValue[]
    readonly continuity?: { readonly sessionId: string; readonly stateRevision: number }
  }

/** Routing values accepted by the durable command and projected to clients. */
export const PHYSICAL_OPERATOR_ROUTING_POLICIES = [
  'auto', 'direct', 'codex', 'claude-code', 'prime-agent',
] as const satisfies readonly PhysicalOperatorRoutingPolicy[]

const ROUTING_OPTIONS: readonly PhysicalOperatorRoutingOption[] = [
  {
    value: 'auto',
    name: 'Smart Auto',
    description: 'The main Agent evaluates every non-trivial task and selects a suitable physical operator and lifetime.',
  },
  {
    value: 'direct',
    name: 'Current Model Only',
    description: 'The main Agent works directly unless the current user message explicitly requests an operator.',
  },
  {
    value: 'codex',
    name: 'Codex',
    description: 'Prefer Codex automatically for delegable implementation, debugging, test, and repository work.',
  },
  {
    value: 'claude-code',
    name: 'Claude Code',
    description: 'Prefer Claude Code automatically for delegable analysis, architecture, review, and long-context work.',
  },
  {
    value: 'prime-agent',
    name: 'Prime Agent',
    description: 'Prefer Prime Agent for bounded recursive exploration, multi-agent synthesis, and long-horizon node work.',
  },
]

const routingProjectionSchema = zod.object({
  options: zod.array(zod.object({
    value: zod.enum(PHYSICAL_OPERATOR_ROUTING_POLICIES),
    name: zod.string(),
    description: zod.string(),
  })),
  currentValue: zod.enum(PHYSICAL_OPERATOR_ROUTING_POLICIES),
})

const PROFILE_EFFORTS = [
  'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
] as const satisfies readonly PhysicalOperatorReasoningEffort[]

const profileProjectionSchema = zod.object({
  profiles: zod.record(zod.string(), zod.object({
    model: zod.string().optional(),
    effort: zod.enum(PROFILE_EFFORTS).optional(),
  })),
  efforts: zod.array(zod.enum(PROFILE_EFFORTS)),
})

/** Register the fixed discovery-and-execution tool. */
export function apply(ctx: Context): void {
  const pending = new WeakMap<Agent, Map<string, PendingHostRoute>>()
  const fallbackConfigs = new WeakMap<Agent, LlmCallConfig>()
  ctx.llm.registerAdapter([ROUTER_PROVIDER], new PhysicalOperatorLlmAdapter(ctx))

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const decision = decideHostRoute(agent, messages)
    const route = decision?.hostRoute
    if (decision !== undefined && !hasRoutingDecision(agent.session.events, decision.requestedByMessageId)) {
      agent.session.append('physical-operator/routing-decision', {
        policy: decision.policy,
        route: decision.route,
        requestedByMessageId: decision.requestedByMessageId,
        reason: decision.reason,
        ...decision.operatorId === undefined ? {} : { operatorId: decision.operatorId },
      }, { ignorable: true })
    }
    if (route !== undefined) {
      const byPosition = pending.get(agent) ?? new Map<string, PendingHostRoute>()
      byPosition.set(`${turn}:${step}`, route)
      pending.set(agent, byPosition)
    }
    return next()
  })

  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const base = await next()
    const key = `${turn}:${step}`
    const byPosition = pending.get(agent)
    let route = byPosition?.get(key)
    byPosition?.delete(key)
    route ??= dispatchForPosition(agent.session.events, turn, step)
    if (route === undefined) {
      if (base.provider !== ROUTER_PROVIDER) {
        fallbackConfigs.set(agent, cloneCallConfig(base))
        return base
      }
      const fallback = recoverFallbackConfig(agent, fallbackConfigs.get(agent))
      if (fallback === undefined) {
        throw new Error('physical-operator router cannot restore the primary model route')
      }
      fallbackConfigs.set(agent, fallback)
      return fallback
    }
    const fallback = base.provider === ROUTER_PROVIDER
      ? recoverFallbackConfig(agent, fallbackConfigs.get(agent))
      : cloneCallConfig(base)
    if (fallback === undefined) {
      throw new Error('physical-operator router cannot capture the primary model route')
    }
    fallbackConfigs.set(agent, fallback)
    route = { ...route, fallbackConfig: fallback }
    if (dispatchForPosition(agent.session.events, turn, step) === undefined) {
      agent.session.append('physical-operator/dispatch', {
        ...route,
        turn,
        step,
      }, { ignorable: true })
    }
    const { reasoningEffort: _reasoningEffort, ...portable } = base
    return { ...portable, provider: ROUTER_PROVIDER, model: route.operatorId }
  })

  ctx.on('agent/session-start', ({ agent, source }) => {
    if (source !== 'resume' || recoverableDispatch(agent.session.events) === undefined) return
    queueMicrotask(() => {
      if (agent.status !== 'idle') return
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: 'Reconnect and deliver the pending Resident physical-operator result.' }],
        source: { kind: 'plugin', plugin: RESUME_SOURCE },
      }))
    })
  })

  ctx.systemPrompt.section({
    name: 'tool:physical-operator',
    order: 116,
    text: context => selectionGuidance(
      ctx.physicalOperators.list(),
      context.agent === undefined ? 'auto' : foldPhysicalOperatorRouting(context.agent.session.events),
    ),
  })

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'physicalOperatorRouting', PhysicalOperatorRoutingPolicy>({
      key: 'physicalOperatorRouting',
      schema: routingProjectionSchema,
      init: () => 'auto',
      apply: (state, event) => event.type === 'physical-operator/policy' ? event.data.policy : state,
      view: routingSelect,
      stateVersion: 1,
    })
    projectionCtx.sessionProjections.register<'physicalOperatorProfiles', PhysicalOperatorProfilePreferences>({
      key: 'physicalOperatorProfiles',
      schema: profileProjectionSchema,
      init: () => ({}),
      apply: (state, event) => {
        if (event.type !== 'physical-operator/profile') return state
        if (event.data.profile === null) {
          return Object.fromEntries(
            Object.entries(state).filter(([operatorId]) => operatorId !== event.data.operatorId),
          )
        }
        return { ...state, [event.data.operatorId]: { ...event.data.profile } }
      },
      view: profilePreferencesSelect,
      stateVersion: 1,
    })
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'operator',
      description: 'Select automatic physical-operator routing or a preferred native worker',
      input: { hint: '<auto|direct|codex|claude-code|prime-agent>' },
      handler: ({ agent, rawInput }) => {
        const value = rawInput.trim()
        if (value === '') {
          return {
            kind: 'success',
            text: `current routing ${foldPhysicalOperatorRouting(agent.session.events)} (available: ${PHYSICAL_OPERATOR_ROUTING_POLICIES.join(', ')})`,
          }
        }
        if (!isPhysicalOperatorRoutingPolicy(value)) {
          return {
            kind: 'error',
            text: `unknown routing policy "${value}" (available: ${PHYSICAL_OPERATOR_ROUTING_POLICIES.join(', ')})`,
          }
        }
        if (foldPhysicalOperatorRouting(agent.session.events) !== value) {
          agent.session.append('physical-operator/policy', { policy: value }, { ignorable: true })
        }
        return { kind: 'success', text: `routing ${value}` }
      },
    })
    commandCtx.commands.register({
      name: 'operator-profile',
      description: 'Select a Resident model and reasoning effort for Codex, Claude Code, or Prime Agent',
      input: { hint: '<codex|claude-code|prime-agent> <model|auto> <effort|auto>' },
      handler: ({ agent, rawInput }) => {
        const parsed = parseProfileCommand(rawInput)
        if ('error' in parsed) return { kind: 'error', text: parsed.error }
        const current = foldPhysicalOperatorProfiles(agent.session.events)[parsed.operatorId]
        if (!profileEquals(current, parsed.profile ?? undefined)) {
          agent.session.append('physical-operator/profile', {
            operatorId: parsed.operatorId,
            profile: parsed.profile,
          }, { ignorable: true })
        }
        return {
          kind: 'success',
          text: parsed.profile === null
            ? `${parsed.operatorId} profile smart-auto`
            : `${parsed.operatorId} profile ${parsed.profile.model ?? 'auto'}/${parsed.profile.effort ?? 'auto'}`,
        }
      },
    })
  })

  ctx.tools.register(defineTool({
    name: 'physical_operator',
    description:
      'Discover and run deployment-defined physical operators. Use action=list to inspect stable operator ids, '
      + 'live availability, tags, and capacity. Use action=run with one listed operator id and a complete standalone '
      + 'task. The operator id is the stable capability boundary: do not choose or assume its backing provider.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'run'],
        description: 'List physical operators or run one selected operator.',
      },
      operator_id: {
        type: 'string',
        description: 'Stable operator id returned by action=list. Required for action=run.',
      },
      description: {
        type: 'string',
        description: 'Short 3-5 word task label. Required for action=run.',
      },
      prompt: {
        type: 'string',
        description: 'Complete standalone task for the selected operator. Required for action=run.',
      },
      mode: {
        type: 'string',
        enum: ['ephemeral', 'resident'],
        description: 'Execution lifetime. Omit for backward-compatible ephemeral execution.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'list' },
              operators: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    operatorId: { type: 'string', required: true },
                    displayName: { type: 'string', required: true },
                    description: { type: 'string', required: true },
                    tags: { type: 'array', required: true, items: { type: 'string' } },
                    state: {
                      type: 'string',
                      required: true,
                      enum: ['available', 'busy', 'unavailable'],
                    },
                    active: { type: 'number', required: true },
                    maxConcurrency: { type: 'number', required: true },
                    executionModes: {
                      type: 'array',
                      required: true,
                      items: { type: 'string', enum: ['ephemeral', 'resident'] },
                    },
                    unavailableReason: { type: 'string' },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'run' },
              operatorId: { type: 'string', required: true },
              executionId: { type: 'string', required: true },
              output: { type: 'array', required: true, items: { type: 'json' } },
              continuity: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sessionId: { type: 'string', required: true },
                  stateRevision: { type: 'number', required: true },
                },
              },
            },
          },
        ],
      },
      render: (_args, value) => value.kind === 'run'
        ? value.output as unknown as ContentBlock[]
        : [{
          type: 'text',
          text: value.operators.length === 0
            ? 'No physical operators are registered.'
            : value.operators.map(operator => [
              `${operator.operatorId} [${operator.state}] ${operator.displayName}`,
              `  ${operator.description}`,
              `  capacity ${operator.active}/${operator.maxConcurrency}`,
              `  modes: ${operator.executionModes.join(', ')}`,
              operator.tags.length === 0 ? undefined : `  tags: ${operator.tags.join(', ')}`,
              operator.unavailableReason === undefined ? undefined : `  unavailable: ${operator.unavailableReason}`,
            ].filter((line): line is string => line !== undefined).join('\n')).join('\n'),
        }],
    },
    async execute(raw, exec): Promise<ToolValue> {
      const request = raw as ToolRequest
      if (request.action === 'list') {
        rejectRunFieldsOnList(request)
        return {
          kind: 'list',
          operators: ctx.physicalOperators.list().map(statusValue),
        }
      }
      if (request.action !== 'run') {
        throw new Error(`physical_operator action must be "list" or "run", received ${JSON.stringify(request.action)}`)
      }
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('physical_operator action=run requires a calling agent (exec.agent was undefined)')
      }
      const operatorId = requireTrimmed(request.operator_id, 'operator_id')
      const description = requireTrimmed(request.description, 'description')
      const prompt = requireTrimmed(request.prompt, 'prompt')
      const run = await ctx.physicalOperators.start(operatorId, {
        label: description,
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal: exec.signal,
        ...request.mode === undefined ? {} : { mode: request.mode },
      })
      const result = await settleForeground(run)
      return {
        kind: 'run',
        operatorId: String(run.operatorId),
        executionId: String(run.id),
        output: result.output as unknown as JsonValue[],
        ...result.continuity === undefined ? {} : { continuity: result.continuity },
      }
    },
  }))
}

/**
 * Host-level model adapter that makes an accepted routing decision executable.
 * DeepSeek is never called on this path: its request is replaced before
 * adapter resolution and the native Resident result becomes the assistant
 * message directly.
 */
class PhysicalOperatorLlmAdapter extends LlmAdapter {
  constructor(private readonly ctx: Context) {
    super()
  }

  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve(this.ctx.physicalOperators.list().map(operator => ({
      provider,
      id: String(operator.id),
      name: operator.displayName,
    })))
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!isAgentLoopRequest(options)) {
      throw new Error('physical-operator router only accepts the primary agent-loop request')
    }
    const agent = this.ctx.agents.requireInitiator()
    const dispatch = recoverableDispatch(agent.session.events)
    if (dispatch === undefined || dispatch.operatorId !== options.model) {
      throw new Error(`physical-operator router has no pending durable dispatch for ${options.model}`)
    }
    const prompt = promptForMessage(agent.session.events, dispatch.promptMessageId)
    if (prompt === undefined) {
      throw new Error(`physical-operator router cannot recover prompt message ${dispatch.promptMessageId}`)
    }
    const signal = options.signal ?? new AbortController().signal
    let run: PhysicalOperatorRun | undefined
    try {
      run = await this.ctx.physicalOperators.start(dispatch.operatorId, {
        executionId: PhysicalOperatorExecutionId(dispatch.commandId),
        label: labelFor(prompt),
        prompt,
        parent: agent,
        signal,
        mode: 'resident',
        ...dispatch.residentProfile === undefined ? {} : { residentProfile: dispatch.residentProfile },
      })
      const result = await run.result
      yield* resultChunks(result)
    } catch (error) {
      if (!signal.aborted) {
        agent.session.append('physical-operator/dispatch-terminal', {
          commandId: dispatch.commandId,
          code: errorCode(error),
        }, { ignorable: true })
      }
      throw error
    } finally {
      await run?.dispose()
    }
  }
}

/** Resolve explicit, continuation, preferred, and smart-auto routing in strict priority order. */
function decideHostRoute(agent: Agent, messages: readonly HostRouteMessage[]): HostRoutingDecision | undefined {
  const current = [...messages].reverse().find(message => message.source.kind === 'user')
  const resume = [...messages].reverse().find(message => (
    message.source.kind === 'plugin' && message.source.plugin === RESUME_SOURCE
  ))
  const previous = latestDispatch(agent.session.events)
  const policy = foldPhysicalOperatorRouting(agent.session.events)
  if (resume !== undefined) {
    const recoverable = recoverableDispatch(agent.session.events)
    if (recoverable === undefined) return undefined
    const hostRoute: PendingHostRoute = {
      commandId: recoverable.commandId,
      operatorId: recoverable.operatorId,
      promptMessageId: recoverable.promptMessageId,
      requestedByMessageId: resume.id,
      recovered: true,
      ...recoverable.residentProfile === undefined ? {} : { residentProfile: recoverable.residentProfile },
    }
    return {
      policy,
      route: 'resident',
      operatorId: recoverable.operatorId,
      requestedByMessageId: resume.id,
      reason: '恢复尚未交付的 Resident receipt',
      hostRoute,
    }
  }
  if (current === undefined) return undefined
  const text = textContent(current.content)
  const explicit = explicitOperator(text)
  if (explicit !== undefined) return residentDecision(agent, current.id, policy, explicit, '当前请求显式指定物理算子')
  if (isContinuation(text) && previous !== undefined) {
    const recoverable = recoverableDispatch(agent.session.events)
    const hostRoute = recoverable === undefined
      ? newHostRoute(agent, current.id, previous.operatorId)
      : {
        commandId: recoverable.commandId,
        operatorId: recoverable.operatorId,
        promptMessageId: recoverable.promptMessageId,
        requestedByMessageId: current.id,
        recovered: true,
        ...recoverable.residentProfile === undefined ? {} : { residentProfile: recoverable.residentProfile },
      }
    return {
      policy,
      route: 'resident',
      operatorId: previous.operatorId,
      requestedByMessageId: current.id,
      reason: '继续上一条物理算子任务',
      hostRoute,
    }
  }
  if (policy === 'direct') return primaryDecision(current.id, policy, '用户选择仅主模型')
  if (policy === 'codex' || policy === 'claude-code' || policy === 'prime-agent') {
    if (isParallelCandidate(text)) {
      return {
        policy,
        route: 'taskgraph-candidate',
        operatorId: policy,
        requestedByMessageId: current.id,
        reason: `任务包含可并行分支，交由主模型构造优先 ${operatorDisplayName(policy)} 的持久 TaskGraph`,
      }
    }
    return isDelegable(text)
      ? residentDecision(agent, current.id, policy, policy, `用户策略为优先 ${operatorDisplayName(policy)}`)
      : primaryDecision(current.id, policy, '请求过小，不值得启动物理算子')
  }
  if (isParallelCandidate(text)) {
    return {
      policy,
      route: 'taskgraph-candidate',
      requestedByMessageId: current.id,
      reason: '任务包含可并行分支或显式多角色协作，交由主模型构造持久 TaskGraph',
    }
  }
  const automatic = automaticOperator(text)
  return automatic === undefined
    ? primaryDecision(current.id, policy, '未发现需要物理算子或 TaskGraph 的工作')
    : residentDecision(agent, current.id, policy, automatic, '智能协作选择一个有界 Resident worker')
}

function residentDecision(
  agent: Agent,
  messageId: string,
  policy: PhysicalOperatorRoutingPolicy,
  operatorId: PhysicalOperatorProfileOwner,
  reason: string,
): HostRoutingDecision {
  return {
    policy,
    route: 'resident',
    requestedByMessageId: messageId,
    reason,
    operatorId,
    hostRoute: newHostRoute(agent, messageId, operatorId),
  }
}

function primaryDecision(
  messageId: string,
  policy: PhysicalOperatorRoutingPolicy,
  reason: string,
): HostRoutingDecision {
  return { policy, route: 'primary-model', requestedByMessageId: messageId, reason }
}

function hasRoutingDecision(events: readonly SessionEvent[], requestedByMessageId: string): boolean {
  return events.some(event => event.type === 'physical-operator/routing-decision'
    && event.data.requestedByMessageId === requestedByMessageId)
}

function newHostRoute(agent: Agent, messageId: string, operatorId: string): PendingHostRoute {
  const residentProfile = isPhysicalOperatorProfileOwner(operatorId)
    ? foldPhysicalOperatorProfiles(agent.session.events)[operatorId]
    : undefined
  return {
    commandId: `resident-${createHash('sha256').update(`${agent.id}\0${messageId}`).digest('hex').slice(0, 32)}`,
    operatorId,
    promptMessageId: messageId,
    requestedByMessageId: messageId,
    recovered: false,
    ...residentProfile === undefined ? {} : { residentProfile },
  }
}

function explicitOperator(text: string): PhysicalOperatorProfileOwner | undefined {
  if (/(?:用|使用|调用|让|请|交给)\s*(?:一下|下)?\s*prime(?:\s+agent)?\b|\bprime(?:\s+agent)?\s*(?:来|去|帮我|执行|处理|分析|研究|综合)/iu.test(text)) return 'prime-agent'
  if (/(?:用|使用|调用|让|请|交给)\s*(?:一下|下)?\s*codex\b|\bcodex\s*(?:来|去|帮我|执行|处理|分析|研究|实现|修复)/iu.test(text)) return 'codex'
  if (/(?:用|使用|调用|让|请|交给)\s*(?:一下|下)?\s*gpt[-\s]?5(?:\.\d+)?(?:[-\s]?(?:codex|sol|terra))?\b/iu.test(text)) return 'codex'
  if (/(?:用|使用|调用|让|请|交给)\s*(?:一下|下)?\s*claude(?:\s+code)?\b|\bclaude(?:\s+code)?\s*(?:来|去|帮我|执行|处理|分析|研究|实现|修复)/iu.test(text)) return 'claude-code'
  if (/(?:用|使用|调用|让|请|交给)\s*(?:一下|下)?\s*(?:sonnet|opus|haiku|fable)\b/iu.test(text)) return 'claude-code'
  if (/\b(?:use|ask|have|let)\s+(?:the\s+)?codex\b/iu.test(text)) return 'codex'
  if (/\b(?:use|ask|have|let)\s+(?:the\s+)?claude(?:\s+code)?\b/iu.test(text)) return 'claude-code'
  if (/\b(?:use|ask|have|let)\s+(?:the\s+)?prime(?:\s+agent)?\b/iu.test(text)) return 'prime-agent'
  return undefined
}

function automaticOperator(text: string): PhysicalOperatorProfileOwner | undefined {
  if (/(?:递归探索|递归推理|多智能体综合|多代理综合|综合探索|超长任务|rlm\b|recursive|multi[- ]agent synthesis|long[- ]horizon)/iu.test(text)) return 'prime-agent'
  if (/(?:代码|开发|实现|修复|调试|bug|测试|构建|编译|仓库|提交|重构|typescript|javascript|python|git\b|code\b)/iu.test(text)) return 'codex'
  if (/(?:深度分析|研究|架构|评审|审查|长文|论文|报告|方案|规划|对比|法律|法案|政策|analysis|architecture|research|review)/iu.test(text)) return 'claude-code'
  return undefined
}

function isDelegable(text: string): boolean {
  const value = text.trim()
  return value.length >= 12 || automaticOperator(value) !== undefined
}

/**
 * Detect work whose independent branches should remain visible to the durable Scheduler.
 * @param text - current user-request text.
 * @returns whether Smart Collaboration should leave the request for TaskGraph admission.
 */
export function isParallelCandidate(text: string): boolean {
  const value = text.trim()
  return value.length >= 180
    || /(?:并行|多个(?:任务|方向|模块|子任务)|分别(?:分析|研究|实现|验证)|多(?:角色|智能体|代理))/u.test(value)
    || /(?:跨(?:学科|模块|仓库)|全面(?:分析|研究|调研)|系统性(?:分析|研究))/u.test(value)
    || /(?:parallel|multi[- ](?:agent|stage|module)|independent branches)/iu.test(value)
}

function isContinuation(text: string): boolean {
  return /^(?:继续|继续啊|接着|接着做|继续执行|continue|go on|resume)[\s!！。,.，]*$/iu.test(text.trim())
}

function latestDispatch(events: readonly SessionEvent[]): DispatchRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type !== 'physical-operator/dispatch') continue
    return { ...event.data, seq: event.seq }
  }
  return undefined
}

function recoverableDispatch(events: readonly SessionEvent[]): DispatchRecord | undefined {
  const dispatch = latestDispatch(events)
  if (dispatch === undefined) return undefined
  const terminal = events.some(event => event.seq > dispatch.seq
    && event.type === 'physical-operator/dispatch-terminal'
    && event.data.commandId === dispatch.commandId)
  if (terminal) return undefined
  const delivered = events.some((event) => {
    if (event.seq <= dispatch.seq || event.type !== 'assistant/message') return false
    const message = event.data.message
    return message.source.provider === ROUTER_PROVIDER && message.source.model === dispatch.operatorId
  })
  return delivered ? undefined : dispatch
}

function dispatchForPosition(events: readonly SessionEvent[], turn: number, step: number): PendingHostRoute | undefined {
  const found = [...events].reverse().find(event => event.type === 'physical-operator/dispatch'
    && event.data.turn === turn && event.data.step === step)
  if (found?.type !== 'physical-operator/dispatch') return undefined
  const {
    commandId, operatorId, promptMessageId, requestedByMessageId, recovered, residentProfile, fallbackConfig,
  } = found.data
  return {
    commandId,
    operatorId,
    promptMessageId,
    requestedByMessageId,
    recovered,
    ...residentProfile === undefined ? {} : { residentProfile },
    ...fallbackConfig === undefined ? {} : { fallbackConfig: cloneCallConfig(fallbackConfig) },
  }
}

/** Recover the non-router model selection that a transient host dispatch replaced. */
function recoverFallbackConfig(agent: Agent, inMemory?: LlmCallConfig): LlmCallConfig | undefined {
  if (inMemory !== undefined && inMemory.provider !== ROUTER_PROVIDER) return cloneCallConfig(inMemory)
  const dispatch = latestDispatch(agent.session.events)
  if (dispatch?.fallbackConfig !== undefined && dispatch.fallbackConfig.provider !== ROUTER_PROVIDER) {
    return cloneCallConfig(dispatch.fallbackConfig)
  }
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type !== 'request/header') continue
    if (event.data.header.config.provider !== ROUTER_PROVIDER) {
      return cloneCallConfig(event.data.header.config)
    }
  }
  if (agent.options.provider && agent.options.model && agent.options.provider !== ROUTER_PROVIDER) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

function cloneCallConfig(config: LlmCallConfig): LlmCallConfig {
  return {
    ...config,
    ...config.stop === undefined ? {} : { stop: [...config.stop] },
  }
}

function promptForMessage(events: readonly SessionEvent[], messageId: string): ContentBlock[] | undefined {
  const found = events.find(event => event.type === 'user/message' && String(event.data.id) === messageId)
  return found?.type === 'user/message' ? [...found.data.content] : undefined
}

function textContent(content: readonly ContentBlock[]): string {
  return content.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text).join('\n')
}

function labelFor(content: readonly ContentBlock[]): string {
  const text = textContent(content).replace(/\s+/g, ' ').trim()
  return text.length <= 48 ? text : `${text.slice(0, 47)}…`
}

function* resultChunks(result: PhysicalOperatorResult): Generator<StreamChunk> {
  for (const [index, block] of result.output.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text }
    else if (block.type === 'reasoning') yield { type: 'reasoning-delta', index, text: block.text }
    yield { type: 'block-end', index, block }
  }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
  yield {
    type: 'finish',
    reason: result.stopReason === 'max-tokens' ? { kind: 'max-tokens' } : { kind: 'stop' },
  }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'RUNTIME_UNAVAILABLE'
}

/**
 * Fold the last logged routing policy; untouched Sessions use smart automatic routing.
 * @param events - one Session's ordered durable log.
 * @returns the effective routing policy for the next model step.
 */
export function foldPhysicalOperatorRouting(events: readonly SessionEvent[]): PhysicalOperatorRoutingPolicy {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type === 'physical-operator/policy') return event.data.policy
  }
  return 'auto'
}

/**
 * Build the complete projected selector from one folded policy.
 * @param policy - folded Session policy.
 * @returns detached choices plus the effective value for client rendering.
 */
export function routingSelect(policy: PhysicalOperatorRoutingPolicy): PhysicalOperatorRoutingSelect {
  return { options: ROUTING_OPTIONS.map(option => ({ ...option })), currentValue: policy }
}

/**
 * Fold the most recent per-product Resident execution preferences.
 * @param events - current DSH Session event log.
 * @returns the latest non-cleared preference for each supported native product.
 */
export function foldPhysicalOperatorProfiles(events: readonly SessionEvent[]): PhysicalOperatorProfilePreferences {
  const profiles: PhysicalOperatorProfilePreferences = {}
  const seen = new Set<PhysicalOperatorProfileOwner>()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as SessionEvent
    if (event.type !== 'physical-operator/profile' || seen.has(event.data.operatorId)) continue
    seen.add(event.data.operatorId)
    if (event.data.profile !== null) profiles[event.data.operatorId] = { ...event.data.profile }
  }
  return profiles
}

/**
 * Build the browser-safe per-product preference projection.
 * @param profiles - folded product preference map.
 * @returns copied preferences plus the complete provider-neutral effort vocabulary.
 */
export function profilePreferencesSelect(
  profiles: PhysicalOperatorProfilePreferences,
): PhysicalOperatorProfilePreferencesSelect {
  return {
    profiles: Object.fromEntries(
      Object.entries(profiles).map(([operatorId, profile]) => [operatorId, { ...profile }]),
    ),
    efforts: [...PROFILE_EFFORTS],
  }
}

function parseProfileCommand(rawInput: string): {
  readonly operatorId: PhysicalOperatorProfileOwner
  readonly profile: PhysicalOperatorExecutionPreference | null
} | { readonly error: string } {
  const [operatorId, model, effort, ...extra] = rawInput.trim().split(/\s+/u)
  if (!isPhysicalOperatorProfileOwner(operatorId) || model === undefined || extra.length > 0) {
    return { error: 'usage: /operator-profile <codex|claude-code|prime-agent> <model|auto> <effort|auto>' }
  }
  if (model === 'auto' && (effort === undefined || effort === 'auto')) {
    return { operatorId, profile: null }
  }
  if (effort !== undefined && effort !== 'auto' && !PROFILE_EFFORTS.some(value => value === effort)) {
    return { error: `unsupported effort "${effort}" (available: ${PROFILE_EFFORTS.join(', ')})` }
  }
  return {
    operatorId,
    profile: {
      ...model === 'auto' ? {} : { model },
      ...effort === undefined || effort === 'auto' ? {} : { effort: effort as PhysicalOperatorReasoningEffort },
    },
  }
}

function isPhysicalOperatorProfileOwner(value: string | undefined): value is PhysicalOperatorProfileOwner {
  return value === 'codex' || value === 'claude-code' || value === 'prime-agent'
}

function profileEquals(
  left: PhysicalOperatorExecutionPreference | undefined,
  right: PhysicalOperatorExecutionPreference | undefined,
): boolean {
  return left?.model === right?.model && left?.effort === right?.effort
}

/** Whether a command argument is one supported routing policy. */
function isPhysicalOperatorRoutingPolicy(value: string): value is PhysicalOperatorRoutingPolicy {
  return PHYSICAL_OPERATOR_ROUTING_POLICIES.some(policy => policy === value)
}

/** Render task-selection guidance from the logged policy and the same live descriptors the tool lists. */
function selectionGuidance(
  operators: readonly PhysicalOperatorStatus[],
  policy: PhysicalOperatorRoutingPolicy,
): string {
  const available = operators
    .filter(operator => operator.state !== 'unavailable')
    .map(operator => `${operator.id}: ${operator.description} [${operator.tags.join(', ') || 'no tags'}]; modes=${operator.executionModes.join(',')}`)
  if (available.length === 0) return ''
  return [
    routingPolicyGuidance(policy),
    'Physical operators are separate native Claude Code, Codex, or Prime Agent workers using the user subscription, never an API fallback.',
    'Choose resident mode for repository implementation, multi-turn work, work that must remain inspectable across a DSH restart, or work that should continue in the same native product session. Keep ephemeral mode for one bounded independent check.',
    'When routing automatically, prefer implementation/debugging/testing tags for code changes, analysis/architecture/review/long-context tags for broad reasoning, and recursive/rlm/multi-agent/synthesis tags for bounded node-local exploration. Call action=list if the suitable stable id is not already evident from the catalog below.',
    'Send one complete standalone prompt. Do not delegate trivial questions, translation, or a tiny direct edit whose coordination cost exceeds the work.',
    ...available.map(operator => `- ${operator}`),
  ].join('\n')
}

/** Policy-specific model instruction placed before the shared operator guidance. */
function routingPolicyGuidance(policy: PhysicalOperatorRoutingPolicy): string {
  switch (policy) {
    case 'auto':
      return 'Physical-operator routing policy: SMART AUTO. At the start of every non-trivial request, explicitly decide whether durable TaskGraph orchestration or one physical operator improves the result. Use orchestration for work with parallel independent branches, explicit dependencies, recovery, or multiple roles; use one suitable operator for bounded single-worker work. Multi-file coding, debugging, refactoring, tests/builds, repository review, and long-running work normally qualify for collaboration.'
    case 'direct':
      return 'Physical-operator routing policy: CURRENT MODEL ONLY. Do not call physical_operator unless the current user message explicitly requests an operator.'
    case 'codex':
      return 'Physical-operator routing policy: CODEX PREFERRED. Use durable TaskGraph orchestration for parallelizable work and set operator.preferredIds=["codex"] on each delegable node. Invoke one codex Resident directly for bounded single-worker work without waiting for the user to repeat the preference.'
    case 'claude-code':
      return 'Physical-operator routing policy: CLAUDE CODE PREFERRED. Use durable TaskGraph orchestration for parallelizable work and set operator.preferredIds=["claude-code"] on each delegable node. Invoke one Claude Code Resident directly for bounded single-worker work without waiting for the user to repeat the preference.'
    case 'prime-agent':
      return 'Physical-operator routing policy: PRIME AGENT PREFERRED. Use durable TaskGraph orchestration for parallelizable work and set operator.preferredIds=["prime-agent"] only on nodes that benefit from bounded RLM recursion or synthesis. Invoke one Prime Agent Resident directly for bounded single-node exploration without letting it replace DSH global scheduling or acceptance.'
  }
}

function operatorDisplayName(operatorId: PhysicalOperatorProfileOwner): string {
  return operatorId === 'codex' ? 'Codex' : operatorId === 'claude-code' ? 'Claude Code' : 'Prime Agent'
}

/** Reject run-only keys on list so accidental work requests are never ignored. */
function rejectRunFieldsOnList(request: ToolRequest): void {
  for (const field of ['operator_id', 'description', 'prompt', 'mode'] as const) {
    if (request[field] !== undefined) {
      throw new Error(`physical_operator action=list does not accept ${field}`)
    }
  }
}

/** Require a nonblank, already-trimmed model argument. */
function requireTrimmed(value: string | undefined, field: string): string {
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new Error(`physical_operator action=run requires a non-blank trimmed ${field}`)
  }
  return value
}

/** Convert a borrowed runtime status to a canonical JSON-owned value. */
function statusValue(status: PhysicalOperatorStatus): OperatorListValue {
  return {
    operatorId: String(status.id),
    displayName: status.displayName,
    description: status.description,
    tags: [...status.tags],
    state: status.state,
    active: status.active,
    maxConcurrency: status.maxConcurrency,
    executionModes: [...status.executionModes],
    ...status.unavailableReason === undefined ? {} : { unavailableReason: status.unavailableReason },
  }
}

// Foreground physical-operator and subagent tools share the same result/disposal ownership rule.
/* jscpd:ignore-start */
/** Await one foreground result and dispose independently without hiding either failure. */
async function settleForeground(run: PhysicalOperatorRun): Promise<PhysicalOperatorResult> {
  const [execution] = await Promise.allSettled([run.result.then((result) => {
    const error = stopReasonError(result)
    if (error !== undefined) throw new Error(withPartialText(error, result.output))
    return result
  })])
  const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
  if (execution.status === 'rejected') {
    if (disposal.status === 'rejected') {
      throw new AggregateError(
        [execution.reason, disposal.reason],
        `physical operator failed: ${String(execution.reason)}; dispose failed: ${String(disposal.reason)}`,
      )
    }
    throw execution.reason
  }
  if (disposal.status === 'rejected') throw disposal.reason
  return execution.value
}
/* jscpd:ignore-end */

/** Translate non-success terminals into model-visible failures. */
function stopReasonError(result: PhysicalOperatorResult): string | undefined {
  switch (result.stopReason) {
    case 'completed': return undefined
    case 'aborted': return 'physical operator execution was cancelled'
    case 'error': return 'physical operator execution failed'
    case 'max-tokens': return 'physical operator execution hit its token limit before finishing'
    case 'refusal': return 'physical operator declined the task'
    default: return `physical operator execution ended abnormally (${String(result.stopReason)})`
  }
}

/** Preserve partial text while still reporting the terminal as an error. */
function withPartialText(error: string, output: ContentBlock[]): string {
  const partial = output
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return partial.length === 0 ? error : `${error}\nPartial output before the execution ended:\n${partial}`
}
