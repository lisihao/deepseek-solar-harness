/** Model-facing durable TaskGraph orchestration Consumer. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import {
  OrchestrationRunId,
  type LogicalTaskGraphV1,
  type OrchestrationRunSnapshot,
} from '@deepseek-ai/dsh-orchestration'
import type {
  ContinualHarnessMode,
  ExecutionModelPreference,
  ModelAllocationObjective,
  PlannerVerifierPreference,
  RlmExecutionMode,
} from '@deepseek-ai/dsh-model-allocation'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { OrchestrationExecutionPreferences, OrchestrationExecutionPreferencesSelect } from './types.ts'

export type * from './types.ts'

type CollaborationPolicy = 'auto' | 'direct' | 'codex' | 'claude-code'

const RLM_OPTIONS = ['auto', 'enabled', 'disabled'] as const satisfies readonly RlmExecutionMode[]
const HARNESS_OPTIONS = ['auto', 'off', 'session', 'workspace', 'global'] as const satisfies readonly ContinualHarnessMode[]
const OPTIMIZATION_OPTIONS = ['balanced', 'quality', 'speed', 'economy'] as const satisfies readonly ModelAllocationObjective[]
const PLANNER_VERIFIER_OPTIONS = ['codex-sol', 'best-high-tier'] as const satisfies readonly PlannerVerifierPreference[]
const EXECUTION_OPTIONS = ['luna-first', 'balanced'] as const satisfies readonly ExecutionModelPreference[]
const DEFAULT_PREFERENCES: OrchestrationExecutionPreferences = {
  rlm: 'auto', continualHarness: 'auto', optimization: 'balanced',
  plannerVerifierPreference: 'codex-sol', executionPreference: 'luna-first',
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable link from one DSH collaboration decision to its TaskGraph run. */
    'orchestration/admission': {
      policy: CollaborationPolicy
      route: 'taskgraph'
      runId: string
      maxParallel: number
      rlm: RlmExecutionMode
      continualHarness: ContinualHarnessMode
      optimization: ModelAllocationObjective
      plannerVerifierPreference: PlannerVerifierPreference
      executionPreference: ExecutionModelPreference
    }
    /** Whole-value strategy preference for future TaskGraph admissions. */
    'orchestration/preferences': OrchestrationExecutionPreferences
  }
}

export const name = 'tool-orchestration'
export const inject = ['orchestrations', 'tools', 'systemPrompt']

type ToolArgs = {
  readonly action: 'start' | 'list' | 'inspect'
  readonly objective?: string
  readonly graph_json?: string
  readonly run_id?: string
}

/** Model-visible policy for durable graphs and per-node Resident operator routing. */
export const orchestrationGuidance = 'Use the orchestration tool for non-trivial work that benefits from an explicit dependency graph, parallel independent nodes, durable Resident execution, approval, retries, or recovery across DSH restarts. Under Smart Auto, prefer this durable TaskGraph path over directly handing a parallelizable task to one Resident operator. Do not use it for a simple answer or one atomic tool call. For action=start, construct a complete version-1 logical TaskGraph JSON with explicit capability/effect/scope/context/retry/acceptance upper bounds and the smallest useful maxParallel ceiling (normally at most 4). Independent nodes run without a phase barrier; dependencies and overlapping write/effect scopes serialize explicitly. For repository-changing work, set qualityPolicy.independentVerification="required", give every mutating node a completion-critical downstream verification node, set graph.baseSha to the clean repository HEAD, and set workspaceIsolation="git-worktree" so each mutating attempt receives its own branch and worktree. Mark planning and verification nodes with phase="planning" or phase="verification" so the allocator requires a high-tier model; execution leaves normally use phase="execution" and low/mid-tier models. Each accepted attempt seals a content-addressed Workbench task contract covering repository/base SHA, execution worktree, authority, dependencies, artifacts, model roles, quota, timeout, retry, and permissions. RLM is a bounded node strategy declared with node.rlm, not an operator id or another global Scheduler. Continuous Harness is an admission preference that supplies versioned workspace/session context without mutating the Graph. Allocation is native-subscription first: Codex and Claude Code capacity is consumed before billed DeepSeek API workers; Codex standard and Spark are independent quota pools, and unused quota nearing reset increases safe parallelism. The default Codex-optimized policy prefers Sol for planning/verification gates and Luna for qualified coding leaves; users can switch independently to best-high-tier and balanced execution without changing the Graph. DeepSeek V4 Flash/Pro are the final text-only fallback and cannot receive file-writing nodes. DSH remains the only global Scheduler and acceptance authority. Leave operator.preferredIds unset for intelligent routing. Set it only when the user or task explicitly requires an operator; an unavailable explicit preference must fail rather than silently switch products. Every node receives the mandatory clean-task Context Capsule and a fresh native execution lane. Low-risk graphs start automatically; medium/high-risk graphs stop at human approval. Inspect existing runs instead of recreating work after a restart.'

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

function collaborationPolicy(events: readonly { readonly type: string; readonly data: unknown }[]): CollaborationPolicy {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'physical-operator/policy') continue
    const policy = (event.data as { policy?: unknown }).policy
    if (policy === 'auto' || policy === 'direct' || policy === 'codex' || policy === 'claude-code') return policy
  }
  return 'auto'
}

/**
 * Fold the latest orchestration strategy selection from a Session event stream.
 * @param events Ordered Session events.
 * @returns The latest valid selection, or the product defaults.
 */
