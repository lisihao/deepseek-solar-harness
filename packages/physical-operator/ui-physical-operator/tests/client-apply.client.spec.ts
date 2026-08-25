import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import {
  apply,
  orchestrationExecutionModeLabel,
  physicalOperatorDashboardRefreshMs,
  physicalOperatorEffortLabel,
  physicalOperatorRoutingDescription,
  physicalOperatorRoutingLabel,
  physicalOperatorRoutingSummary,
} from '../src/client/index.ts'

describe('physical operator client plugin', () => {
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
        rlm: 'enabled', harness: 'off', optimization: 'balanced',
      ) => Promise<string | null>
    }
    await expect(injected.select('codex')).resolves.toBeNull()
    await expect(injected.selectProfile('codex', 'gpt-5.6-sol', 'high')).resolves.toBeNull()
    await expect(injected.selectOrchestrationStrategy('enabled', 'off', 'balanced')).resolves.toBeNull()
    expect(execute).toHaveBeenNthCalledWith(1, 'session-1', '/operator codex')
    expect(execute).toHaveBeenNthCalledWith(2, 'session-1', '/operator-profile codex gpt-5.6-sol high')
    expect(execute).toHaveBeenNthCalledWith(3, 'session-1', '/orchestration-strategy enabled off balanced')
  })

  it('keeps user-facing collaboration labels stable outside the Desktop product', () => {
    expect(orchestrationExecutionModeLabel('auto')).toBe('自动（系统选择）')
    expect(orchestrationExecutionModeLabel('enabled')).toBe('RLM（Prime 递归）')
    expect(orchestrationExecutionModeLabel('disabled')).toBe('标准（单 Agent）')
    expect(physicalOperatorRoutingLabel('auto')).toBe('智能协作')
    expect(physicalOperatorRoutingLabel('codex')).toBe('优先 Codex')
    expect(physicalOperatorRoutingSummary('claude-code')).toBe('Claude Code')
    expect(physicalOperatorRoutingDescription('codex')).toContain('短问答仍由主模型处理')
    expect(physicalOperatorEffortLabel('high')).toBe('高 · 复杂任务的深度推理')
    expect(physicalOperatorDashboardRefreshMs(false)).toBe(60_000)
    expect(physicalOperatorDashboardRefreshMs(true)).toBe(10_000)
  })
})
