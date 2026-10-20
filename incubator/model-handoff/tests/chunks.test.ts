import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { chunkProvenance, planChunks } from '../src/chunks.js'

const assistant = (ids: readonly string[], text = '调用工具'): Record<string, unknown> => ({
  seq: 1,
  type: 'assistant/message',
  role: 'assistant',
  content: [
    { type: 'text', text },
    ...ids.map(id => ({ type: 'tool-call', id, name: 'echo', arguments: '{}' })),
  ],
  source: { kind: 'model', provider: 'fixture', model: 'fixture' },
})

const tool = (seq: number, id: string, text: string): Record<string, unknown> => ({
  seq,
  type: 'tool/result',
  role: 'tool',
  content: [{ type: 'text', text }],
  toolCallId: id,
  source: { kind: 'tool', callId: id },
})

const user = (seq: number, text: string): Record<string, unknown> => ({
  seq,
  type: 'user/message',
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

function unwrap(chunks: readonly string[]): Record<string, unknown>[] {
  return chunks.flatMap(chunk => {
    const parsed = JSON.parse(chunk) as { records: Record<string, unknown>[] }
    return parsed.records
  })
}

type Fragment = {
  readonly formatVersion: number
  readonly unitIndex: number
  readonly recordIndex: number
  readonly recordCount: number
  readonly seq?: number
  readonly role?: string
  readonly sourceKind?: string
  readonly toolCallId?: string
  readonly isError?: boolean
  readonly part: number
  readonly byteOffset: number
  readonly totalBytes: number
  readonly sha256: string
  readonly text: string
  readonly last: boolean
}

function parseChunk(chunk: string): { records?: Record<string, unknown>[]; historyFragment?: Fragment } {
  return JSON.parse(chunk) as { records?: Record<string, unknown>[]; historyFragment?: Fragment }
}

function noisyText(seed: string, repeats = 180): string {
  return `${seed} 引号" 反斜杠\\ 中文🌟\n`.repeat(repeats)
}

function largeRecord(seq: number, type: string, role: string, seed: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq,
    type,
    role,
    content: [{ type: 'text', text: noisyText(seed) }],
    source: { kind: role },
    ...extra,
  }
}

function assertUnicodeSafe(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      expect(value.charCodeAt(index + 1)).toBeGreaterThanOrEqual(0xdc00)
      expect(value.charCodeAt(index + 1)).toBeLessThanOrEqual(0xdfff)
      index += 1
    } else {
      expect(code >= 0xdc00 && code <= 0xdfff).toBe(false)
    }
  }
}

