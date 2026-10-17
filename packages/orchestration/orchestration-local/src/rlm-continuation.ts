/**
 * What an RLM execution ends in after its last continuation, and the prompt of each continuation; the pure helpers that build an
 * RLM or TaskGraph node's prompt and context envelope and project its usage and attempt-abort reasons; and the one error type
 * the daemon's `executeModelWorker` and the RLM execution core (`rlm-execution-core.ts`) both construct and check with
 * `instanceof`. This file has no dependency on either of them, so both import from here instead of from each other.
 */
import { OrchestrationError } from '@deepseek-ai/dsh-orchestration'
import type { ModelAllocationPlan } from '@deepseek-ai/dsh-model-allocation'
import type { ContentBlock, ContextSnapshotSection, ResolvedRetryPolicy, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { PhysicalOperatorModelToolBridgeV1, PhysicalOperatorResult, PhysicalOperatorUsage } from '@deepseek-ai/dsh-physical-operator'
import type { ContextPacketV1 } from '@deepseek-ai/dsh-context-compiler'
import type { CapabilityBindingPlanV1 } from '@deepseek-ai/dsh-capability-capsule'
import type { ContinualHarnessSnapshotV1 } from '@deepseek-ai/dsh-continual-harness'
import {
  buildOperatorContextEnvelope,
  renderOperatorContextEnvelopeText,
  type OperatorContextEnvelopeV1,
} from '@deepseek-ai/dsh-system-prompt'
import { renderTaskTemplateInjection } from '@deepseek-ai/dsh-task-template-context'
import type { TaskTemplateSelection } from '@deepseek-ai/dsh-task-template'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { NodeExecutionPlanV1, OrchestrationNodeSpecV1 } from '@deepseek-ai/dsh-orchestration'
import type { RlmExecutionPlanV1 } from '@deepseek-ai/dsh-rlm-strategy'
import { operatorOutputPreview } from './output-preview.ts'
import {
  RlmRuntimeError,
  type RlmChildExecutionOptionsV1,
  type RlmChildExecutionResult,
  type RlmChildModelPolicyV1,
  type RlmChildResultContentV1,
  type RlmFamilyRosterV1,
  type RlmJsonValue,
  type RlmRuntimeSessionSnapshotV1,
  type RlmStopReason,
} from '@deepseek-ai/dsh-rlm-runtime'

/**
 * The reason with which an attempt is aborted while its run keeps running, so that such an abort can be told from the run's
 * cancellation. Aborting with any other reason (a cancellation of the run, a shutdown, an interrupt of a child) is not one of these.
 */
export class AttemptAbortReason extends Error {}

/** The runtime interrupted the root session of the attempt; the run is not cancelled and the node may be run again. */
export class RootInterruptedError extends AttemptAbortReason {
  constructor() {
    super('the root session of the attempt was interrupted')
    this.name = 'RootInterruptedError'
  }
}

/**
 * Whether the work was stopped together with its run: aborted for a reason other than the attempt's deadline or an interrupt of
 * its root session, which leave the run running. A request that such an abort interrupted may still be in doubt, and the node
 * would be run again, so it is not a cancellation.
 * @param signal - the signal the work ran under.
 * @returns `true` when the signal was aborted together with the run (or by an interrupt of one execution below the root).
 */
export function abortedWithTheRun(signal: AbortSignal): boolean {
  return signal.aborted && !(signal.reason instanceof AttemptAbortReason)
}

/**
 * A model-worker command that failed under an evaluation scope after sending a physical request whose usage the ledger does not
 * hold. The request may have been processed and billed, so the command is an unknown outcome and must not be retried as an
 * ordinary failure. Created only under a scope, by the daemon's `executeModelWorker` and by the RLM execution core.
 */
export class UnknownPhysicalOutcomeError extends OrchestrationError {
  /** The failure of the command, and, if the store refused the metering event, that refusal as well. */
  override readonly cause: unknown

  constructor(message: string, cause: unknown) {
    super(message, 'COMMAND_INDETERMINATE')
    this.name = 'UnknownPhysicalOutcomeError'
    this.cause = cause
  }
}

function isPhysicalOperatorUsage(
  usage: PhysicalOperatorUsage | TokenUsage,
): usage is PhysicalOperatorUsage {
  return 'cacheReadInputTokens' in usage || 'cacheWriteInputTokens' in usage
}

function rlmAuthMode(
  source: 'native-subscription' | 'metered-api' | undefined,
  operatorId: string,
): 'api' | 'subscription' {
  if (source !== undefined) return source === 'metered-api' ? 'api' : 'subscription'
  return operatorId.startsWith('deepseek') ? 'api' : 'subscription'
}

/** The usage-bearing fields of either a Resident `PhysicalOperatorResult` or an API `ModelWorkerResult`. */
export type RlmUsageResult = Pick<PhysicalOperatorResult, 'stopReason' | 'usage'>
  | { readonly stopReason: string; readonly usage?: PhysicalOperatorUsage | TokenUsage }

/**
 * The usage of one RLM turn or command, normalized to one shape regardless of whether it came from a Resident
 * `PhysicalOperatorResult` or an API `ModelWorkerResult`.
 * @param result - the turn or command's result.
 * @returns `undefined` when the result carries no usage.
 */
export function rlmUsage(result: RlmUsageResult): {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheWriteInputTokens: number
  readonly costUsd?: number
} | undefined {
  const usage = result.usage
  if (usage === undefined) return undefined
  const physical = isPhysicalOperatorUsage(usage)
  const cacheReadInputTokens = physical ? usage.cacheReadInputTokens ?? 0 : usage.cacheReadTokens ?? 0
  const cacheWriteInputTokens = physical ? usage.cacheWriteInputTokens ?? 0 : usage.cacheWriteTokens ?? 0
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    ...physical && usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {},
  }
}

