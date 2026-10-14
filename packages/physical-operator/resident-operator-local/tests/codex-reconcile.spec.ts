/**
 * A Codex start the run could not take a turn from. A turn the response named is waited for by id; a turn that is only
 * inferred from the thread is never interrupted, never taken as settled, and keeps the Session closed to new commands.
 */
import { describe, expect, it, vi } from 'vitest'
import { ResidentOperatorError } from '@deepseek-ai/dsh-resident-operator'
import { reconcileUncertainStart, type CodexTurnProbe } from '../src/codex-reconcile.ts'

type Turn = { id: string; status: string } | undefined

/** A probe that answers each read from a script, then repeats the last answer. */
function probe(script: Array<Turn | Error>, statuses: Array<string | undefined | Error> = []) {
  const reads: Array<Turn | Error> = [...script]
  const states: Array<string | undefined | Error> = [...statuses]
  const latestTurn = vi.fn(async () => {
    const next = reads.length > 1 ? reads.shift() : reads[0]
    if (next instanceof Error) throw next
    return next
  })
  const turnStatus = vi.fn(async () => {
    const next = states.length > 1 ? states.shift() : states[0]
    if (next instanceof Error) throw next
    return next
  })
  const interruptTurn = vi.fn()
  return { latestTurn, turnStatus, interruptTurn } satisfies CodexTurnProbe
}

const sleep = vi.fn(async () => {})
const timing = { pollMs: 1_000, settleMs: 3_000, maxMs: 10_000, sleep }
const live = () => new AbortController().signal

async function outcome(run: Promise<never>): Promise<ResidentOperatorError> {
  const error = await run.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ResidentOperatorError)
  expect((error as ResidentOperatorError).code).toBe('COMMAND_INDETERMINATE')
  return error as ResidentOperatorError
}

