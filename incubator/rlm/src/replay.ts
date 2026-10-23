import { createReadStream } from 'node:fs'

type JsonRecord = Record<string, unknown>

type ReplayEntry =
  | { kind: 'unique'; canonicalState: string; state: unknown }
  | { kind: 'ambiguous' }

interface RestoreState {
  entries: Map<string, ReplayEntry>
  highestModelOrdinal: number
}

const KNOWN_JOURNAL_TYPES = new Set([
  'acp',
  'cancel-notification-error',
  'model-chunk',
  'model-dispatch',
  'model-error',
  'model-intent',
  'model-settlement',
  'native-launch',
  'turn-intent',
])

function formatError(detail: string): Error {
  return new Error(`RLM_REPLAY_FORMAT: ${detail}`)
}

function ambiguousError(): Error {
  return new Error('RLM_REPLAY_AMBIGUOUS: 同一 Prime assistant wire message 对应多个不同的 DSH replay state，拒绝选择其中一个。')
}

function isRecord(value: unknown): value is JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function objectOrEmpty(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

/** Deterministic JSON for durable identity comparisons; functions and aliases are not replayable. */
function canonicalJson(value: unknown, path: string): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string': return JSON.stringify(value)
    case 'boolean': return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw formatError(`${path} contains a non-finite number`)
      return JSON.stringify(value)
    case 'object':
      if (Array.isArray(value)) {
        return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(',')}]`
      }
      if (!isRecord(value)) throw formatError(`${path} is not JSON-compatible`)
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`)}`).join(',')}}`
    default:
      throw formatError(`${path} is not JSON-compatible`)
  }
}

/**
 * The exact data core's former replayKey selected: unrelated OpenAI fields do
 * not affect replay identity, while text, reasoning and tool-call order/args do.
 */
function wireKey(message: unknown): string {
  const value = objectOrEmpty(message)
  return canonicalJson([
    value.content ?? '',
    value.reasoning_content ?? '',
    value.tool_calls ?? [],
  ], 'message')
}

function has(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function journalError(line: number, detail: string): Error {
  return formatError(`journal line ${line}: ${detail}`)
}

/**
 * Stores DSH adapter replay envelopes keyed by the exact OpenAI assistant
 * message Prime will send back. A key with conflicting historical metadata is
 * intentionally unusable: guessing a provider signature can corrupt replay.
 */
export class ReplayRegistry {
  private entries = new Map<string, ReplayEntry>()
  private highestOrdinal = 0

  record(message: unknown, replayState: unknown): void {
    this.recordInto(this.entries, message, replayState)
  }

  /** The highest durable model reservation in this run, or zero before restore. */
  highestModelOrdinal(): number {
    return this.highestOrdinal
  }

  forMessage(message: unknown): unknown {
    const entry = this.entries.get(wireKey(message))
    if (entry === undefined) return undefined
    if (entry.kind === 'ambiguous') throw ambiguousError()
    // Deliberately return the stored value itself: no normalization or
    // synthesis is valid for adapter-private replay metadata.
    return entry.state
  }

  async restore(journalPath: string): Promise<void> {
    const restored: RestoreState = {
      entries: new Map<string, ReplayEntry>(),
      highestModelOrdinal: 0,
    }
    let lineNumber = 0
    let remainder = ''

    try {
      const stream = createReadStream(journalPath, { encoding: 'utf8' })
      for await (const chunk of stream) {
        remainder += chunk
        let delimiter = remainder.indexOf('\n')
        while (delimiter !== -1) {
          const rawLine = remainder.slice(0, delimiter)
          remainder = remainder.slice(delimiter + 1)
          lineNumber += 1
          this.restoreLine(restored, rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine, lineNumber)
          delimiter = remainder.indexOf('\n')
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.entries = restored.entries
        this.highestOrdinal = restored.highestModelOrdinal
        return
      }
      throw error
    }

    if (remainder.length !== 0) throw journalError(lineNumber + 1, 'ends with a partial JSONL line')
    this.entries = restored.entries
    this.highestOrdinal = restored.highestModelOrdinal
  }

  private recordInto(entries: Map<string, ReplayEntry>, message: unknown, replayState: unknown): void {
    if (replayState === undefined) throw formatError('replayState is absent')
    const key = wireKey(message)
    const canonicalState = canonicalJson(replayState, 'replayState')
    const existing = entries.get(key)
    if (existing === undefined) {
      entries.set(key, { kind: 'unique', canonicalState, state: replayState })
      return
    }
    if (existing.kind === 'ambiguous' || existing.canonicalState === canonicalState) return
    entries.set(key, { kind: 'ambiguous' })
  }

  private restoreLine(restored: RestoreState, rawLine: string, line: number): void {
    if (rawLine.length === 0) throw journalError(line, 'is empty')
    let parsed: unknown
    try {
      parsed = JSON.parse(rawLine) as unknown
    } catch {
      throw journalError(line, 'is not valid JSON')
    }
    if (!isRecord(parsed) || parsed.formatVersion !== 1 || typeof parsed.time !== 'string' || !has(parsed, 'value')) {
      throw journalError(line, 'does not have store journal format version 1')
    }
    const event = parsed.value
    if (!isRecord(event) || typeof event.type !== 'string') throw journalError(line, 'has no event type')
    if (!KNOWN_JOURNAL_TYPES.has(event.type)) throw journalError(line, `has unknown event type ${JSON.stringify(event.type)}`)
    if (event.type === 'model-intent') {
      const ordinal = event.ordinal
      if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal <= 0) {
        throw journalError(line, 'model-intent ordinal must be a positive integer')
      }
      if (ordinal <= restored.highestModelOrdinal) {
        throw journalError(line, `model-intent ordinal ${ordinal} is not greater than prior ordinal ${restored.highestModelOrdinal}`)
      }
      restored.highestModelOrdinal = ordinal
      return
    }
    if (event.type !== 'model-settlement') return

    if (!isRecord(event.value)) throw journalError(line, 'model-settlement has no value object')
    const settlement = event.value
    if (!has(settlement, 'message')) throw journalError(line, 'model-settlement has no message')
    if (!has(settlement, 'replayState')) return
    if (!isRecord(settlement.message)) throw journalError(line, 'model-settlement message is not an OpenAI assistant object')
    try {
      this.recordInto(restored.entries, settlement.message, settlement.replayState)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('RLM_REPLAY_FORMAT:')) {
        throw journalError(line, error.message.slice('RLM_REPLAY_FORMAT: '.length))
      }
      throw error
    }
  }
}
