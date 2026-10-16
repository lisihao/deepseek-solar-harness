/**
 * What the request captures of the `prime-rlm-terminal` fixture and of the Resident end-to-end test are built from: the raw
 * requests a fake provider received, the production records that say which session and command each belonged to, and a stable
 * projection of each request for reading and comparing.
 *
 * The raw request is the evidence. The projection replaces only values that differ in every run and sit at a known place (the
 * envelope digest, the sealed plan digest, the home directory of the sender workspace, the ids in a tool result, the ids of tool
 * calls), and gives each distinct value its own indexed token, so two different ids stay different and one id stays one id.
 * Task text, tool schemas, and policy text are not rewritten; `assertLossless` fails when putting the values back into a
 * projection does not give the raw request.
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { FakeRawRequest } from './fake-deepseek.ts'

/** A capture that cannot be trusted: a request tied to no single production session and command, or a projection that lost information. */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CaptureError'
  }
}

/** Which dispatch a request belonged to. */
export type CaptureWho = 'root' | 'child' | 'continuation'

/** The parts of the runtime's persisted state a capture is checked against, besides the dispatch records. */
export interface ProductionRecords {
  readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly parentSessionId?: string }>
  /** The receipts of model-tool cells: `commandId` is `<worker command>:deepseek-tool:<tool call id>`. */
  readonly receipts: ReadonlyArray<{ readonly commandId: string; readonly sessionId?: string; readonly operation?: string }>
}

/** One request tied to its production dispatch. */
interface CorrelatedRequest {
  readonly ordinal: number
  /** The number of tool results the request carried back; 0 for the first request of a model loop. */
  readonly round: number
  readonly who: CaptureWho
  readonly sessionId: string
  /** The command of the dispatch, without the tool-call suffix. */
  readonly workerCommand: string
  /** Requests of one model loop share a chain number: the ordinal of the loop's first request. */
  readonly chain: number
}

/** What `correlate` returns: the requests of the run, and the ordinals of requests that belong to another run. */
export interface Correlation {
  readonly requests: readonly CorrelatedRequest[]
  readonly otherRun: readonly number[]
}

const TOOL_SUFFIX = ':deepseek-tool:'

interface ParsedRequest {
  readonly raw: FakeRawRequest
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content?: unknown; readonly tool_call_id?: unknown }>
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as readonly unknown[]).map((part) => {
    const text = typeof part === 'object' && part !== null ? (part as { readonly text?: unknown }).text : undefined
    return typeof text === 'string' ? text : ''
  }).join('\n')
}

/**
 * Ties every request to the production session and command it was sent for, by the tool-call ids the fake issued and the
 * receipts the runtime kept for the cells those calls ran. A request's text is used only to check the result.
 * @param raw - the requests of the scenario in arrival order.
 * @param production - the runtime's persisted sessions and receipts.
 * @param facts - the dispatches the orchestration and runtime events recorded; the kind of each request comes from them.
 * @param runId - the orchestration run; requests of the sessions of other runs are reported, not classified.
 * @param hint - what the text of a request says its dispatch is; a disagreement with the production records fails.
 * @returns the correlated requests in arrival order.
 * @throws CaptureError when a request cannot be tied to exactly one dispatch.
 */