describe('a start whose response named the turn', () => {
  it('waits for that turn by id, and its end proves the execution stopped, so the Session is released', async () => {
    const turns = probe([], ['inProgress', 'inProgress', 'completed'])
    const error = await outcome(reconcileUncertainStart(turns, { startedTurnId: 'turn-known' }, 'frames: #1', live(), timing))
    expect(error.nativeOutcomeUnconfirmed).toBe(false)
    expect(error.message).toContain('Codex turn turn-known ended with status completed')
    expect(error.message).toContain('frames: #1')
    expect(turns.turnStatus).toHaveBeenCalledTimes(3)
    expect(turns.latestTurn).not.toHaveBeenCalled()
  })

  it.each(['completed', 'interrupted', 'failed'])('releases the Session when the named turn ends as %s', async (status) => {
    const error = await outcome(reconcileUncertainStart(probe([], [status]), { startedTurnId: 'turn-known' }, 'd', live(), timing))
    expect(error.nativeOutcomeUnconfirmed).toBe(false)
  })

  it.each(['aborted', 'cancelled', 'in_progress', '', 'COMPLETED'])('does not take the unrecognised status %j as proof that the turn ended', async (status) => {
    const turns = probe([], [status])
    const error = await outcome(reconcileUncertainStart(turns, { startedTurnId: 'turn-known' }, 'd', live(), timing))
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
    expect(turns.turnStatus.mock.calls.length).toBeGreaterThan(1)
  })

  it('still interrupts the named turn once when it reports an unrecognised status', async () => {
    const turns = probe([], ['aborted'])
    const controller = new AbortController()
    controller.abort(new Error('resident turn interrupted'))
    const error = await outcome(reconcileUncertainStart(turns, { startedTurnId: 'turn-known' }, 'd', controller.signal, timing))
    expect(turns.interruptTurn).toHaveBeenCalledOnce()
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
  })

  it('names the pinned turn when the Resident turn is interrupted while it runs, and interrupts nothing', async () => {
    const turns = probe([{ id: 'turn-new', status: 'inProgress' }])
    const controller = new AbortController()
    controller.abort(new Error('resident turn interrupted'))
    const error = await outcome(reconcileUncertainStart(turns, { baselineTurnId: 'turn-old' }, 'd', controller.signal, timing))
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
    expect(error.message).toContain('native turn turn-new was still running')
    expect(turns.interruptTurn).not.toHaveBeenCalled()
  })

  it('reports an unnamed turn when the longest wait ends before the settle time and nothing was pinned', async () => {
    const error = await outcome(reconcileUncertainStart(probe([undefined]), {}, 'd', live(), { ...timing, settleMs: 20_000, maxMs: 2_000 }))
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
    expect(error.message).toContain('native turn unknown was still running when the wait ended')
  })

  it('does not take an inferred turn with an unrecognised status as ended', async () => {
    const turns = probe([{ id: 'turn-new', status: 'aborted' }])
    const error = await outcome(reconcileUncertainStart(turns, { baselineTurnId: 'turn-old' }, 'd', live(), timing))
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
    expect(error.message).toContain('turn-new was still running when the wait ended')
    expect(error.message).not.toContain('ended with status')
  })

  it('interrupts that turn once when the Resident turn is interrupted, and still waits for it to end', async () => {
    const turns = probe([], ['inProgress', 'inProgress', 'interrupted'])
    const controller = new AbortController()
    controller.abort(new Error('resident turn interrupted'))
    const error = await outcome(reconcileUncertainStart(turns, { startedTurnId: 'turn-known' }, 'd', controller.signal, timing))
    expect(turns.interruptTurn).toHaveBeenCalledOnce()
    expect(turns.interruptTurn).toHaveBeenCalledWith('turn-known')
    expect(error.message).toContain('ended with status interrupted')
    expect(error.nativeOutcomeUnconfirmed).toBe(false)
  })

  it('keeps the Session closed when the turn is still running or not listed when the wait ends', async () => {
    const running = await outcome(reconcileUncertainStart(probe([], ['inProgress']), { startedTurnId: 'turn-known' }, 'd', live(), { ...timing, maxMs: 3_000 }))
    expect(running.nativeOutcomeUnconfirmed).toBe(true)
    expect(running.message).toContain('turn-known was still running when the wait ended')
    const unlisted = await outcome(reconcileUncertainStart(probe([], [undefined]), { startedTurnId: 'turn-known' }, 'd', live(), { ...timing, maxMs: 2_000 }))
    expect(unlisted.nativeOutcomeUnconfirmed).toBe(true)
    expect(unlisted.message).toContain('turn-known was not listed when the wait ended')
  })

  it('keeps the Session closed when the thread cannot be read', async () => {
    const error = await outcome(reconcileUncertainStart(probe([], [new Error('stream closed')]), { startedTurnId: 'turn-known' }, 'frames: #2', live(), timing))
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
    expect(error.message).toContain('could not be read (stream closed)')
    expect(error.message).toContain('frames: #2')
  })
})

