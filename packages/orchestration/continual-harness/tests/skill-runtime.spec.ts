import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ContinualHarnessSkillRuntime } from '../src/index.ts'

describe('ContinualHarnessSkillRuntime', () => {
  it('invokes only a trusted registered TypeScript module and returns JSON', async () => {
    const ctx = new Context()
    await ctx.plugin(ContinualHarnessSkillRuntime)
    const invoke = vi.fn(async (request: { readonly args: Readonly<Record<string, unknown>> }) => ({
      text: typeof request.args.text === 'string' ? request.args.text : '',
    }))
    ctx.continualHarnessSkills.register({
      moduleId: '@deepseek-ai/dsh-skill-summarize',
      callables: ['summarize'],
      invoke,
    })
    expect(ctx.continualHarnessSkills.has('@deepseek-ai/dsh-skill-summarize', 'summarize')).toBe(true)
    await expect(ctx.continualHarnessSkills.invoke({
      moduleId: '@deepseek-ai/dsh-skill-summarize', callable: 'summarize', args: { text: 'bounded' },
      workspace: '/repo', sessionId: 'rlm-root', entryId: 'summarize',
    })).resolves.toEqual({ text: 'bounded' })
    expect(invoke).toHaveBeenCalledTimes(1)
    await expect(ctx.continualHarnessSkills.invoke({
      moduleId: '@deepseek-ai/dsh-skill-summarize', callable: 'arbitrary', args: {},
      workspace: '/repo', sessionId: 'rlm-root', entryId: 'untrusted',
    })).rejects.toThrow('managed TypeScript skill is unavailable')
    await ctx.root.fiber.dispose()
  })
})