/**
 * The usage of one RLM child or continuation turn, attributed to the operator and model it actually ran on, in the shape an
 * {@link RlmChildExecutionResult} carries it.
 * @param result - the turn's result.
 * @param model - the operator, model and recorded source the turn actually ran with.
 * @returns `undefined` when the result carries no usage.
 */
export function rlmAttributedUsage(
  result: RlmUsageResult,
  model: {
    readonly operatorId: string
    readonly model: string
    readonly source?: 'native-subscription' | 'metered-api'
  },
): RlmChildExecutionResult['usage'] {
  const usage = rlmUsage(result)
  if (usage === undefined) return undefined
  return {
    provider: model.operatorId,
    model: model.model,
    authMode: rlmAuthMode(model.source, model.operatorId),
    ...usage,
  }
}

/**
 * Which model policy a sealed RLM plan's fidelity implies for a child that does not pick a model explicitly.
 * @param plan - the sealed RLM execution plan.
 * @returns `'parent-inherit'` for Prime Strict, `'allocator-default'` for the DSH-optimized fidelity.
 * @throws OrchestrationError `GRAPH_INVALID` for a fidelity this build does not know.
 */
export function rlmChildModelPolicy(plan: RlmExecutionPlanV1): RlmChildModelPolicyV1 {
  if (plan.fidelity === 'prime-strict') return 'parent-inherit'
  if (plan.fidelity === 'dsh-optimized') return 'allocator-default'
  throw new OrchestrationError(`enabled RLM plan has unsupported fidelity: ${plan.fidelity}`, 'GRAPH_INVALID')
}

/**
 * The retry policy an RLM root or child session records, derived from its node's sealed retry policy.
 * @param spec - the sealed node spec.
 * @returns the resolved retry policy.
 */
