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
      strategyVersion: '1.4.0',
      maxDepth: 1,
      reason: 'auto-explicit-decomposition',
    })
    expect(plan.instruction).toContain('distinct solution, failure-analysis, evidence-review, or alternative-design lenses')
    expect(plan.instruction).toContain('coverage-checked')
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
  })
})
