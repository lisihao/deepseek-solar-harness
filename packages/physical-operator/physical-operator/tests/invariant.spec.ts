import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SessionId } from '@deepseek-ai/dsh-session'
import PhysicalOperatorRuntime, {
  PhysicalOperatorExecutionId,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorExecutionEndInfo,
  type PhysicalOperatorExecutionInfo,
} from '@deepseek-ai/dsh-physical-operator'
import * as PhysicalOperatorInvariant from '@deepseek-ai/dsh-physical-operator/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(PhysicalOperatorRuntime)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(PhysicalOperatorInvariant)
  return ctx
}

const operator = (id: string): PhysicalOperator => ({
  descriptor: {
    id: PhysicalOperatorId(id),
    displayName: 'Invariant Operator',
    description: 'Exercises invariant lifecycle checks.',
    tags: [],
    maxConcurrency: 1,
  },
  availability: () => ({ available: true }),
  start: async () => ({
    result: Promise.resolve({ output: [], stopReason: 'completed' }),
    dispose: async () => {},
  }),
})

const start = (executionId = 'run-1', operatorId = 'physics'): PhysicalOperatorExecutionInfo => ({
  executionId: PhysicalOperatorExecutionId(executionId),
  operatorId: PhysicalOperatorId(operatorId),
})

const end = (executionId = 'run-1', operatorId = 'physics'): PhysicalOperatorExecutionEndInfo => ({
  ...start(executionId, operatorId),
  stopReason: 'completed',
})

describe('physical-operator invariants', () => {
  it('accepts the service-owned registration and execution lifecycle', async () => {
    const ctx = await setup()
    const remove = ctx.physicalOperators.registerOperator(operator('physics'))
    const run = await ctx.physicalOperators.start('physics', {
      prompt: [{ type: 'text', text: 'solve' }],
      parent: { id: SessionId('parent') } as unknown as Agent,
      signal: new AbortController().signal,
    })
    await run.result
    await remove()
  })

  it('rejects duplicate, unknown, and divergent lifecycle edges', async () => {
    const ctx = await setup()
    ctx.emit('physical-operator/added', operator('physics'))
    expect(() => { ctx.emit('physical-operator/added', operator('physics')) }).toThrow(/repeated "physics"/)
    expect(() => { ctx.emit('physical-operator/removed', PhysicalOperatorId('missing')) }).toThrow(/unknown operator/)

    ctx.emit('physical-operator/start', start())
    expect(() => { ctx.emit('physical-operator/start', start()) }).toThrow(/repeated execution id/)
    expect(() => { ctx.emit('physical-operator/end', end('missing')) }).toThrow(/no matching start/)
    expect(() => { ctx.emit('physical-operator/end', end('run-1', 'other')) }).toThrow(/operator diverges/)
  })
})