export function foldOrchestrationPreferences(
  events: readonly { readonly type: string; readonly data: unknown }[],
): OrchestrationExecutionPreferences {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'orchestration/preferences') {
      return { ...DEFAULT_PREFERENCES, ...(event.data as Partial<OrchestrationExecutionPreferences>) }
    }
  }
  return { ...DEFAULT_PREFERENCES }
}

function preferenceProjection(value: OrchestrationExecutionPreferences): OrchestrationExecutionPreferencesSelect {
  return {
    ...value,
    rlmOptions: RLM_OPTIONS,
    continualHarnessOptions: HARNESS_OPTIONS,
    optimizationOptions: OPTIMIZATION_OPTIONS,
    plannerVerifierPreferenceOptions: PLANNER_VERIFIER_OPTIONS,
    executionPreferenceOptions: EXECUTION_OPTIONS,
  }
}

/** Register one compact orchestration tool and its automatic-entry policy. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:orchestration', order: 118, text: orchestrationGuidance })
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'orchestrationExecutionPreferences', OrchestrationExecutionPreferences>({
      key: 'orchestrationExecutionPreferences',
      schema: zod.object({
        rlm: zod.enum(RLM_OPTIONS), continualHarness: zod.enum(HARNESS_OPTIONS), optimization: zod.enum(OPTIMIZATION_OPTIONS),
        plannerVerifierPreference: zod.enum(PLANNER_VERIFIER_OPTIONS),
        executionPreference: zod.enum(EXECUTION_OPTIONS),
        rlmOptions: zod.array(zod.enum(RLM_OPTIONS)),
        continualHarnessOptions: zod.array(zod.enum(HARNESS_OPTIONS)),
        optimizationOptions: zod.array(zod.enum(OPTIMIZATION_OPTIONS)),
        plannerVerifierPreferenceOptions: zod.array(zod.enum(PLANNER_VERIFIER_OPTIONS)),
        executionPreferenceOptions: zod.array(zod.enum(EXECUTION_OPTIONS)),
      }),
      init: () => ({ ...DEFAULT_PREFERENCES }),
      apply: (state, event) => event.type === 'orchestration/preferences'
        ? { ...DEFAULT_PREFERENCES, ...event.data }
        : state,
      view: preferenceProjection,
      stateVersion: 3,
    })
  })
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'orchestration-strategy',
      description: 'Select RLM, Continuous Harness, optimization, planning/verifying model policy, and execution model policy',
      input: { hint: '<rlm> <auto|off|session|workspace|global> <optimization> <codex-sol|best-high-tier> <luna-first|balanced>' },
      handler: ({ agent, rawInput }) => {
        const [
          rlm, continualHarness, optimization, plannerVerifierPreference, executionPreference, ...extra
        ] = rawInput.trim().split(/\s+/u)
        if (!RLM_OPTIONS.some(value => value === rlm)
          || !HARNESS_OPTIONS.some(value => value === continualHarness)
          || !OPTIMIZATION_OPTIONS.some(value => value === optimization)
          || !PLANNER_VERIFIER_OPTIONS.some(value => value === plannerVerifierPreference)
          || !EXECUTION_OPTIONS.some(value => value === executionPreference)
          || extra.length > 0) {
          return { kind: 'error', text: 'usage: /orchestration-strategy <auto|enabled|disabled> <auto|off|session|workspace|global> <balanced|quality|speed|economy> <codex-sol|best-high-tier> <luna-first|balanced>' }
        }
        const preferences = {
          rlm, continualHarness, optimization, plannerVerifierPreference, executionPreference,
        } as OrchestrationExecutionPreferences
        agent.session.append('orchestration/preferences', preferences, { ignorable: true })
        return {
          kind: 'success',
          text: `orchestration strategy ${rlm}/${continualHarness}/${optimization}/${plannerVerifierPreference}/${executionPreference}`,
        }
      },
    })
  })
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
    async execute(args: ToolArgs, exec) {
      if (args.action === 'list') return jsonObject({ kind: 'list', runs: (await ctx.orchestrations.list()).map(bounded) })
      if (args.action === 'inspect') {
        if (args.run_id === undefined || args.run_id.length === 0) throw new Error('run_id is required for action=inspect')
        return jsonObject({ kind: 'inspect', run: bounded(await ctx.orchestrations.inspect(OrchestrationRunId(args.run_id))) })
      }
      if (args.objective === undefined || args.objective.trim().length === 0) throw new Error('objective is required for action=start')
      const graph = parseGraph(args.graph_json)
      const agent = exec.agent
      const policy = agent === undefined ? 'auto' : collaborationPolicy(agent.session.events)
      const preferences = agent === undefined ? DEFAULT_PREFERENCES : foldOrchestrationPreferences(agent.session.events)
      const compilation = await ctx.orchestrations.compile({
        intent: { request: args.objective },
        graph,
        ...agent === undefined ? {} : {
          admission: { policy, route: 'taskgraph', sourceSessionId: String(agent.id), ...preferences },
        },
      })
      const run = await ctx.orchestrations.start({ compilationId: compilation.compilationId })
      agent?.session.append('orchestration/admission', {
        policy,
        route: 'taskgraph',
        runId: String(run.runId),
        maxParallel: graph.maxParallel,
        ...preferences,
      }, { ignorable: true })
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
