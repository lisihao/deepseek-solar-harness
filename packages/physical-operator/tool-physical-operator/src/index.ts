/**
 * Model-facing `physical_operator` consumer. The model discovers stable
 * operator ids and invokes one without selecting a subprocess, SDK, model, or
 * provider transport. All execution remains on `ctx.physicalOperators`.
 *
 * @module @deepseek-ai/dsh-tool-physical-operator
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  isAgentLoopRequest,
  LlmAdapter,
  type ContentBlock,
  type GenerateOptions,
  type LlmCallConfig,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { isJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { z as zod } from 'zod'
import type {
  PhysicalOperatorExecutionMode,
  PhysicalOperatorExecutionPreference,
  PhysicalOperatorReasoningEffort,
  PhysicalOperatorResult,
  PhysicalOperatorRun,
  PhysicalOperatorStatus,
  PhysicalOperatorUsage,
} from '@deepseek-ai/dsh-physical-operator'
import { PhysicalOperatorError, PhysicalOperatorExecutionId } from '@deepseek-ai/dsh-physical-operator'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  PhysicalOperatorRoutingOption,
  PhysicalOperatorRoutingPolicy,
  PhysicalOperatorRoutingSelect,
  PhysicalOperatorRoutingTarget,
  PhysicalOperatorProfileOwner,
  PhysicalOperatorProfilePreferences,
  PhysicalOperatorProfilePreferencesSelect,
} from './types.ts'
import { PhysicalOperatorModelToolBridge } from './model-tool-bridge.ts'

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
      route: 'primary-model' | 'ephemeral' | 'resident' | 'taskgraph-candidate'
      requestedByMessageId: string
      reason: string
      operatorId?: string
    }
    /** Durable host decision that binds one DSH message to one physical-operator command. */
    'physical-operator/dispatch': {
      commandId: string
      operatorId: string
      fallbackOperatorId?: string
      promptMessageId: string
      requestedByMessageId: string
      turn: number
      step: number
      recovered: boolean
      /** Omitted by pre-ChatGPT-Web logs; those legacy host routes were Resident. */
      executionMode?: PhysicalOperatorExecutionMode
      residentProfile?: PhysicalOperatorExecutionPreference
      fallbackConfig?: LlmCallConfig
    }
    /** Explicit physical_operator tool admission, distinct from a routed main-model turn. */
    'physical-operator/tool-dispatch': {
      commandId: string
      operatorId: string
      toolCallId: string
      mode: 'ephemeral' | 'resident'
      description: string
    }
    /** Non-cancellation terminal failure; prevents an endless cold-resume loop. */
    'physical-operator/dispatch-terminal': {
      commandId: string
      code: string
    }
    /** One bounded native Resident observation copied into this Session's ignorable Trace. */
    'physical-operator/progress': {
      commandId: string
      operatorId: string
      sequence: number
      type: string
      time: string
      data: Record<string, JsonValue>
    }
    /** Resident progress could not be projected completely into this Session Trace. */
    'physical-operator/trace-degraded': {
      commandId: string
      operatorId: string
      code: 'PROGRESS_UNAVAILABLE'
      message: string
    }
    /** One Resident-native model call into the current Agent's real DSH tool surface. */
    'physical-operator/tool-call': {
      commandId: string
      /** Stable receipt identity; legacy events use commandId when absent. */
      toolCallId?: string
      /** Parent physical execution command that owns this model-tool call. */
      executionCommandId?: string
      tool: string
      arguments: Record<string, JsonValue>
    }
    /** Settled result of one bridged DSH tool call. */
    'physical-operator/tool-result': {
      commandId: string
      /** Stable receipt identity; legacy events use commandId when absent. */
      toolCallId?: string
      /** Parent physical execution command that owns this model-tool call. */
      executionCommandId?: string
      tool: string
      result: JsonValue
    }
    /** A recovered bridge Receipt has a call but no provable settled result. */
    'physical-operator/tool-indeterminate': {
      commandId: string
      toolCallId: string
      executionCommandId: string
      tool: string
      code: 'COMMAND_INDETERMINATE'
    }
  }
}

export const name = 'tool-physical-operator'
export const inject = ['tools', 'physicalOperators', 'systemPrompt', 'llm', 'agents']

const ROUTER_PROVIDER = 'dsh-physical-operator'
const RESUME_SOURCE = 'physical-operator-resume'
const FALLBACK_REQUIRED_CODE = 'PHYSICAL_OPERATOR_FALLBACK_REQUIRED'

