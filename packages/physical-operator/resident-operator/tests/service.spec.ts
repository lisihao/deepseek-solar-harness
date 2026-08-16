import { describe, expect, it } from 'vitest'
import {
  assertStateRevision,
  ResidentOperatorCommandId,
  ResidentOperatorError,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
} from '../src/index.ts'

describe('resident operator Service Definition', () => {
  it('preserves opaque daemon identities', () => {
    expect(ResidentOperatorSessionId('session-1')).toBe('session-1')
    expect(ResidentOperatorTurnId('turn-1')).toBe('turn-1')
    expect(ResidentOperatorCommandId('command-1')).toBe('command-1')
  })

  it.each([0, 1, Number.MAX_SAFE_INTEGER])('accepts safe state revision %s', (revision) => {
    expect(() => { assertStateRevision(revision) }).not.toThrow()
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid state revision %s with a stable code',
    (revision) => {
      expect(() => { assertStateRevision(revision) }).toThrow(expect.objectContaining<Partial<ResidentOperatorError>>({
        name: 'ResidentOperatorError',
        code: 'REVISION_CONFLICT',
      }))
    },
  )
})
