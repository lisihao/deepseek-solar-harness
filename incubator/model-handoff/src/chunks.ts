import { createHash } from 'node:crypto'

type JsonRecord = Record<string, unknown>

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function encode(records: readonly JsonRecord[]): string {
  return JSON.stringify({ records })
}

function attribution(record: JsonRecord): JsonRecord {
  const source = record.source as JsonRecord | undefined
  return {
    ...(record.seq === undefined ? {} : { seq: record.seq }),
    ...(record.type === undefined ? {} : { type: record.type }),
    role: record.role,
    ...(source?.kind === undefined ? {} : { sourceKind: source.kind }),
    ...(source?.kind !== 'model' ? {} : { provider: source.provider, model: source.model }),
    ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
    ...(record.isError === undefined ? {} : { isError: record.isError }),
  }
}

/** Small, deterministic attribution retained alongside each map draft at reduction. */
export function chunkProvenance(chunk: string): JsonRecord {
  const parsed = JSON.parse(chunk) as { records?: JsonRecord[]; historyFragment?: JsonRecord }
  if (parsed.records) return { records: parsed.records.map(attribution) }
  if (!parsed.historyFragment) throw new Error('unknown history chunk envelope')
  const { text: _text, ...metadata } = parsed.historyFragment
  return metadata
}

function fragmentRecord(record: JsonRecord, unitIndex: number, recordIndex: number, recordCount: number, maxBytes: number): string[] {
  const text = JSON.stringify(record)
  const points = Array.from(text)
  const metadata = { formatVersion: 1, unitIndex, recordIndex, recordCount, ...attribution(record),
    totalBytes: utf8Bytes(text), sha256: createHash('sha256').update(text).digest('hex') }
  const chunks: string[] = []
  let start = 0
  let byteOffset = 0
  while (start < points.length) {
    const envelope = (end: number): string => JSON.stringify({ historyFragment: {
      ...metadata, part: chunks.length, byteOffset, text: points.slice(start, end).join(''), last: end === points.length,
    } })
    let low = start + 1
    let high = points.length
    let best = start
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (utf8Bytes(envelope(middle)) <= maxBytes) { best = middle; low = middle + 1 } else high = middle - 1
    }
    // `true` is one byte shorter than `false`; the final point may still fit.
    if (best < points.length && utf8Bytes(envelope(points.length)) <= maxBytes) best = points.length
    if (best === start) throw new Error('分块预算无法容纳历史片段元数据和一个字符；没有调用 Luna。')
    chunks.push(envelope(best))
    byteOffset += utf8Bytes(points.slice(start, best).join(''))
    start = best
  }
  return chunks
}

function toolCallIds(record: JsonRecord): string[] {
  if (!Array.isArray(record.content)) return []
  const ids: string[] = []
  for (const block of record.content) {
    if (typeof block !== 'object' || block === null || (block as { type?: unknown }).type !== 'tool-call') continue
    const id = (block as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) throw new Error('tool-call block must have a non-empty id')
    ids.push(id)
  }
  return ids
}

function balancedUnits(records: readonly JsonRecord[]): JsonRecord[][] {
  const units: JsonRecord[][] = []
  let group: JsonRecord[] | undefined
  const open = new Set<string>()

  for (const record of records) {
    const calls = toolCallIds(record)
    if (record.role === 'tool') {
      if (calls.length > 0) throw new Error('tool result cannot open a tool call')
      const id = record.toolCallId
      if (typeof id !== 'string' || id.length === 0 || !open.has(id)) {
        throw new Error(`orphan tool result${typeof id === 'string' ? ` "${id}"` : ''}`)
      }
      group?.push(record)
      open.delete(id)
      if (open.size === 0) {
        units.push(group ?? [record])
        group = undefined
      }
      continue
    }

    if (calls.length > 0) {
      for (const id of calls) {
        if (open.has(id)) throw new Error(`repeated tool-call id "${id}"`)
        open.add(id)
      }
      if (group === undefined) group = []
      group.push(record)
      continue
    }

    if (open.size > 0) {
      group?.push(record)
      continue
    }
    units.push([record])
  }

  if (open.size > 0) throw new Error(`open tool call at end: ${[...open].join(', ')}`)
  return units
}

/**
 * Pack complete session records into bounded UTF-8 JSON envelopes.
 * Tool pairs are validated globally. Oversized balanced units become attributed
 * serialized record fragments, never orphan native tool messages.
 */
export function planChunks(records: readonly Record<string, unknown>[], maxBytes: number): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive safe integer')
  if (records.length === 0) return []

  const units = balancedUnits(records)
  const chunks: string[] = []
  let current: JsonRecord[] = []
  for (const [unitIndex, unit] of units.entries()) {
    const single = encode(unit)
    if (utf8Bytes(single) > maxBytes) {
      if (current.length > 0) { chunks.push(encode(current)); current = [] }
      for (const [recordIndex, record] of unit.entries()) chunks.push(...fragmentRecord(record, unitIndex, recordIndex, unit.length, maxBytes))
      continue
    }
    const candidate = encode([...current, ...unit])
    if (current.length > 0 && utf8Bytes(candidate) > maxBytes) {
      chunks.push(encode(current))
      current = [...unit]
    } else {
      current.push(...unit)
    }
  }
  if (current.length > 0) chunks.push(encode(current))
  return chunks
}