interface PendingHostRoute {
  readonly commandId: string
  readonly operatorId: string
  readonly fallbackOperatorId?: string
  readonly promptMessageId: string
  readonly requestedByMessageId: string
  readonly recovered: boolean
  /** Capability-selected lifetime frozen with the host dispatch. */
  readonly executionMode: PhysicalOperatorExecutionMode
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
  readonly route: 'primary-model' | 'ephemeral' | 'resident' | 'taskgraph-candidate'
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
  /** Capabilities the delegated operator must receive through the DSH surface. */
  readonly required_capabilities?: readonly string[]
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
  'auto', 'direct', 'codex', 'claude-code', 'chatgpt-web',
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
    value: 'chatgpt-web',
    name: 'ChatGPT Web',
    description: 'Use the authenticated ChatGPT website only when explicitly selected; Smart Auto never chooses this browser subscription route.',
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
  const modelTools = new PhysicalOperatorModelToolBridge(ctx)
  ctx.effect(function* () {
    yield async () => { await modelTools.dispose() }
  }, 'tool-physical-operator: model tool bridge')
  ctx.llm.registerAdapter([ROUTER_PROVIDER], new PhysicalOperatorLlmAdapter(ctx, modelTools))

  ctx.on('agent/pre-step', async ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const decision = decideHostRoute(ctx, agent, messages)
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
    if (route === undefined && base.provider === ROUTER_PROVIDER && debateEnabled(agent.session.events)) {
      return base
    }
    if (route === undefined && base.provider === ROUTER_PROVIDER) {
      const fallback = recoverFallbackConfig(agent, fallbackConfigs.get(agent))
      if (fallback !== undefined) {
        fallbackConfigs.set(agent, fallback)
        return fallback
      }
      const promptMessage = latestUserPromptMessage(agent.session.events)
      if (promptMessage === undefined) {
        throw new Error('physical-operator primary model has no current user message')
      }
      if (!ctx.physicalOperators.list().some(operator => String(operator.id) === base.model)) {
        throw new Error(`physical-operator primary model is not registered: ${base.model}`)
      }
      route = newHostRoute(ctx, agent, promptMessage.id, base.model)
    }
    if (route === undefined) {
      fallbackConfigs.set(agent, cloneCallConfig(base))
      return base
    }
    const fallback = base.provider === ROUTER_PROVIDER
      ? recoverFallbackConfig(agent, fallbackConfigs.get(agent))
      : cloneCallConfig(base)
    if (base.provider !== ROUTER_PROVIDER && fallback === undefined) {
      throw new Error('physical-operator router cannot capture the primary model route')
    }
    if (fallback !== undefined) {
      fallbackConfigs.set(agent, fallback)
      route = { ...route, fallbackConfig: fallback }
    }
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

  ctx.on('agent/request-error', async ({ agent, turn, step, provider, failure, signal }, next) => {
    if (provider !== ROUTER_PROVIDER || failure.code !== FALLBACK_REQUIRED_CODE || signal.aborted) return next()
    const failed = dispatchForPosition(agent.session.events, turn, step)
    if (failed?.fallbackOperatorId === undefined) return next()
    const fallback = fallbackHostRoute(ctx, agent, failed, failed.fallbackOperatorId)
    agent.session.append('physical-operator/routing-decision', {
      policy: 'auto',
      route: routeKind(fallback.executionMode),
      requestedByMessageId: failed.requestedByMessageId,
      reason: `${operatorDisplayName(failed.operatorId)} 订阅资格不可用，智能协作切换到 ${operatorDisplayName(fallback.operatorId)}`,
      operatorId: fallback.operatorId,
    }, { ignorable: true })
    agent.session.append('physical-operator/dispatch', {
      ...fallback,
      turn,
      step,
    }, { ignorable: true })
    return { kind: 'retry' }
  })

  ctx.on('agent/session-start', ({ agent, source }) => {
    if (source !== 'resume' || resumableResidentDispatch(agent.session.events) === undefined) return
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
      input: { hint: '<auto|direct|codex|claude-code|chatgpt-web>' },
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
      description: 'Select a Resident model and reasoning effort for Codex or Claude Code',
      input: { hint: '<codex|claude-code> <model|auto> <effort|auto>' },
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
      required_capabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Capabilities required by the delegated task, for example browser. Browser requires resident mode so the full DSH tool bridge remains authoritative.',
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
      rejectUnsupportedCapabilityMode(request)
      const executionId = PhysicalOperatorExecutionId(
        `tool-${createHash('sha256').update(`${String(parent.id)}\0${String(exec.callId)}`).digest('hex').slice(0, 32)}`,
      )
      const resident = request.mode === 'resident'
        ? await prepareResidentSurface(ctx, modelTools, executionId, parent, exec.signal)
        : undefined
      let run: PhysicalOperatorRun | undefined
      let observer: ReturnType<typeof observePhysicalOperatorProgress> | undefined
      try {
        parent.session.append('physical-operator/tool-dispatch', {
          commandId: String(executionId),
          operatorId,
          toolCallId: String(exec.callId),
          mode: request.mode ?? 'ephemeral',
          description: description.slice(0, 160),
        }, { ignorable: true })
        run = await ctx.physicalOperators.start(operatorId, {
          executionId,
          label: description,
          prompt: [{ type: 'text', text: prompt }],
          parent,
          signal: exec.signal,
          ...request.mode === undefined ? {} : { mode: request.mode },
          ...request.mode === 'resident' ? { residentLaneId: `explicit-tool:${String(parent.id)}` } : {},
          ...resident?.systemPrompt === undefined ? {} : { systemPrompt: resident.systemPrompt },
          ...resident?.descriptor === undefined ? {} : { modelToolBridge: resident.descriptor },
          ...resident?.descriptor === undefined ? {} : { nativeToolPolicy: 'dsh-tools-authoritative' as const },
        })
        observer = observePhysicalOperatorProgress(ctx, parent, run, String(executionId))
        const result = await settleForeground(run, () => observer?.stop())
        return {
          kind: 'run',
          operatorId: String(run.operatorId),
          executionId: String(run.id),
          output: result.output as unknown as JsonValue[],
          ...result.continuity === undefined ? {} : { continuity: result.continuity },
        }
      } finally {
        await observer?.stop()
        resident?.release()
      }
    },
  }))
}

