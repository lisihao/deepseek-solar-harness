import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CreditBlockStore, sessionCreditBlocked } from '../src/credit-blocks.ts'

const HOUR = 3_600_000
const root = () => mkdtempSync(join(tmpdir(), 'dsh-credit-blocks-'))

describe('CreditBlockStore', () => {
  it('keeps a block until it expires and forgets it after a completed run', () => {
    const store = new CreditBlockStore(undefined, HOUR, vi.fn())
    store.block('claude-code:claude-fable-5-1', 1_000)

    expect([...store.active(1_000 + HOUR - 1)]).toEqual(['claude-code:claude-fable-5-1'])
    expect([...store.active(1_000 + HOUR)]).toEqual([])

    store.block('codex:gpt-6-sol', 5_000)
    store.clear('codex:gpt-6-sol')
    store.clear('codex:gpt-6-sol')
    expect([...store.active(5_001)]).not.toContain('codex:gpt-6-sol')
  })

  it('shares blocks with a later store on the same directory', () => {
    const directory = root()
    new CreditBlockStore(directory, HOUR, vi.fn()).block('claude-code:claude-fable-5-1', Date.now())

    expect([...new CreditBlockStore(directory, HOUR, vi.fn()).active()]).toEqual(['claude-code:claude-fable-5-1'])
    expect(JSON.parse(readFileSync(join(directory, 'credit-blocked.json'), 'utf8'))).toMatchObject({ version: 1 })
  })

  it('treats an empty root as process-local state', () => {
    const store = new CreditBlockStore('', HOUR, vi.fn())
    store.block('codex:a', Date.now())

    expect([...store.active()]).toEqual(['codex:a'])
  })

  it('ignores a record that is not valid JSON and entries of the wrong type, and says so', () => {
    const directory = root()
    const warn = vi.fn()
    writeFileSync(join(directory, 'credit-blocked.json'), '{not json')
    expect([...new CreditBlockStore(directory, HOUR, warn).active()]).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'))

    writeFileSync(join(directory, 'credit-blocked.json'), JSON.stringify({ blocked: [{ key: 1, blockedAt: 'x' }, { key: 'codex:a', blockedAt: Date.now() }] }))
    expect([...new CreditBlockStore(directory, HOUR, warn).active()]).toEqual(['codex:a'])

    writeFileSync(join(directory, 'credit-blocked.json'), JSON.stringify({}))
    expect([...new CreditBlockStore(directory, HOUR, warn).active()]).toEqual([])
  })

  it('reports an unreadable record and an unwritable directory without throwing', () => {
    const directory = root()
    const warn = vi.fn()
    const unreadable = join(directory, 'credit-blocked.json', 'nested')
    writeFileSync(join(directory, 'credit-blocked.json'), '{}')
    expect([...new CreditBlockStore(unreadable, HOUR, warn).active()]).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreadable'))

    const blocked = new CreditBlockStore(join(directory, 'credit-blocked.json'), HOUR, warn)
    blocked.block('codex:a', Date.now())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not saved'))
    expect([...blocked.active()]).toEqual(['codex:a'])
  })
})

describe('sessionCreditBlocked', () => {
  it('collects the operator and model of dispatches that ended with the code', () => {
    const events = [
      { type: 'physical-operator/dispatch', seq: 1, time: 1, data: { commandId: 'a', operatorId: 'claude-code', residentProfile: { model: 'fable' } } },
      { type: 'physical-operator/dispatch-terminal', seq: 2, time: 1, data: { commandId: 'a', code: 'MODEL_REQUIRES_CREDITS' } },
      { type: 'physical-operator/dispatch', seq: 3, time: 1, data: { commandId: 'b', operatorId: 'codex', residentProfile: { model: 'sol' } } },
      { type: 'physical-operator/dispatch-terminal', seq: 4, time: 1, data: { commandId: 'b', code: 'INVALID_RESULT' } },
      { type: 'physical-operator/dispatch-terminal', seq: 5, time: 1, data: { commandId: 'c', code: 'MODEL_REQUIRES_CREDITS' } },
      { type: 'physical-operator/dispatch', seq: 6, time: 1, data: { commandId: 'd', operatorId: 'codex' } },
      { type: 'physical-operator/dispatch-terminal', seq: 7, time: 1, data: { commandId: 'd', code: 'MODEL_REQUIRES_CREDITS' } },
    ] as unknown as Parameters<typeof sessionCreditBlocked>[0]

    expect([...sessionCreditBlocked(events, 'MODEL_REQUIRES_CREDITS')]).toEqual(['claude-code:fable'])
  })
})
