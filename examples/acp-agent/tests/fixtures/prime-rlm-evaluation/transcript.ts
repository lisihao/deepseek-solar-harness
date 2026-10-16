/**
 * What a scenario of the `prime-rlm-evaluation` fixture reports, built from what the driver read back: the requests the fake
 * received (their exact bytes, digests and arrival order), the ledger the daemon wrote, and the events of the run. Nothing here
 * is a parameter of the run; run-specific ids are replaced by the name of the agent or the number of the attempt.
 */
import type { FakeRawRequest } from '../prime-rlm-terminal/fake-deepseek.ts'
import { DELTA, GAMMA, type Scenario } from './scenarios.ts'

interface LedgerAttempt {
  readonly id?: string
  readonly seq?: number
  readonly state: string
  readonly label: string
  readonly bodySha256: string
  readonly bodyBytes: number
  readonly reservedOutput: number
  readonly refusal?: string
}

interface SnapshotNode {
  readonly state: string
  readonly attempt: number
  readonly blockers?: ReadonlyArray<{ readonly code: string }>
}

/** The `data` of an `evaluation.command.metering` event. */
interface MeteringEventData {
  readonly commandId: string
  readonly outcome: { readonly kind: string; readonly stopReason?: string; readonly code?: string }
  readonly metering: {
    readonly complete: boolean
    readonly admissionCalls: number
    readonly rows: number
    readonly sent: number
    readonly refused: number
    readonly unaccounted: number
    readonly observed: { readonly input: number; readonly output: number }
    readonly missing: ReadonlyArray<{ readonly round: number | null; readonly state: string }>
    readonly attempts: ReadonlyArray<{ readonly id: string; readonly refusal?: string }>
  }
}

export interface TranscriptInput {
  readonly scenario: Scenario
  readonly snapshot: { readonly state: string; readonly nodes: readonly SnapshotNode[] }
  readonly events: ReadonlyArray<{ readonly type: string; readonly data: Readonly<Record<string, unknown>> }>
  readonly raw: readonly FakeRawRequest[]
  /** `undefined` in a home without a scope. */
  readonly ledger: { readonly attempts: readonly LedgerAttempt[] } | undefined
  readonly reservedWhenReceived: ReadonlyMap<number, boolean>
  readonly messageStatuses: readonly string[]
  /** The types of the runtime's persisted events. */
  readonly runtimeEventTypes: readonly string[]
}

type Who = 'root' | 'gamma' | 'delta' | 'continuation'

function taskOf(body: string): string {
  type Envelope = { messages?: Array<{ content?: unknown }> }
  const first = (JSON.parse(body) as Envelope).messages?.[0]?.content
  const envelope = JSON.parse(typeof first === 'string' ? first : '{}') as {
    dshOperatorContextEnvelope?: { task?: { content?: Array<{ text?: string }> } }
  }
  return (envelope.dshOperatorContextEnvelope?.task?.content ?? []).map(block => block.text ?? '').join('\n')
}

function whoOf(task: string): Who {
  if (task.includes('Agent message from')) return 'continuation'
  if (task.includes(GAMMA)) return 'gamma'
  return task.includes(DELTA) ? 'delta' : 'root'
}

/** The number of the node attempt a command id belongs to: `orch:<run>:<node>:<attempt>:rlm:...`. */
function attemptOf(command: string): number | null {
  const match = /^orch:[^:]+:[^:]+:(\d+)(?::|$)/u.exec(command)
  return match?.[1] === undefined ? null : Number(match[1])
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)].sort()

/**
 * @param input - what the driver read back.
 * @returns the transcript: outbound requests joined one to one with ledger rows, how each command's account stands, which usage
 *   events exist, and how the run and its messages ended.
 */