/**
 * Host-level model adapter that makes an accepted routing decision executable.
 * DeepSeek is never called on this path: its request is replaced before
 * adapter resolution and the selected physical-operator result becomes the
 * assistant message directly.
 */
class PhysicalOperatorLlmAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly modelTools: PhysicalOperatorModelToolBridge,
  ) {
    super()
  }

  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve(this.ctx.physicalOperators.list()
      .filter(operator => operator.state !== 'unavailable')
      .map(operator => ({
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
      throw new Error(`physical-operator router has no pending dispatch for ${options.model}`)
    }
    const prompt = promptForMessage(agent.session.events, dispatch.promptMessageId)
    if (prompt === undefined) {
      throw new Error(`physical-operator router cannot recover prompt message ${dispatch.promptMessageId}`)
    }
    const signal = options.signal ?? new AbortController().signal
    let run: PhysicalOperatorRun | undefined
    let observer: ReturnType<typeof observePhysicalOperatorProgress> | undefined
    let releaseModelTools: (() => void) | undefined
    try {
      const bound = dispatch.executionMode === 'resident'
        ? await this.modelTools.bind(
          dispatch.commandId,
          agent,
          options.tools ?? [],
          signal,
        )
        : undefined
      releaseModelTools = bound === undefined ? undefined : () => { bound.release() }
      run = await this.ctx.physicalOperators.start(dispatch.operatorId, {
        executionId: PhysicalOperatorExecutionId(dispatch.commandId),
        label: labelFor(prompt),
        prompt,
        parent: agent,
        signal,
        mode: dispatch.executionMode,
        // Only Resident products can attach to the owner-local typed DSH tool
        // bridge. Browser-backed ephemeral products receive the same system
        // instruction but never a synthetic tool surface.
        ...(dispatch.executionMode === 'resident'
          ? { nativeToolPolicy: 'dsh-tools-authoritative' as const }
          : {}),
        ...options.system === undefined ? {} : { systemPrompt: options.system },
        ...(bound?.descriptor === undefined ? {} : { modelToolBridge: bound.descriptor }),
        ...(dispatch.executionMode === 'resident' && dispatch.residentProfile !== undefined
          ? { residentProfile: dispatch.residentProfile }
          : {}),
      })
      observer = observePhysicalOperatorProgress(this.ctx, agent, run, dispatch.commandId)
      const result = await run.result
      await observer.stop()
      if (result.stopReason === 'error' || result.stopReason === 'refusal') {
        agent.session.append('physical-operator/dispatch-terminal', {
          commandId: dispatch.commandId,
          code: terminalCodeFor(result.stopReason),
        }, { ignorable: true })
      }
      yield* resultChunks(result)
    } catch (error) {
      if (observer !== undefined) await observer.stop()
      else if (run !== undefined) {
        await projectPhysicalOperatorProgress(this.ctx, agent, run, dispatch.commandId)
      }
      if (!signal.aborted) {
        const code = errorCode(error)
        agent.session.append('physical-operator/dispatch-terminal', {
          commandId: dispatch.commandId,
          code,
        }, { ignorable: true })
        if (run === undefined && dispatch.fallbackOperatorId !== undefined && code === 'AUTH_MODE_MISMATCH') {
          throw new PhysicalOperatorError(
            `${operatorDisplayName(dispatch.operatorId)} subscription qualification failed; trying the Smart Auto fallback`,
            FALLBACK_REQUIRED_CODE,
            { cause: error },
          )
        }
      }
      throw error
    } finally {
      await observer?.stop()
      releaseModelTools?.()
      await run?.dispose()
    }
  }
}

async function prepareResidentSurface(
  ctx: Context,
  modelTools: PhysicalOperatorModelToolBridge,
  executionId: PhysicalOperatorExecutionId,
  agent: Agent,
  signal: AbortSignal,
): Promise<{
  readonly systemPrompt: string
  readonly descriptor?: import('@deepseek-ai/dsh-physical-operator').PhysicalOperatorModelToolBridgeV1
  release(): void
}> {
  const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
  const bound = await modelTools.bind(String(executionId), agent, assembly.tools, signal)
  return { systemPrompt: renderPrompt(assembly), ...bound }
}

/** Resolve explicit, continuation, preferred, and smart-auto routing in strict priority order. */
function decideHostRoute(ctx: Context, agent: Agent, messages: readonly HostRouteMessage[]): HostRoutingDecision | undefined {
  const current = [...messages].reverse().find(message => message.source.kind === 'user')
  const resume = [...messages].reverse().find(message => (
    message.source.kind === 'plugin' && message.source.plugin === RESUME_SOURCE
  ))
  const previous = latestDispatch(agent.session.events)
  const policy = foldPhysicalOperatorRouting(agent.session.events)
  if (resume !== undefined) {
    const recoverable = recoverableDispatch(agent.session.events)
    if (recoverable === undefined) return undefined
    const hostRoute = recoveredHostRoute(recoverable, resume.id)
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
  if (debateEnabled(agent.session.events)) {
    return {
      policy,
      route: 'taskgraph-candidate',
      requestedByMessageId: current.id,
      reason: '当前会话已明确启用 Debate，由 Debate Consumer 通过唯一 TaskGraph 调度器接管',
    }
  }
  const text = textContent(current.content)
  const explicit = explicitOperator(text)
  if (explicit !== undefined) return operatorDecision(ctx, agent, current.id, policy, explicit, '当前请求显式指定物理算子')
  if (isContinuation(text) && previous !== undefined) {
    const recoverable = recoverableDispatch(agent.session.events)
    const hostRoute = recoverable === undefined
      ? newHostRoute(ctx, agent, current.id, previous.operatorId)
      : recoveredHostRoute(recoverable, current.id)
    return {
      policy,
      route: routeKind(hostRoute.executionMode),
      operatorId: previous.operatorId,
      requestedByMessageId: current.id,
      reason: '继续上一条物理算子任务',
      hostRoute,
    }
  }
  if (policy === 'direct') return primaryDecision(current.id, policy, '用户选择仅主模型')
  if (policy === 'chatgpt-web') {
    return isDelegable(text)
      ? operatorDecision(ctx, agent, current.id, policy, policy, '用户策略为 ChatGPT 网页订阅')
      : primaryDecision(current.id, policy, '请求过小，不值得启动 ChatGPT 网页算子')
  }
  if (policy === 'codex' || policy === 'claude-code') {
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
      ? operatorDecision(ctx, agent, current.id, policy, policy, `用户策略为优先 ${operatorDisplayName(policy)}`)
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
    : operatorDecision(
      ctx,
      agent,
      current.id,
      policy,
      automatic,
      '智能协作选择一个有界物理算子',
      automatic === 'claude-code' ? 'codex' : undefined,
    )
}

function debateEnabled(events: readonly SessionEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { readonly type: string; readonly data: unknown }
    if (event.type !== 'debate/preferences') continue
    return (event.data as { readonly mode?: unknown }).mode === 'enabled'
  }
  return false
}

function operatorDecision(
  ctx: Context,
  agent: Agent,
  messageId: string,
  policy: PhysicalOperatorRoutingPolicy,
  operatorId: PhysicalOperatorRoutingTarget,
  reason: string,
  fallbackOperatorId?: PhysicalOperatorRoutingTarget,
): HostRoutingDecision {
  const hostRoute = newHostRoute(ctx, agent, messageId, operatorId, fallbackOperatorId)
  return {
    policy,
    route: routeKind(hostRoute.executionMode),
    requestedByMessageId: messageId,
    reason,
    operatorId,
    hostRoute,
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

function newHostRoute(
  ctx: Context,
  agent: Agent,
  messageId: string,
  operatorId: string,
  fallbackOperatorId?: string,
): PendingHostRoute {
  const executionMode = executionModeFor(ctx, operatorId)
  const residentProfile = executionMode === 'resident' && isPhysicalOperatorProfileOwner(operatorId)
    ? foldPhysicalOperatorProfiles(agent.session.events)[operatorId]
    : undefined
  return {
    commandId: `resident-${createHash('sha256').update(`${agent.id}\0${messageId}`).digest('hex').slice(0, 32)}`,
    operatorId,
    ...fallbackOperatorId === undefined ? {} : { fallbackOperatorId },
    promptMessageId: messageId,
    requestedByMessageId: messageId,
    recovered: false,
    executionMode,
    ...residentProfile === undefined ? {} : { residentProfile },
  }
}

function recoveredHostRoute(recoverable: DispatchRecord, requestedByMessageId: string): PendingHostRoute {
  return {
    commandId: recoverable.commandId,
    operatorId: recoverable.operatorId,
    promptMessageId: recoverable.promptMessageId,
    requestedByMessageId,
    recovered: true,
    executionMode: recoverable.executionMode,
    ...recoverable.fallbackOperatorId === undefined ? {} : { fallbackOperatorId: recoverable.fallbackOperatorId },
    ...recoverable.residentProfile === undefined ? {} : { residentProfile: recoverable.residentProfile },
    ...recoverable.fallbackConfig === undefined ? {} : { fallbackConfig: cloneCallConfig(recoverable.fallbackConfig) },
  }
}

function fallbackHostRoute(ctx: Context, agent: Agent, failed: PendingHostRoute, operatorId: string): PendingHostRoute {
  const executionMode = executionModeFor(ctx, operatorId)
  const residentProfile = executionMode === 'resident' && isPhysicalOperatorProfileOwner(operatorId)
    ? foldPhysicalOperatorProfiles(agent.session.events)[operatorId]
    : undefined
  return {
    commandId: `resident-${createHash('sha256').update(`${failed.commandId}\0fallback\0${operatorId}`).digest('hex').slice(0, 32)}`,
    operatorId,
    promptMessageId: failed.promptMessageId,
    requestedByMessageId: failed.requestedByMessageId,
    recovered: false,
    executionMode,
    ...residentProfile === undefined ? {} : { residentProfile },
    ...failed.fallbackConfig === undefined ? {} : { fallbackConfig: cloneCallConfig(failed.fallbackConfig) },
  }
}

function explicitOperator(text: string): PhysicalOperatorRoutingTarget | undefined {
  if (/(?:用|使用|调用|让|请|交给)\s*(?:一下|下)?\s*codex\b|\bcodex\s*(?:来|去|帮我|执行|处理|分析|研究|实现|修复)/iu.test(text)) return 'codex'
  if (/(?:用|使用|调用|让|请|交给)\s*(?:一下|下)?\s*gpt[-\s]?5(?:\.\d+)?(?:[-\s]?(?:codex|sol|terra))?\b/iu.test(text)) return 'codex'
  if (/(?:用|使用|调用|让|请|交给)\s*(?:一下|下)?\s*claude(?:\s+code)?\b|\bclaude(?:\s+code)?\s*(?:来|去|帮我|执行|处理|分析|研究|实现|修复)/iu.test(text)) return 'claude-code'
  if (/(?:用|使用|调用|让|请|交给)\s*(?:一下|下)?\s*(?:sonnet|opus|haiku|fable)\b/iu.test(text)) return 'claude-code'
  if (/(?:用|使用|调用|让|请|交给)\s*(?:一下|下)?\s*(?:chatgpt(?:\s*(?:web|网页(?:版)?))?|openai\s+chatgpt)/iu.test(text)) return 'chatgpt-web'
  if (/\b(?:use|ask|have|let)\s+(?:the\s+)?codex\b/iu.test(text)) return 'codex'
  if (/\b(?:use|ask|have|let)\s+(?:the\s+)?claude(?:\s+code)?\b/iu.test(text)) return 'claude-code'
  if (/\b(?:use|ask|have|let)\s+(?:the\s+)?chatgpt(?:\s+web)?\b/iu.test(text)) return 'chatgpt-web'
  return undefined
}

function automaticOperator(text: string): PhysicalOperatorProfileOwner | undefined {
  // RLM and multi-agent requests stay on the TaskGraph path; they are strategies, not products.
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

/** Select the strongest supported lifetime without coupling to any Provider implementation. */
function executionModeFor(ctx: Context, operatorId: string): PhysicalOperatorExecutionMode {
  const status = ctx.physicalOperators.list().find(candidate => String(candidate.id) === operatorId)
  if (status?.executionModes.includes('resident') === true) return 'resident'
  if (status?.executionModes.includes('ephemeral') === true) return 'ephemeral'
  // Keep legacy error behavior for a route whose provider is not composed:
  // `ctx.physicalOperators.start()` remains the single diagnostic authority.
  return 'resident'
}

function routeKind(executionMode: PhysicalOperatorExecutionMode): 'ephemeral' | 'resident' {
  return executionMode
}

function latestDispatch(events: readonly SessionEvent[]): DispatchRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type !== 'physical-operator/dispatch') continue
    return { ...event.data, executionMode: event.data.executionMode ?? 'resident', seq: event.seq }
  }
  return undefined
}

/** Only Resident routes are safe to request again after a cold DSH Session resume. */
function resumableResidentDispatch(events: readonly SessionEvent[]): DispatchRecord | undefined {
  const dispatch = recoverableDispatch(events)
  return dispatch?.executionMode === 'resident' ? dispatch : undefined
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
    commandId, operatorId, fallbackOperatorId, promptMessageId, requestedByMessageId, recovered,
    executionMode, residentProfile, fallbackConfig,
  } = found.data
  return {
    commandId,
    operatorId,
    ...fallbackOperatorId === undefined ? {} : { fallbackOperatorId },
    promptMessageId,
    requestedByMessageId,
    recovered,
    executionMode: executionMode ?? 'resident',
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

function latestUserPromptMessage(events: readonly SessionEvent[]): { readonly id: string; readonly content: ContentBlock[] } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    return { id: String(event.data.id), content: [...event.data.content] }
  }
  return undefined
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
  const usage = tokenUsageFor(result.usage)
  if (usage !== undefined) yield { type: 'usage', usage }
  yield {
    type: 'finish',
    reason: finishReasonFor(result.stopReason),
  }
}

type FinishReason = Extract<StreamChunk, { type: 'finish' }>['reason']

function finishReasonFor(stopReason: PhysicalOperatorResult['stopReason']): FinishReason {
  switch (stopReason) {
    case 'completed': return { kind: 'stop' }
    case 'max-tokens': return { kind: 'max-tokens' }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: 'physical operator execution was aborted', code: 'OPERATOR_ABORTED' },
    }
    case 'error': return {
      kind: 'error',
      failure: { message: 'physical operator execution failed', code: terminalCodeFor('error') },
    }
    case 'refusal': return {
      kind: 'error',
      failure: { message: 'physical operator refused the request', code: terminalCodeFor('refusal') },
    }
    default: return {
      kind: 'error',
      failure: {
        message: `physical operator execution ended abnormally (${String(stopReason)})`,
        code: 'OPERATOR_ERROR',
      },
    }
  }
}

