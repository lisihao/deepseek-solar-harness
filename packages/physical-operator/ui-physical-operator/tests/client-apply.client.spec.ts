import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  type PhysicalOperatorRoutingInjected,
  changeOrchestrationExecutionMechanism,
  orchestrationAutonomousModeLabel,
  orchestrationExecutionMechanism,
  orchestrationExecutionMechanismLabel,
  orchestrationExecutionModeLabel,
  physicalOperatorDashboardRefreshMs,
  physicalOperatorEffortLabel,
  physicalOperatorRoutingDescription,
  physicalOperatorRoutingLabel,
  physicalOperatorRoutingSummary,
  physicalOperatorStrategyPanelPosition,
} from '../src/client/index.ts'
import {
  authenticateResidentOperator,
  ResidentAuthenticationError,
} from '../src/client/ResidentOperatorsPanel.tsx'

describe('physical operator client plugin', () => {
  it('starts authentication only through an explicit owner action', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:13080' } })
    let requestedUrl = ''
    const request = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      requestedUrl = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : ''
      return new Response(JSON.stringify({
        provider: { operatorId: 'claude-code', available: true },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })

    try {
      await expect(authenticateResidentOperator('claude-code', request)).resolves.toMatchObject({
        provider: { operatorId: 'claude-code', available: true },
      })
      expect(request).toHaveBeenCalledOnce()
      expect(requestedUrl).toContain('operator_id=claude-code')
      expect(request.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', cache: 'no-store' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    'auth_required',
    'network_unavailable',
    'callback_listener_missing',
  ] as const)('preserves the structured %s login reason for an explicit retry UI', async (reason) => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:13080' } })
    const request = vi.fn(async () => new Response(JSON.stringify({
      error: 'RESIDENT_AUTHENTICATION_FAILED',
      reason,
      message: `login failed: ${reason}`,
    }), { status: 503, headers: { 'content-type': 'application/json' } }))
    try {
      let failure: unknown
      try {
        await authenticateResidentOperator('claude-code', request)
      } catch (cause: unknown) {
        failure = cause
      }
      expect(failure).toBeInstanceOf(ResidentAuthenticationError)
      expect(failure).toMatchObject({ reason, message: `login failed: ${reason}` })
      expect(request).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('leaves native and Web catalog refresh to session.models', () => {
    const request = vi.fn()
    const registerRefreshSource = vi.fn()
    const ctx = {
      effect: vi.fn(),
      get: (key: string) => key === 'connection' ? { request } : undefined,
      inject: vi.fn((_services: readonly string[], install: (scope: ClientContext) => unknown) => install(ctx)),
      modelDirectories: {
        directoryFor: vi.fn(),
        registerRefreshSource,
      },
      remote: { commands: { execute: vi.fn() } },
      slots: { inject: vi.fn(), register: vi.fn() },
    } as unknown as ClientContext
    apply(ctx)

    expect(registerRefreshSource).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('registers provider-neutral Resident and routing slots through Cordis services', async () => {
    const registrations: Array<{
      options: { id?: string; name?: string; inject?: (sessionId: string) => unknown }
    }> = []
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      value: { commandId: 'command-1', result: { kind: 'success' as const } },
    })
    const request = vi.fn()
    const directory = {}
    const refreshModels = vi.fn(async () => undefined)
    const modelDirectories = { directoryFor: vi.fn(() => ({ store: directory, load: refreshModels })) }
    const inject = vi.fn()
    const ctx = {
      effect: vi.fn(),
      get: (key: string) => key === 'connection' ? { request } : undefined,
      inject,
      modelDirectories,
      remote: { commands: { execute } },
      slots: {
        inject: vi.fn((_name: string, install: () => unknown) => install()),
        register: vi.fn((options: { id?: string; name?: string; inject?: (sessionId: string) => unknown }) => {
          registrations.push({ options })
          return () => {}
        }),
      },
    } as unknown as ClientContext
    inject.mockImplementation((_services: readonly string[], install: (scope: ClientContext) => unknown) => install(ctx))

    apply(ctx)

    const resident = registrations.find(({ options }) => options.id === 'resident-physical-operators')
    const routing = registrations.find(({ options }) => options.id === 'physical-operator-routing')
    expect(resident?.options.name).toBe('conversation.session.header.actions')
    expect(resident?.options.inject?.('session-1')).toEqual({ request })
    expect(routing?.options.name).toBe('conversation.input.right')
    const injected = routing?.options.inject?.('session-1') as Pick<
      PhysicalOperatorRoutingInjected,
      'directory' | 'refreshModels' | 'select' | 'selectProfile' | 'selectOrchestrationStrategy'
    >
    expect(injected.directory).toBe(directory)
    expect(modelDirectories.directoryFor).toHaveBeenCalledWith('session-1')
    await injected.refreshModels()
    expect(refreshModels).toHaveBeenCalledWith({ refresh: true })
    await expect(injected.select('codex')).resolves.toBeNull()
    await expect(injected.select('chatgpt-web')).resolves.toBeNull()
    await expect(injected.selectProfile('codex', 'gpt-5.6-sol', 'high')).resolves.toBeNull()
    await expect(injected.selectOrchestrationStrategy(
      'enabled', 'enabled', 'off', 'balanced', 'codex-sol', 'luna-first',
    )).resolves.toBeNull()
    expect(execute).toHaveBeenNthCalledWith(1, 'session-1', '/operator codex')
    expect(execute).toHaveBeenNthCalledWith(2, 'session-1', '/operator chatgpt-web')
    expect(execute).toHaveBeenNthCalledWith(3, 'session-1', '/operator-profile codex gpt-5.6-sol high')
    expect(execute).toHaveBeenNthCalledWith(
      4,
      'session-1',
      '/orchestration-strategy enabled enabled off balanced codex-sol luna-first',
    )

    execute
      .mockResolvedValueOnce({
        ok: true,
        value: { commandId: 'command-error-1', result: { kind: 'error', text: 'operator rejected' } },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { commandId: 'command-error-2', result: { kind: 'error', text: 'profile rejected' } },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { commandId: 'command-error-3', result: { kind: 'error', text: 'strategy rejected' } },
      })
    await expect(injected.select('codex')).resolves.toBe('operator rejected')
    await expect(injected.selectProfile('codex', 'gpt-5.6-sol', 'high')).resolves.toBe('profile rejected')
    await expect(injected.selectOrchestrationStrategy(
      'enabled', 'enabled', 'off', 'balanced', 'codex-sol', 'luna-first',
    )).resolves.toBe('strategy rejected')

    execute.mockReset()
    execute.mockResolvedValueOnce({
      ok: true,
      value: { commandId: 'transition-error-1', result: { kind: 'error', text: 'RLM rejected' } },
    })
    await expect(changeOrchestrationExecutionMechanism(
      { rlm: 'auto' },
      'rlm',
      mode => injected.selectOrchestrationStrategy(
        mode, 'enabled', 'off', 'balanced', 'codex-sol', 'luna-first',
      ),
    )).resolves.toBe('启用 RLM失败：RLM rejected')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('maps the RLM preference into one execution selector', () => {
    expect(orchestrationExecutionMechanism('auto')).toBe('auto')
    expect(orchestrationExecutionMechanism('disabled')).toBe('standard')
    expect(orchestrationExecutionMechanism('enabled')).toBe('rlm')
    expect(orchestrationExecutionMechanismLabel('standard')).toBe('标准（关闭 RLM）')
  })

  it('saves the RLM mode that the selected mechanism needs and nothing else', async () => {
    const saveRlm = vi.fn(async () => null)
    await expect(changeOrchestrationExecutionMechanism({ rlm: 'disabled' }, 'auto', saveRlm)).resolves.toBeNull()
    expect(saveRlm).toHaveBeenLastCalledWith('auto')
    await expect(changeOrchestrationExecutionMechanism({ rlm: 'auto' }, 'standard', saveRlm)).resolves.toBeNull()
    expect(saveRlm).toHaveBeenLastCalledWith('disabled')
    await expect(changeOrchestrationExecutionMechanism({ rlm: 'disabled' }, 'rlm', saveRlm)).resolves.toBeNull()
    expect(saveRlm).toHaveBeenLastCalledWith('enabled')
    expect(saveRlm).toHaveBeenCalledTimes(3)

    // Reselecting the saved mechanism saves nothing, except that standard also closes an enabled Autonomous Mode.
    saveRlm.mockClear()
    await expect(changeOrchestrationExecutionMechanism({ rlm: 'enabled' }, 'rlm', saveRlm)).resolves.toBeNull()
    await expect(changeOrchestrationExecutionMechanism({ rlm: 'disabled', autonomous: 'disabled' }, 'standard', saveRlm)).resolves.toBeNull()
    expect(saveRlm).not.toHaveBeenCalled()
    await expect(changeOrchestrationExecutionMechanism({ rlm: 'disabled', autonomous: 'enabled' }, 'standard', saveRlm)).resolves.toBeNull()
    expect(saveRlm).toHaveBeenCalledWith('disabled')
  })

  it('returns a failed save and allows the same selection to be retried', async () => {
    const saveRlm = vi.fn()
      .mockResolvedValueOnce('temporary host failure')
      .mockResolvedValue(null)
    const current = { rlm: 'auto' as const }

    await expect(changeOrchestrationExecutionMechanism(current, 'rlm', saveRlm)).resolves.toBe('启用 RLM失败：temporary host failure')
    await expect(changeOrchestrationExecutionMechanism(current, 'rlm', saveRlm)).resolves.toBeNull()
    expect(saveRlm).toHaveBeenCalledTimes(2)
    expect(saveRlm).toHaveBeenLastCalledWith('enabled')
  })

  it('keeps user-facing collaboration labels stable outside the Desktop product', () => {
    expect(orchestrationExecutionModeLabel('auto')).toBe('自动（系统选择）')
    expect(orchestrationExecutionModeLabel('enabled')).toBe('RLM（Prime 递归）')
    expect(orchestrationExecutionModeLabel('disabled')).toBe('标准（单 Agent）')
    expect(orchestrationAutonomousModeLabel('auto')).toBe('自动（按任务判断）')
    expect(orchestrationAutonomousModeLabel('enabled')).toBe('自主闭环')
    expect(orchestrationAutonomousModeLabel('disabled')).toBe('关闭')
    expect(physicalOperatorRoutingLabel('auto')).toBe('智能协作')
    expect(physicalOperatorRoutingLabel('codex')).toBe('优先 Codex')
    expect(physicalOperatorRoutingSummary('claude-code')).toBe('Claude Code')
    expect(physicalOperatorRoutingSummary('chatgpt-web')).toBe('ChatGPT 网页版')
    expect(physicalOperatorRoutingLabel('chatgpt-web')).toBe('ChatGPT 网页订阅')
    expect(physicalOperatorRoutingDescription('chatgpt-web')).toContain('不进入智能自动')
    expect(physicalOperatorRoutingDescription('codex')).toContain('短问答仍由主模型处理')
    expect(physicalOperatorEffortLabel('high')).toBe('高 · 复杂任务的深度推理')
    expect(physicalOperatorEffortLabel('high', 'claude-code')).toBe('高 · Claude 深入思考')
    expect(physicalOperatorEffortLabel('max', 'claude-code')).toBe('最大 · Claude 最大思考预算')
    expect(physicalOperatorDashboardRefreshMs(false)).toBe(60_000)
    expect(physicalOperatorDashboardRefreshMs(true)).toBe(10_000)
  })

  it('keeps the collaboration panel inside the viewport above, below, and beside a new-session composer', () => {
    const viewport = { width: 1_440, height: 800 }
    const middle = physicalOperatorStrategyPanelPosition(
      { top: 360, right: 1_120, bottom: 386 },
      520,
      viewport,
    )
    expect(middle.top).toBeGreaterThanOrEqual(12)
    expect(middle.top + 520).toBeLessThanOrEqual(788)
    expect(middle.right).toBeGreaterThanOrEqual(12)

    expect(physicalOperatorStrategyPanelPosition(
      { top: 24, right: 1_420, bottom: 50 },
      300,
      viewport,
    ).top).toBe(58)
    expect(physicalOperatorStrategyPanelPosition(
      { top: 750, right: 1_420, bottom: 776 },
      300,
      viewport,
    ).top).toBe(442)
  })
})
