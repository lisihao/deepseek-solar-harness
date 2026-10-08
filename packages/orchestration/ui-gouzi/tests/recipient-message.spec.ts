import { describe, expect, it } from 'vitest'
import { decodeKennelMessage, encodeKennelMessage } from '../src/recipient-message.ts'
const target = { gouziId: 'member.opaque', generation: 2, mode: 'standard' } as const
const prefix = '[DSH kennel recipient]\n'
describe('kennel durable recipient text', () => {
  it('preserves manager text and exact addressed body', () => {
    const body = '\n @name\n中文\r\n '
    expect(encodeKennelMessage(body, null)).toBe(body)
    expect(encodeKennelMessage(body, target)).toBe(prefix + '{"version":1,"gouziId":"member.opaque","generation":2,"mode":"standard"}\n' + body)
    expect(decodeKennelMessage(encodeKennelMessage(body, target))).toEqual({ text: body, recipient: target })
    expect(decodeKennelMessage(body)).toEqual({ text: body })
    expect(decodeKennelMessage('body\n' + prefix + 'broken')).toEqual({ text: 'body\n' + prefix + 'broken' })
  })
  it('escapes copied recipient markers as plain text without selecting the copied target', () => {
    const quoted = encodeKennelMessage('复制的任务\n原文', target)
    const encoded = encodeKennelMessage(quoted, null)
    expect(encoded).toBe('[DSH kennel plain]\n{"version":1}\n' + quoted)
    expect(decodeKennelMessage(encoded)).toEqual({ text: quoted })
    expect(decodeKennelMessage(encodeKennelMessage(quoted, target))).toEqual({ text: quoted, recipient: target })
  })
  it('escapes plain markers once and preserves malformed quoted markers', () => {
    const plain = '[DSH kennel plain]\n{"version":1}\n' + encodeKennelMessage('inner target', target)
    expect(decodeKennelMessage(encodeKennelMessage(plain, null))).toEqual({ text: plain })
    for (const text of [prefix + 'broken', '[DSH kennel plain]\nbroken']) {
      expect(decodeKennelMessage(encodeKennelMessage(text, null))).toEqual({ text })
    }
    const embedded = '引用：\n' + plain
    expect(encodeKennelMessage(embedded, null)).toBe(embedded)
    expect(decodeKennelMessage(embedded)).toEqual({ text: embedded })
  })
  it.each(['', '{}', '{"version":2}', '{"version":1,"gouziId":"other"}', 'null', '{'])('rejects invalid outer plain metadata %s', (metadata) => {
    expect(() => decodeKennelMessage('[DSH kennel plain]\n' + metadata + '\nbody')).toThrow('Invalid kennel plain envelope')
  })
  it.each([null, {}, { ...target, version: 2 }, { ...target, version: 1, mode: 'resident' }, { ...target, version: 1, generation: 0 }, { ...target, version: 1, generation: 1.5 }, { ...target, version: 1, gouziId: ' x ' }, { ...target, version: 1, gouziId: '' }])('rejects invalid leading metadata %j', (metadata) => {
    expect(() => decodeKennelMessage(prefix + JSON.stringify(metadata) + '\nbody')).toThrow('Invalid kennel recipient')
  })
  it('rejects missing or malformed JSON and invalid encode fields', () => {
    expect(() => decodeKennelMessage(prefix + '{}')).toThrow()
    expect(() => decodeKennelMessage(prefix + '{\nbody')).toThrow()
    expect(() => encodeKennelMessage('body', { ...target, generation: NaN })).toThrow()
  })
})
