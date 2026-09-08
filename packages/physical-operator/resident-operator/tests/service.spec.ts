import { describe, expect, it } from 'vitest'
import {
  assertStateRevision,
  ResidentOperatorCommandId,
  ResidentOperatorError,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
  type ResidentProviderStatus,
} from '../src/index.ts'

describe('resident operator Service Definition', () => {
  it('preserves opaque daemon identities', () => {
    expect(ResidentOperatorSessionId('session-1')).toBe('session-1')
    expect(ResidentOperatorTurnId('turn-1')).toBe('turn-1')
    expect(ResidentOperatorCommandId('command-1')).toBe('command-1')
  })

  it('permits an unavailable provider to preserve its native qualification code', () => {
    const status = {
      operatorId: 'claude-code',
      product: 'claude-code',
      displayName: 'Claude Code',
      description: 'Test provider.',
      tags: ['subscription'],
      maxConcurrency: 1,
      injectionBoundaries: ['pre-dispatch'],
      available: false,
      unavailableReason: 'Claude Code model catalog timed out',
      unavailableCode: 'RUNTIME_UNAVAILABLE',
      authentication: 'unqualified',
      productVersion: 'unavailable',
      protocolHash: 'unavailable',
      models: [],
    } satisfies ResidentProviderStatus
    expect(status.unavailableCode).toBe('RUNTIME_UNAVAILABLE')
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
