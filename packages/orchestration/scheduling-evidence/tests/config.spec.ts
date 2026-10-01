import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/index.ts'

const base = { python: 'python3', sourceRoot: '/src', stateRoot: '/state' }

describe('Config', () => {
  it('requires the interpreter and the source and state directories', () => {
    expect(Config(base)).toEqual(base)
    // The Loader hands the schema unchecked YAML, so the missing keys are deliberate.
    for (const missing of ['python', 'sourceRoot', 'stateRoot'] as const) {
      const { [missing]: _omitted, ...incomplete } = base
      expect(() => Config(incomplete as never)).toThrow()
    }
  })

  it('rejects limits outside their bounds', () => {
    expect(Config({ ...base, timeoutMs: 1, graceMs: 2_147_483_647, maxOutputBytes: 1_024 })).toMatchObject({ timeoutMs: 1 })
    expect(() => Config({ ...base, timeoutMs: 0 })).toThrow()
    expect(() => Config({ ...base, graceMs: 2_147_483_648 })).toThrow()
    expect(() => Config({ ...base, maxOutputBytes: 1_023 })).toThrow()
    expect(() => Config({ ...base, maxOutputBytes: 16 * 1_024 * 1_024 + 1 })).toThrow()
  })
})

describe('resolveConfig', () => {
  it('fills each omitted limit with its documented default', () => {
    expect(resolveConfig(base)).toEqual({ ...base, timeoutMs: 15_000, graceMs: 2_000, maxOutputBytes: 1_048_576 })
  })

  it('keeps explicit limits', () => {
    const explicit = { ...base, timeoutMs: 1, graceMs: 2, maxOutputBytes: 3_000 }
    expect(resolveConfig(explicit)).toEqual(explicit)
  })
})
