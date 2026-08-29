import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
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
import { authenticateResidentOperator } from '../src/client/ResidentOperatorsPanel.tsx'

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

  it('registers provider-neutral Resident and routing slots through Cordis services', async () => {
    const registrations: Array<{
      options: { id?: string; name?: string; inject?: (sessionId: string) => unknown }
    }> = []
    const execute = vi.fn().mockResolvedValue({ ok: true, value: { matched: true } })
    const request = vi.fn()
    const ctx = {
      effect: vi.fn(),
      get: (key: string) => key === 'connection' ? { request } : undefined,
      remote: { commands: { execute } },
      slots: {
        inject: vi.fn((_name: string, install: () => unknown) => install()),
        register: vi.fn((options: { id?: string; name?: string; inject?: (sessionId: string) => unknown }) => {
          registrations.push({ options })
          return () => {}
        }),
      },
    } as unknown as ClientContext

    apply(ctx)

    const resident = registrations.find(({ options }) => options.id === 'resident-physical-operators')
    const routing = registrations.find(({ options }) => options.id === 'physical-operator-routing')
    expect(resident?.options.name).toBe('conversation.session.header.actions')
    expect(resident?.options.inject?.('session-1')).toEqual({ request })
    expect(routing?.options.name).toBe('conversation.input.right')
    const injected = routing?.options.inject?.('session-1') as {
      select: (policy: 'codex') => Promise<string | null>
      selectProfile: (operatorId: 'codex', model?: string, effort?: 'high') => Promise<string | null>
      selectOrchestrationStrategy: (
        rlm: 'enabled', autonomous: 'enabled', harness: 'off', optimization: 'balanced',
        plannerVerifierPreference: 'codex-sol', executionPreference: 'luna-first',
      ) => Promise<string | null>
      selectDebateMode: (mode: 'enabled') => Promise<string | null>
    }
    await expect(injected.select('codex')).resolves.toBeNull()
    await expect(injected.selectProfile('codex', 'gpt-5.6-sol', 'high')).resolves.toBeNull()
    await expect(injected.selectOrchestrationStrategy(
      'enabled', 'enabled', 'off', 'balanced', 'codex-sol', 'luna-first',
    )).resolves.toBeNull()
    await expect(injected.selectDebateMode('enabled')).resolves.toBeNull()
    expect(execute).toHaveBeenNthCalledWith(1, 'session-1', '/operator codex')
    expect(execute).toHaveBeenNthCalledWith(2, 'session-1', '/operator-profile codex gpt-5.6-sol high')
    expect(execute).toHaveBeenNthCalledWith(
      3,
      'session-1',
      '/orchestration-strategy enabled enabled off balanced codex-sol luna-first',
    )
    expect(execute).toHaveBeenNthCalledWith(4, 'session-1', '/debate-mode enabled')
  })

  it('maps RLM and Debate preferences into one mutually exclusive execution selector', () => {
    expect(orchestrationExecutionMechanism('auto', 'auto')).toBe('auto')
    expect(orchestrationExecutionMechanism('auto', 'disabled')).toBe('auto')
    expect(orchestrationExecutionMechanism('disabled', 'disabled')).toBe('standard')
    expect(orchestrationExecutionMechanism('enabled', 'disabled')).toBe('rlm')
    expect(orchestrationExecutionMechanism('disabled', 'enabled')).toBe('debate')
    expect(orchestrationExecutionMechanismLabel('debate')).toBe('Debate（多 Agent 辩论）')
  })

  it('closes the non-target mechanism before enabling the selected mechanism', async () => {
    const calls: string[] = []
    const saveRlm = vi.fn(async (mode: 'auto' | 'enabled' | 'disabled') => {
      calls.push(`rlm:${mode}`)
      return null
    })
    const saveDebate = vi.fn(async (mode: 'auto' | 'enabled' | 'disabled') => {
      calls.push(`debate:${mode}`)
      return null
    })
    await expect(changeOrchestrationExecutionMechanism(
      { rlm: 'auto', debate: 'auto' },
      'debate',
      saveRlm,
      saveDebate,
    )).resolves.toBeNull()
    expect(calls).toEqual(['rlm:disabled', 'debate:enabled'])

    calls.length = 0
    await expect(changeOrchestrationExecutionMechanism(
      { rlm: 'disabled', debate: 'enabled' },
      'rlm',
      saveRlm,
      saveDebate,
    )).resolves.toBeNull()
    expect(calls).toEqual(['debate:disabled', 'rlm:enabled'])

    calls.length = 0
    await expect(changeOrchestrationExecutionMechanism(
      { rlm: 'disabled', debate: 'disabled' },
      'auto',
      saveRlm,
      saveDebate,
    )).resolves.toBeNull()
    expect(calls).toEqual(['rlm:auto', 'debate:auto'])

    calls.length = 0
    await expect(changeOrchestrationExecutionMechanism(
      { rlm: 'auto', debate: 'auto' },
      'standard',
      saveRlm,
      saveDebate,
    )).resolves.toBeNull()
    expect(calls).toEqual(['debate:disabled', 'rlm:disabled'])
  })

  it('returns a failed transition step and allows the same selection to be retried', async () => {
    const saveRlm = vi.fn()
      .mockResolvedValueOnce('temporary host failure')
      .mockResolvedValue(null)
    const saveDebate = vi.fn().mockResolvedValue(null)
    const current = { rlm: 'enabled' as const, debate: 'disabled' as const }

    await expect(changeOrchestrationExecutionMechanism(
      current,
      'debate',
      saveRlm,
      saveDebate,
    )).resolves.toBe('关闭 RLM失败：temporary host failure')
    expect(saveDebate).not.toHaveBeenCalled()

    await expect(changeOrchestrationExecutionMechanism(
      current,
      'debate',
      saveRlm,
      saveDebate,
    )).resolves.toBeNull()
    expect(saveDebate).toHaveBeenCalledWith('enabled')
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
