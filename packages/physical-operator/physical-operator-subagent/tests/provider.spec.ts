import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import PhysicalOperatorRuntime from '@deepseek-ai/dsh-physical-operator'
import SubagentRuntime, {
  type ResolvedSubagentStartRequest,
  type SubagentAuthentication,
  type SubagentProvider,
  type SubagentResult,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import * as adapter from '../src/index.ts'

function fakeParent(): Agent {
  return { id: SessionId('parent') } as unknown as Agent
}

class StubSubagentProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
  readonly inheritsParentContext = false
  readonly authentication?: SubagentAuthentication
  lastRequest: ResolvedSubagentStartRequest | undefined
  disposed = 0

  constructor(
    private readonly outcome: Promise<SubagentResult> = Promise.resolve({
      output: [{ type: 'text', text: 'computed' }],
      stopReason: 'completed',
    }),
    options: { name?: string; authentication?: SubagentAuthentication } = {},
  ) {
    this.name = options.name ?? 'worker'
    if (options.authentication !== undefined) this.authentication = options.authentication
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.lastRequest = request
    return {
      id: SessionId('child'),
      localAgent: undefined,
      result: this.outcome,
      dispose: async () => { this.disposed += 1 },
    }
  }
}

const config: adapter.Config = {
  operators: [{
    id: 'physics-solver',
    provider: 'worker',
    displayName: 'Physics Solver',
    description: 'Solves one bounded physics task.',
    tags: ['physics', 'reasoning'],
    maxConcurrency: 1,
  }],
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(PhysicalOperatorRuntime)
  return ctx
}