function terminalCodeFor(stopReason: 'error' | 'refusal'): string {
  return stopReason === 'error' ? 'OPERATOR_ERROR' : 'OPERATOR_REFUSED'
}

const PHYSICAL_OPERATOR_PROGRESS_PAGE_LIMIT = 100
const PHYSICAL_OPERATOR_PROGRESS_POLL_MS = 750
const MAX_RESIDENT_OBSERVATION_PREVIEW = 1_600
const MAX_RESIDENT_OBSERVATION_NAME = 160

interface PhysicalOperatorProgressProjectionState {
  afterSequence: number
  readonly projected: Set<number>
}

/** Start a bounded best-effort observer while any physical-operator turn is running. */
function observePhysicalOperatorProgress(
  ctx: Context,
  agent: Agent,
  run: PhysicalOperatorRun,
  commandId: string,
): { drain(): Promise<void>; stop(): Promise<void> } {
  const state = progressProjectionState(agent, commandId)
  let active = true
  let pending: Promise<void> | undefined
  const drain = async (): Promise<void> => {
    if (pending !== undefined) return pending
    const operation = projectPhysicalOperatorProgress(ctx, agent, run, commandId, state).finally(() => {
      if (pending === operation) pending = undefined
    })
    pending = operation
    return operation
  }
  const timer = setInterval(() => {
    if (active) void drain()
  }, PHYSICAL_OPERATOR_PROGRESS_POLL_MS)
  void drain()
  return {
    drain,
    async stop(): Promise<void> {
      active = false
      clearInterval(timer)
      await drain()
    },
  }
}