export function correlate(
  raw: readonly FakeRawRequest[],
  production: ProductionRecords,
  facts: DispatchFacts,
  runId: string,
  hint: (firstMessageText: string) => CaptureWho,
): Correlation {
  const parsed: ParsedRequest[] = raw.map(request => ({
    raw: request,
    messages: (JSON.parse(request.body) as { messages?: ParsedRequest['messages'] }).messages ?? [],
  }))
  const issuer = new Map<string, number>()
  parsed.forEach((request, index) => {
    const id = request.raw.issuedToolCallId
    if (id === undefined) return
    if (issuer.has(id)) throw new CaptureError(`Two requests were answered with the same tool call id ${id}`)
    issuer.set(id, index)
  })
  const previous = new Map<number, number>()
  const followers = new Map<number, number>()
  parsed.forEach((request, index) => {
    const results = request.messages.filter(message => message.role === 'tool')
    for (const result of results) {
      const id = String(result.tool_call_id)
      if (!issuer.has(id)) throw new CaptureError(`Request ${String(request.raw.ordinal)} carries the result of tool call ${id}, which no request was answered with`)
    }
    const last = results.at(-1)
    if (last === undefined) return
    const from = issuer.get(String(last.tool_call_id))
    if (from === undefined || from >= index) throw new CaptureError(`Request ${String(request.raw.ordinal)} does not follow the request that issued its last tool call`)
    const other = followers.get(from)
    if (other !== undefined) {
      throw new CaptureError(`Requests ${String(parsed[other]?.raw.ordinal)} and ${String(request.raw.ordinal)} both follow request ${String(parsed[from]?.raw.ordinal)}`)
    }
    followers.set(from, index)
    previous.set(index, from)
  })
  const chainOf = (index: number): number => {
    const before = previous.get(index)
    return before === undefined ? index : chainOf(before)
  }
  const members = new Map<number, number[]>()
  parsed.forEach((_request, index) => {
    const head = chainOf(index)
    members.set(head, [...members.get(head) ?? [], index])
  })
  const rootOf = (sessionId: string): string => {
    const parent = production.sessions.find(session => session.sessionId === sessionId)?.parentSessionId
    return parent === undefined ? sessionId : rootOf(parent)
  }
  const correlated: CorrelatedRequest[] = []
  const otherRun: number[] = []
  for (const [head, indexes] of members) {
    const identity = chainIdentity(indexes.map(index => parsed[index] as ParsedRequest), production)
    if (!rootOf(identity.sessionId).includes(runId)) {
      otherRun.push(...indexes.map(index => (parsed[index] as ParsedRequest).raw.ordinal))
      continue
    }
    if (!production.sessions.some(session => session.sessionId === identity.sessionId)) {
      throw new CaptureError(`The runtime holds no session ${identity.sessionId}`)
    }
    const who = dispatchOf(identity.sessionId, identity.workerCommand, facts)
    for (const index of indexes) {
      const request = parsed[index] as ParsedRequest
      const hinted = hint(textOf(request.messages[0]?.content))
      if (hinted !== who) {
        throw new CaptureError(`Request ${String(request.raw.ordinal)} was sent for the ${who} dispatch ${identity.workerCommand}, and its text says ${hinted}`)
      }
      correlated.push({
        ordinal: request.raw.ordinal, round: request.messages.filter(message => message.role === 'tool').length, who,
        sessionId: identity.sessionId, workerCommand: identity.workerCommand, chain: parsed[head]?.raw.ordinal ?? head,
      })
    }
  }
  return {
    requests: correlated.sort((left, right) => left.ordinal - right.ordinal),
    otherRun: otherRun.sort((left, right) => left - right),
  }
}

