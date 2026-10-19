type JsonRecord = Record<string, unknown>

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function encode(records: readonly JsonRecord[]): string {
  return JSON.stringify({ records })
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
 * Tool-call records and all of their matching tool results stay together.
 */
export function planChunks(records: readonly Record<string, unknown>[], maxBytes: number): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive safe integer')
  if (records.length === 0) return []

  const units = balancedUnits(records)
  const chunks: string[] = []
  let current: JsonRecord[] = []
  for (const unit of units) {
    const single = encode(unit)
    if (utf8Bytes(single) > maxBytes) throw new Error('one balanced history unit exceeds maxBytes')
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
