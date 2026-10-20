import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import {
  Config,
  SolarRlmControl,
  createControlTool,
  createInspectTool,
  createRunTool,
} from '../src/index.js'
import type { RlmHost } from '../src/core.js'
import type { RunSummary } from '../src/ui-contract.js'

function summary(state = 'running'): RunSummary {
  return {
    runId: '00000000-0000-4000-8000-000000000001',
    label: 'test run',
    state,
    message: 'receipt',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    modelRequests: 0,
  }
}

function exec(overrides: Record<string, unknown> = {}): ToolRunContext {
  return {
    agent: {
      id: 'agent-1',
      session: { id: 'session-1' },
      options: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', maxTokens: 512 },
    },
    callId: 'call-1',
    rootCallId: 'root-1',
    name: 'solar_rlm_run',
    arguments: {},
    signal: new AbortController().signal,
    token: Symbol(),
    deferContext: vi.fn(),
    concludeTurn: vi.fn(),
    ...overrides,
  } as unknown as ToolRunContext
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    maxInputBytes: 16 * 1024 * 1024,
    factoryEnabled: false,
    harnessRefinements: true,
    maxModelRequests: 100,
    maxWallTimeMs: 60_000,
    ...overrides,
  }
}

function hostFixture(): {
  host: RlmHost
  start: ReturnType<typeof vi.fn>
  continueRun: ReturnType<typeof vi.fn>
  inspect: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  check: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
} {
  const start = vi.fn(async () => summary())
  const continueRun = vi.fn(async () => summary('idle'))
  const inspect = vi.fn(async () => summary())
  const cancel = vi.fn(async () => summary('cancelled'))
  const status = vi.fn(async () => ({ runtime: { available: false, message: 'fixture', primeCommit: 'prime' }, runs: [] }))
  const check = vi.fn(async () => ({ formatVersion: 1 as const, kind: 'local-keyless' as const, status: 'passed' as const, checks: [], modelRequests: 0, resultDirectory: '/tmp/check' }))
  const dispose = vi.fn(async () => undefined)
  return {
    host: { start, continue: continueRun, inspect, cancel, status, check, dispose } as unknown as RlmHost,
    start,
    continueRun,
    inspect,
    cancel,
    status,
    check,
    dispose,
  }
}