function chainIdentity(chain: readonly ParsedRequest[], production: ProductionRecords): { sessionId: string; workerCommand: string } {
  const issued = chain.flatMap(request => request.raw.issuedToolCallId === undefined ? [] : [request.raw.issuedToolCallId])
  if (issued.length === 0) {
    throw new CaptureError(`Request ${String(chain[0]?.raw.ordinal)} and the rest of its model loop issued no tool call, so no production record names them`)
  }
  const commands = new Set<string>()
  let sessionId: string | undefined
  for (const id of issued) {
    const suffix = `${TOOL_SUFFIX}${id}`
    const receipts = production.receipts.filter(receipt => receipt.operation === 'cell.execute' && receipt.commandId.endsWith(suffix))
    if (receipts.length !== 1) throw new CaptureError(`Tool call ${id} has ${String(receipts.length)} cell receipts; exactly one is needed`)
    const [receipt] = receipts as [(typeof receipts)[number]]
    if (receipt.sessionId === undefined) throw new CaptureError(`The receipt of tool call ${id} names no session`)
    if (sessionId !== undefined && sessionId !== receipt.sessionId) {
      throw new CaptureError(`Tool calls of one model loop ran in two sessions (${sessionId} and ${receipt.sessionId})`)
    }
    sessionId = receipt.sessionId
    commands.add(receipt.commandId.slice(0, receipt.commandId.length - suffix.length))
    for (const request of chain) {
      const result = request.messages.find(message => message.role === 'tool' && message.tool_call_id === id)
      if (result === undefined) continue
      const cell = tryParse(textOf(result.content)) as { sessionId?: unknown; commandId?: unknown } | undefined
      if (cell?.commandId !== undefined && (cell.commandId !== receipt.commandId || cell.sessionId !== receipt.sessionId)) {
        throw new CaptureError(
          `The tool result of ${id} names ${JSON.stringify([cell.sessionId, cell.commandId])}, and the runtime kept ${JSON.stringify([receipt.sessionId, receipt.commandId])}`,
        )
      }
    }
  }
  if (commands.size !== 1 || sessionId === undefined) throw new CaptureError(`A model loop ran under ${String(commands.size)} worker commands; exactly one is needed`)
  const [workerCommand] = [...commands] as [string]
  return { sessionId, workerCommand }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // Text that is not JSON is not a cell result; the caller treats `undefined` as "no identity to compare".
    return undefined
  }
}

/** Gives each distinct value of a kind its own indexed token, and puts the values back. */
export class Tokens {
  private readonly tokens = new Map<string, string>()
  private readonly values = new Map<string, string>()
  private readonly counts = new Map<string, number>()

  /**
   * @param kind - what the value is, for example `uuid`.
   * @param value - the raw value.
   * @returns `<kind-N>`, the same token every time for the same kind and value, and a different one for a different value.
   */
  take(kind: string, value: string): string {
    const key = `${kind}\u0000${value}`
    const known = this.tokens.get(key)
    if (known !== undefined) return known
    const index = (this.counts.get(kind) ?? 0) + 1
    this.counts.set(kind, index)
    const token = `<${kind}-${String(index)}>`
    this.tokens.set(key, token)
    this.values.set(token, value)
    return token
  }

  /**
   * @param text - text that holds tokens.
   * @returns the text with every token replaced by its value.
   */
  restore(text: string): string {
    return text.replaceAll(/<[a-z]+-\d+>/gu, token => this.values.get(token) ?? token)
  }

