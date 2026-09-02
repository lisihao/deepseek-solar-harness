import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime, {
  BrowserOperationId,
  BrowserPageKey,
  BrowserProviderId,
  BrowserWorkspaceId,
} from '@deepseek-ai/dsh-browser'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBrowser from '../src/index.ts'
import { parseBrowserPlan, resultValue } from '../src/index.ts'

describe('tool-browser boundary', () => {
  it('accepts and brands one closed portable plan', () => {
    expect(parseBrowserPlan({
      version: 1,
      workspace: { kind: 'named', name: 'research', createIfMissing: true },
      requiredCapabilities: ['named-workspace', 'semantic-snapshot'],
      operations: [
        { id: 'open', kind: 'open', page: 'main', url: 'https://example.com', reuse: 'exact-url', waitUntil: 'load' },
        { id: 'snapshot', kind: 'snapshot', page: 'main' },
        { id: 'done', kind: 'complete', keep: true },
      ],
    })).toEqual({
      version: 1,
      workspace: { kind: 'named', name: 'research', createIfMissing: true },
      requiredCapabilities: ['named-workspace', 'semantic-snapshot'],
      operations: [
        { id: BrowserOperationId('open'), kind: 'open', page: BrowserPageKey('main'), url: 'https://example.com', reuse: 'exact-url', waitUntil: 'load' },
        { id: BrowserOperationId('snapshot'), kind: 'snapshot', page: BrowserPageKey('main') },
        { id: BrowserOperationId('done'), kind: 'complete', keep: true },
      ],
    })
  })

  it('rejects arbitrary programs, screenshots, takeover, and unknown fields', () => {
    for (const operation of [
      { id: 'x', kind: 'screenshot', page: 'main', fullPage: true },
      { id: 'x', kind: 'takeover' },
      { id: 'x', kind: 'program', source: 'process.exit()' },
      { id: 'x', kind: 'pages', providerRef: '@12' },
    ]) {
      expect(() => parseBrowserPlan({
        version: 1,
        workspace: { kind: 'current' },
        requiredCapabilities: [],
        operations: [operation],
      })).toThrow()
    }
  })

  it('projects portable results to JSON without changing stable ids', () => {
    expect(resultValue({
      version: 1,
      workspace: { id: BrowserWorkspaceId('space-1'), name: 'research', lifecycle: 'active', control: 'agent' },
      operations: [
        { id: BrowserOperationId('read'), kind: 'read', value: 'hello' },
        { id: BrowserOperationId('count'), kind: 'count', count: 2 },
      ],
    })).toEqual({
      version: 1,
      workspace: { id: 'space-1', name: 'research', lifecycle: 'active', control: 'agent' },
      operations: [
        { id: 'read', kind: 'read', value: 'hello' },
        { id: 'count', kind: 'count', count: 2 },
      ],
    })
  })

  it('executes through the generic ctx.browser seam and forwards cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(BrowserRuntime, { provider: 'fake' })
    const runPlan = vi.fn(async (_plan, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal)
      return {
        version: 1 as const,
        workspace: { id: BrowserWorkspaceId('space-1'), lifecycle: 'active' as const, control: 'agent' as const },
        operations: [{ id: BrowserOperationId('pages'), kind: 'pages' as const, pages: [] }],
      }
    })
    ctx.browser.registerProvider({
      descriptor: {
        id: BrowserProviderId('fake'),
        layers: ['portable-plan-v1'],
        capabilities: [],
      },
      available: () => true,
      runPlan,
    })
    await ctx.plugin(ToolBrowser)
    const controller = new AbortController()
    const out = await ctx.tools.execute({
      callId: CallId('browser-call'),
      name: 'browser',
      arguments: {
        plan: {
          version: 1,
          workspace: { kind: 'current' },
          requiredCapabilities: [],
          operations: [{ id: 'pages', kind: 'pages' }],
        },
      },
      signal: controller.signal,
    })
    expect(out.isError).toBe(false)
    expect(runPlan).toHaveBeenCalledTimes(1)
    expect(out.value).toEqual({
      version: 1,
      workspace: { id: 'space-1', lifecycle: 'active', control: 'agent' },
      operations: [{ id: 'pages', kind: 'pages', pages: [] }],
    })
  })
})
