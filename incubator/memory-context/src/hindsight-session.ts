import { createDeveloperMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { MemoryContextError, type SessionFlusher } from './graph-memory.js'
import { COMPACT_HINDSIGHT_GUIDE, compactHindsightText, isHindsightRecall, projectHindsightMessage } from './hindsight.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'solar-hindsight-context': {
      kind: 'solar-hindsight-context'
      form: 'guide-retirement'
      formatVersion: 1
      policyVersion: 1
    }
  }
}

function projectionMarker(message: UserMessage): Record<string, unknown> | undefined {
  if (!isHindsightRecall(message)) return undefined
  const source = message.source as unknown as Record<string, unknown>
  const marker = source.solarHindsightContext
  if (marker === undefined) return undefined
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) {
    throw new MemoryContextError('MEMORY_CONTEXT_PROJECTION_UNSUPPORTED', 'Hindsight guide projection metadata is not an object')
  }
  const value = marker as Record<string, unknown>
  if (value.formatVersion !== 1 || value.policyVersion !== 1 || typeof value.includesCompactGuide !== 'boolean') {
    throw new MemoryContextError('MEMORY_CONTEXT_PROJECTION_UNSUPPORTED', 'Hindsight guide projection version or shape is unsupported')
  }
  return value
}

function hasCompactGuide(message: UserMessage): boolean {
  return projectionMarker(message)?.includesCompactGuide === true
    && message.content.some(block => block.type === 'text' && block.text.includes(COMPACT_HINDSIGHT_GUIDE))
}

function removeCompactGuide(message: UserMessage): UserMessage {
  const source = message.source as unknown as Record<string, unknown>
  const marker = projectionMarker(message)!
  return createUserMessage({
    content: message.content.map(block => block.type === 'text'
      ? { ...block, text: block.text.replace(COMPACT_HINDSIGHT_GUIDE, '') }
      : block),
    source: { ...source, solarHindsightContext: { ...marker, includesCompactGuide: false } } as never,
  })
}

function hasContent(message: UserMessage): boolean {
  return message.content.some(block => block.type !== 'text' || block.text.trim().length > 0)
}

interface HindsightAction {
  readonly seq: SessionSeq
  readonly message: UserMessage
}

/** Current contributions are processed before commit; source and factual blocks remain. */
export function projectCurrentHindsight(messages: readonly UserMessage[]): { readonly messages: readonly UserMessage[]; readonly freshGuide: boolean } {
  let freshGuide = false
  let changed = false
  const result = messages.map(message => {
    projectionMarker(message)
    const projected = projectHindsightMessage(message, !freshGuide)
    if (projected === undefined) return message
    freshGuide = true
    changed = true
    return projected
  })
  return { messages: changed ? result : messages, freshGuide }
}

/** Plan the complete change first, so unsupported Solar metadata cannot cause partial writes. */
export function planHindsightProjection(session: Session): readonly HindsightAction[] {
  const candidates: Array<{ seq: SessionSeq; message: UserMessage; compact: boolean }> = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (event?.type !== 'user/message' || !isHindsightRecall(event.data)) continue
    const compact = hasCompactGuide(event.data)
    const known = event.data.content.some(block => block.type === 'text' && compactHindsightText(block.text) !== undefined)
    if (compact || known) candidates.push({ seq, message: event.data, compact })
  }
  // Keep the newest committed guide until its replacement is also committed.
  // An ephemeral pre-step proposal may still be aborted by the host.
  const latest = candidates.at(-1)?.seq
  const actions: HindsightAction[] = []
  for (const candidate of candidates) {
    if (candidate.compact && candidate.seq === latest) continue
    const message = candidate.compact
      ? removeCompactGuide(candidate.message)
      : projectHindsightMessage(candidate.message, candidate.seq === latest)!
    actions.push({ seq: candidate.seq, message })
  }
  return actions
}

export class HindsightDurabilityBarrier {
  readonly #pending = new WeakSet<Session>()

  constructor(private readonly sessions: SessionFlusher) {}

  async beforeRequest(session: Session, position: { turn: number; step: number }, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const actions = planHindsightProjection(session)
    signal.throwIfAborted()
    if (actions.length > 0) this.#pending.add(session)
    for (const action of actions) {
      const options = {
        surfaceOp: { op: 'replace' as const, startSeq: action.seq, endSeq: action.seq },
        sourceEventSeqs: [action.seq],
      }
      if (hasContent(action.message)) session.append('user/message', action.message, options)
      else session.append('developer/message', {
        ...position,
        message: createDeveloperMessage({ content: [], source: { kind: 'solar-hindsight-context', form: 'guide-retirement', formatVersion: 1, policyVersion: 1 } }),
      }, options)
    }
    if (this.#pending.has(session)) {
      let persisted: boolean
      try { persisted = await this.sessions.flush(session) }
      catch (cause) { throw new MemoryContextError('MEMORY_CONTEXT_FLUSH_FAILED', 'Hindsight guide projection durability could not be checked', { cause }) }
      if (!persisted) throw new MemoryContextError('MEMORY_CONTEXT_FLUSH_FAILED', 'Hindsight guide projection was not confirmed durable before the request')
      this.#pending.delete(session)
    }
    signal.throwIfAborted()
  }
}