export function rlmChildRetryPolicy(spec: OrchestrationNodeSpecV1): ResolvedRetryPolicy {
  return {
    mode: 'normal',
    maxRetries: Math.max(0, spec.retryPolicy.maxAttempts - 1),
    retryableCodes: [...spec.retryPolicy.retryableCodes],
    initialDelayMs: spec.retryPolicy.backoffMs,
    maxDelayMs: spec.retryPolicy.backoffMs,
    jitterRatio: 0,
  }
}

/**
 * A JSON-safe projection of an RLM session's execution options, for the event that records it.
 * @param options - the session's execution options.
 * @returns the JSON-safe projection.
 */
export function rlmExecutionOptionsSummary(options: RlmChildExecutionOptionsV1): RlmJsonValue {
  return {
    toolNames: (options.tools ?? []).map(tool => tool.name),
    skillAliases: (options.skills ?? []).map(skill => skill.alias),
    retryPolicy: options.retryPolicy === undefined
      ? null
      : options.retryPolicy.mode === 'normal'
        ? {
          mode: options.retryPolicy.mode,
          maxRetries: options.retryPolicy.maxRetries,
          retryableCodes: [...options.retryPolicy.retryableCodes],
          initialDelayMs: options.retryPolicy.initialDelayMs,
          maxDelayMs: options.retryPolicy.maxDelayMs,
          jitterRatio: options.retryPolicy.jitterRatio,
        }
        : {
          mode: options.retryPolicy.mode,
          initialDelayMs: options.retryPolicy.initialDelayMs,
          maxDelayMs: options.retryPolicy.maxDelayMs,
          jitterRatio: options.retryPolicy.jitterRatio,
        },
  }
}

/**
 * Reject a model-tool bridge that offers a tool the sealed RLM execution options did not seal in.
 * @param options - the sealed execution options the turn was given.
 * @param bridge - the model-tool bridge the turn's provider actually offered.
 * @throws OrchestrationError `GRAPH_INVALID` when the bridge offers an unsealed tool.
 */
export function assertRlmBridgeAllowed(
  options: RlmChildExecutionOptionsV1,
  bridge: PhysicalOperatorModelToolBridgeV1,
): void {
  const allowedTools = new Set((options.tools ?? []).map(tool => tool.name))
  const unsealedTool = bridge.tools.find(tool => !allowedTools.has(tool.name))
  if (unsealedTool !== undefined) {
    throw new OrchestrationError(
      `RLM model-tool bridge requested unsealed parent tool: ${unsealedTool.name}`,
      'GRAPH_INVALID',
    )
  }
}

/**
 * The Prime Agent operator-protocol projection of one native RLM turn's `PhysicalOperatorResult`.
 * @param result - the turn's result as the physical operator reported it.
 * @returns the settled or failed `RlmChildExecutionResult` the RLM runtime records for the turn.
 */
export function asRlmExecutionResult(result: PhysicalOperatorResult): RlmChildExecutionResult {
  const status = result.stopReason === 'completed' ? 'settled' as const : 'failed' as const
  return {
    status,
    stopReason: result.stopReason,
    output: result.output,
    outputPreview: operatorOutputPreview(result.output).outputPreview,
    ...status === 'failed' ? { error: `native execution stopped with ${result.stopReason}` } : {},
  }
}

/**
 * The additional instruction appended to an RLM root's prompt describing the programmable runtime it runs under.
 * @param base - the node's own prompt, before this instruction is appended.
 * @param rlmPlan - the sealed RLM execution plan, for its fidelity.
 * @param defaultChild - the sealed default child allocation, when the plan has one.
 * @returns the root's complete prompt content blocks.
 */