function recoverFragmentedUnits(chunks: readonly string[]): Record<string, unknown>[] {
  type OutputItem =
    | { readonly chunkIndex: number; readonly records: Record<string, unknown>[] }
    | { readonly chunkIndex: number; readonly unitIndex: number }
  const output: OutputItem[] = []
  const unitParts = new Map<number, Map<number, Fragment[]>>()
  for (const [chunkIndex, chunk] of chunks.entries()) {
    const parsed = parseChunk(chunk)
    if (parsed.records !== undefined) {
      output.push({ chunkIndex, records: parsed.records })
      continue
    }
    if (parsed.historyFragment === undefined) throw new Error('unexpected chunk envelope')
    const fragment = parsed.historyFragment
    expect(fragment.formatVersion).toBe(1)
    expect(fragment.unitIndex).toBeGreaterThanOrEqual(0)
    expect(fragment.recordIndex).toBeGreaterThanOrEqual(0)
    expect(fragment.recordCount).toBeGreaterThan(fragment.recordIndex)
    expect(fragment.part).toBeGreaterThanOrEqual(0)
    if (!unitParts.has(fragment.unitIndex)) {
      unitParts.set(fragment.unitIndex, new Map())
      output.push({ chunkIndex, unitIndex: fragment.unitIndex })
    }
    const records = unitParts.get(fragment.unitIndex)!
    records.set(fragment.recordIndex, [...(records.get(fragment.recordIndex) ?? []), fragment])
  }

  const recoverUnit = (unitIndex: number): Record<string, unknown>[] => {
    const records = unitParts.get(unitIndex)!
    const recordCount = [...records.values()][0]?.[0]?.recordCount ?? 0
    expect(records.size).toBe(recordCount)
    return Array.from({ length: recordCount }, (_, recordIndex) => {
      const parts = [...(records.get(recordIndex) ?? [])].sort((left, right) => left.part - right.part)
      expect(parts.length).toBeGreaterThan(0)
      expect(parts[0]?.part).toBe(0)
      const text = parts.map(part => part.text).join('')
      const totalBytes = Buffer.byteLength(text, 'utf8')
      const digest = createHash('sha256').update(text, 'utf8').digest('hex')
      expect(parts.every(part => part.recordIndex === recordIndex && part.recordCount === recordCount)).toBe(true)
      expect(parts.every(part => part.totalBytes === totalBytes && part.sha256 === digest)).toBe(true)
      for (const [partIndex, part] of parts.entries()) {
        const offset = Buffer.byteLength(parts.slice(0, partIndex).map(item => item.text).join(''), 'utf8')
        expect(part.part).toBe(partIndex)
        expect(part.byteOffset).toBe(offset)
        expect(part.last).toBe(partIndex === parts.length - 1)
        expect(part.text.length).toBeGreaterThan(0)
        assertUnicodeSafe(part.text)
      }
      const record = JSON.parse(text) as Record<string, unknown>
      expect(JSON.stringify(record)).toBe(text)
      if (Object.hasOwn(record, 'seq')) expect(parts.every(part => part.seq === record.seq)).toBe(true)
      if (Object.hasOwn(record, 'role')) expect(parts.every(part => part.role === record.role)).toBe(true)
      if (typeof record.source === 'object' && record.source !== null && 'kind' in record.source) {
        expect(parts.every(part => part.sourceKind === (record.source as { kind: unknown }).kind)).toBe(true)
      }
      if (Object.hasOwn(record, 'toolCallId')) expect(parts.every(part => part.toolCallId === record.toolCallId)).toBe(true)
      if (Object.hasOwn(record, 'isError')) expect(parts.every(part => part.isError === record.isError)).toBe(true)
      else expect(parts.every(part => !Object.hasOwn(part, 'isError'))).toBe(true)
      return record
    })
  }

  return output.sort((left, right) => left.chunkIndex - right.chunkIndex).flatMap(item => (
    'records' in item ? item.records : recoverUnit(item.unitIndex)
  ))
}

