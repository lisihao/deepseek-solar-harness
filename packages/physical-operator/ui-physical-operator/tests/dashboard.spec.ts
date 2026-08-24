import type { Context } from '@deepseek-ai/cordis'
import {
  ResidentOperatorCommandId,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
} from '@deepseek-ai/dsh-resident-operator'
import { describe, expect, it, vi } from 'vitest'
import { readResidentDashboard } from '../src/dashboard.ts'

describe('Resident Operator Desktop projection', () => {
  it('reconnects to daemon-owned session, progress, and settled result state', async () => {
    const sessionId = ResidentOperatorSessionId('session-1')
    const turnId = ResidentOperatorTurnId('turn-1')
    const commandId = ResidentOperatorCommandId('command-1')
    const latestEvent = {
      sequence: 7,
      type: 'turn.progress',
      time: '2026-08-16T10:00:00.000Z',
      data: { commandId, turnId, phase: 'reasoning', taskLabel: 'Check the runtime boundary' },
    }
    const residentOperators = {
      providers: vi.fn(async () => [{
        operatorId: 'codex',
        product: 'codex' as const,
        displayName: 'Codex',
        description: 'Test Resident provider.',
        tags: ['coding'],
        maxConcurrency: 4,
        injectionBoundaries: ['pre-dispatch', 'next-turn'] as const,
        available: true,
        quotaUnavailableReason: 'Codex subscription quota telemetry unavailable: test outage',
        authentication: 'native-subscription' as const,
        productVersion: '0.147.0',
        protocolHash: 'schema',
        models: [{
          model: 'gpt-5.6-sol',
          displayName: 'GPT-5.6 Sol',
          description: 'Frontier agentic coding model',
          supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          defaultEffort: 'medium',
          isDefault: true,
          supportsAdaptiveThinking: false,
        }],
      }]),
      list: vi.fn(async () => [{
        sessionId,
        operatorId: 'codex',
        workspace: '/tmp/research',
        lifecycle: 'running' as const,
        health: 'ok' as const,
        control: 'automation' as const,
        stateRevision: 4,
        activeTurnId: turnId,
        executionProfile: { model: 'gpt-5.6-sol', effort: 'high' },
        executionProfileSource: 'manual' as const,
        latestTurn: {
          commandId,
          turnId,
          state: 'running' as const,
          taskLabel: 'Check the runtime boundary',
          updatedAt: latestEvent.time,
        },
        latestEvent,
        updatedAt: latestEvent.time,
      }]),
      readEvents: vi.fn(async () => ({ events: [latestEvent], nextCursor: 7 })),
      inspectTurn: vi.fn(async () => ({
        commandId,
        turnId,
        sessionId,
        stateRevision: 4,
        state: 'running' as const,
        updatedAt: latestEvent.time,
      })),
    }

    const dashboard = await readResidentDashboard({ residentOperators } as unknown as Context, String(sessionId))

    expect(dashboard.providers).toEqual([expect.objectContaining({
      operatorId: 'codex',
      available: true,
      displayName: 'Codex',
      quotaUnavailableReason: 'Codex subscription quota telemetry unavailable: test outage',
      models: [expect.objectContaining({ model: 'gpt-5.6-sol', defaultEffort: 'medium' })],
    })])
    expect(dashboard.sessions).toHaveLength(1)
    expect(dashboard.sessions[0]).toMatchObject({
      sessionId: 'session-1',
      activeTurnId: 'turn-1',
      executionProfile: { model: 'gpt-5.6-sol', effort: 'high' },
      executionProfileSource: 'manual',
      workspaceDisplay: '/tmp/research',
    })
    expect(dashboard.sessions[0]?.latestTurn?.state).toBe('running')
    expect(dashboard.sessions[0]?.latestEvent?.data.phase).toBe('reasoning')
    expect(dashboard.selectedTurn).toEqual(expect.objectContaining({ turnId: 'turn-1', state: 'running' }))
    expect(dashboard.events).toEqual([expect.objectContaining({ type: 'turn.progress' })])
    expect(dashboard.activities).toEqual([expect.objectContaining({
      taskLabel: 'Check the runtime boundary',
      status: 'running',
    })])
  })

  it('keeps development canary sessions out of the user task list', async () => {
    const residentOperators = {
      providers: vi.fn(async () => []),
      list: vi.fn(async () => [{
        sessionId: ResidentOperatorSessionId('diagnostic'),
        operatorId: 'codex',
        workspace: '/Users/me/.dsh/artifacts/resident-dev-canary/workspace',
        lifecycle: 'idle' as const,
        health: 'ok' as const,
        control: 'automation' as const,
        stateRevision: 1,
        updatedAt: '2026-08-16T10:00:00.000Z',
      }]),
      readEvents: vi.fn(),
      inspectTurn: vi.fn(),
    }

    const dashboard = await readResidentDashboard({ residentOperators } as unknown as Context)
    expect(dashboard.sessions).toEqual([])
    expect(dashboard.hiddenDiagnosticSessions).toBe(1)
  })
})