describe('a start whose turn can only be inferred', () => {
  it('never settles the original turn from another turn: A running, then B running, then B completed is ambiguous and interrupts nothing', async () => {
    const turns = probe([
      { id: 'turn-a', status: 'inProgress' }, { id: 'turn-b', status: 'inProgress' }, { id: 'turn-b', status: 'completed' },
    ])
    const error = await outcome(reconcileUncertainStart(turns, { baselineTurnId: 'turn-old' }, 'd', live(), timing))
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
    expect(error.message).toContain('two different native turns appeared after it (turn-a, then turn-b)')
    expect(error.message).not.toContain('ended with status')
    expect(turns.interruptTurn).not.toHaveBeenCalled()
    // It stopped reading at the second turn: the third read, B completing, was never made.
    expect(turns.latestTurn).toHaveBeenCalledTimes(2)
  })

  it('does not interrupt a turn that is only inferred, even when the Resident turn is interrupted', async () => {
    const turns = probe([{ id: 'turn-a', status: 'inProgress' }])
    const controller = new AbortController()
    controller.abort(new Error('resident turn interrupted'))
    const error = await outcome(reconcileUncertainStart(turns, { baselineTurnId: 'turn-old' }, 'd', controller.signal, timing))
    expect(turns.interruptTurn).not.toHaveBeenCalled()
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
    expect(error.message).toContain('no native turn was interrupted')
    expect(error.message).toContain('turn-a was still running')
  })

  it('reports an inferred turn that ended as unproven, and keeps the Session closed', async () => {
    const turns = probe([{ id: 'turn-a', status: 'inProgress' }, { id: 'turn-a', status: 'completed' }])
    const error = await outcome(reconcileUncertainStart(turns, { baselineTurnId: 'turn-old' }, 'd', live(), timing))
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
    expect(error.message).toContain('native turn turn-a appeared after it and ended with status completed')
    expect(error.message).toContain('nothing proves it is this command\'s turn')
  })

  it('reports no new turn only after the settle time, and never as not started', async () => {
    sleep.mockClear()
    const turns = probe([{ id: 'turn-old', status: 'completed' }])
    const error = await outcome(reconcileUncertainStart(turns, { baselineTurnId: 'turn-old' }, 'd', live(), timing))
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
    expect(error.message).toContain('no new native turn was observed, though the start may still land')
    expect(turns.latestTurn).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('pins a start that lands late, and a thread with no turn is the same as no new turn', async () => {
    const late = await outcome(reconcileUncertainStart(
      probe([{ id: 'turn-old', status: 'completed' }, { id: 'turn-late', status: 'inProgress' }, { id: 'turn-late', status: 'interrupted' }]),
      { baselineTurnId: 'turn-old' }, 'd', live(), timing,
    ))
    expect(late.message).toContain('turn-late appeared after it and ended with status interrupted')
    const empty = await outcome(reconcileUncertainStart(probe([undefined]), {}, 'd', live(), timing))
    expect(empty.message).toContain('no new native turn was observed')
  })

  it('without a baseline, only a running turn is taken up, and a settled newest turn is not', async () => {
    const settled = await outcome(reconcileUncertainStart(probe([{ id: 'turn-any', status: 'completed' }]), {}, 'd', live(), timing))
    expect(settled.message).toContain('no new native turn was observed')
    const running = await outcome(reconcileUncertainStart(probe([{ id: 'turn-any', status: 'inProgress' }, { id: 'turn-any', status: 'failed' }]), {}, 'd', live(), timing))
    expect(running.message).toContain('turn-any appeared after it and ended with status failed')
  })

  it('stops after the longest wait with the turn still running, and keeps the Session closed', async () => {
    const error = await outcome(reconcileUncertainStart(probe([{ id: 'turn-a', status: 'inProgress' }]), { baselineTurnId: 'turn-old' }, 'd', live(), { ...timing, maxMs: 3_000 }))
    expect(error.nativeOutcomeUnconfirmed).toBe(true)
    expect(error.message).toContain('turn-a was still running when the wait ended')
  })

  it('keeps the Session closed when the thread cannot be read, and uses the real timer when none is given', async () => {
    const unreadable = await outcome(reconcileUncertainStart(probe([new Error('stream closed')]), { baselineTurnId: 'turn-old' }, 'frames: #2', live(), timing))
    expect(unreadable.nativeOutcomeUnconfirmed).toBe(true)
    expect(unreadable.message).toContain('could not be read (stream closed)')
    const plain: CodexTurnProbe = { ...probe([]), latestTurn: () => Promise.reject('boom') } // eslint-disable-line prefer-promise-reject-errors
    const text = await outcome(reconcileUncertainStart(plain, { baselineTurnId: 'a' }, 'd', live(), timing))
    expect(text.message).toContain('could not be read (boom)')
    const real = await outcome(reconcileUncertainStart(probe([{ id: 'turn-old', status: 'completed' }]), { baselineTurnId: 'turn-old' }, 'd', live(), { pollMs: 1, settleMs: 2, maxMs: 5 }))
    expect(real.message).toContain('no new native turn was observed')
    const realKnown = await outcome(reconcileUncertainStart(probe([], ['completed']), { startedTurnId: 'turn-k' }, 'd', live(), { pollMs: 1, settleMs: 2, maxMs: 5 }))
    expect(realKnown.nativeOutcomeUnconfirmed).toBe(false)
    const realWait = await outcome(reconcileUncertainStart(probe([], ['inProgress']), { startedTurnId: 'turn-k' }, 'd', live(), { pollMs: 1, settleMs: 2, maxMs: 3 }))
    expect(realWait.nativeOutcomeUnconfirmed).toBe(true)
  })
})
