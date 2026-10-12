import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SchedulingEvidenceInvariant from '../src/invariant.ts'

describe('scheduling-evidence invariant companion', () => {
  it('registers its explained empty runtime invariant', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const fiber = await ctx.plugin(SchedulingEvidenceInvariant)

    expect(() => {
      ctx.invariants.register('@deepseek-ai/dsh-scheduling-evidence', () => {})
    }).toThrow(/already registered/)
    await fiber.dispose()
    await ctx.fiber.dispose()
  })
})
