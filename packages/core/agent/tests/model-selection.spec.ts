import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  agentEvents,
  installModelSelection,
  readModelSelection,
  type Agent,
  type ModelSelectionRef,
} from '../src/index.ts'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'

describe('installModelSelection()', () => {
  it('snapshots prompt variables and request routing together, then disposes both listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const dispose = installModelSelection(ctx, selection)
    const agent = {} as Agent
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    selection.current = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'alpha', model: 'a1' })
    selection.current = { provider: 'beta', model: 'b1' }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.2,
    })

    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'beta', model: 'b1' })
    const inherited: LlmCallConfig = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('max'),
      temperature: 0.2,
    }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({ provider: 'beta', model: 'b1', temperature: 0.2 })

    dispose()
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })

  it('exposes only the captured selection and does not leak a later current value', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const agent = {
      ctx,
      options: { provider: 'fallback', model: 'fallback' },
    } as Agent
    const selection: ModelSelectionRef = {
      current: { provider: 'alpha', model: 'a1' },
      assembled: undefined,
    }

    expect(readModelSelection(agent)).toEqual({
      installed: false,
      selection: { provider: 'fallback', model: 'fallback' },
    })

    const dispose = installModelSelection(ctx, selection)
    expect(readModelSelection(agent)).toEqual({ installed: true, selection: undefined })

    let seenDuringAssembly: ReturnType<typeof readModelSelection> | undefined
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      seenDuringAssembly = readModelSelection(agent)
      selection.current = { provider: 'beta', model: 'b1' }
      return next()
    })

    await ctx.systemPrompt.assemble()

    expect(seenDuringAssembly).toEqual({ installed: true, selection: undefined })
    expect(readModelSelection(agent)).toEqual({
      installed: true,
      selection: { provider: 'alpha', model: 'a1' },
    })

    selection.current = undefined
    await ctx.systemPrompt.assemble()
    selection.current = { provider: 'gamma', model: 'g1' }
    expect(readModelSelection(agent)).toEqual({ installed: true, selection: undefined })

    dispose()
    expect(readModelSelection(agent)).toEqual({
      installed: false,
      selection: { provider: 'fallback', model: 'fallback' },
    })
    await ctx.fiber.dispose()
  })

  it('keeps a replacement lookup when an older installer disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const agent = {
      ctx,
      options: { provider: 'fallback', model: 'fallback' },
    } as Agent
    const first: ModelSelectionRef = {
      current: { provider: 'first', model: 'f1' },
      assembled: undefined,
    }
    const second: ModelSelectionRef = {
      current: { provider: 'second', model: 's1' },
      assembled: undefined,
    }
    const disposeFirst = installModelSelection(ctx, first)
    const disposeSecond = installModelSelection(ctx, second)

    await ctx.systemPrompt.assemble()
    expect(readModelSelection(agent)).toEqual({
      installed: true,
      selection: { provider: 'second', model: 's1' },
    })

    disposeFirst()
    expect(readModelSelection(agent)).toEqual({
      installed: true,
      selection: { provider: 'second', model: 's1' },
    })
    disposeSecond()
    await ctx.fiber.dispose()
  })

  it('removes an installed lookup when its Agent scope disposes', async () => {
    const ctx = new Context()
    const agent = {
      ctx,
      options: { provider: 'fallback', model: 'fallback' },
    } as Agent
    installModelSelection(ctx, {
      current: { provider: 'alpha', model: 'a1' },
      assembled: undefined,
    })

    await ctx.fiber.dispose()

    expect(readModelSelection(agent)).toEqual({
      installed: false,
      selection: { provider: 'fallback', model: 'fallback' },
    })
  })

  it('uses Agent options only when both fallback fields exist', async () => {
    const ctx = new Context()
    expect(readModelSelection({ ctx, options: { provider: 'fallback' } } as Agent)).toEqual({
      installed: false,
      selection: undefined,
    })
    expect(readModelSelection({ ctx, options: { model: 'fallback' } } as Agent)).toEqual({
      installed: false,
      selection: undefined,
    })
    await ctx.fiber.dispose()
  })
})
