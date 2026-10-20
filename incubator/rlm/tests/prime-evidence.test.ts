import { describe, expect, it } from 'vitest'

import { PrimeEvidence, type PrimeEvidenceMeta } from '../src/prime-evidence.js'

function frame(eventSequence: number, promptTurnId: number, phase: string, extra: PrimeEvidenceMeta = {}): PrimeEvidenceMeta {
  return { eventSequence, promptTurnId, phase, ...extra }
}

function settledEvidence(): PrimeEvidence {
  const evidence = new PrimeEvidence()
  evidence.beginTurn()
  evidence.observe(frame(1, 1, 'responseBoundary', { outcome: 'result', terminalQuiescenceExpected: true, nativeBoundary: { source: 'prime' } }))
  evidence.observe(frame(2, 1, 'terminalQuiescence', {
    outcome: 'result',
    quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 0, nativeCounter: 0 },
    nativeTerminal: { source: 'prime' },
  }))
  return evidence
}

describe('PrimeEvidence', () => {
  it('does not treat end_turn or a turn-0 session event as completion evidence', () => {
    const evidence = new PrimeEvidence()
    evidence.observe(frame(1, 0, 'event', { sessionOnly: true }))
    evidence.beginTurn()

    expect(() => evidence.assertSettled('end_turn')).toThrow('RLM_EFFECT_INDETERMINATE')
    expect(evidence.boundary).toBeUndefined()
    expect(evidence.terminal).toBeUndefined()
  })

  it('keeps stale ordinary events out of completion and rejects a stale terminal frame causally', () => {
    const evidence = settledEvidence()
    evidence.beginTurn()
    evidence.observe(frame(3, 1, 'event', { late: true, nativePayload: { preserved: true } }))
    expect(evidence.boundary).toBeUndefined()
    expect(evidence.terminal).toBeUndefined()
    expect(() => evidence.observe(frame(4, 1, 'terminalQuiescence', {
      outcome: 'result',
      quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 0 },
    }))).toThrow('RLM_NATIVE_ERROR')
    expect(() => evidence.assertSettled('end_turn')).toThrow('RLM_EFFECT_INDETERMINATE')
  })

  it('requires one strictly increasing positive connection sequence', () => {
    const evidence = new PrimeEvidence()
    evidence.beginTurn()
    evidence.observe(frame(2, 1, 'event'))

    expect(() => evidence.observe(frame(2, 1, 'event'))).toThrow('RLM_NATIVE_ERROR')
    expect(() => evidence.observe(frame(1, 1, 'event'))).toThrow('RLM_NATIVE_ERROR')
    expect(() => evidence.observe(frame(3, 1, 'event'))).not.toThrow()
  })

  it('rejects a future prompt and non-event frames from another prompt', () => {
    const evidence = new PrimeEvidence()
    expect(() => evidence.observe(frame(1, 0, 'terminalQuiescence', {
      outcome: 'result',
      quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 0 },
    }))).toThrow('RLM_NATIVE_ERROR')
    evidence.beginTurn()

    expect(() => evidence.observe(frame(1, 2, 'event'))).toThrow('RLM_NATIVE_ERROR')
    expect(() => evidence.observe(frame(1, 0, 'responseBoundary', { outcome: 'result' }))).toThrow('RLM_NATIVE_ERROR')
  })

  it('rejects malformed causal fields and reports incomplete quiescence at settlement', () => {
    const cases: PrimeEvidenceMeta[] = [
      frame(1, 1, 'unknown'),
      frame(1, -1, 'event'),
      frame(1, 1, 'responseBoundary'),
      frame(1, 1, 'responseBoundary', { outcome: 'unknown' }),
    ]
    for (const value of cases) {
      const evidence = new PrimeEvidence()
      evidence.beginTurn()
      expect(() => evidence.observe(value)).toThrow('RLM_NATIVE_ERROR')
    }

    const incomplete = new PrimeEvidence()
    incomplete.beginTurn()
    incomplete.observe(frame(1, 1, 'responseBoundary', { outcome: 'result' }))
    incomplete.observe(frame(2, 1, 'terminalQuiescence', {
      outcome: 'result',
      quiescence: { outstandingSubagents: -1, remainingAutonomousContinuations: 0 },
    }))
    expect(() => incomplete.assertSettled('end_turn')).toThrow('RLM_EFFECT_INDETERMINATE')
  })

  it('does not settle while children or autonomous continuations remain', () => {
    const evidence = new PrimeEvidence()
    evidence.beginTurn()
    evidence.observe(frame(1, 1, 'responseBoundary', { outcome: 'result' }))
    evidence.observe(frame(2, 1, 'terminalQuiescence', {
      outcome: 'result',
      quiescence: { outstandingSubagents: 1, remainingAutonomousContinuations: 0 },
    }))
    expect(() => evidence.assertSettled('end_turn')).toThrow('RLM_EFFECT_INDETERMINATE')

    const continuation = new PrimeEvidence()
    continuation.beginTurn()
    continuation.observe(frame(1, 1, 'responseBoundary', { outcome: 'result' }))
    continuation.observe(frame(2, 1, 'terminalQuiescence', {
      outcome: 'result',
      quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 1 },
    }))
    expect(() => continuation.assertSettled('end_turn')).toThrow('RLM_EFFECT_INDETERMINATE')
  })

  it('accepts a complete current boundary and terminal and preserves native fields', () => {
    const evidence = settledEvidence()

    expect(evidence.boundary).toEqual(expect.objectContaining({ nativeBoundary: { source: 'prime' } }))
    expect(evidence.terminal).toEqual(expect.objectContaining({ nativeTerminal: { source: 'prime' } }))
    expect(evidence.terminal?.quiescence).toEqual({
      outstandingSubagents: 0,
      remainingAutonomousContinuations: 0,
      nativeCounter: 0,
    })
    expect(() => evidence.assertSettled('end_turn')).not.toThrow()
    expect(() => evidence.observe(frame(3, 1, 'event', { afterTerminal: true }))).toThrow('RLM_NATIVE_ERROR')
  })

  it('rejects a settled turn with a non-end_turn stop reason as a native limit', () => {
    const evidence = settledEvidence()
    expect(() => evidence.assertSettled('max_tokens')).toThrow('RLM_NATIVE_LIMIT')
  })

  it('reports a Prime boundary error as a native error', () => {
    const evidence = new PrimeEvidence()
    evidence.beginTurn()
    evidence.observe(frame(1, 1, 'responseBoundary', { outcome: 'error', nativeError: { code: 'provider' } }))
    expect(() => evidence.assertSettled('end_turn')).toThrow('RLM_NATIVE_ERROR')
  })

  it('clears current evidence and advances the expected prompt on the next turn', () => {
    const evidence = settledEvidence()
    evidence.beginTurn()
    expect(evidence.boundary).toBeUndefined()
    expect(evidence.terminal).toBeUndefined()
    expect(() => evidence.assertSettled('end_turn')).toThrow('RLM_EFFECT_INDETERMINATE')

    evidence.observe(frame(3, 2, 'responseBoundary', { outcome: 'result', turn: 2 }))
    evidence.observe(frame(4, 2, 'terminalQuiescence', {
      outcome: 'result',
      quiescence: { outstandingSubagents: 0, remainingAutonomousContinuations: 0 },
      turn: 2,
    }))
    expect(() => evidence.assertSettled('end_turn')).not.toThrow()
  })
})
