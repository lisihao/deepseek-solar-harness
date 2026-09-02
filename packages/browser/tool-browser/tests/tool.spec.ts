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

const validPlan = () => ({
  version: 1 as const,
  workspace: { kind: 'named' as const, name: 'model', createIfMissing: true },
  requiredCapabilities: [],
  operations: [{ id: 'done', kind: 'complete' as const, keep: true }],
})

async function setupBrowserFixture() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(BrowserRuntime, { provider: 'fake' })
  const runPlan = vi.fn(async () => ({
    version: 1 as const,
    workspace: { id: BrowserWorkspaceId('space-1'), lifecycle: 'active' as const, control: 'agent' as const },
    operations: [{ id: BrowserOperationId('done'), kind: 'done' as const, operation: 'complete' as const }],
  }))
  ctx.browser.registerProvider({
    descriptor: { id: BrowserProviderId('fake'), layers: ['portable-plan-v1'], capabilities: [] },
    available: () => true,
    runPlan,
  })
  return { ctx, runPlan }
}

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
        workspace: { kind: 'named', name: 'model', createIfMissing: true },
        requiredCapabilities: [],
        operations: [operation],
      })).toThrow()
    }
  })

  it('closes out Ego Lite-incompatible model plans before the Provider is called', async () => {
    const { ctx, runPlan } = await setupBrowserFixture()
    await ctx.plugin(ToolBrowser)
    const invalidPlans = [
      { ...validPlan(), workspace: { kind: 'current' } },
      { ...validPlan(), operations: [{ id: 'open', kind: 'open', page: 'main', url: 'https://example.com', reuse: 'never', waitUntil: 'load' }] },
      { ...validPlan(), operations: [{ id: 'pages', kind: 'pages' }] },
    ]

    for (const [index, plan] of invalidPlans.entries()) {
      const result = await ctx.tools.execute({
        callId: CallId(`browser-invalid-${index}`),
        name: 'browser',
        arguments: { plan },
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(true)
    }
    expect(runPlan).not.toHaveBeenCalled()
  })

  it('publishes a closed model schema with only Ego Lite-compatible selectors', async () => {
    const { ctx } = await setupBrowserFixture()
    await ctx.plugin(ToolBrowser)
    const schema = ctx.tools.get('browser')?.parameters as {
      type: string
      additionalProperties: boolean
      properties: {
        plan: {
          type: string
          additionalProperties: boolean
          properties: {
            workspace: { oneOf: Array<{ properties: { kind: { const?: string } } }> }
            operations: { items: { properties: { kind: { enum?: string[] }; reuse: { const?: string } } } }
          }
        }
      }
    }
    expect(schema.properties.plan.type).toBe('object')
    expect(schema.properties.plan.additionalProperties).toBe(false)
    expect(schema.properties.plan.properties.workspace.oneOf.map(branch => branch.properties.kind.const)).toEqual(['existing', 'named'])
    expect(schema.properties.plan.properties.operations.items.properties.kind.enum).not.toContain('pages')
    expect(schema.properties.plan.properties.operations.items.properties.reuse.const).toBe('exact-url')
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
          workspace: { kind: 'named', name: 'model', createIfMissing: true },
          requiredCapabilities: [],
          operations: [{ id: 'done', kind: 'complete', keep: true }],
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
