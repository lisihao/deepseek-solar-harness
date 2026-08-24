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
      strategyId: 'dsh-native-rlm',
      strategyVersion: '1.1.0',
      maxDepth: 2,
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
    expect(plan).toMatchObject({ enabled: false, reason: 'auto-direct-node' })
  })
})