export function primeRlmRootPrompt(
  base: readonly ContentBlock[],
  rlmPlan: RlmExecutionPlanV1,
  defaultChild?: ModelAllocationPlan,
): ContentBlock[] {
  return [
    ...base,
    {
      type: 'text',
      text: [
        'This attempt uses the Prime Agent compatible programmable RLM runtime.',
        'Use the native typescript_repl tool as the only programming and delegation surface.',
        'The persistent namespace exposes context, rlm(task, options), rlm.listSubagents(), rlm.deleteSubagent(), agentMessage.send(), agentMessage.read(), harness, goal, and compact().',
        'rlm(...) returns an admission handle immediately, never the child answer. Children deliver answers only by explicit agentMessage.send(...) or artifact references.',
        'You decide the recursive topology dynamically within the sealed depth, child, and turn budgets. Do not ask the Scheduler to manufacture fixed branches.',
        defaultChild === undefined
          ? rlmPlan.fidelity === 'prime-strict'
            ? 'Prime Strict is active: when rlm() omits overrides, every child inherits this parent model, reasoning profile, tools, managed skills, retry policy and sealed capability context. Unsupported rlm() option names fail instead of being ignored.'
            : 'Use lower-cost children for bounded exploration and retain this root model for planning, verification, and final synthesis when that improves the result.'
          : `When rlm() omits a model, the sealed default child is ${defaultChild.operatorId}/${defaultChild.model} (${defaultChild.tier}, ${defaultChild.source}). Use an explicit model only when the task genuinely requires an override.`,
        'Before finishing, read pending family messages, verify coverage against the original task, and return one complete final answer.',
      ].join('\n'),
    },
  ]
}

/**
 * A fake Agent carrying only the workspace and run identity a Prime RLM dispatch needs to pass as `parent`.
 * @param workspace - the execution workspace path.
 * @param runId - the run identity to embed in the fake session id.
 * @returns the fake Agent.
 */
export function fakeParent(workspace: string, runId: string): Agent {
  return {
    id: SessionId(`orchestration-${runId}`),
    session: { header: { cwd: workspace } },
  } as unknown as Agent
}

/** Project the selected task-template content as one named context field. */
function taskTemplateContexts(selection: TaskTemplateSelection | undefined): ContextSnapshotSection[] {
  return selection?.decision === 'inject'
    ? [{
      name: `task-template:${String(selection.selected?.id ?? 'unknown')}`,
      text: renderTaskTemplateInjection(selection),
    }]
    : []
}

const TASKGRAPH_SYSTEM_TEXT = 'You are a DSH TaskGraph worker. Execute only the sealed current node and preserve its declared authority and acceptance rules.'

/**
 * Build the exact current-node handoff, excluding every unrelated node or conversation turn.
 * @param plan - the sealed node execution plan.
 * @param prompt - the node's prompt content blocks.
 * @returns the operator context envelope.
 */
export function taskGraphContextEnvelope(
  plan: NodeExecutionPlanV1,
  prompt: readonly ContentBlock[],
): OperatorContextEnvelopeV1 {
  return buildOperatorContextEnvelope({
    systemText: TASKGRAPH_SYSTEM_TEXT,
    task: prompt,
    contexts: [
      ...(plan.runtimeContext?.sections ?? []),
      ...taskTemplateContexts(plan.taskTemplate),
    ],
    source: {
      kind: 'taskgraph',
      runId: String(plan.runId),
      nodeId: plan.nodeId,
      contextPacketRef: String(plan.contextPacketRef),
    },
  })
}

/**
 * The prompt an operator context envelope renders as, for a transport (the API worker) that takes plain content blocks.
 * @param envelope - the built operator context envelope.
 * @returns the envelope's text, as one text content block.
 */
export function modelWorkerEnvelopePrompt(envelope: OperatorContextEnvelopeV1): ContentBlock[] {
  return [{ type: 'text', text: renderOperatorContextEnvelopeText(envelope) }]
}

/**
 * Build the prompt a TaskGraph node's executor receives: the task, capability instructions, upstream Evidence and Harness state.
 * @param node - the sealed node spec.
 * @param context - the compiled context packet.
 * @param capabilities - the sealed capability binding plan.
 * @param harness - the Continuous Harness snapshot, when one applies.
 * @param rlm - the sealed RLM execution plan, when the node is RLM-enabled.
 * @returns the node's prompt, as one text content block.
 */
