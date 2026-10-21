import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { retireHistoricalCatalogs } from '../src/index.js'

function appendCatalog(session: Session, count: number) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'LARGE-CATALOG-BODY-' + 'x'.repeat(count * 300) }],
    source: { kind: 'skill-catalog', form: 'catalog', entries: Array.from({ length: count }, (_, index) => ({ name: `skill-${index}`, description: `Skill ${index}` })) },
  }), { surfaceOp: 'append' })
}

function appendUser(session: Session, text: string) {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

describe('canonical single-node catalog retirement', () => {
  it('retires three interleaved full catalogs while retaining original events and user facts', () => {
    const session = Session.create(SessionId('offline-retirement-fixture'))
    const catalogs = [appendCatalog(session, 1467)]
    const firstUser = appendUser(session, 'Keep the corrected budget: 1800.')
    catalogs.push(appendCatalog(session, 1475))
    const secondUser = appendUser(session, 'Do not run tools or change files.')
    catalogs.push(appendCatalog(session, 1477))
    const original = JSON.stringify(session.snapshotEvents())
    const originalLength = session.seq
    expect(session.deriveMessages().filter(message => message.source.kind === 'skill-catalog')).toHaveLength(3)

    expect(retireHistoricalCatalogs(session, { turn: 2, step: 0 })).toBe(3)
    expect(session.deriveMessages()).toEqual([firstUser.data, secondUser.data])
    expect(JSON.stringify(session.snapshotEvents().slice(0, originalLength))).toBe(original)
    const replacements = session.snapshotEvents().slice(originalLength)
    expect(replacements.map(event => event.sourceEventSeqs)).toEqual(catalogs.map(event => [event.seq]))
    expect(replacements.every(event => event.type === 'developer/message' && event.data.message.content.length === 0)).toBe(true)
    const stableLength = session.seq
    expect(retireHistoricalCatalogs(session, { turn: 2, step: 1 })).toBe(0)
    expect(session.seq).toBe(stableLength)
  })

  it('restores the same bounded canonical request from the preserved event log', () => {
    const session = Session.create(SessionId('offline-reopen-fixture'))
    appendCatalog(session, 1477)
    const user = appendUser(session, 'Keep this task after reopening.')
    retireHistoricalCatalogs(session, { turn: 1, step: 0 })
    const reopened = Session.create(session.id, session.snapshotEvents())
    expect(reopened.deriveMessages()).toEqual([user.data])
    expect(reopened.snapshotEvents()[0]?.type).toBe('user/message')
    expect(retireHistoricalCatalogs(reopened, { turn: 2, step: 0 })).toBe(0)
  })

  it('validates all catalog records before any replacement write', () => {
    const session = Session.create(SessionId('offline-invalid-catalog-fixture'))
    appendCatalog(session, 1)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unsupported catalog body' }],
      source: { kind: 'skill-catalog', form: 'catalog', entries: null as never },
    }), { surfaceOp: 'append' })
    const before = JSON.stringify(session.snapshotEvents())
    expect(() => retireHistoricalCatalogs(session, { turn: 1, step: 0 })).toThrow('SKILL_CONTEXT_CATALOG_INVALID')
    expect(JSON.stringify(session.snapshotEvents())).toBe(before)
  })
})