export function scenarioTranscript(input: TranscriptInput) {
  const { scenario, snapshot, events, raw, ledger } = input
  // Each received request takes one admitted row with its body digest; a row serves one request, so identical bodies count twice.
  const rows = (ledger?.attempts ?? []).filter(attempt => attempt.state !== 'refused')
  const taken = new Set<number>()
  const joined = raw.map((request) => {
    const bytes = Buffer.byteLength(request.body, 'utf8')
    const index = rows.findIndex((row, position) => !taken.has(position) && row.bodySha256 === request.sha256 && row.bodyBytes === bytes)
    if (index >= 0) taken.add(index)
    return { request, row: index >= 0 ? rows[index] : undefined }
  })
  const commandOwner = new Map<string, Who>()
  for (const [index, entry] of joined.entries()) {
    const label = entry.row?.label.split('#')[0]
    if (label !== undefined) commandOwner.set(label, whoOf(taskOf(raw[index]?.body ?? '{}')))
  }
  const ownerOf = (command: string): string => {
    const known = commandOwner.get(command)
    if (known !== undefined) return known
    if (command.endsWith(':rlm:root')) return 'root'
    return command.endsWith(':deliver') ? 'continuation' : 'unseen'
  }
  const requests = joined.map(({ request, row }) => {
    const parsed = JSON.parse(request.body) as { model: string; max_tokens: number; thinking?: { type: string }; reasoning_effort?: string }
    const label = row?.label
    const roundText = label === undefined ? undefined : /#round(\d+)@/u.exec(label)?.[1]
    return {
      who: whoOf(taskOf(request.body)),
      attempt: label === undefined ? null : attemptOf(label.split('#')[0] ?? ''),
      round: roundText === undefined ? null : Number(roundText),
      joinedRow: row !== undefined,
      rowState: row?.state ?? null,
      reservedBeforeSend: input.reservedWhenReceived.get(request.ordinal) ?? null,
      body: {
        model: parsed.model,
        maxTokens: parsed.max_tokens ?? null,
        thinking: parsed.thinking?.type ?? null,
        effort: parsed.reasoning_effort ?? null,
      },
    }
  }).sort((left, right) => (
    left.who.localeCompare(right.who) || (left.attempt ?? 0) - (right.attempt ?? 0) || (left.round ?? 0) - (right.round ?? 0)
  ))
  const metering = events.filter(event => event.type === 'evaluation.command.metering').map((event) => {
    const data = event.data as unknown as MeteringEventData
    const ledgerIds = new Set((ledger?.attempts ?? []).filter(row => row.label.startsWith(`${data.commandId}#`)).map(row => row.id))
    const { metering: account } = data
    return {
      who: ownerOf(data.commandId),
      attempt: attemptOf(data.commandId),
      outcome: data.outcome.kind === 'returned' ? { kind: 'returned', stopReason: data.outcome.stopReason } : { kind: 'failed', code: data.outcome.code },
      complete: account.complete,
      admissionCalls: account.admissionCalls,
      rows: account.rows,
      sent: account.sent,
      refused: account.refused,
      unaccounted: account.unaccounted,
      observed: account.observed,
      missingRounds: account.missing.map(entry => `${String(entry.round)}:${entry.state}`),
      listedAttemptsAreTheLedgersRows: account.attempts.length === ledgerIds.size
        && account.attempts.every(entry => ledgerIds.has(entry.id)),
    }
  }).sort((left, right) => left.who.localeCompare(right.who) || (left.attempt ?? 0) - (right.attempt ?? 0))
  const usageEvents = events.filter(event => event.type === 'rlm.usage').map(event => ({
    source: String(event.data.source),
    who: ownerOf(String(event.data.sourceCommandId)),
    attempt: attemptOf(String(event.data.sourceCommandId)),
  })).sort((left, right) => left.who.localeCompare(right.who) || (left.attempt ?? 0) - (right.attempt ?? 0))
  const continuationEvents = events.filter(event => event.type.startsWith('rlm.message.continuation.')).map(event => ({
    type: event.type,
    commandId: String(event.data.commandId),
    members: Array.isArray(event.data.messageIds) ? event.data.messageIds.length : 0,
  }))
  const continuationCommands = new Set(continuationEvents.map(event => event.commandId)).size
  const everything = JSON.stringify(events)
  return {
    scenario: scenario.name,
    scoped: scenario.scoped,
    run: snapshot.state,
    nodes: snapshot.nodes.map(node => ({
      state: node.state, attempt: node.attempt, blockers: (node.blockers ?? []).map(blocker => blocker.code),
    })),
    outbound: raw.length,
    rowsAdmitted: rows.length,
    refusals: unique((ledger?.attempts ?? []).filter(attempt => attempt.state === 'refused').map(attempt => attempt.refusal ?? '')),
    everyRequestJoinsOneRowAndEveryRowOneRequest: scenario.scoped
      ? joined.every(entry => entry.row !== undefined) && taken.size === rows.length
      : null,
    everyRequestWasReservedBeforeItArrived: scenario.scoped ? requests.every(entry => entry.reservedBeforeSend === true) : null,
    ledgerStates: unique((ledger?.attempts ?? []).map(attempt => attempt.state)),
    requests,
    metering,
    rlmUsageEvents: usageEvents,
    continuationEvents: continuationEvents.map(event => ({ type: event.type, members: event.members })),
    continuationCommands,
    messageStatuses: unique(input.messageStatuses),
    runtimeOutcomeEvents: Object.fromEntries(unique(input.runtimeEventTypes.filter(
      type => /^rlm\.(child\.(settled|failed|indeterminate)|message\.continuation\.)/u.test(type),
    )).map(type => [type, input.runtimeEventTypes.filter(other => other === type).length])),
    retryScheduled: events.filter(event => event.type === 'node.retry_scheduled').length,
    namesDispatchNotAdmitted: everything.includes('RLM_DISPATCH_NOT_ADMITTED'),
    namesOperatorBusy: everything.includes('OPERATOR_BUSY'),
    namesAdmissionRefusedInEvents: everything.includes('ADMISSION_REFUSED'),
    refusalReasonsInMeteringRows: unique(events.filter(event => event.type === 'evaluation.command.metering').flatMap(
      event => (event.data as unknown as MeteringEventData).metering.attempts.flatMap(
        entry => entry.refusal === undefined ? [] : [entry.refusal],
      ),
    )),
    namesDispatchUnknown: events.some(event => event.type === 'rlm.message.dispatch_unknown'),
  }
}
