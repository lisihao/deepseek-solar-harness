import { describe, expect, it } from 'vitest'
import { OrchestrationError, StandaloneRlmStartRejected } from '@deepseek-ai/dsh-orchestration'
import { unwrapWire, wireFailure } from '../src/protocol.ts'

describe('standalone command refusal evidence', () => {
  it('preserves an explicit daemon admission refusal across the wire', () => {
    const wire = wireFailure(new StandaloneRlmStartRejected('different input', 'COMMAND_CONFLICT'))
    expect(wire).toMatchObject({ error: { standaloneStartRejected: true, code: 'COMMAND_CONFLICT' } })
    expect(() => unwrapWire(JSON.parse(JSON.stringify(wire)))).toThrow(StandaloneRlmStartRejected)
  })

  it('never infers no admission from an ordinary error with the same code', () => {
    const wire = wireFailure(new OrchestrationError('outcome unknown', 'COMMAND_CONFLICT'))
    expect(wire.error.standaloneStartRejected).toBeUndefined()
    try {
      unwrapWire(wire)
      throw new Error('expected a failure')
    } catch (error) {
      expect(error).toBeInstanceOf(OrchestrationError)
      expect(error).not.toBeInstanceOf(StandaloneRlmStartRejected)
    }
  })

  it.each([null, [], { code: 1, message: 'bad' }, { code: 'COMMAND_CONFLICT', message: 'bad', standaloneStartRejected: 'true' }])(
    'rejects malformed refusal fields without creating non-admission proof: %j', (error) => {
      expect(() => unwrapWire({ ok: false, error })).toThrow(OrchestrationError)
      expect(() => unwrapWire({ ok: false, error })).not.toThrow(StandaloneRlmStartRejected)
    },
  )
})
