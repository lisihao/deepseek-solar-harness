/** Model-facing durable TaskGraph orchestration Consumer. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import {
  OrchestrationRunId,
  type LogicalTaskGraphV1,
  type OrchestrationRunSnapshot,
} from '@deepseek-ai/dsh-orchestration'

export const name = 'tool-orchestration'
export const inject = ['orchestrations', 'tools', 'systemPrompt']

type ToolArgs = {
  readonly action: 'start' | 'list' | 'inspect'
  readonly objective?: string
  readonly graph_json?: string
  readonly run_id?: string
}

const GUIDANCE = 'Use the orchestration tool for non-trivial work that benefits from an explicit dependency graph, parallel independent nodes, durable Resident execution, approval, retries, or recovery across DSH restarts. Do not use it for a simple answer or one atomic tool call. For action=start, construct a complete version-1 logical TaskGraph JSON with explicit capability/effect/scope/context/retry/acceptance upper bounds. Low-risk graphs start automatically; medium/high-risk graphs stop at human approval. Inspect existing runs instead of recreating work after a restart.'

const VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const

function jsonObject(value: object): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
}

function bounded(snapshot: OrchestrationRunSnapshot): Record<string, JsonValue> {
  return jsonObject({
    runId: String(snapshot.runId),
    title: snapshot.title,
    state: snapshot.state,
    revision: snapshot.revision,
    graphRevision: snapshot.graphRevision,
    nodes: snapshot.nodes.map(node => ({
      id: node.id,
      title: node.title,
      state: node.state,
      attempt: node.attempt,
      capabilityGeneration: node.capabilityGeneration,
      ...node.operatorId === undefined ? {} : { operatorId: node.operatorId },
      evidenceRefs: node.evidenceRefs.map(String),
      blockers: node.blockers,
    })),
    blockers: snapshot.blockers,
  })
}

function parseGraph(value: string | undefined): LogicalTaskGraphV1 {
  if (value === undefined || value.length === 0) throw new Error('graph_json is required for action=start')
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch (error) {
    throw new Error(`graph_json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return parsed as LogicalTaskGraphV1
}

/** Register one compact orchestration tool and its automatic-entry policy. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:orchestration', order: 118, text: GUIDANCE })
  ctx.tools.register(defineTool({
    name: 'orchestration',
    description: 'Compile/start a durable Resident TaskGraph, list runs, or inspect one run. Complex low-risk work may be started automatically; risky work remains awaiting human approval.',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'list', 'inspect'] },
      objective: { type: 'string', description: 'Unmodified user objective; required for start.' },
      graph_json: { type: 'string', description: 'Complete LogicalTaskGraphV1 JSON; required for start.' },
      run_id: { type: 'string', description: 'Run id; required for inspect.' },
    },
    output: {
      schema: VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args: ToolArgs) {
      if (args.action === 'list') return jsonObject({ kind: 'list', runs: (await ctx.orchestrations.list()).map(bounded) })
      if (args.action === 'inspect') {
        if (args.run_id === undefined || args.run_id.length === 0) throw new Error('run_id is required for action=inspect')
        return jsonObject({ kind: 'inspect', run: bounded(await ctx.orchestrations.inspect(OrchestrationRunId(args.run_id))) })
      }
      if (args.objective === undefined || args.objective.trim().length === 0) throw new Error('objective is required for action=start')
      const compilation = await ctx.orchestrations.compile({
        intent: { request: args.objective },
        graph: parseGraph(args.graph_json),
      })
      const run = await ctx.orchestrations.start({ compilationId: compilation.compilationId })
      return jsonObject({
        kind: 'start',
        compilationId: compilation.compilationId,
        certificateSha256: compilation.certificate.certificateSha256,
        run: bounded(run),
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: args.action === 'start' ? 'Start durable TaskGraph' : args.action === 'list' ? 'List TaskGraphs' : 'Inspect TaskGraph',
      kind: args.action === 'list' || args.action === 'inspect' ? 'read' : 'other',
      ...args.run_id === undefined ? {} : { rawInput: args.run_id },
    }),
  }))
}