export function promptFromPlan(
  node: OrchestrationNodeSpecV1,
  context: ContextPacketV1,
  capabilities: CapabilityBindingPlanV1,
  harness?: ContinualHarnessSnapshotV1,
  rlm?: RlmExecutionPlanV1,
): ContentBlock[] {
  const instructions = capabilities.instructions.map(value => `- ${value.text}`).join('\n')
  const upstream = context.included.filter(value => value.kind === 'artifact').map(value => `- ${value.ref}`).join('\n')
  const upstreamMaterials = context.sourceMaterials.map(value => (
    `Evidence ${value.ref}${value.truncated ? ' (bounded preview)' : ''}:\n${value.text}`
  )).join('\n\n')
  const legacyHarnessEntries = harness?.entries.map(value => `- [${value.kind}] ${value.text} (Evidence: ${value.evidenceRefs.join(', ') || 'none'})`) ?? []
  const managedHarnessEntries = harness?.managedEntries.map(value => [
    `- [${value.kind}] ${value.title}: ${value.content}`,
    ...value.reference === undefined ? [] : [`  reference=${JSON.stringify(value.reference)}`],
    ...value.arguments === undefined ? [] : [`  arguments=${JSON.stringify(value.arguments)}`],
  ].join('\n')) ?? []
  const harnessEntries = [...managedHarnessEntries, ...legacyHarnessEntries].join('\n')
  return [{
    type: 'text',
    text: [
      `TaskGraph node ${node.id}: ${node.title}`,
      '',
      context.task,
      '',
      `Sender workspace: ${context.workspace}`,
      'Use the executor current working directory for filesystem operations. A remote executor materializes the same repository and commit at its own path; the sender workspace is not a directory on that host. Resolve the listed relative scopes against the executor working directory.',
      `Read scopes: ${node.readScopes.join(', ') || 'none'}`,
      `Write scopes: ${node.writeScopes.join(', ') || 'none'}`,
      `Acceptance: ${node.acceptance.map(value => value.description).join('; ') || 'operator completion'}`,
      ...(instructions.length === 0 ? [] : ['', 'Capability instructions:', instructions]),
      ...(upstream.length === 0 ? [] : ['', 'Upstream artifact references:', upstream]),
      ...(upstreamMaterials.length === 0 ? [] : ['', 'Upstream Evidence contents:', upstreamMaterials]),
      ...(harnessEntries.length === 0 ? [] : ['', `Continuous Harness generation ${String(harness?.generation ?? 0)}:`, harnessEntries]),
      ...(rlm?.enabled === true ? [
        '',
        'RLM execution strategy:',
        `- Strategy: ${rlm.strategyId}@${rlm.strategyVersion}.`,
        `- ${rlm.instruction}`,
        `- Sealed RLM plan: ${rlm.planSha256}; reason: ${rlm.reason}.`,
        '- DSH remains the only global TaskGraph Scheduler and acceptance authority.',
      ] : []),
      '',
      'Return a concise result. Do not expand authority beyond the listed scopes and effects.',
    ].join('\n'),
  }]
}

/**
 * The operator result an RLM execution ends in after its last continuation. A continuation that did not settle keeps
 * its own stop reason, and its partial output when it has one, so a failed or indeterminate continuation can no longer
 * be reported as a completed run.
 * @param continuation - the last continuation the runtime drained, when there was one.
 * @param previous - the result before that continuation.
 * @returns `previous` when there was no continuation, or when it settled without output; otherwise the continuation's
 *   stop reason (its own, or the one its status implies) with its output, or with `previous`'s output when it returned none.
 */
