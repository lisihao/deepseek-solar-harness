/**
 * Versioned, frozen operator-context input for physical-operator and subagent
 * handoffs.
 *
 * @module @deepseek-ai/dsh-system-prompt/envelope
 */

import { createHash } from 'node:crypto'
import type { ContentBlock, ContextSnapshotSection, MessageId } from '@deepseek-ai/dsh-llm'

/** Envelope schema version. Bump only for a structural format change. */
export const OPERATOR_CONTEXT_ENVELOPE_VERSION = 1

/** One effective named dynamic-context contribution, in PromptAssembly order. */
export interface OperatorContextEnvelopeContextV1 {
  /** The contributing context's unique name. */
  readonly name: string
  /** The exact rendered text contributed by that context. */
  readonly text: string
}

/** One named dynamic-context segment's position inside its source snapshot. */
export interface OperatorContextEnvelopeContextSegmentV1 {
  /** The contributing context's unique name. */
  readonly name: string
  /** Zero-based position in the snapshot and envelope context list. */
  readonly index: number
}

/** Session-log provenance for a direct Agent request. */
export interface OperatorContextEnvelopeSessionSourceV1 {
  readonly kind: 'session'
  /** Sequence of the frozen `request/header` event containing `systemText`. */
  readonly requestHeaderEventSeq: number
  /** Identity of the current user message whose task text this envelope carries. */
  readonly taskMessageId: MessageId
  /** Identity of the current runtime-context snapshot, when one contributed contexts. */
  readonly contextSnapshotMessageId?: MessageId
  /** Other current-request instruction messages represented as named contexts. */
  readonly instructionMessageIds?: readonly MessageId[]
  /** Named dynamic-context segments from the snapshot, in order. */
  readonly contextSegments: readonly OperatorContextEnvelopeContextSegmentV1[]
}

/** Durable artifact provenance for a TaskGraph node dispatch. */
export interface OperatorContextEnvelopeTaskGraphSourceV1 {
  readonly kind: 'taskgraph'
  /** Owning orchestration run. */
  readonly runId: string
  /** Owning node. */
  readonly nodeId: string
  /** Stored context packet used to construct the dispatch. */
  readonly contextPacketRef: string
  /** Named dynamic-context segments captured for this node, in order. */
  readonly contextSegments: readonly OperatorContextEnvelopeContextSegmentV1[]
}

/** Session-log provenance for a model-issued physical-operator tool call. */
export interface OperatorContextEnvelopeToolSourceV1 {
  readonly kind: 'tool'
  /** Sequence of the frozen request header under which the tool was called. */
  readonly requestHeaderEventSeq: number
  /** Durable tool-call identity carrying the delegated task argument. */
  readonly toolCallId: string
  /** Current runtime-context snapshot represented in the envelope, when any. */
  readonly contextSnapshotMessageId?: MessageId
  /** Other current-request instruction messages represented as named contexts. */
  readonly instructionMessageIds?: readonly MessageId[]
  /** Named context positions, in order. */
  readonly contextSegments: readonly OperatorContextEnvelopeContextSegmentV1[]
}

/** Durable locations from which an envelope can be reconstructed. */
export type OperatorContextEnvelopeSourceV1 =
  | OperatorContextEnvelopeSessionSourceV1
  | OperatorContextEnvelopeTaskGraphSourceV1
  | OperatorContextEnvelopeToolSourceV1

/**
 * Version-one immutable operator-context envelope. It contains only current
 * system instructions, one task, and its effective dynamic contexts. Prior
 * user, assistant, and tool history never enters this value.
 */
export interface OperatorContextEnvelopeV1 {
  readonly version: 1
  /** Exact system text from the frozen request input. */
  readonly systemText: string
  /** Exact content blocks of the current task. */
  readonly task: readonly ContentBlock[]
  /** Effective named dynamic contexts. */
  readonly contexts: readonly OperatorContextEnvelopeContextV1[]
  /** Durable session or TaskGraph locations for reconstruction. */
  readonly source: OperatorContextEnvelopeSourceV1
  /** Deterministic content identity over `systemText`, `task`, and `contexts`. */
  readonly digest: string
}

