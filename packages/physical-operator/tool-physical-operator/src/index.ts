/**
 * Model-facing `physical_operator` consumer. The model discovers stable
 * operator ids and invokes one without selecting a subprocess, SDK, model, or
 * provider transport. All execution remains on `ctx.physicalOperators`.
 *
 * @module @deepseek-ai/dsh-tool-physical-operator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import type {
  PhysicalOperatorResult,
  PhysicalOperatorRun,
  PhysicalOperatorStatus,
} from '@deepseek-ai/dsh-physical-operator'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  PhysicalOperatorRoutingOption,
  PhysicalOperatorRoutingPolicy,
  PhysicalOperatorRoutingSelect,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole-value physical-operator routing preference for subsequent model requests.
     * @param policy The selected automatic, direct, Codex, or Claude Code policy.
     */
    'physical-operator/policy': { policy: PhysicalOperatorRoutingPolicy }
  }
}

export const name = 'tool-physical-operator'
export const inject = ['tools', 'physicalOperators', 'systemPrompt']

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
  'auto', 'direct', 'codex', 'claude-code',
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
]

const routingProjectionSchema = zod.object({
  options: zod.array(zod.object({
    value: zod.enum(PHYSICAL_OPERATOR_ROUTING_POLICIES),
    name: zod.string(),
    description: zod.string(),
  })),
  currentValue: zod.enum(PHYSICAL_OPERATOR_ROUTING_POLICIES),
})

/** Register the fixed discovery-and-execution tool. */
export function apply(ctx: Context): void {
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
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'operator',
      description: 'Select automatic physical-operator routing or a preferred native worker',
      input: { hint: '<auto|direct|codex|claude-code>' },
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
          agent.session.append('physical-operator/policy', { policy: value })
        }
        return { kind: 'success', text: `routing ${value}` }
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
    'Physical operators are separate native Claude Code or Codex workers using the user subscription, never an API fallback.',
    'Choose resident mode for repository implementation, multi-turn work, work that must remain inspectable across a DSH restart, or work that should continue in the same native product session. Keep ephemeral mode for one bounded independent check.',
    'When routing automatically, prefer implementation/debugging/testing tags for code changes and analysis/architecture/review/long-context tags for broad reasoning. Call action=list if the suitable stable id is not already evident from the catalog below.',
    'Send one complete standalone prompt. Do not delegate trivial questions, translation, or a tiny direct edit whose coordination cost exceeds the work.',
    ...available.map(operator => `- ${operator}`),
  ].join('\n')
}

/** Policy-specific model instruction placed before the shared operator guidance. */
function routingPolicyGuidance(policy: PhysicalOperatorRoutingPolicy): string {
  switch (policy) {
    case 'auto':
      return 'Physical-operator routing policy: SMART AUTO. At the start of every non-trivial request, explicitly decide whether delegation improves implementation quality, independent verification, or continuity. Invoke a suitable available operator without waiting for the user to name Claude Code or Codex. Multi-file coding, debugging, refactoring, tests/builds, repository review, and long-running work normally qualify.'
    case 'direct':
      return 'Physical-operator routing policy: CURRENT MODEL ONLY. Do not call physical_operator unless the current user message explicitly requests an operator.'
    case 'codex':
      return 'Physical-operator routing policy: CODEX PREFERRED. For every delegable non-trivial task, invoke the available codex operator without waiting for the user to repeat the preference; use resident mode for continuing repository work.'
    case 'claude-code':
      return 'Physical-operator routing policy: CLAUDE CODE PREFERRED. For every delegable non-trivial task, invoke the available claude-code operator without waiting for the user to repeat the preference; use resident mode for continuing repository work.'
  }
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