export function rlmContinuationResult(
  continuation: RlmChildExecutionResult | undefined,
  previous: PhysicalOperatorResult,
): PhysicalOperatorResult {
  if (continuation === undefined) return previous
  const stopReason = continuation.stopReason
    ?? (continuation.status === 'settled' ? 'completed' : continuation.status === 'failed' ? 'error' : 'aborted')
  if (continuation.output === undefined && stopReason === 'completed') return previous
  return { output: [...continuation.output ?? previous.output], stopReason }
}

/**
 * Whether an RLM result may be followed by another turn of the same execution. Only `completed` may: after `error`,
 * `aborted`, `max-tokens`, or `refusal` a later turn is not started, because its success would replace the real stop
 * reason and the partial output of the turn that did not finish.
 * @param result - the result of the last turn.
 * @returns whether the result is a success.
 */
export function rlmResultSucceeded(result: PhysicalOperatorResult): boolean {
  return result.stopReason === 'completed'
}

/**
 * Most variable names each list of a message continuation names; the rest are counted, not named. This is a fixed bound on how
 * much of a list one prompt carries, not a setting that varies by deployment, so it is not a `Config` field.
 */
export const MAX_CONTINUATION_VARIABLE_NAMES = 64

const GENERIC_INSPECTION = 'Use typescript_repl to inspect the preserved context, variables, child registry, explicit messages, '
  + 'Continuous Harness, and goal state.'

/**
 * The prompt of one continuation of a persistent RLM session.
 * @param request - why the session continues, the instruction it received, and how a queued message is ordered.
 * @param inspection - the sentences that tell the model what state it can use. Omit it for the generic instruction to inspect the
 *   preserved state; a message continuation passes {@link rlmMessageContinuationFacts}.
 * @returns the prompt text. Without `inspection` it is the same text for every `source` as before message continuations restated
 *   their task.
 */
export function rlmContinuationPrompt(
  request: {
    readonly source: 'goal' | 'heartbeat' | 'message' | 'autonomous'
    readonly instruction: string
    readonly deliveryMode: 'steer' | 'follow_up'
    /** The messages a `message` continuation delivers; more than one makes the wording plural. */
    readonly messageIds?: readonly string[]
  },
  inspection: string = GENERIC_INSPECTION,
): string {
  return [
    `Continue the persistent Prime RLM session for this ${request.source}.`,
    request.instruction,
    inspection,
    request.source === 'goal'
      ? 'Audit the objective. Call await goal.complete() only when every requirement is actually achieved; otherwise make concrete progress within this continuation.'
      : request.source === 'heartbeat'
        ? 'Treat this heartbeat as scheduled new work. Use explicit family messages for any recursive results.'
        : request.source === 'autonomous'
          ? 'This follow-up was injected by the host Autonomous policy. Do not claim completion from prose; make concrete progress and let the host quality gates decide.'
          : `Process the queued family message${(request.messageIds?.length ?? 1) > 1 ? 's' : ''} using ${request.deliveryMode} ordering, make any required progress, and reply through agentMessage.send() when another family member needs the result.`,
  ].join('\n')
}

function namedList(names: readonly string[]): string {
  if (names.length === 0) return 'none'
  const shown = names.slice(0, MAX_CONTINUATION_VARIABLE_NAMES).join(', ')
  return names.length > MAX_CONTINUATION_VARIABLE_NAMES
    ? `${shown} (${String(names.length - MAX_CONTINUATION_VARIABLE_NAMES)} more not listed)`
    : shown
}

/**
 * What the host knows about a session that a message continuation would otherwise have to rediscover. The text restates only the
 * session's own task (whole, as the session received it), its saved variable names, and the agents it can already see; it never
 * copies a variable value, another agent's task, or a message. It does not widen who may instruct the session: only controller
 * input, as the runtime recorded it, may change the task, and a message from another agent stays data. Controller input of an
 * earlier turn is not restated.
 * @param session - the session's snapshot; its task, and the names saved by its last successful cell.
 * @param roster - the parent, siblings, and direct children the session can already message. It is listed whole: it holds at most
 *   the parent plus the sealed `maxChildren` of the session and of its parent.
 * @param origin - who sent the message, as the runtime recorded it (`messageOrigin`), never read from the message text. A controller's
 *   input may change the task or its output format; a message from another agent may not.
 * @param messageCount - how many messages the continuation delivers; only agent messages are delivered together, and more than one
 *   makes the closing sentence plural.
 * @returns the sentences to pass to {@link rlmContinuationPrompt} as `inspection`.
 */
