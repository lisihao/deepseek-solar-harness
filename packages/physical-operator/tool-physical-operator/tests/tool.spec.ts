import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import PhysicalOperatorRuntime, {
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorResult,
  type PhysicalOperatorStartRequest,
} from '@deepseek-ai/dsh-physical-operator'
import * as tool from '../src/index.ts'

function fakeAgent(): Agent {
  return { id: SessionId('parent') } as unknown as Agent
}

class ScriptedOperator implements PhysicalOperator {
  readonly descriptor = {
    id: PhysicalOperatorId('physics-solver'),
    displayName: 'Physics Solver',
    description: 'Solves bounded physics problems.',
    tags: ['physics', 'reasoning'],
    maxConcurrency: 1,
  }
  lastRequest: PhysicalOperatorStartRequest | undefined
  disposed = 0

  constructor(
    private readonly outcome: Promise<PhysicalOperatorResult> = Promise.resolve({
      output: [{ type: 'text', text: 'answer 42' }],
      stopReason: 'completed',
    }),
    private readonly disposal: Promise<void> = Promise.resolve(),
  ) {}

  availability() {
    return { available: true as const }
  }

  async start(request: PhysicalOperatorStartRequest): Promise<PhysicalOperatorProviderRun> {
    this.lastRequest = request
    return {
      result: this.outcome,
      dispose: async () => {
        this.disposed += 1
        return this.disposal
      },
    }
  }
}

async function setup(operator = new ScriptedOperator()) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PhysicalOperatorRuntime)
  ctx.physicalOperators.registerOperator(operator)
  await ctx.plugin(tool)
  return { ctx, operator }
}

let calls = 0
function call(
  ctx: Context,
  args: unknown,
  options: { agent?: Agent | undefined; signal?: AbortSignal } = {},
) {
  const agent = 'agent' in options ? options.agent : fakeAgent()
  return ctx.tools.execute({
    signal: options.signal ?? new AbortController().signal,
    callId: CallId(`physical-${++calls}`),
    name: 'physical_operator',
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('physical_operator tool', () => {
  it('exposes only the stable operator boundary to the model', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'physical_operator')
    expect(schema).toBeDefined()
    const properties = schema!.parameters.properties as Record<string, unknown>
    expect(Object.keys(properties).sort()).toEqual(['action', 'description', 'mode', 'operator_id', 'prompt'])
    expect(schema!.description).not.toMatch(/codex|claude|subagent/i)
    expect(schema!.description).toContain('backing provider')
    const section = (await ctx.systemPrompt.assemble()).sections
      .find(candidate => candidate.name === 'tool:physical-operator')
    expect(section?.text).toContain('Choose resident mode for multi-turn work')
    expect(section?.text).toContain('physics-solver: Solves bounded physics problems. [physics, reasoning]')
  })

  it('lists canonical live status without requiring a calling agent', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, { action: 'list' }, { agent: undefined })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected list success')
    expect(result.value).toEqual({
      kind: 'list',
      operators: [{
        operatorId: 'physics-solver',
        displayName: 'Physics Solver',
        description: 'Solves bounded physics problems.',
        tags: ['physics', 'reasoning'],
        state: 'available',
        active: 0,
        maxConcurrency: 1,
        executionModes: ['ephemeral'],
      }],
    })
    expect(text(result)).toContain('physics-solver [available]')
  })

  it('runs one stable id, returns content, and always disposes the execution', async () => {
    const { ctx, operator } = await setup()
    const parent = fakeAgent()
    const signal = new AbortController().signal
    const result = await call(ctx, {
      action: 'run',
      operator_id: 'physics-solver',
      description: 'solve pendulum',
      prompt: 'derive the period',
    }, { agent: parent, signal })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected run success')
    expect(result.value).toMatchObject({
      kind: 'run',
      operatorId: 'physics-solver',
      output: [{ type: 'text', text: 'answer 42' }],
    })
    expect((result.value as { executionId: string }).executionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(text(result)).toBe('answer 42')
    expect(operator.lastRequest).toMatchObject({
      label: 'solve pendulum',
      prompt: [{ type: 'text', text: 'derive the period' }],
      parent,
      signal,
    })
    expect(operator.disposed).toBe(1)
  })

  it('requires exact run fields and a calling agent without silently ignoring list fields', async () => {
    const { ctx, operator } = await setup()
    const noAgent = await call(ctx, {
      action: 'run', operator_id: 'physics-solver', description: 'do work', prompt: 'work',
    }, { agent: undefined })
    expect(noAgent.isError).toBe(true)
    expect(text(noAgent)).toContain('requires a calling agent')

    for (const args of [
      { action: 'run', description: 'do work', prompt: 'work' },
      { action: 'run', operator_id: 'physics-solver', prompt: 'work' },
      { action: 'run', operator_id: 'physics-solver', description: 'do work' },
      { action: 'list', prompt: 'must not be ignored' },
    ]) {
      const result = await call(ctx, args)
      expect(result.isError).toBe(true)
    }
    expect(operator.lastRequest).toBeUndefined()
  })

  it('reports non-completed results as errors while preserving partial text and disposal', async () => {
    const operator = new ScriptedOperator(Promise.resolve({
      output: [{ type: 'text', text: 'partial derivation' }],
      stopReason: 'max-tokens',
    }))
    const { ctx } = await setup(operator)
    const result = await call(ctx, {
      action: 'run', operator_id: 'physics-solver', description: 'do work', prompt: 'work',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('hit its token limit')
    expect(text(result)).toContain('partial derivation')
    expect(operator.disposed).toBe(1)
  })

  it('keeps independent result and disposal failures observable', async () => {
    const resultFailure = Promise.reject<PhysicalOperatorResult>(new Error('wire failed'))
    const disposalFailure: Promise<void> = Promise.reject(new Error('dispose failed'))
    void resultFailure.catch(() => {})
    void disposalFailure.catch(() => {})
    const operator = new ScriptedOperator(
      resultFailure,
      disposalFailure,
    )
    const { ctx } = await setup(operator)
    const result = await call(ctx, {
      action: 'run', operator_id: 'physics-solver', description: 'do work', prompt: 'work',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('wire failed')
    expect(text(result)).toContain('dispose failed')
    expect(operator.disposed).toBe(1)
  })

  it('unmounts with its plugin fiber and never owns the operator registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PhysicalOperatorRuntime)
    const operator = new ScriptedOperator()
    ctx.physicalOperators.registerOperator(operator)
    const mounted = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(schema => schema.name === 'physical_operator')).toBe(true)
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:physical-operator')).toBe(true)
    await mounted.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'physical_operator')).toBe(false)
    expect((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'tool:physical-operator')).toBe(false)
    expect(ctx.physicalOperators.getOperator('physics-solver')).toBe(operator)
  })
})
