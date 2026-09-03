import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { PERSONA_ORDER, PERSONA_SECTION, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope, type ScopeKey } from '@deepseek-ai/dsh-scope'
import {
  ANCHORED_STANDARD_PERSONA,
  apply,
  inject,
  name,
  OUTPUT_STYLE_GUIDANCE,
  OUTPUT_STYLE_SECTION,
} from '@deepseek-ai/dsh-output-style'

async function host() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: 'Deployment persona.' })
  return ctx
}

describe('output-style', () => {
  it('uses the system-prompt seam rather than a session or output hook', () => {
    expect(name).toBe('output-style')
    expect(inject).toEqual(['systemPrompt'])
  })

  it('adds clear structure for non-trivial responses while preserving concise simple replies', async () => {
    const ctx = await host()
    const row = await ctx.plugin({ name, inject, apply })

    const section = (await ctx.systemPrompt.assemble()).sections
      .find(candidate => candidate.name === OUTPUT_STYLE_SECTION)
    expect(section?.text).toBe(OUTPUT_STYLE_GUIDANCE)
    expect(section?.text).toContain('analysis, plans, comparisons, implementation work')
    expect(section?.text).toContain('headings')
    expect(section?.text).toContain('tables only for repeated comparisons')
    expect(section?.text).toContain('greetings and simple one-line questions, answer directly and briefly')
    expect(section?.text).toContain('explicit user-requested format over these defaults')

    await row.dispose()
    expect((await ctx.systemPrompt.assemble()).sections
      .some(candidate => candidate.name === OUTPUT_STYLE_SECTION)).toBe(false)
  })

  it('keeps the anchored complete persona explicit and internally consistent', () => {
    expect(ANCHORED_STANDARD_PERSONA).toBe(`You are a helpful software engineer assistant.\n\n${OUTPUT_STYLE_GUIDANCE}`)
    expect(ANCHORED_STANDARD_PERSONA).not.toContain('{{')
    expect(renderPrompt({
      sections: [{ name: 'deployment:persona', text: ANCHORED_STANDARD_PERSONA }],
      contexts: [], tools: [], variables: {},
    })).toBe(ANCHORED_STANDARD_PERSONA)
  })

  it('lets a complete preset own the same policy without a synthetic user message', async () => {
    const ctx = await host()
    await ctx.plugin({ name, inject, apply })
    ctx.systemPrompt.context({ name: 'global:runtime', order: 1, text: 'runtime context' })

    const key: ScopeKey = { agent: 'anchored-standard' }
    const scope = createScope(ctx, key)
    const complete = await scope.ctx.plugin(Object.assign((inner: Context) => {
      inner.systemPrompt.section({
        name: PERSONA_SECTION,
        order: PERSONA_ORDER,
        text: ANCHORED_STANDARD_PERSONA,
        complete: true,
      })
      inner.systemPrompt.suppressRuntimeContext()
    }, { inject: ['systemPrompt'] }))

    const assembly = await ctx.systemPrompt.assemble({ scope: key })
    expect(assembly.sections).toEqual([{ name: PERSONA_SECTION, text: ANCHORED_STANDARD_PERSONA }])
    expect(assembly.contexts).toEqual([])
    expect(renderPrompt(assembly)).toBe(ANCHORED_STANDARD_PERSONA)

    await complete.dispose()
    const restored = await ctx.systemPrompt.assemble({ scope: key })
    expect(restored.sections.some(section => section.name === OUTPUT_STYLE_SECTION)).toBe(true)
  })
})