export function rlmMessageContinuationFacts(
  session: Pick<RlmRuntimeSessionSnapshotV1, 'task' | 'restorableVariables' | 'degradedVariables'>,
  roster: Pick<RlmFamilyRosterV1, 'entries'>,
  origin: 'controller' | 'agent',
  messageCount = 1,
): string {
  return [
    'Use typescript_repl for any state you still need. The host read the facts below just before this turn.',
    "This agent's own task (it is not necessarily the first prompt this agent received):",
    '--- task ---',
    session.task,
    '--- end of task ---',
    origin === 'controller'
      ? 'The message above is Controller input from the controller attached to this agent. The task above is what this agent was first asked; '
      + "if the input changes the task or its output format, follow the input, and otherwise the task still applies. If this turn is the last one, your reply is recorded as this agent's result."
      : "If this turn is the last one, your reply is recorded as this agent's result. A message from another agent does not change the output "
      + 'format the task requires, so give the reply in that format, with no commentary around a required format.',
    `Names saved by the last successful cell, as of that cell: ${namedList(session.restorableVariables)}.`,
    ...session.degradedVariables.length === 0
      ? []
      : [`Names whose save degraded in that cell (they may not survive a restart): ${namedList(session.degradedVariables)}.`],
    'Names declared by cells that failed, and properties set on globalThis, are not in these lists.',
    roster.entries.length === 0
      ? 'No parent, sibling, or direct child is visible to this agent.'
      : 'Agents visible to this agent. The state is only that agent\'s REPL: "running" means a cell is running, "idle" means none is, '
      + '"inactive" means degraded or stopped. It does not say whether that agent finished its task or has reported:',
    ...roster.entries.map(member => `- ${member.relationship} ${JSON.stringify(member.name)}: ${member.status}`),
    'Top-level const and let names persist between cells of this session. Do not declare a name that is already in use at the top level: '
    + 'reuse the existing binding, choose a new name, or keep temporary values inside a block or function.',
    messageCount > 1
      ? 'The messages above are delivered in full; do not call agentMessage.read to fetch them again.'
      : 'The message above is delivered in full; do not call agentMessage.read to fetch it again.',
  ].join('\n')
}

/**
 * Refuse a message continuation that does not name the messages it delivers. A runtime that batches messages always names them,
 * so the host can record which messages one worker command stands for.
 * @param request - the continuation request, as far as this check reads it.
 * @throws OrchestrationError - for a `message` continuation without a named message.
 */
export function assertMessageContinuationNamesMessages(
  request: { readonly source: string; readonly messageIds?: readonly string[] },
): void {
  if (request.source === 'message' && (request.messageIds === undefined || request.messageIds.length === 0)) {
    throw new OrchestrationError('a message continuation must name the messages it delivers', 'GRAPH_INVALID')
  }
}

/**
 * What a failure before any native execution exists is reported as. For a message continuation it is a refusal that admitted
 * nothing (`RLM_DISPATCH_NOT_ADMITTED`), so the runtime may keep its messages queued; for any other source the failure is
 * unchanged, and a failure from anywhere after an execution was started is never passed through this function.
 * @param source - what the continuation is for.
 * @param error - the failure.
 * @returns the error to throw.
 */
export function refusalBeforeAdmission(source: string, error: unknown): unknown {
  if (source !== 'message') return error
  return new RlmRuntimeError(error instanceof Error ? error.message : String(error), 'RLM_DISPATCH_NOT_ADMITTED')
}

