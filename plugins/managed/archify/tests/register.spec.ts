import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: unknown) => options,
}))

import { apply, inject, name } from '../src/index.ts'

describe('Archify plugin registration contract', () => {
  it('exports an isolated Cordis plugin contract', () => {
    expect(name).toBe('@deepseek-ai/dsh-archify')
    expect(inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof apply).toBe('function')
  })

  it('registers one model-facing tool with all five types and core actions', () => {
    let captured: any
    const ctx: any = {
      tools: { register: (definition: unknown) => { captured = definition } },
      systemPrompt: { section: vi.fn() },
    }
    apply(ctx, { artifactRoot: '', timeoutMs: 120_000, maxCaptureBytes: 16_384, maxOutputBytes: 32_000_000, promptSectionOrder: 116 })
    expect(captured.name).toBe('archify')
    expect(captured.parameters.action.enum).toContain('validate')
    expect(captured.parameters.action.enum).toContain('deliver')
    expect(captured.parameters.action.enum).toContain('compare')
    expect(captured.parameters.type.enum).toEqual(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle'])
    expect(captured.parameters.input.type).toBe('json')
    expect(captured.parameters.baseInput.type).toBe('json')
    expect(captured.parameters.headInput.type).toBe('json')
    expect(captured.output.schema.type).toBe('json')
    expect(typeof captured.execute).toBe('function')
    expect(ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ name: 'archify:usage' }))
  })
})