describe('physical-operator subagent provider', () => {
  it('registers stable ids before the backing provider and tracks provider HMR live', async () => {
    const ctx = await setup()
    const plugin = await ctx.plugin(adapter, config)
    expect(ctx.physicalOperators.status('physics-solver')).toMatchObject({
      state: 'unavailable',
      unavailableReason: 'subagent provider "worker" is not registered',
    })

    const provider = new StubSubagentProvider()
    const removeProvider = ctx.subagents.registerProvider(provider)
    expect(ctx.physicalOperators.status('physics-solver')).toMatchObject({ state: 'available', active: 0 })
    removeProvider()
    expect(ctx.physicalOperators.status('physics-solver')).toMatchObject({ state: 'unavailable' })

    await plugin.dispose()
    expect(ctx.physicalOperators.list()).toEqual([])
  })

  it('forwards label, prompt, parent, and signal through the existing subagent seam', async () => {
    const ctx = await setup()
    const provider = new StubSubagentProvider()
    ctx.subagents.registerProvider(provider)
    await ctx.plugin(adapter, config)
    const controller = new AbortController()
    const parent = fakeParent()

    const run = await ctx.physicalOperators.start('physics-solver', {
      label: 'solve pendulum',
      prompt: [{ type: 'text', text: 'derive period' }],
      parent,
      signal: controller.signal,
    })
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'computed' }],
      stopReason: 'completed',
    })
    await run.dispose()

    expect(provider.lastRequest).toMatchObject({
      label: 'solve pendulum',
      prompt: [{ type: 'text', text: 'derive period' }],
      parent,
      signal: controller.signal,
    })
    expect(provider.disposed).toBe(1)
  })

  it('preserves accepted subagent execution across adapter disposal', async () => {
    const result = Promise.withResolvers<SubagentResult>()
    const ctx = await setup()
    const provider = new StubSubagentProvider(result.promise)
    ctx.subagents.registerProvider(provider)
    const plugin = await ctx.plugin(adapter, config)
    const run = await ctx.physicalOperators.start('physics-solver', {
      prompt: [{ type: 'text', text: 'work' }],
      parent: fakeParent(),
      signal: new AbortController().signal,
    })

    await plugin.dispose()
    expect(ctx.physicalOperators.list()).toEqual([])
    result.resolve({ output: [{ type: 'text', text: 'late result' }], stopReason: 'completed' })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose()
    expect(provider.disposed).toBe(1)
  })

  it('does not start a subagent while its backing provider is absent', async () => {
    const ctx = await setup()
    await ctx.plugin(adapter, config)
    await expect(ctx.physicalOperators.start('physics-solver', {
      prompt: [{ type: 'text', text: 'work' }],
      parent: fakeParent(),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'OPERATOR_UNAVAILABLE' })
  })

  it.each(['codex', 'claude-code'] as const)(
    'fails closed when the %s provider does not attest native subscription authentication',
    async (providerName) => {
      for (const authentication of [
        undefined,
        { mode: 'explicit-environment' as const },
      ]) {
        const ctx = await setup()
        ctx.subagents.registerProvider(new StubSubagentProvider(undefined, {
          name: providerName,
          ...authentication === undefined ? {} : { authentication },
        }))
        await ctx.plugin(adapter, {
          operators: [{ ...config.operators[0]!, provider: providerName }],
        })
        const status = ctx.physicalOperators.status('physics-solver')
        expect(status.state).toBe('unavailable')
        expect(status.unavailableReason).toContain('native-subscription')
        await expect(ctx.physicalOperators.start('physics-solver', {
          prompt: [{ type: 'text', text: 'work' }],
          parent: fakeParent(),
          signal: new AbortController().signal,
        })).rejects.toMatchObject({ code: 'OPERATOR_UNAVAILABLE' })
        await ctx.fiber.dispose()
      }
    },
  )

  it.each(['codex', 'claude-code'] as const)(
    'accepts the %s provider only with native subscription authentication',
    async (providerName) => {
      const ctx = await setup()
      ctx.subagents.registerProvider(new StubSubagentProvider(undefined, {
        name: providerName,
        authentication: { mode: 'native-subscription' },
      }))
      await ctx.plugin(adapter, {
        operators: [{ ...config.operators[0]!, provider: providerName }],
      })
      expect(ctx.physicalOperators.status('physics-solver')).toMatchObject({ state: 'available' })
      await ctx.fiber.dispose()
    },
  )

  it('validates direct configuration before registering any operator', async () => {
    const ctx = await setup()
    expect(() => { adapter.apply(ctx, { operators: [] }) }).toThrow('at least one mapping')
    expect(() => { adapter.apply(ctx, {
      operators: [
        { ...config.operators[0]!, id: 'same' },
        { ...config.operators[0]!, id: 'same' },
      ],
    }) }).toThrow('duplicate operator id')
    expect(() => { adapter.apply(ctx, {
      operators: [{ ...config.operators[0]!, maxConcurrency: 0 }],
    }) }).toThrow('positive safe integer')
    expect(ctx.physicalOperators.list()).toEqual([])
  })

  it('emits both physical-operator and subagent lifecycle pairs for one call', async () => {
    const ctx = await setup()
    ctx.subagents.registerProvider(new StubSubagentProvider())
    await ctx.plugin(adapter, config)
    const events: string[] = []
    ctx.on('physical-operator/start', () => { events.push('physical-start') })
    ctx.on('physical-operator/end', () => { events.push('physical-end') })
    ctx.on('subagent/start', () => { events.push('subagent-start') })
    ctx.on('subagent/end', () => { events.push('subagent-end') })

    const run = await ctx.physicalOperators.start('physics-solver', {
      prompt: [{ type: 'text', text: 'work' }],
      parent: fakeParent(),
      signal: new AbortController().signal,
    })
    await run.result
    expect(events).toHaveLength(4)
    expect(events.indexOf('subagent-start')).toBeLessThan(events.indexOf('subagent-end'))
    expect(events.indexOf('physical-start')).toBeLessThan(events.indexOf('physical-end'))
  })

  it('passes the caller cancellation signal unchanged', async () => {
    const ctx = await setup()
    const provider = new StubSubagentProvider()
    const start = vi.spyOn(provider, 'start')
    ctx.subagents.registerProvider(provider)
    await ctx.plugin(adapter, config)
    const controller = new AbortController()
    const run = await ctx.physicalOperators.start('physics-solver', {
      prompt: [{ type: 'text', text: 'work' }],
      parent: fakeParent(),
      signal: controller.signal,
    })
    await run.result
    expect(start.mock.calls[0]?.[0].signal).toBe(controller.signal)
  })
})