  /** @returns the token to value table, for the capture files. */
  table(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.values)
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu

/** Replaces the run, session and message uuids and the tool-call ids in an id field. */
function ids(text: string, tokens: Tokens): string {
  return text.replaceAll(UUID, id => tokens.take('uuid', id)).replaceAll(/fake-call-\d+/gu, id => tokens.take('call', id))
}

function taskText(text: string, tokens: Tokens): string {
  return text
    .replaceAll(/(Sealed RLM plan: )([0-9a-f]{64})/gu, (_all, label: string, value: string) => `${label}${tokens.take('plan', value)}`)
    .replaceAll(/(Sender workspace: )(\S*dsh-prime-(?:rlm-terminal-snapshot|capture)-[A-Za-z0-9]+)/gu, (_all, label: string, value: string) => `${label}${tokens.take('home', value)}`)
    .replaceAll(/(Agent message from )(\S+?)(:\n)/gu, (_all, label: string, value: string, end: string) => `${label}${tokens.take('session', value)}${end}`)
}

interface Envelope {
  digest?: unknown
  task?: { content?: Array<{ type?: string; text?: string }> }
}

function envelope(content: string, tokens: Tokens): string {
  const parsed = tryParse(content) as { dshOperatorContextEnvelope?: Envelope } | undefined
  const inner = parsed?.dshOperatorContextEnvelope
  if (parsed === undefined || inner === undefined) return content
  if (typeof inner.digest === 'string') inner.digest = tokens.take('digest', inner.digest)
  for (const block of inner.task?.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') block.text = taskText(block.text, tokens)
  }
  return JSON.stringify(parsed)
}

const CONTEXT_REFS = ['contextPacketRef', 'capabilityPlanRef'] as const

function cellResult(content: string, tokens: Tokens): string {
  const cell = tryParse(content) as Record<string, unknown> | undefined
  if (cell === undefined || cell === null || typeof cell !== 'object') return content
  if (typeof cell.sessionId === 'string') cell.sessionId = ids(cell.sessionId, tokens)
  if (typeof cell.commandId === 'string') cell.commandId = ids(cell.commandId, tokens)
  // A cell that printed the child's `context` shows run-specific references; the same raw values also appear in `display`.
  const replaced: Array<readonly [string, string]> = []
  if (typeof cell.value === 'string') {
    const value = tryParse(cell.value) as Record<string, unknown> | undefined
    if (value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const swap = (key: string, kind: string, prefix = ''): void => {
        const raw = value[key]
        if (typeof raw !== 'string' || !raw.startsWith(prefix)) return
        const token = `${prefix}${tokens.take(kind, raw.slice(prefix.length))}`
        replaced.push([raw, token])
        value[key] = token
      }
      swap('runId', 'uuid', 'run-')
      for (const key of CONTEXT_REFS) swap(key, 'ref', 'sha256:')
      swap('graphCertificateHash', 'hash')
      if (replaced.length > 0) cell.value = JSON.stringify(value)
    }
  }
  if (typeof cell.display === 'string') {
    let display = cell.display
    for (const [raw, token] of replaced) display = display.replaceAll(raw, token)
    cell.display = display
  }
  return JSON.stringify(cell)
}

/** A parsed chat-completions request body. */
export type RequestBody = { readonly messages?: ReadonlyArray<Record<string, unknown>> } & Record<string, unknown>

/**
 * The projection of one request body: the parsed body with the run-specific values at known places replaced by tokens.
 * @param body - the parsed request body.
 * @param tokens - the table shared by every request of the capture.
 * @returns the projected body.
 */
export function project(body: RequestBody, tokens: Tokens): unknown {
  const copy = structuredClone(body)
  for (const [index, message] of (copy.messages ?? []).entries()) {
    const content = message.content
    if (message.role === 'user' && index === 0 && typeof content === 'string') message.content = envelope(content, tokens)
    if (message.role === 'tool' && typeof content === 'string') message.content = cellResult(content, tokens)
    if (typeof message.tool_call_id === 'string') message.tool_call_id = ids(message.tool_call_id, tokens)
    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls as Array<{ id?: unknown }>) if (typeof call.id === 'string') call.id = ids(call.id, tokens)
    }
  }
  return copy
}

/**
 * Fails unless the projection, with its tokens replaced by the values they stand for, is the raw request again, and the tool
 * schemas and the roles of the messages are untouched.
 * @param raw - the raw request.
 * @param projection - what `project` returned for it.
 * @param tokens - the table that made it.
 * @throws CaptureError when anything but the replaced values differs.
 */
export function assertLossless(raw: FakeRawRequest, projection: unknown, tokens: Tokens): void {
  const original = JSON.parse(raw.body) as { tools?: unknown; messages?: Array<{ role?: unknown }> }
  const projected = projection as { tools?: unknown; messages?: Array<{ role?: unknown }> }
  const restored = tokens.restore(JSON.stringify(projection))
  if (JSON.stringify(original) !== raw.body) throw new CaptureError(`Request ${String(raw.ordinal)} is not the serialization of its own parsed body`)
  if (restored !== raw.body) throw new CaptureError(`The projection of request ${String(raw.ordinal)} does not restore to the raw request`)
  if (!isDeepStrictEqual(projected.tools, original.tools)) throw new CaptureError(`The projection of request ${String(raw.ordinal)} changed the tool schemas`)
  if (!isDeepStrictEqual(projected.messages?.map(message => message.role), original.messages?.map(message => message.role))) {
    throw new CaptureError(`The projection of request ${String(raw.ordinal)} changed the roles of the messages`)
  }
}

