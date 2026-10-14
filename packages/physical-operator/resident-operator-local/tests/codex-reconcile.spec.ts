/** A Codex start with no authoritative response: the Session is held until the native turn settles, then fenced as unknown. */
import { describe, expect, it, vi } from 'vitest'
import { ResidentOperatorError } from '@deepseek-ai/dsh-resident-operator'
import { reconcileUncertainStart, type CodexTurnProbe } from '../src/codex-reconcile.ts'

type Turn = { id: string; status: string } | undefined

/** A probe that answers each read from a script, then repeats the last answer. */
function probe(script: Array<Turn | Error>) {
  const reads: Array<Turn | Error> = [...script]
  const latestTurn = vi.fn(async () => {
    const next = reads.length > 1 ? reads.shift() : reads[0]
    if (next instanceof Error) throw next
    return next
  })
  const interruptTurn = vi.fn()
  return { latestTurn, interruptTurn } satisfies CodexTurnProbe
}

const sleep = vi.fn(async () => {})
const timing = { pollMs: 1_000, settleMs: 3_000, maxMs: 10_000, sleep }

async function outcome(run: Promise<never>): Promise<ResidentOperatorError> {
  const error = await run.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ResidentOperatorError)
  return error as ResidentOperatorError
}

describe('reconcileUncertainStart', () => {
  it('waits for the native turn the start created to settle, then reports the outcome as unknown', async () => {
    const turns = probe([{ id: 'turn-new', status: 'inProgress' }, { id: 'turn-new', status: 'inProgress' }, { id: 'turn-new', status: 'completed' }])
    const error = await outcome(reconcileUncertainStart(turns, 'turn-old', 'frames: #1', new AbortController().signal, timing))
    expect(error.code).toBe('COMMAND_INDETERMINATE')
    expect(error.message).toContain('native turn turn-new ended with status completed')
    expect(error.message).toContain('its output was not captured')
    expect(error.message).toContain('frames: #1')
    // Two reads saw it running before the third saw it settled, so the Session stayed held through two waits.
    expect(turns.latestTurn).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(turns.interruptTurn).not.toHaveBeenCalled()
  })

  it('reports that no new turn appeared only after the settle time, and never treats that as not started', async () => {
    sleep.mockClear()
    const turns = probe([{ id: 'turn-old', status: 'completed' }])
    const error = await outcome(reconcileUncertainStart(turns, 'turn-old', 'd', new AbortController().signal, timing))
    expect(error.message).toContain('no new native turn was observed')
    expect(error.code).toBe('COMMAND_INDETERMINATE')
    expect(turns.latestTurn).toHaveBeenCalledTimes(4)
    expect(sleep).toHaveBeenCalledTimes(3)
  })

  it('catches a start that lands late, within the settle time', async () => {
    const turns = probe([{ id: 'turn-old', status: 'completed' }, { id: 'turn-late', status: 'inProgress' }, { id: 'turn-late', status: 'interrupted' }])
    const error = await outcome(reconcileUncertainStart(turns, 'turn-old', 'd', new AbortController().signal, timing))
    expect(error.message).toContain('native turn turn-late ended with status interrupted')
  })

  it('treats a thread with no turn like one without a new turn', async () => {
    const error = await outcome(reconcileUncertainStart(probe([undefined]), undefined, 'd', new AbortController().signal, timing))
    expect(error.message).toContain('no new native turn was observed')
  })

  it('without a baseline, waits only for a turn that is running, and leaves a settled turn as not observed', async () => {
    const settled = await outcome(reconcileUncertainStart(probe([{ id: 'turn-any', status: 'completed' }]), undefined, 'd', new AbortController().signal, timing))
    expect(settled.message).toContain('no new native turn was observed')
    const running = await outcome(reconcileUncertainStart(
      probe([{ id: 'turn-any', status: 'inProgress' }, { id: 'turn-any', status: 'failed' }]), undefined, 'd', new AbortController().signal, timing,
    ))
    expect(running.message).toContain('native turn turn-any ended with status failed')
  })

  it('interrupts the native turn once when the Resident turn is interrupted, and still waits for it to settle', async () => {
    const turns = probe([{ id: 'turn-new', status: 'inProgress' }, { id: 'turn-new', status: 'inProgress' }, { id: 'turn-new', status: 'interrupted' }])
    const controller = new AbortController()
    controller.abort(new Error('resident turn interrupted'))
    const error = await outcome(reconcileUncertainStart(turns, 'turn-old', 'd', controller.signal, timing))
    expect(turns.interruptTurn).toHaveBeenCalledOnce()
    expect(turns.interruptTurn).toHaveBeenCalledWith('turn-new')
    expect(error.message).toContain('ended with status interrupted')
  })

  it('stops waiting after the longest wait and says the turn was still running', async () => {
    const error = await outcome(reconcileUncertainStart(
      probe([{ id: 'turn-new', status: 'inProgress' }]), 'turn-old', 'd', new AbortController().signal, { ...timing, maxMs: 3_000 },
    ))
    expect(error.message).toContain('native turn turn-new was still running when the wait ended')
  })

  it('reports an unreadable thread as unknown without claiming the turn did not start', async () => {
    const error = await outcome(reconcileUncertainStart(probe([new Error('stream closed')]), 'turn-old', 'frames: #2', new AbortController().signal, timing))
    expect(error.code).toBe('COMMAND_INDETERMINATE')
    expect(error.message).toContain('could not be read (stream closed)')
    expect(error.message).toContain('frames: #2')
    const text = await outcome(reconcileUncertainStart(probe([Object.assign(new Error('x'), { message: 'plain' })]), 'a', 'd', new AbortController().signal, timing))
    expect(text.message).toContain('plain')
  })

  it('waits with the real timer when none is given', async () => {
    const error = await outcome(reconcileUncertainStart(
      probe([{ id: 'turn-new', status: 'completed' }]), 'turn-old', 'd', new AbortController().signal, { pollMs: 1, settleMs: 1, maxMs: 5 },
    ))
    expect(error.message).toContain('ended with status completed')
    const waited = await outcome(reconcileUncertainStart(
      probe([{ id: 'turn-old', status: 'completed' }]), 'turn-old', 'd', new AbortController().signal, { pollMs: 1, settleMs: 2, maxMs: 5 },
    ))
    expect(waited.message).toContain('no new native turn was observed')
  })
})
