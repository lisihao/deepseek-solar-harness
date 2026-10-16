import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import LocalRlmStrategy from '../src/index.ts'

async function strategy() {
  const ctx = new Context()
  await ctx.plugin(LocalRlmStrategy)
  return ctx.rlmStrategy
}

describe('LocalRlmStrategy', () => {
  it('enables bounded recursion for an automatic recursive node', async () => {
    const service = await strategy()
    const plan = await service.resolve({
      runId: 'run', nodeId: 'explore', phase: 'execution', role: 'explorer',
      task: '递归探索候选方案并综合证据', requestedMode: 'auto',
    })
    expect(plan).toMatchObject({
      enabled: true,
      fidelity: 'dsh-optimized',
      strategyId: 'dsh-native-rlm',
      strategyVersion: '1.5.1',
      maxDepth: 1,
      reason: 'auto-explicit-decomposition',
    })
    expect(plan.instruction).toContain('distinct solution, failure-analysis, evidence-review, or alternative-design lenses')
    expect(plan.instruction).toContain('coverage-checked')
    expect(plan.instruction).toContain('solve a small or strictly sequential task directly with none')
  })

  it('keeps an ordinary automatic node direct', async () => {
    const service = await strategy()
    const plan = await service.resolve({
      runId: 'run', nodeId: 'edit', phase: 'execution', role: 'implementer',
      task: 'change the button label', requestedMode: 'auto',
    })
    expect(plan).toMatchObject({ enabled: false, reason: 'auto-balanced-direct-node' })
  })

  it('uses the user objective to trade quality against latency and cost', async () => {
    const service = await strategy()
    const task = `Prepare a multi-source implementation plan. ${'constraint '.repeat(100)}`
    await expect(service.resolve({
      runId: 'run', nodeId: 'plan-quality', phase: 'planning', role: 'planner',
      task, requestedMode: 'auto', objective: 'quality',
    })).resolves.toMatchObject({ enabled: true, reason: 'auto-quality-complex-planning' })
    await expect(service.resolve({
      runId: 'run', nodeId: 'plan-speed', phase: 'planning', role: 'planner',
      task, requestedMode: 'auto', objective: 'speed',
    })).resolves.toMatchObject({ enabled: false, reason: 'auto-speed-direct-node' })
    await expect(service.resolve({
      runId: 'run', nodeId: 'plan-economy', phase: 'planning', role: 'planner',
      task, requestedMode: 'auto', objective: 'economy',
    })).resolves.toMatchObject({ enabled: false, reason: 'auto-economy-direct-node' })
  })

  it('honours explicit Standard and RLM choices over Smart Auto', async () => {
    const service = await strategy()
    const task = '递归探索并综合多个方案'
    await expect(service.resolve({
      runId: 'run', nodeId: 'standard', phase: 'synthesis', role: 'synthesizer',
      task, requestedMode: 'disabled', objective: 'quality',
    })).resolves.toMatchObject({ enabled: false, fidelity: 'standard', reason: 'user-disabled' })
    await expect(service.resolve({
      runId: 'run', nodeId: 'rlm', phase: 'execution', role: 'implementer',
      task: 'change one label', requestedMode: 'enabled', objective: 'economy',
    })).resolves.toMatchObject({ enabled: true, fidelity: 'prime-strict', reason: 'user-enabled' })
    const strict = await service.resolve({
      runId: 'run', nodeId: 'rlm-strict', phase: 'execution', role: 'implementer',
      task: 'change one label', requestedMode: 'enabled', objective: 'economy',
    })
    expect(strict.instruction).toContain('solve a small or strictly sequential task directly with none')
    expect(strict.instruction).toContain('distinct solution, failure-analysis, evidence-review, or alternative-design lenses')
  })

  it('leaves a division of work the task explicitly asks for to the node, within the limits and capabilities already sealed', async () => {
    const service = await strategy()
    const task = 'Change one label. Use exactly two children: one edits the label and one updates its test.'
    const plans = await Promise.all([
      service.resolve({ runId: 'run', nodeId: 'explicit-strict', phase: 'execution', role: 'implementer', task, requestedMode: 'enabled', objective: 'economy' }),
      service.resolve({ runId: 'run', nodeId: 'explicit-auto', phase: 'execution', role: 'implementer', task: `${task} Explore the candidate designs recursively.`, requestedMode: 'auto' }),
    ])
    expect(plans.map(plan => plan.fidelity).sort()).toEqual(['dsh-optimized', 'prime-strict'])
    for (const plan of plans) {
      expect(plan.enabled).toBe(true)
      expect(plan.maxChildren).toBeGreaterThanOrEqual(2)
      expect(plan.instruction).toContain('Unless the task explicitly asks for a division of work, create children only for independent parts')
      expect(plan.instruction).toContain('When the task explicitly asks for a division of work, follow it within the child, depth and turn limits above and the sealed capabilities')
      expect(plan.instruction).toContain(`at most ${String(plan.maxChildren)} fresh-context children per level`)
      // The advice to solve a small task directly is part of the sentence that begins with the exception, in both fidelities.
      expect(plan.instruction.match(/solve a small or strictly sequential task directly/gu)).toHaveLength(1)
      expect(plan.instruction).toContain('worth their cost, and solve a small or strictly sequential task directly with none.')
    }
  })
})