/**
 * @param projection - a projected request.
 * @returns its sha256, as the snapshot records it.
 */
export function projectionSha256(projection: unknown): string {
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex')
}

/** What the orchestration and runtime events say about the dispatches of a run. */
export interface DispatchFacts {
  /** `rlm.execution.started`: the runtime session of the root. */
  readonly started: ReadonlyArray<{ readonly runtimeSessionId: string }>
  /** `rlm.child.dispatched`: the execution (which is the command of the child's dispatch) and the session of the child. */
  readonly dispatched: ReadonlyArray<{ readonly executionId: string; readonly childSessionId: string }>
  /** `rlm.message.delivered`: the command a delivered message was handed to. */
  readonly delivered: ReadonlyArray<{ readonly sessionId: string; readonly commandId: string }>
}

/**
 * @param orchestration - the events of the orchestration run.
 * @param runtime - the events of the RLM runtime (its persisted `events`).
 * @returns the dispatch facts those events record.
 */
export function dispatchFacts(
  orchestration: ReadonlyArray<{ readonly type: string; readonly data: Readonly<Record<string, unknown>> }>,
  runtime: ReadonlyArray<{ readonly type: string; readonly sessionId: string; readonly data: Readonly<Record<string, unknown>> }>,
): DispatchFacts {
  return {
    started: orchestration.filter(event => event.type === 'rlm.execution.started').map(event => ({ runtimeSessionId: String(event.data.runtimeSessionId) })),
    dispatched: orchestration.filter(event => event.type === 'rlm.child.dispatched').map(event => ({
      executionId: String(event.data.executionId), childSessionId: String(event.data.childSessionId),
    })),
    delivered: runtime.filter(event => event.type === 'rlm.message.delivered').map(event => ({
      sessionId: event.sessionId, commandId: String(event.data.commandId),
    })),
  }
}

/**
 * Names the dispatch a command and session belong to by the events that recorded it: the root's session and its `:rlm:root`
 * command, a child's session and the execution `rlm.child.dispatched` named, or the session and command a message was
 * delivered to. Exactly one record must match.
 * @param sessionId - the session the command ran in.
 * @param command - the command of the dispatch, without a tool-call suffix.
 * @param facts - the recorded dispatches.
 * @returns the kind of dispatch.
 * @throws CaptureError when no record, or more than one, matches.
 */
export function dispatchOf(sessionId: string | undefined, command: string, facts: DispatchFacts): CaptureWho {
  const matches: CaptureWho[] = []
  // The root's session is `rlm:<execution>`, and its command is `<execution>:rlm:root`.
  if (facts.started.some(start => start.runtimeSessionId === sessionId
    && `${start.runtimeSessionId.replace(/^rlm:/u, '')}:rlm:root` === command)) matches.push('root')
  if (facts.dispatched.some(child => child.executionId === command && child.childSessionId === sessionId)) matches.push('child')
  if (facts.delivered.some(entry => entry.commandId === command && entry.sessionId === sessionId)) matches.push('continuation')
  if (matches.length !== 1) {
    throw new CaptureError(`Command ${command} in session ${String(sessionId)} matches ${String(matches.length)} dispatch records: ${matches.join(', ')}`)
  }
  return matches[0] as CaptureWho
}

/** A request of the Resident provider seam: its position among all of them, its command, and the session of its model-tool bridge. */
export interface ResidentSeamRequest {
  readonly ordinal: number
  readonly commandId: string
  readonly bridgeSessionId: string | undefined
}

/**
 * Ties each Resident request to a root, a child or a message continuation by the events the daemon and runtime recorded for the
 * dispatch: the command and the session of the request must both match one record (`dispatchOf`).
 * @param requests - the requests that carry a model-tool bridge, in arrival order.
 * @param facts - the recorded dispatches.
 * @returns the kind of dispatch of each request, in the order given.
 * @throws CaptureError when a request matches no dispatch record or several.
 */
