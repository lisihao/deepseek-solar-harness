import { describe, expect, it } from 'vitest'
import { planChunks } from '../src/chunks.js'

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

  it('rejects an oversized balanced unit and invalid budgets', () => {
    const records = [assistant(['a'], 'x'.repeat(300)), tool(2, 'a', '结果')]
    const unitBytes = Buffer.byteLength(JSON.stringify({ records }), 'utf8')
    expect(() => planChunks(records, unitBytes - 1)).toThrow(/exceeds|maxBytes/)
    expect(() => planChunks([], 0)).toThrow()
    expect(() => planChunks(records, 0)).toThrow()
    expect(() => planChunks(records, 1.5)).toThrow()
    expect(() => planChunks(records, Number.POSITIVE_INFINITY)).toThrow()
  })

  it('returns no chunks for empty history', () => {
    expect(planChunks([], 1024)).toEqual([])
  })
})