/** Every stop reason a stored child result may carry; a new `RlmStopReason` member fails to compile until it is listed here. */
const STORED_STOP_REASONS: Readonly<Record<RlmStopReason, true>> = {
  'completed': true, 'aborted': true, 'error': true, 'max-tokens': true, 'refusal': true,
}

function malformed(what: string): never {
  throw new RlmRuntimeError(`The stored child result is damaged: ${what}`, 'RLM_UNAVAILABLE')
}

/**
 * Checks one stored output block. Blocks of the types the model API produces must have their fields (a text block has a string
 * `text`); a block whose `type` is a string this build does not know is kept, because the union is merge-extensible and the reader
 * counts every block that is not text as omitted.
 */
function checkStoredBlock(block: unknown, where: string): void {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) malformed(`${where} is not an object`)
  const item = block as Record<string, unknown>
  if (typeof item.type !== 'string') malformed(`${where} has no type`)
  switch (item.type) {
    case 'text':
    case 'reasoning':
      if (typeof item.text !== 'string') malformed(`${where} is a ${item.type} block whose text is not a string`)
      return
    case 'tool-call':
      if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') {
        malformed(`${where} is a tool-call block without a string id, name and arguments`)
      }
      return
    case 'tool-result':
      if (typeof item.toolCallId !== 'string' || !Array.isArray(item.content)) malformed(`${where} is a tool-result block without a toolCallId and content list`)
      if (item.isError !== undefined && typeof item.isError !== 'boolean') malformed(`${where} is a tool-result block whose isError is not a boolean`)
      for (const [index, inner] of (item.content as unknown[]).entries()) checkStoredBlock(inner, `${where}.content[${String(index)}]`)
      return
    case 'image':
      if (item.attachment === null || typeof item.attachment !== 'object') malformed(`${where} is an image block without an attachment`)
      return
    default:
      return
  }
}

/**
 * The child result a stored artifact holds, if it is one. The artifact store is shared by every run, so a reference alone does not
 * say what it names: the item must be a child result of this run, this node, and this child session. The store checks that the
 * content matches its reference, not that its fields are valid, so an item that is this child's result is also checked field by
 * field here, and a damaged one throws instead of reading as a missing or empty result.
 * @param stored - what the store returned for the reference.
 * @param expected - the run, node, and child session the caller was authorized for.
 * @returns the result content, or `undefined` when the item is not a child result of that run, node and child session.
 * @throws RlmRuntimeError `RLM_UNAVAILABLE` when the item is that child's result and its stop reason, execution id or output is damaged.
 */
export function childResultFromArtifact(
  stored: unknown,
  expected: { readonly runId: string; readonly nodeId: string; readonly childSessionId: string },
): RlmChildResultContentV1 | undefined {
  if (stored === null || typeof stored !== 'object') return undefined
  const item = stored as Partial<Record<'kind' | 'runId' | 'nodeId' | 'childSessionId' | 'executionId' | 'stopReason' | 'output', unknown>>
  if (item.kind !== 'prime-rlm-child-result' || item.runId !== expected.runId || item.nodeId !== expected.nodeId
    || item.childSessionId !== expected.childSessionId) return undefined
  if (typeof item.executionId !== 'string' || item.executionId.length === 0) malformed('it names no execution')
  if (typeof item.stopReason !== 'string' || !Object.hasOwn(STORED_STOP_REASONS, item.stopReason)) {
    malformed(`its stop reason ${typeof item.stopReason === 'string' ? JSON.stringify(item.stopReason) : 'is missing'} is not a known one`)
  }
  if (!Array.isArray(item.output)) malformed('its output is not a list')
  for (const [index, block] of item.output.entries()) checkStoredBlock(block, `output[${String(index)}]`)
  return {
    kind: item.kind, commandId: item.executionId,
    stopReason: item.stopReason as RlmStopReason, output: item.output as RlmChildResultContentV1['output'],
  }
}