export function correlateResident(
  requests: readonly ResidentSeamRequest[],
  facts: DispatchFacts,
): Array<ResidentSeamRequest & { readonly who: CaptureWho }> {
  return requests.map(request => ({ ...request, who: dispatchOf(request.bridgeSessionId, request.commandId, facts) }))
}

/**
 * The projection of a serialized Resident request: the command, lane, workspace, native context digest, bridge socket and session,
 * and the sender workspace and sealed plan digest in the prompt are replaced by tokens; every other field is kept.
 * @param value - the serializable fields of the request.
 * @param tokens - the table shared by every request of the capture.
 * @returns the projected fields.
 */
export function projectResident(value: Readonly<Record<string, unknown>>, tokens: Tokens): Record<string, unknown> {
  const copy = structuredClone(value) as Record<string, unknown>
  for (const key of ['commandId', 'laneId']) if (typeof copy[key] === 'string') copy[key] = ids(copy[key], tokens)
  if (typeof copy.workspace === 'string') copy.workspace = copy.workspace.replaceAll(/\S*dsh-prime-capture-[A-Za-z0-9]+/gu, home => tokens.take('home', home))
  const native = copy.nativeContext as { digest?: unknown } | undefined
  if (typeof native?.digest === 'string') native.digest = tokens.take('digest', native.digest)
  const bridge = copy.modelToolBridge as { socketPath?: unknown; sessionId?: unknown } | undefined
  if (bridge !== undefined) {
    if (typeof bridge.socketPath === 'string') bridge.socketPath = tokens.take('socket', bridge.socketPath)
    if (typeof bridge.sessionId === 'string') bridge.sessionId = ids(bridge.sessionId, tokens)
  }
  for (const block of Array.isArray(copy.prompt) ? copy.prompt as Array<{ text?: unknown }> : []) {
    if (typeof block.text === 'string') block.text = taskText(block.text, tokens)
  }
  return copy
}

/**
 * Fails unless the projection, with its tokens replaced by their values, is the original again.
 * @param label - what is being checked, for the message.
 * @param original - the serialized request.
 * @param projection - what `projectResident` returned.
 * @param tokens - the table that made it.
 * @throws CaptureError when anything but the replaced values differs.
 */
export function assertRestores(label: string, original: unknown, projection: unknown, tokens: Tokens): void {
  if (tokens.restore(JSON.stringify(projection)) !== JSON.stringify(original)) throw new CaptureError(`The projection of ${label} does not restore to the original`)
}

/** A request of the Resident provider seam, serialized with a list of what could not be. */
export interface SerializedRequest {
  readonly value: Readonly<Record<string, unknown>>
  readonly excluded: ReadonlyArray<{ readonly field: string; readonly reason: string }>
}

/**
 * Saves every field of a request that survives a JSON round trip, and names each field that does not and why. An
 * `AbortSignal` is recorded as its `aborted` flag, because it holds no data a request is judged by.
 * @param request - the request object the provider seam received.
 * @returns the serializable fields and the excluded ones with their reasons.
 */
export function serializeRequest(request: object): SerializedRequest {
  const value: Record<string, unknown> = {}
  const excluded: Array<{ field: string; reason: string }> = []
  for (const [field, entry] of Object.entries(request)) {
    if (entry instanceof AbortSignal) {
      value[`${field}Aborted`] = entry.aborted
      excluded.push({ field, reason: 'an AbortSignal is a cancellation handle without data; only its aborted flag is recorded' })
      continue
    }
    if (entry === undefined || typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
      excluded.push({ field, reason: `a ${entry === undefined ? 'missing value' : typeof entry} has no JSON form` })
      continue
    }
    const roundTrip = JSON.parse(JSON.stringify(entry)) as unknown
    if (!isDeepStrictEqual(roundTrip, entry)) {
      excluded.push({ field, reason: 'it does not survive a JSON round trip unchanged' })
      continue
    }
    value[field] = roundTrip
  }
  return { value, excluded }
}