function progressProjectionState(agent: Agent, commandId: string): PhysicalOperatorProgressProjectionState {
  const projected = new Set<number>()
  let afterSequence = 0
  for (const event of agent.session.events) {
    if (event.type !== 'physical-operator/progress' || event.data.commandId !== commandId) continue
    projected.add(event.data.sequence)
    afterSequence = Math.max(afterSequence, event.data.sequence)
  }
  return { afterSequence, projected }
}

function boundedResidentText(value: unknown, limit: number, multiline = false): string | undefined {
  if (typeof value !== 'string') return undefined
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu : /[\u0000-\u001f\u007f]/gu
  return value.replace(controls, '').slice(0, limit)
}

/**
 * Re-check the daemon boundary before copying it into Session. The Resident
 * daemon already sanitizes observations, but remote providers are still an
 * untrusted boundary: only the documented bounded public shapes survive.
 */
function safeResidentProgressData(type: string, payload: unknown, commandId: string): Record<string, JsonValue> | undefined {
  if (!isJsonValue(payload) || payload === null || Array.isArray(payload)) return undefined
  const data = payload as Record<string, JsonValue>
  if (data.commandId !== commandId) return undefined
  if (type === 'turn.progress') {
    const phase = boundedResidentText(data.phase, MAX_RESIDENT_OBSERVATION_NAME)
    return phase === undefined ? undefined : { commandId, phase }
  }
  if (type === 'turn.settled') {
    const stopReason = boundedResidentText(data.stopReason, MAX_RESIDENT_OBSERVATION_NAME)
    return stopReason === undefined ? undefined : { commandId, stopReason }
  }
  if (type.startsWith('chatgpt-web.')) {
    const phase = boundedResidentText(data.phase, MAX_RESIDENT_OBSERVATION_NAME)
    if (phase === undefined) return undefined
    const projected: Record<string, JsonValue> = { commandId, phase }
    if (typeof data.requestedModel === 'string') {
      const requestedModel = boundedResidentText(data.requestedModel, MAX_RESIDENT_OBSERVATION_NAME)
      if (requestedModel !== undefined) projected.requestedModel = requestedModel
    }
    if (typeof data.outputBytes === 'number' && Number.isSafeInteger(data.outputBytes) && data.outputBytes >= 0) {
      projected.outputBytes = data.outputBytes
    }
    if (typeof data.truncated === 'boolean') projected.truncated = data.truncated
    if (typeof data.code === 'string') {
      const code = boundedResidentText(data.code, MAX_RESIDENT_OBSERVATION_NAME)
      if (code !== undefined) projected.code = code
    }
    return projected
  }
  if (type !== 'turn.observation') return undefined
  const kind = boundedResidentText(data.kind, MAX_RESIDENT_OBSERVATION_NAME)
  switch (kind) {
    case 'public-output': {
      const preview = boundedResidentText(data.preview, MAX_RESIDENT_OBSERVATION_PREVIEW, true)
      return preview === undefined ? undefined : { commandId, kind, preview }
    }
    case 'tool-started':
    case 'tool-completed': {
      const toolName = boundedResidentText(data.toolName, MAX_RESIDENT_OBSERVATION_NAME)
      return toolName === undefined ? undefined : { commandId, kind, toolName }
    }
    case 'approval-required': {
      const approvalKind = boundedResidentText(data.approvalKind, MAX_RESIDENT_OBSERVATION_NAME)
      const preview = boundedResidentText(data.preview, MAX_RESIDENT_OBSERVATION_PREVIEW)
      return approvalKind === undefined ? undefined : {
        commandId, kind, approvalKind,
        ...preview === undefined ? {} : { preview },
      }
    }
    case 'usage-updated': {
      if (!isJsonValue(data.usage) || data.usage === null || Array.isArray(data.usage)) return undefined
      const usage = data.usage as Record<string, JsonValue>
      const numericUsage = Object.fromEntries(
        ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'costUsd']
          .flatMap(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? [[key, usage[key]]] : []),
      ) as Record<string, JsonValue>
      return Object.keys(numericUsage).length === 0 ? undefined : { commandId, kind, usage: numericUsage }
    }
    default: return undefined
  }
}