/** Successful materialization of an envelope by a receiving Consumer. */
export interface OperatorContextEnvelopeAcceptedReceiptV1 {
  readonly version: 1
  /** The envelope content identity materialized by this Consumer. */
  readonly digest: string
  /** Stable Consumer identity recorded by the owning handoff. */
  readonly receiver: string
  /** A successful receipt represents every envelope field. */
  readonly outcome: 'accepted'
  /** The Consumer received native fields or the canonical JSON text form. */
  readonly format: 'native' | 'text'
  /** Whether field roles remained native or were explicitly downgraded to text. */
  readonly roleFidelity: 'native' | 'text-downgrade'
}

/** Explicit refusal to materialize an envelope. */
export interface OperatorContextEnvelopeRejectedReceiptV1 {
  readonly version: 1
  /** The envelope content identity the Consumer declined. */
  readonly digest: string
  /** Stable Consumer identity recorded by the owning handoff. */
  readonly receiver: string
  /** A rejection prevents a Consumer from silently dropping envelope fields. */
  readonly outcome: 'rejected'
  /** Provider-owned reason why the envelope could not be materialized. */
  readonly reason: string
}

/** One receipt emitted by an envelope Consumer after accepting or rejecting it. */
export type OperatorContextEnvelopeReceiptV1 =
  | OperatorContextEnvelopeAcceptedReceiptV1
  | OperatorContextEnvelopeRejectedReceiptV1

/** Session provenance accepted before context-segment positions are derived. */
export type OperatorContextEnvelopeSessionInputSourceV1 =
  Omit<OperatorContextEnvelopeSessionSourceV1, 'contextSegments'>

/** TaskGraph provenance accepted before context-segment positions are derived. */
export type OperatorContextEnvelopeTaskGraphInputSourceV1 =
  Omit<OperatorContextEnvelopeTaskGraphSourceV1, 'contextSegments'>

/** Tool-call provenance accepted before context-segment positions are derived. */
export type OperatorContextEnvelopeToolInputSourceV1 =
  Omit<OperatorContextEnvelopeToolSourceV1, 'contextSegments'>

/** Caller-supplied material captured before one handoff. */
export interface OperatorContextEnvelopeInput {
  /** Exact system text from the frozen request input, or `''` when absent. */
  readonly systemText: string
  /** Exact content blocks from the current task. */
  readonly task: readonly ContentBlock[]
  /** Already-rendered effective context sections. */
  readonly contexts: readonly ContextSnapshotSection[]
  /** Durable source locations for the input. */
  readonly source:
    | OperatorContextEnvelopeSessionInputSourceV1
    | OperatorContextEnvelopeTaskGraphInputSourceV1
    | OperatorContextEnvelopeToolInputSourceV1
}

/**
 * Deterministically digest one envelope's model-visible fields. JSON array
 * framing keeps arbitrary text, including NUL characters, unambiguous while
 * preserving context order.
 * @param fields - model-visible fields from one envelope.
 * @returns a lowercase SHA-256 content identity.
 */
