import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  assertStateRevision,
  ResidentOperatorCommandId,
  ResidentOperatorError,
  ResidentOperatorService,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
  type ResidentProviderStatus,
} from '../src/index.ts'

class MinimalResidentOperators extends ResidentOperatorService {
  providers() { return Promise.resolve([]) }
  execute(): Promise<never> { return Promise.reject(new Error('unused')) }
  list() { return Promise.resolve([]) }
  inspect(): Promise<never> { return Promise.reject(new Error('unused')) }
  inspectTurn(): Promise<never> { return Promise.reject(new Error('unused')) }
  readEvents() { return Promise.resolve({ events: [], nextSequence: 0 }) }
  interrupt() { return Promise.resolve() }
  reset(): Promise<never> { return Promise.reject(new Error('unused')) }
  resolveIndeterminate() { return Promise.resolve() }
}

describe('resident operator Service Definition', () => {
  it('rejects native CLI runtime management unless a Provider implements it', () => {
    const service = new MinimalResidentOperators(new Context())
    expect(() => service.cliRuntimes()).toThrow(ResidentOperatorError)
    expect(() => service.updateCli('codex')).toThrow('does not manage native CLI runtimes')
  })


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
