import { describe, expect, it, vi } from 'vitest'
import { renderContextSnapshot, renderPrompt, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type { HostAgent, HostContextShape } from '../src/contracts.ts'
import { registerAgentRuntimeMemoryContext, registerRuntimeMemoryContext, RUNTIME_MEMORY_CONTEXT_NAME } from '../src/guidance.ts'
import type { RuntimeMemoryController } from '../src/runtime-memory.ts'

describe('runtime memory prompt interpolation', () => {
  it('preserves every runtime-memory interpolation shape as literal data', () => {
    const contexts: Array<{ name: string; order: number; text: () => string }> = []
    const variables = new Map<string, () => string>()
    const prompt = {
      section: vi.fn(),
      context: vi.fn((context: { name: string; order: number; text: () => string }) => { contexts.push(context) }),
      variable: vi.fn((name: string, provider: () => string) => { variables.set(name, provider) }),
    }
    const ctx = {
      get: vi.fn((name: string) => name === 'systemPrompt' ? prompt : undefined),
    } as unknown as HostContextShape
    let memoryText = [
      'Empty: {{}}',
      'Non-ASCII: {{变量}}',
      'Whitespace: {{ 变量 }}',
      'Legal and unknown names: {{model}} {{unknown}}',
      'Adjacent and nested: {{a}}{{b}} {{{nested}}} {{{{}}}}',
      'Escape name: {{mnemon_runtime_memory_literal_open_braces}}',
      'Incomplete groups: prefix {{unterminated and stray }}',
    ].join('\n')
    const controller = {
      contextText: vi.fn(() => memoryText),
    } as unknown as RuntimeMemoryController

    registerRuntimeMemoryContext(ctx, controller)
    const runtimeContext = contexts.find(context => context.name === RUNTIME_MEMORY_CONTEXT_NAME)!
    const assemble = (): PromptAssembly => ({
      sections: [{ name: 'other', text: 'Other section uses {{model}}.' }],
      contexts: [{ name: runtimeContext.name, text: runtimeContext.text() }],
      tools: [],
      variables: {
        model: 'deepseek',
        ...Object.fromEntries([...variables].map(([name, provider]) => [name, provider()])),
      },
    })

    const first = assemble()
    expect(() => renderPrompt(first)).not.toThrow()
    expect(() => renderContextSnapshot(first)).not.toThrow()
    expect(renderPrompt(first)).toBe('Other section uses deepseek.')
    expect(renderContextSnapshot(first)).toBe([
      'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
      memoryText,
    ].join('\n\n'))

    memoryText = 'Updated workspace memory.'
    const second = assemble()
    expect(renderPrompt(second)).toBe(renderPrompt(first))
    expect(renderContextSnapshot(second)).toBe([
      'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
      'Updated workspace memory.',
    ].join('\n\n'))
    expect(prompt.section).not.toHaveBeenCalled()
  })
})

describe('agent-scoped runtime memory context', () => {
  it('registers a same-named per-Agent runtime context that resolves the current workspace lazily', () => {
    const dispose = vi.fn()
    const context = vi.fn((_value: { name: string; order: number; text: () => string }) => dispose)
    const agent = {
      ctx: { get: vi.fn((name: string) => name === 'systemPrompt' ? { context } : undefined) },
    } as unknown as HostAgent
    let text = 'workspace-one memory'
    const controller = { contextText: vi.fn(() => text) } as unknown as RuntimeMemoryController

    const stop = registerAgentRuntimeMemoryContext(agent, () => controller)
    const registered = context.mock.calls[0]![0]
    expect(registered).toMatchObject({ name: RUNTIME_MEMORY_CONTEXT_NAME, order: 145 })
    expect(registered?.text()).toBe('workspace-one memory')
    text = 'workspace-two memory'
    expect(registered?.text()).toBe('workspace-two memory')
    stop()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