export function operatorContextEnvelopeDigest(fields: {
  readonly systemText: string
  readonly task: readonly ContentBlock[]
  readonly contexts: readonly OperatorContextEnvelopeContextV1[]
}): string {
  const canonical = JSON.stringify([
    OPERATOR_CONTEXT_ENVELOPE_VERSION,
    fields.systemText,
    fields.task,
    fields.contexts.map(context => [context.name, context.text]),
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * Build one immutable envelope from already-frozen request inputs. The input
 * is copied so later caller mutation cannot desynchronize content and digest.
 * @param input - rendered system text, task, contexts, and source locations.
 * @returns the versioned envelope with its deterministic content identity.
 */
export function buildOperatorContextEnvelope(input: OperatorContextEnvelopeInput): OperatorContextEnvelopeV1 {
  const contexts = Object.freeze(input.contexts.map((section): OperatorContextEnvelopeContextV1 => Object.freeze({
    name: section.name,
    text: section.text,
  })))
  const contextSegments = Object.freeze(contexts.map((context, index): OperatorContextEnvelopeContextSegmentV1 => Object.freeze({
    name: context.name,
    index,
  })))
  let source: OperatorContextEnvelopeSourceV1
  if (input.source.kind === 'session') {
    source = Object.freeze({
      kind: 'session',
      requestHeaderEventSeq: input.source.requestHeaderEventSeq,
      taskMessageId: input.source.taskMessageId,
      ...input.source.contextSnapshotMessageId === undefined
        ? {}
        : { contextSnapshotMessageId: input.source.contextSnapshotMessageId },
      ...input.source.instructionMessageIds === undefined
        ? {}
        : { instructionMessageIds: Object.freeze([...input.source.instructionMessageIds]) },
      contextSegments,
    })
  } else if (input.source.kind === 'taskgraph') {
    source = Object.freeze({
      kind: 'taskgraph',
      runId: input.source.runId,
      nodeId: input.source.nodeId,
      contextPacketRef: input.source.contextPacketRef,
      contextSegments,
    })
  } else {
    source = Object.freeze({
      kind: 'tool',
      requestHeaderEventSeq: input.source.requestHeaderEventSeq,
      toolCallId: input.source.toolCallId,
      ...input.source.contextSnapshotMessageId === undefined
        ? {}
        : { contextSnapshotMessageId: input.source.contextSnapshotMessageId },
      ...input.source.instructionMessageIds === undefined
        ? {}
        : { instructionMessageIds: Object.freeze([...input.source.instructionMessageIds]) },
      contextSegments,
    })
  }
  const task = deepFreeze(structuredClone(input.task))
  const digest = operatorContextEnvelopeDigest({ systemText: input.systemText, task, contexts })
  return Object.freeze({
    version: OPERATOR_CONTEXT_ENVELOPE_VERSION,
    systemText: input.systemText,
    task,
    contexts,
    source,
    digest,
  })
}

/**
 * Validate and reconstruct one envelope received across a process or network
 * boundary. The supplied digest and derived context-segment index must match
 * the reconstructed immutable value.
 * @param value - untrusted decoded JSON value.
 * @returns a newly frozen envelope safe for native materialization.
 */
export function parseOperatorContextEnvelope(value: unknown): OperatorContextEnvelopeV1 {
  const record = envelopeRecord(value, 'operator context envelope')
  exactEnvelopeKeys(record, ['version', 'systemText', 'task', 'contexts', 'source', 'digest'], 'operator context envelope')
  if (record.version !== OPERATOR_CONTEXT_ENVELOPE_VERSION) {
    throw new Error(`operator context envelope version must be ${String(OPERATOR_CONTEXT_ENVELOPE_VERSION)}`)
  }
  const systemText = envelopeString(record.systemText, 'operator context envelope.systemText')
  const taskValue = record.task
  if (!Array.isArray(taskValue)) throw new Error('operator context envelope.task must be an array')
  taskValue.forEach((block, index) => {
    const blockRecord = envelopeRecord(block, `operator context envelope.task[${String(index)}]`)
    envelopeNonEmptyString(blockRecord.type, `operator context envelope.task[${String(index)}].type`)
    assertJsonValue(block, `operator context envelope.task[${String(index)}]`)
  })
  const contextValue = record.contexts
  if (!Array.isArray(contextValue)) throw new Error('operator context envelope.contexts must be an array')
  const contextNames = new Set<string>()
  const contexts = contextValue.map((entry, index) => {
    const label = `operator context envelope.contexts[${String(index)}]`
    const context = envelopeRecord(entry, label)
    exactEnvelopeKeys(context, ['name', 'text'], label)
    const name = envelopeNonEmptyString(context.name, `${label}.name`)
    if (contextNames.has(name)) throw new Error(`operator context envelope context name ${JSON.stringify(name)} is duplicated`)
    contextNames.add(name)
    return { name, text: envelopeString(context.text, `${label}.text`) }
  })
  const sourceRecord = envelopeRecord(record.source, 'operator context envelope.source')
  const suppliedSegments = parseContextSegments(sourceRecord.contextSegments)
  const source = parseEnvelopeSource(sourceRecord)
  const suppliedDigest = envelopeNonEmptyString(record.digest, 'operator context envelope.digest')
  if (!/^[a-f0-9]{64}$/u.test(suppliedDigest)) {
    throw new Error('operator context envelope.digest must be a lowercase SHA-256 digest')
  }
  const envelope = buildOperatorContextEnvelope({
    systemText,
    task: structuredClone(taskValue) as ContentBlock[],
    contexts,
    source,
  })
  if (envelope.digest !== suppliedDigest) {
    throw new Error(`operator context envelope digest mismatch: expected ${envelope.digest}, received ${suppliedDigest}`)
  }
  if (JSON.stringify(envelope.source.contextSegments) !== JSON.stringify(suppliedSegments)) {
    throw new Error('operator context envelope source contextSegments do not match contexts')
  }
  return envelope
}

function parseEnvelopeSource(
  source: Record<string, unknown>,
): OperatorContextEnvelopeInput['source'] {
  if (source.kind === 'session') {
    exactEnvelopeKeys(source, [
      'kind', 'requestHeaderEventSeq', 'taskMessageId', 'contextSnapshotMessageId',
      'instructionMessageIds', 'contextSegments',
    ], 'operator context envelope.source')
    return {
      kind: 'session',
      requestHeaderEventSeq: envelopeNonnegativeInteger(
        source.requestHeaderEventSeq,
        'operator context envelope.source.requestHeaderEventSeq',
      ),
      taskMessageId: envelopeNonEmptyString(
        source.taskMessageId,
        'operator context envelope.source.taskMessageId',
      ) as MessageId,
      ...source.contextSnapshotMessageId === undefined ? {} : {
        contextSnapshotMessageId: envelopeNonEmptyString(
          source.contextSnapshotMessageId,
          'operator context envelope.source.contextSnapshotMessageId',
        ) as MessageId,
      },
      ...source.instructionMessageIds === undefined ? {} : {
        instructionMessageIds: parseMessageIds(source.instructionMessageIds),
      },
    }
  }
  if (source.kind === 'taskgraph') {
    exactEnvelopeKeys(
      source,
      ['kind', 'runId', 'nodeId', 'contextPacketRef', 'contextSegments'],
      'operator context envelope.source',
    )
    return {
      kind: 'taskgraph',
      runId: envelopeNonEmptyString(source.runId, 'operator context envelope.source.runId'),
      nodeId: envelopeNonEmptyString(source.nodeId, 'operator context envelope.source.nodeId'),
      contextPacketRef: envelopeNonEmptyString(
        source.contextPacketRef,
        'operator context envelope.source.contextPacketRef',
      ),
    }
  }
  if (source.kind === 'tool') {
    exactEnvelopeKeys(source, [
      'kind', 'requestHeaderEventSeq', 'toolCallId', 'contextSnapshotMessageId',
      'instructionMessageIds', 'contextSegments',
    ], 'operator context envelope.source')
    return {
      kind: 'tool',
      requestHeaderEventSeq: envelopeNonnegativeInteger(
        source.requestHeaderEventSeq,
        'operator context envelope.source.requestHeaderEventSeq',
      ),
      toolCallId: envelopeNonEmptyString(source.toolCallId, 'operator context envelope.source.toolCallId'),
      ...source.contextSnapshotMessageId === undefined ? {} : {
        contextSnapshotMessageId: envelopeNonEmptyString(
          source.contextSnapshotMessageId,
          'operator context envelope.source.contextSnapshotMessageId',
        ) as MessageId,
      },
      ...source.instructionMessageIds === undefined ? {} : {
        instructionMessageIds: parseMessageIds(source.instructionMessageIds),
      },
    }
  }
  throw new Error('operator context envelope.source.kind is invalid')
}

function parseContextSegments(value: unknown): OperatorContextEnvelopeContextSegmentV1[] {
  if (!Array.isArray(value)) throw new Error('operator context envelope.source.contextSegments must be an array')
  return value.map((entry, index) => {
    const label = `operator context envelope.source.contextSegments[${String(index)}]`
    const segment = envelopeRecord(entry, label)
    exactEnvelopeKeys(segment, ['name', 'index'], label)
    return {
      name: envelopeNonEmptyString(segment.name, `${label}.name`),
      index: envelopeNonnegativeInteger(segment.index, `${label}.index`),
    }
  })
}

function parseMessageIds(value: unknown): MessageId[] {
  if (!Array.isArray(value)) {
    throw new Error('operator context envelope.source.instructionMessageIds must be an array')
  }
  return value.map((entry, index) => envelopeNonEmptyString(
    entry,
    `operator context envelope.source.instructionMessageIds[${String(index)}]`,
  ) as MessageId)
}

function envelopeRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactEnvelopeKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed)
  const unknown = Object.keys(record).filter(key => !allowedSet.has(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown field ${JSON.stringify(unknown[0])}`)
}

function envelopeString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

function envelopeNonEmptyString(value: unknown, label: string): string {
  const text = envelopeString(value, label)
  if (text.length === 0) throw new Error(`${label} must be non-empty`)
  return text
}

function envelopeNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value as number
}

function assertJsonValue(value: unknown, label: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain only finite JSON numbers`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertJsonValue(entry, `${label}[${String(index)}]`) })
    return
  }
  if (typeof value !== 'object') throw new Error(`${label} must contain only JSON values`)
  for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${label}.${key}`)
}

/** Canonical JSON document handed to text-only Consumers. */
interface OperatorContextEnvelopeTextV1 {
  readonly dshOperatorContextEnvelope: {
    readonly version: 1
    readonly digest: string
    readonly system: { readonly role: 'system'; readonly text: string }
    readonly contexts: readonly { readonly role: 'context'; readonly name: string; readonly text: string }[]
    readonly task: { readonly role: 'task'; readonly content: readonly ContentBlock[] }
  }
}

/** Native-role materialization for Consumers with a separate system slot. */
export interface OperatorContextEnvelopeNativeMaterializationV1 {
  /** Exact system-role text. */
  readonly systemPrompt: string
  /** Dynamic contexts followed by the task content in the user-input channel. */
  readonly prompt: readonly ContentBlock[]
}

/**
 * Materialize an envelope for a Consumer with a native system slot. Dynamic
 * context stays one unambiguous JSON block and the task blocks remain exact.
 * @param envelope - the frozen envelope to materialize.
 * @returns separate system and user-input fields.
 */
export function materializeOperatorContextEnvelopeNative(
  envelope: OperatorContextEnvelopeV1,
): OperatorContextEnvelopeNativeMaterializationV1 {
  const context = envelope.contexts.length === 0
    ? []
    : [{
      type: 'text' as const,
      text: JSON.stringify({
        dshRuntimeContext: {
          version: OPERATOR_CONTEXT_ENVELOPE_VERSION,
          digest: envelope.digest,
          precedence: 'The current task and system safety rules take priority over this runtime context.',
          contexts: envelope.contexts,
        },
      }),
    }]
  return Object.freeze({
    systemPrompt: envelope.systemText,
    prompt: Object.freeze([...context, ...envelope.task]),
  })
}

/**
 * Render every envelope field as one canonical JSON document for a Consumer
 * that cannot receive native roles. JSON string framing makes arbitrary field
 * contents round-trip without delimiter or role-banner spoofing.
 * @param envelope - the frozen envelope to render.
 * @returns canonical JSON text carrying system, context, and task roles.
 */
export function renderOperatorContextEnvelopeText(envelope: OperatorContextEnvelopeV1): string {
  const document: OperatorContextEnvelopeTextV1 = {
    dshOperatorContextEnvelope: {
      version: OPERATOR_CONTEXT_ENVELOPE_VERSION,
      digest: envelope.digest,
      system: { role: 'system', text: envelope.systemText },
      contexts: envelope.contexts.map(context => ({ role: 'context', name: context.name, text: context.text })),
      task: { role: 'task', content: envelope.task },
    },
  }
  return JSON.stringify(document)
}

/** Recursively freeze one structured-cloned model input. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

/**
 * Record successful complete materialization of an envelope.
 * @param envelope - the envelope materialized by the Consumer.
 * @param receiver - stable identity of the receiving Consumer.
 * @param format - native fields or canonical text used by the Consumer.
 * @returns a complete-acceptance receipt bound to the envelope digest.
 */
export function receiveOperatorContextEnvelope(
  envelope: OperatorContextEnvelopeV1,
  receiver: string,
  format: OperatorContextEnvelopeAcceptedReceiptV1['format'],
): OperatorContextEnvelopeAcceptedReceiptV1 {
  return Object.freeze({
    version: OPERATOR_CONTEXT_ENVELOPE_VERSION,
    digest: envelope.digest,
    receiver,
    outcome: 'accepted',
    format,
    roleFidelity: format === 'native' ? 'native' : 'text-downgrade',
  })
}

/**
 * Record a Consumer's explicit refusal to materialize an envelope.
 * @param envelope - the envelope the Consumer declined.
 * @param receiver - stable identity of the receiving Consumer.
 * @param reason - provider-owned reason for the refusal.
 * @returns a rejection receipt bound to the envelope digest.
 */
export function rejectOperatorContextEnvelope(
  envelope: OperatorContextEnvelopeV1,
  receiver: string,
  reason: string,
): OperatorContextEnvelopeRejectedReceiptV1 {
  return Object.freeze({
    version: OPERATOR_CONTEXT_ENVELOPE_VERSION,
    digest: envelope.digest,
    receiver,
    outcome: 'rejected',
    reason,
  })
}