/**
 * Copy the settled Resident event page into the owning DSH Session. The
 * provider page is process/durable-boundary data, so only lossless JSON
 * records for this command are admitted; older/replayed pages are deduped by
 * their native sequence. A read failure remains observable in the host log
 * without replacing the model result that already settled.
 */
async function projectPhysicalOperatorProgress(
  ctx: Context,
  agent: Agent,
  run: PhysicalOperatorRun,
  commandId: string,
  state = progressProjectionState(agent, commandId),
): Promise<void> {
  if (run.readEvents === undefined) return
  try {
    while (true) {
      const page = await run.readEvents(state.afterSequence, PHYSICAL_OPERATOR_PROGRESS_PAGE_LIMIT)
      if (page.events.length === 0) return
      let lastSequence = state.afterSequence
      for (const event of page.events) {
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence) {
          throw new Error(`invalid progress sequence for physical operator command ${commandId}`)
        }
        if (typeof event.type !== 'string' || typeof event.time !== 'string') {
          throw new Error(`invalid progress payload for physical operator command ${commandId}`)
        }
        lastSequence = event.sequence
        const data = safeResidentProgressData(event.type, event.data, commandId)
        if (data === undefined || state.projected.has(event.sequence)) continue
        agent.session.append('physical-operator/progress', {
          commandId,
          operatorId: String(run.operatorId),
          sequence: event.sequence,
          type: event.type,
          time: event.time,
          data,
        }, { ignorable: true })
        state.projected.add(event.sequence)
      }
      state.afterSequence = lastSequence
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    agent.session.append('physical-operator/trace-degraded', {
      commandId,
      operatorId: String(run.operatorId),
      code: 'PROGRESS_UNAVAILABLE',
      message,
    }, { ignorable: true })
    ctx.logger.warn(`physical-operator: progress projection for "${commandId}" failed: ${message}`)
  }
}

