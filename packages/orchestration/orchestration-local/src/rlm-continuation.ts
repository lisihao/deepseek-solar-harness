/** What an RLM execution ends in after its last continuation, and the prompt of each continuation. */
import { OrchestrationError } from '@deepseek-ai/dsh-orchestration'
import type { PhysicalOperatorResult } from '@deepseek-ai/dsh-physical-operator'
import {
  RlmRuntimeError,
  type RlmChildExecutionResult,
  type RlmChildResultContentV1,
  type RlmFamilyRosterV1,
  type RlmRuntimeSessionSnapshotV1,
  type RlmStopReason,
} from '@deepseek-ai/dsh-rlm-runtime'

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
