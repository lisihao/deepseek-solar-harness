/**
 * Model-facing `physical_operator` consumer. The model discovers stable
 * operator ids and invokes one without selecting a subprocess, SDK, model, or
 * provider transport. All execution remains on `ctx.physicalOperators`.
 *
 * @module @deepseek-ai/dsh-tool-physical-operator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  PhysicalOperatorResult,
  PhysicalOperatorRun,
  PhysicalOperatorStatus,
} from '@deepseek-ai/dsh-physical-operator'

export const name = 'tool-physical-operator'
export const inject = ['tools', 'physicalOperators']

type ToolRequest = {
  readonly action: string
  readonly operator_id?: string
  readonly description?: string
  readonly prompt?: string
}

type OperatorListValue = {
  readonly operatorId: string
  readonly displayName: string
  readonly description: string
  readonly tags: string[]
  readonly state: PhysicalOperatorStatus['state']
  readonly active: number
  readonly maxConcurrency: number
  readonly unavailableReason?: string
}

type ToolValue =
  | { readonly kind: 'list'; readonly operators: OperatorListValue[] }
  | {
    readonly kind: 'run'
    readonly operatorId: string
    readonly executionId: string
    readonly output: JsonValue[]
  }

/** Register the fixed discovery-and-execution tool. */
export function apply(ctx: Context): void {
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
      })
      const result = await settleForeground(run)
      return {
        kind: 'run',
        operatorId: String(run.operatorId),
        executionId: String(run.id),
        output: result.output as unknown as JsonValue[],
      }
    },
  }))
}

/** Reject run-only keys on list so accidental work requests are never ignored. */
function rejectRunFieldsOnList(request: ToolRequest): void {
  for (const field of ['operator_id', 'description', 'prompt'] as const) {
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