/**
 * Adapt native physical-operator accounting to the LLM stream vocabulary.
 *
 * The two contracts deliberately use different cache field names: the
 * physical seam keeps the product-neutral `*InputTokens` names while the LLM
 * stream uses the disjoint `cache*Tokens` buckets consumed by Session and
 * billing projections.  No synthetic zero sample is emitted when a product
 * has no authoritative counters; absence must remain distinguishable from a
 * real zero-token response.
 */
function tokenUsageFor(usage: PhysicalOperatorUsage | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...usage.cacheReadInputTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadInputTokens },
    ...usage.cacheWriteInputTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteInputTokens },
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
    return { error: 'usage: /operator-profile <codex|claude-code> <model|auto> <effort|auto>' }
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
  return value === 'codex' || value === 'claude-code'
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
    'Physical operators use their own native subscription surface, including configured browser subscriptions; they are never an API fallback.',
    'Choose resident mode for repository implementation, multi-turn work, work that must remain inspectable across a DSH restart, or work that should continue in the same native product session. Keep ephemeral mode for one bounded independent check; a browser-only provider may intentionally support ephemeral mode only.',
    'When routing automatically, prefer implementation/debugging/testing tags for code changes and analysis/architecture/review/long-context tags for broad reasoning. RLM and Continuous Harness are TaskGraph strategies, never operator ids. Call action=list if the suitable stable id is not already evident from the catalog below.',
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
    case 'chatgpt-web':
      return 'Physical-operator routing policy: CHATGPT WEB EXPLICIT. Use the authenticated ChatGPT website for bounded non-trivial work through the configured browser subscription. This is an ephemeral route, does not expose a DSH model or effort setting, and is never selected by Smart Auto.'
  }
}