describe('planChunks', () => {
  it('covers Unicode records once in original order and respects UTF-8 bytes', () => {
    const records = [user(0, '中文🌟'.repeat(20)), user(1, '第二段内容')] 
    const oneRecordBytes = Buffer.byteLength(JSON.stringify({ records: [records[0]] }), 'utf8')
    const chunks = planChunks(records, oneRecordBytes)

    expect(chunks).toHaveLength(2)
    expect(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= oneRecordBytes)).toBe(true)
    expect(unwrap(chunks)).toEqual(records)
  })

  it('keeps parallel tool calls and matching results in one balanced unit', () => {
    const records = [user(0, '前置'), assistant(['a', 'b']), tool(2, 'b', 'B'), tool(3, 'a', 'A'), user(4, '后置')]
    const group = records.slice(1, 4)
    const groupBytes = Buffer.byteLength(JSON.stringify({ records: group }), 'utf8')
    const chunks = planChunks(records, groupBytes)
    const parsed = chunks.map(chunk => (JSON.parse(chunk) as { records: Record<string, unknown>[] }).records)

    expect(parsed.flat()).toEqual(records)
    expect(parsed.some(unit => unit.length === 3 && unit[0]?.type === 'assistant/message')).toBe(true)
    expect(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= groupBytes)).toBe(true)
    expect(chunks.every(chunk => Object.hasOwn(parseChunk(chunk), 'records'))).toBe(true)
  })

  it('allows a tool-call id to be reused after its earlier result closed', () => {
    const records = [assistant(['same']), tool(2, 'same', 'first'), assistant(['same']), tool(4, 'same', 'second')]
    expect(unwrap(planChunks(records, 10_000))).toEqual(records)
  })

  it.each([
    ['orphan result', [tool(0, 'missing', 'x')], 10_000],
    ['repeated open id', [assistant(['same']), assistant(['same']), tool(2, 'same', 'x')], 10_000],
    ['open at end', [assistant(['never'])], 10_000],
  ])('rejects %s tool pairing', (_label, records, maxBytes) => {
    expect(() => planChunks(records, maxBytes)).toThrow()
  })

  it('fragments oversized user/system/developer records and a parallel tool group without losing bytes', () => {
    const toolIds = ['parallel-a', 'parallel-b', 'parallel-c']
    const records = [
      user(0, 'small before'),
      largeRecord(10, 'user/message', 'user', 'user'),
      user(11, 'small between user and system'),
      largeRecord(12, 'system/message', 'system', 'system'),
      user(13, 'small between system and developer'),
      largeRecord(14, 'developer/message', 'developer', 'developer', {
        toolHeader: {
          header: {
            config: { provider: 'fixture', model: 'fixture' },
            tools: Array.from({ length: 8 }, (_, index) => ({
              name: `large-tool-${index}`,
              description: noisyText(`header-${index}`, 8),
              parameters: { type: 'object', properties: { value: { type: 'string' } } },
            })),
          },
        },
      }),
      user(15, 'small between developer and tools'),
      {
        seq: 16,
        type: 'assistant/message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'parallel tools' },
          ...toolIds.map(id => ({ type: 'tool-call', id, name: 'echo', arguments: `{"quote":"\\${id}"}` })),
        ],
        source: { kind: 'model', provider: 'fixture', model: 'fixture' },
      },
      ...toolIds.map((id, index) => {
        const result = tool(17 + index, id, noisyText(`result-${id}`))
        return index === 1 ? { ...result, isError: false } : index === 2 ? { ...result, isError: true } : result
      }),
      user(20, 'small after'),
    ]
    const maxBytes = 1_024
    const chunks = planChunks(records, maxBytes)

    expect(chunks.length).toBeGreaterThan(4)
    expect(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= maxBytes)).toBe(true)
    expect(recoverFragmentedUnits(chunks)).toEqual(records)
    const envelopes = chunks.map(parseChunk)
    expect(envelopes.some(envelope => envelope.records !== undefined)).toBe(true)
    const fragmentEnvelopes = envelopes.filter((envelope): envelope is { historyFragment: Fragment } => envelope.historyFragment !== undefined)
    expect(fragmentEnvelopes.length).toBeGreaterThan(0)
    expect(new Set(fragmentEnvelopes.map(envelope => envelope.historyFragment.unitIndex)).size).toBe(4)
    const provenance = chunks.map(chunkProvenance)
    const toolProvenance = provenance.filter(item => item.toolCallId !== undefined)
    expect(toolProvenance.some(item => !Object.hasOwn(item, 'isError'))).toBe(true)
    expect(toolProvenance.some(item => item.isError === false)).toBe(true)
    expect(toolProvenance.some(item => item.isError === true)).toBe(true)
  })

  it('rejects a fragment budget that cannot hold metadata plus one UTF-8 character', () => {
    const record = largeRecord(20, 'user/message', 'user', 'tiny-budget')
    expect(() => planChunks([record], 128)).toThrow(/budget|maxBytes|fragment|metadata|预算|上限|容纳/i)
  })

  it('rejects invalid budgets while retaining tool-pair validation', () => {
    const records = [assistant(['a'], 'x'.repeat(300)), tool(2, 'a', '结果')]
    expect(() => planChunks([], 0)).toThrow()
    expect(() => planChunks(records, 0)).toThrow()
    expect(() => planChunks(records, 1.5)).toThrow()
    expect(() => planChunks(records, Number.POSITIVE_INFINITY)).toThrow()
  })

  it('returns no chunks for empty history', () => {
    expect(planChunks([], 1024)).toEqual([])
  })
})
