import type { Context } from '@deepseek-ai/cordis'
import {
  ResidentOperatorCommandId,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
} from '@deepseek-ai/dsh-resident-operator'
import { describe, expect, it, vi } from 'vitest'
import { readResidentDashboard, registerResidentDashboard } from '../src/dashboard.ts'

function responseRecorder(): {
  response: { writeHead: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
  status: () => number | undefined
  json: () => unknown
} {
  const writeHead = vi.fn()
  const end = vi.fn()
  return {
    response: { writeHead, end },
    status: () => writeHead.mock.calls[0]?.[0] as number | undefined,
    json: () => JSON.parse(String(end.mock.calls[0]?.[0])) as unknown,
  }
}

describe('Resident Operator Desktop projection', () => {
  it('allows explicit login only from the owner-local browser route', async () => {
    let handler: ((request: unknown, response: unknown) => Promise<void>) | undefined
    const authenticate = vi.fn(async () => ({
      operatorId: 'claude-code',
      product: 'claude-code',
      displayName: 'Claude Code',
      description: 'Test provider',
      tags: ['subscription'],
      maxConcurrency: 1,
      injectionBoundaries: ['pre-dispatch'] as const,
      available: true,
      authentication: 'native-subscription' as const,
      productVersion: 'test',
      protocolHash: 'test',
      models: [],
    }))
    const remoteAuth = {
      authenticate: (token: string) => token === 'valid'
        ? { deviceId: 'remote', deviceName: 'Remote', scope: 'admin' as const }
        : undefined,
    }
    const ctx = {
      residentOperators: { authenticate },
      webServer: {
        register: vi.fn((route: { handler: typeof handler }) => {
          handler = route.handler
          return () => {}
        }),
      },
      get: (key: string) => key === 'remoteAuth' ? remoteAuth : undefined,
      logger: { warn: vi.fn() },
    } as unknown as Context
    registerResidentDashboard(ctx)
    if (handler === undefined) throw new Error('dashboard route was not registered')

    const local = responseRecorder()
    await handler({
      method: 'POST',
      url: '/api/resident-operators?operator_id=claude-code',
      headers: { host: '127.0.0.1:13080', origin: 'http://127.0.0.1:13080' },
      socket: { remoteAddress: '127.0.0.1' },
    }, local.response)
    expect(local.status()).toBe(200)
    expect(local.json()).toMatchObject({ provider: { operatorId: 'claude-code', available: true } })
    expect(authenticate).toHaveBeenCalledOnce()

    const remote = responseRecorder()
    await handler({
      method: 'POST',
      url: '/api/resident-operators?operator_id=claude-code',
      headers: { host: 'server.test', authorization: 'Bearer valid' },
      socket: { remoteAddress: '100.64.0.2' },
    }, remote.response)
    expect(remote.status()).toBe(403)
    expect(remote.json()).toEqual({ error: 'LOCAL_OWNER_REQUIRED' })
    expect(authenticate).toHaveBeenCalledOnce()
  })

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