function operatorDisplayName(operatorId: string): string {
  if (operatorId === 'codex') return 'Codex'
  if (operatorId === 'claude-code') return 'Claude Code'
  if (operatorId === 'chatgpt-web') return 'ChatGPT Web'
  return operatorId
}

/** Reject run-only keys on list so accidental work requests are never ignored. */
function rejectRunFieldsOnList(request: ToolRequest): void {
  for (const field of ['operator_id', 'description', 'prompt', 'mode', 'required_capabilities'] as const) {
    if (request[field] !== undefined) {
      throw new Error(`physical_operator action=list does not accept ${field}`)
    }
  }
}

/** DSH-owned browser tool capabilities require the Resident bridge. */
function rejectUnsupportedCapabilityMode(request: ToolRequest): void {
  if (request.required_capabilities?.includes('browser') === true && request.mode !== 'resident') {
    throw new Error('physical_operator capability "browser" through the DSH tool surface requires mode="resident"; retry with mode="resident"')
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
async function settleForeground(
  run: PhysicalOperatorRun,
  beforeDispose?: () => void | Promise<void>,
): Promise<PhysicalOperatorResult> {
  const [execution] = await Promise.allSettled([run.result.then((result) => {
    const error = stopReasonError(result)
    if (error !== undefined) throw new Error(withPartialText(error, result.output))
    return result
  })])
  await beforeDispose?.()
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