describe('RLM tools and owner service', () => {
  it('uses the exact current Agent route and leaves background owner signal unset', async () => {
    const fixture = hostFixture()
    const tool = createRunTool(fixture.host, config())
    await tool.execute({
      task: 'inspect the selected workspace',
      cwd: '/tmp/workspace',
      inputs: ['input.json'],
      maxModelRequests: 3,
      maxWallTimeMs: 30_000,
    }, exec())

    expect(fixture.start).toHaveBeenCalledOnce()
    expect(fixture.start.mock.calls[0]?.[0]).toEqual({
      task: 'inspect the selected workspace',
      cwd: '/tmp/workspace',
      inputs: ['input.json'],
      maxModelRequests: 3,
      maxWallTimeMs: 30_000,
    })
    expect(fixture.start.mock.calls[0]?.[1]).toEqual({
      sessionId: 'session-1',
      route: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high', maxTokens: 512 },
    })
    expect(fixture.start.mock.calls[0]?.[1].signal).toBeUndefined()
  })

  it('keeps the pinned Prime native gate defaults in the public config', () => {
    expect(Config()).toMatchObject({ factoryEnabled: false, harnessRefinements: true })
  })

  it('rejects missing routes, unknown fields, and budgets above configured caps', async () => {
    const fixture = hostFixture()
    const tool = createRunTool(fixture.host, config({ maxModelRequests: 2, maxWallTimeMs: 10_000 }))
    await expect(tool.execute({
      task: 'task', cwd: '/tmp/workspace', maxModelRequests: 3, maxWallTimeMs: 10_000,
    }, exec())).rejects.toThrow('RLM_BUDGET_LIMIT')
    await expect(tool.execute({
      task: 'task', cwd: '/tmp/workspace', maxModelRequests: 1, maxWallTimeMs: 10_000, unexpected: true,
    }, exec())).rejects.toThrow()
    await expect(tool.execute({
      task: 'task', cwd: '/tmp/workspace', maxModelRequests: 1, maxWallTimeMs: 10_000,
    }, exec({ agent: undefined }))).rejects.toThrow('RLM_OWNER_REQUIRED')
    expect(fixture.start).not.toHaveBeenCalled()
  })

  it('routes continue, raw refine, and cancel through the Host without reimplementing refinement', async () => {
    const fixture = hostFixture()
    const tool = createControlTool(fixture.host)
    await tool.execute({ runId: '00000000-0000-4000-8000-000000000001', action: 'continue', text: 'continue with the next check' }, exec())
    await tool.execute({ runId: '00000000-0000-4000-8000-000000000001', action: 'refine', text: '/refine preserve this evidence' }, exec())
    await tool.execute({ runId: '00000000-0000-4000-8000-000000000001', action: 'cancel' }, exec({ agent: { session: { id: 'session-1' } } }))

    expect(fixture.continueRun).toHaveBeenNthCalledWith(1, '00000000-0000-4000-8000-000000000001', 'continue with the next check', expect.objectContaining({ sessionId: 'session-1' }))
    expect(fixture.continueRun).toHaveBeenNthCalledWith(2, '00000000-0000-4000-8000-000000000001', '/refine preserve this evidence', expect.objectContaining({ sessionId: 'session-1' }))
    expect(fixture.cancel).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', 'session-1')
  })

  it('requires the original /refine command and keeps inspect owner-scoped', async () => {
    const fixture = hostFixture()
    const control = createControlTool(fixture.host)
    await expect(control.execute({ runId: '00000000-0000-4000-8000-000000000001', action: 'refine', text: 'invented refinement' }, exec())).rejects.toThrow()

    const inspect = createInspectTool(fixture.host)
    await inspect.execute({ runId: '00000000-0000-4000-8000-000000000001' }, exec({ agent: { session: { id: 'session-1' } } }))
    expect(fixture.inspect).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', 'session-1')
  })

  it('exposes the keyless owner-only service under ctx.solarRlm', async () => {
    const fixture = hostFixture()
    const ctx = new Context()
    const service = new SolarRlmControl(ctx, fixture.host)
    expect(ctx.solarRlm).toBeDefined()
    await ctx.solarRlm.status()
    await ctx.solarRlm.check({ commandId: '00000000-0000-4000-8000-000000000000' })
    await ctx.solarRlm.inspect({ runId: '00000000-0000-4000-8000-000000000001' })
    await ctx.solarRlm.cancel({ runId: '00000000-0000-4000-8000-000000000001' })
    expect(fixture.status).toHaveBeenCalledOnce()
    expect(fixture.check).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000000')
    expect(fixture.inspect).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
    expect(fixture.cancel).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
  })

  it('registers all RLM tools with the real ToolRuntime schema validator', async () => {
    const fixture = hostFixture()
    const ctx = new Context()
    const removePrompt = ctx.provide('systemPrompt', {
      tools: () => () => undefined,
      section: () => () => undefined,
      getSectionOrder: () => 0,
    })
    const runtime = new ToolRuntime(ctx)
    const unregister = [
      runtime.register(createRunTool(fixture.host, config())),
      runtime.register(createInspectTool(fixture.host)),
      runtime.register(createControlTool(fixture.host)),
    ]

    expect(runtime.get('solar_rlm_run')).toBeDefined()
    expect(runtime.get('solar_rlm_inspect')).toBeDefined()
    expect(runtime.get('solar_rlm_control')).toBeDefined()
    unregister.forEach(dispose => dispose())
    await removePrompt()
  })
})
