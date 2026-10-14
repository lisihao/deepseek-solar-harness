import type { Context } from '@deepseek-ai/cordis'
import {
  ResidentOperatorError,
  ResidentOperatorCommandId,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
} from '@deepseek-ai/dsh-resident-operator'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import {
  readResidentDashboard,
  registerResidentCliRuntimes,
  registerResidentDashboard,
  registerResidentSessionRecovery,
} from '../src/dashboard.ts'

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

function localGet(url: string): {
  method: 'GET'
  url: string
  headers: { host: string; origin: string }
  socket: { remoteAddress: string }
} {
  return {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:13080', origin: 'http://127.0.0.1:13080' },
    socket: { remoteAddress: '127.0.0.1' },
  }
}

function provider(model: string, supportedEfforts: readonly string[]) {
  return {
    operatorId: 'codex',
    product: 'codex' as const,
    displayName: 'Codex',
    description: 'Test Resident provider.',
    tags: ['coding'],
    maxConcurrency: 4,
    injectionBoundaries: ['pre-dispatch', 'next-turn'] as const,
    available: true,
    authentication: 'native-subscription' as const,
    productVersion: 'test',
    protocolHash: 'test',
    models: [{
      model,
      displayName: model,
      description: `${model} test catalog entry`,
      supportedEfforts: [...supportedEfforts],
      defaultEffort: 'medium',
      isDefault: true,
      supportsAdaptiveThinking: false,
    }],
  }
}

describe('Resident Operator Desktop projection', () => {
  it.each([
    ['AUTH_REQUIRED', 'auth_required'],
    ['NETWORK_UNAVAILABLE', 'network_unavailable'],
    ['CALLBACK_LISTENER_MISSING', 'callback_listener_missing'],
  ] as const)('returns structured %s login failures to the local UI', async (code, reason) => {
    let handler: ((request: unknown, response: unknown) => Promise<void>) | undefined
    const ctx = {
      residentOperators: {
        authenticate: vi.fn(async () => {
          throw new ResidentOperatorError(`login failed with ${code}`, code)
        }),
      },
      webServer: {
        register: vi.fn((route: { handler: typeof handler }) => {
          handler = route.handler
          return () => {}
        }),
      },
      get: () => undefined,
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
    expect(local.status()).toBe(503)
    expect(local.json()).toEqual({
      error: 'RESIDENT_AUTHENTICATION_FAILED',
      reason,
      message: `login failed with ${code}`,
    })
  })

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

  it('serves cached provider catalogs normally and forces a fresh catalog only with refresh=1', async () => {
    const providers = vi.fn()
      .mockResolvedValueOnce([provider('gpt-5.5-stale', ['low', 'medium'])])
      .mockResolvedValueOnce([provider('gpt-5.6-new', ['low', 'medium', 'high', 'ultra'])])
    const authenticate = vi.fn()
    const remoteAuth = {
      authenticate: vi.fn(() => ({ deviceId: 'local', deviceName: 'Local', scope: 'admin' as const })),
    }
    const ctx = {
      residentOperators: {
        providers,
        providerSnapshot: vi.fn()
          .mockReturnValueOnce(undefined)
          .mockReturnValueOnce({
            observedAt: Date.now(),
            providers: [provider('gpt-5.6-new', ['low', 'medium', 'high', 'ultra'])],
          }),
        list: vi.fn(async () => []),
        authenticate,
      },
      webServer: {
        register: vi.fn((route: { handler: typeof handler }) => {
          handler = route.handler
          return () => {}
        }),
      },
      get: (key: string) => key === 'remoteAuth' ? remoteAuth : undefined,
      logger: { warn: vi.fn() },
    } as unknown as Context
    let handler: ((request: unknown, response: unknown) => Promise<void>) | undefined
    registerResidentDashboard(ctx)
    if (handler === undefined) throw new Error('dashboard route was not registered')

    const cachedRequest = responseRecorder()
    await handler(localGet('/api/resident-operators'), cachedRequest.response)
    expect(cachedRequest.status()).toBe(200)
    expect(cachedRequest.json()).toMatchObject({
      providers: [{ models: [{ model: 'gpt-5.5-stale', supportedEfforts: ['low', 'medium'] }] }],
    })

    const cachedAgain = responseRecorder()
    await handler(localGet('/api/resident-operators'), cachedAgain.response)
    expect(cachedAgain.status()).toBe(200)
    expect(cachedAgain.json()).toMatchObject({
      providers: [{ models: [{ model: 'gpt-5.6-new', supportedEfforts: ['low', 'medium', 'high', 'ultra'] }] }],
    })
    expect(providers).toHaveBeenCalledOnce()

    const refreshed = responseRecorder()
    await handler(localGet('/api/resident-operators?refresh=1'), refreshed.response)
    expect(refreshed.status()).toBe(200)
    expect(refreshed.json()).toMatchObject({
      providers: [{ models: [{ model: 'gpt-5.6-new', supportedEfforts: ['low', 'medium', 'high', 'ultra'] }] }],
    })
    expect(providers).toHaveBeenCalledTimes(2)
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('keeps the last good provider cache after a failed refresh and surfaces the failure', async () => {
    const providers = vi.fn()
      .mockResolvedValueOnce([provider('gpt-5.5-stale', ['low', 'medium'])])
      .mockRejectedValueOnce(new Error('fresh catalog unavailable'))
    const authenticate = vi.fn()
    const ctx = {
      residentOperators: {
        providers,
        providerSnapshot: vi.fn(() => undefined),
        list: vi.fn(async () => []),
        authenticate,
      },
      webServer: {
        register: vi.fn((route: { handler: typeof handler }) => {
          handler = route.handler
          return () => {}
        }),
      },
      get: (key: string) => key === 'remoteAuth' ? {
        authenticate: vi.fn(() => ({ deviceId: 'local', deviceName: 'Local', scope: 'admin' as const })),
      } : undefined,
      logger: { warn: vi.fn() },
    } as unknown as Context
    let handler: ((request: unknown, response: unknown) => Promise<void>) | undefined
    registerResidentDashboard(ctx)
    if (handler === undefined) throw new Error('dashboard route was not registered')

    const warm = responseRecorder()
    await handler(localGet('/api/resident-operators'), warm.response)
    expect(warm.status()).toBe(200)

    const failed = responseRecorder()
    await handler(localGet('/api/resident-operators?refresh=1'), failed.response)
    expect(failed.status()).toBe(503)
    expect(failed.json()).toEqual({
      error: 'RESIDENT_DASHBOARD_UNAVAILABLE',
      message: 'fresh catalog unavailable',
    })

    const stale = responseRecorder()
    await handler(localGet('/api/resident-operators'), stale.response)
    expect(stale.status()).toBe(200)
    expect(stale.json()).toMatchObject({
      providers: [{ models: [{ model: 'gpt-5.5-stale', supportedEfforts: ['low', 'medium'] }] }],
    })
    expect(providers).toHaveBeenCalledTimes(2)
    expect(authenticate).not.toHaveBeenCalled()
  })

  it('falls back to a provider query when the central snapshot has expired', async () => {
    const providers = vi.fn(async () => [provider('gpt-5.6-fresh', ['low', 'medium', 'high'])])
    const providerSnapshot = vi.fn(() => ({
      observedAt: Date.now() - 60_001,
      providers: [provider('gpt-5.5-expired', ['low'])],
    }))
    const ctx = {
      residentOperators: {
        providers,
        providerSnapshot,
        list: vi.fn(async () => []),
        authenticate: vi.fn(),
      },
      webServer: {
        register: vi.fn((route: { handler: typeof handler }) => {
          handler = route.handler
          return () => {}
        }),
      },
      get: (key: string) => key === 'remoteAuth' ? {
        authenticate: vi.fn(() => ({ deviceId: 'local', deviceName: 'Local', scope: 'admin' as const })),
      } : undefined,
      logger: { warn: vi.fn() },
    } as unknown as Context
    let handler: ((request: unknown, response: unknown) => Promise<void>) | undefined
    registerResidentDashboard(ctx)
    if (handler === undefined) throw new Error('dashboard route was not registered')

    const response = responseRecorder()
    await handler(localGet('/api/resident-operators'), response.response)

    expect(response.status()).toBe(200)
    expect(response.json()).toMatchObject({
      providers: [{ models: [{ model: 'gpt-5.6-fresh', supportedEfforts: ['low', 'medium', 'high'] }] }],
    })
    expect(providers).toHaveBeenCalledOnce()
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

  it('preserves the trusted provider qualification code for the browser panel', async () => {
    const dashboard = await readResidentDashboard({
      residentOperators: {
        providers: vi.fn(async () => [{
          operatorId: 'claude-code',
          product: 'claude-code',
          displayName: 'Claude Code',
          description: 'Test Resident provider.',
          tags: ['coding'],
          maxConcurrency: 4,
          injectionBoundaries: ['pre-dispatch', 'next-turn'] as const,
          available: false,
          unavailableReason: 'Claude Code model catalog timed out',
          unavailableCode: 'RUNTIME_UNAVAILABLE' as const,
          authentication: 'unqualified' as const,
          supportsExplicitAuthentication: true,
          productVersion: '0.1.0',
          protocolHash: 'test',
          models: [],
        }]),
        list: vi.fn(async () => []),
      },
    } as unknown as Context)

    expect(dashboard.providers).toEqual([expect.objectContaining({
      operatorId: 'claude-code',
      unavailableCode: 'RUNTIME_UNAVAILABLE',
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

describe('native CLI route', () => {
  function register(residentOperators: Record<string, unknown>, withAuth = true) {
    let handler: ((request: unknown, response: unknown) => Promise<void>) | undefined
    const remoteAuth = {
      authenticate: (token: string) => token === 'valid'
        ? { deviceId: 'remote', deviceName: 'Remote', scope: 'admin' as const }
        : undefined,
    }
    const warn = vi.fn()
    registerResidentCliRuntimes({
      residentOperators,
      webServer: {
        register: vi.fn((route: { handler: typeof handler }) => {
          handler = route.handler
          return () => {}
        }),
      },
      get: (key: string) => key === 'remoteAuth' && withAuth ? remoteAuth : undefined,
      logger: { warn },
    } as unknown as Context)
    if (handler === undefined) throw new Error('CLI route was not registered')
    return { handler, warn }
  }

  it('reports versions to authorized readers and updates only for the local owner', async () => {
    const cliRuntimes = vi.fn(async () => [
      { product: 'claude-code', currentVersion: '2.1.239', latestVersion: '2.1.281', updateAvailable: true, managed: false },
    ])
    const updateCli = vi.fn()
      .mockResolvedValueOnce({ product: 'claude-code', version: '2.1.281', status: 'activated' })
      .mockResolvedValueOnce({ product: 'codex', version: '0.160.0', status: 'incompatible', reason: 'missing turn/interrupt' })
    const { handler } = register({ cliRuntimes, updateCli })

    const read = responseRecorder()
    await handler({ ...localGet('/api/resident-operators/cli'), headers: { host: 'server.test', authorization: 'Bearer valid' }, socket: { remoteAddress: '100.64.0.2' } }, read.response)
    expect(read.status()).toBe(200)
    expect(read.json()).toEqual({ runtimes: [
      { product: 'claude-code', currentVersion: '2.1.239', latestVersion: '2.1.281', updateAvailable: true, managed: false },
    ] })

    const remote = responseRecorder()
    await handler({ method: 'POST', url: '/api/resident-operators/cli?product=codex', headers: { host: 'server.test', authorization: 'Bearer valid' }, socket: { remoteAddress: '100.64.0.2' } }, remote.response)
    expect(remote.status()).toBe(403)

    const missing = responseRecorder()
    await handler({ ...localGet('/api/resident-operators/cli?product=cursor'), method: 'POST' }, missing.response)
    expect(missing.status()).toBe(400)
    expect(updateCli).not.toHaveBeenCalled()

    const activated = responseRecorder()
    await handler({ ...localGet('/api/resident-operators/cli?product=claude-code'), method: 'POST' }, activated.response)
    expect(activated.json()).toEqual({ product: 'claude-code', version: '2.1.281', status: 'activated' })
    const refused = responseRecorder()
    await handler({ ...localGet('/api/resident-operators/cli?product=codex'), method: 'POST' }, refused.response)
    expect(refused.json()).toEqual({ product: 'codex', version: '0.160.0', status: 'incompatible', reason: 'missing turn/interrupt' })
    expect(updateCli.mock.calls).toEqual([['claude-code'], ['codex']])
  })

  it('rejects unauthenticated or unsupported requests and reports provider failures', async () => {
    const { handler, warn } = register({
      cliRuntimes: vi.fn(async () => { throw new Error('registry offline') }),
      updateCli: vi.fn(async () => { throw 'daemon gone' }),
    })
    const anonymous = responseRecorder()
    await handler({ method: 'GET', url: '/api/resident-operators/cli', headers: { host: 'server.test' }, socket: { remoteAddress: '100.64.0.2' } }, anonymous.response)
    expect(anonymous.status()).toBe(401)

    const put = responseRecorder()
    await handler({ ...localGet('/api/resident-operators/cli'), method: 'PUT' }, put.response)
    expect(put.status()).toBe(405)

    const read = responseRecorder()
    await handler(localGet('/api/resident-operators/cli'), read.response)
    expect(read.status()).toBe(503)
    expect(read.json()).toEqual({ error: 'RESIDENT_CLI_UNAVAILABLE', message: 'registry offline' })
    const write = responseRecorder()
    await handler({ ...localGet('/api/resident-operators/cli?product=codex'), method: 'POST' }, write.response)
    expect(write.json()).toEqual({ error: 'RESIDENT_CLI_UNAVAILABLE', message: 'daemon gone' })
    expect(warn).toHaveBeenCalledTimes(2)

    const unauthenticated = register({}, false)
    const noAuth = responseRecorder()
    await unauthenticated.handler(localGet('/api/resident-operators/cli'), noAuth.response)
    expect(noAuth.status()).toBe(503)
  })
})

describe('closed-lane recovery route', () => {
  const lane = (patch: Record<string, unknown> = {}) => ({
    sessionId: 'session-1', operatorId: 'codex', workspace: '/project', laneId: 'lane-1', lifecycle: 'idle', health: 'degraded',
    healthReason: 'native_outcome_unconfirmed', stateRevision: 7, updatedAt: '2026-10-14T00:00:00.000Z',
    latestTurn: { commandId: 'command-9', turnId: 'turn-9', state: 'indeterminate', taskLabel: 'Fix parser', updatedAt: '2026-10-14T00:00:00.000Z' },
    ...patch,
  })

  function register(residentOperators: Record<string, unknown>) {
    let handler: ((request: unknown, response: unknown) => Promise<void>) | undefined
    const remoteAuth = {
      authenticate: (token: string) => token === 'valid' ? { deviceId: 'remote', deviceName: 'Remote', scope: 'admin' as const } : undefined,
    }
    registerResidentSessionRecovery({
      residentOperators,
      webServer: { register: vi.fn((route: { handler: typeof handler }) => { handler = route.handler; return () => {} }) },
      get: (key: string) => key === 'remoteAuth' ? remoteAuth : undefined,
      logger: { warn: vi.fn() },
    } as unknown as Context)
    if (handler === undefined) throw new Error('recovery route was not registered')
    const call = async (query: string, options: { remote?: boolean; method?: string } = {}) => {
      const recorded = responseRecorder()
      await handler?.(options.remote === true
        ? { method: options.method ?? 'POST', url: `/api/resident-operators/session-recovery?${query}`, headers: { host: 'server.test', authorization: 'Bearer valid' }, socket: { remoteAddress: '100.64.0.2' } }
        : { method: options.method ?? 'POST', url: `/api/resident-operators/session-recovery?${query}`, headers: { host: '127.0.0.1:13080', origin: 'http://127.0.0.1:13080' }, socket: { remoteAddress: '127.0.0.1' } },
      recorded.response)
      return recorded
    }
    return { call }
  }

  it('answers only the local owner, and only with a session, an action and a revision', async () => {
    const service = { inspect: vi.fn(), resolveIndeterminate: vi.fn(), reset: vi.fn() }
    const { call } = register(service)
    const remote = await call('session_id=session-1&action=reset&revision=7', { remote: true })
    expect(remote.status()).toBe(403)
    expect(remote.json()).toEqual({ error: 'LOCAL_OWNER_REQUIRED' })
    expect((await call('session_id=session-1&action=reset&revision=7', { method: 'GET' })).status()).toBe(405)
    expect((await call('action=reset&revision=7')).json()).toEqual({ error: 'SESSION_REQUIRED' })
    expect((await call('session_id=session-1&revision=7')).json()).toEqual({ error: 'ACTION_REQUIRED' })
    expect((await call('session_id=session-1&action=drop&revision=7')).json()).toEqual({ error: 'ACTION_REQUIRED' })
    expect((await call('session_id=session-1&action=reset&revision=-1')).json()).toEqual({ error: 'REVISION_REQUIRED' })
    expect((await call('session_id=session-1&action=reset&revision=x')).json()).toEqual({ error: 'REVISION_REQUIRED' })
    expect(service.inspect).not.toHaveBeenCalled()
    expect(service.reset).not.toHaveBeenCalled()
    expect(service.resolveIndeterminate).not.toHaveBeenCalled()
  })

  it('refuses a lane that is not closed by an unconfirmed native turn, without calling the service', async () => {
    for (const healthy of [lane({ health: 'ok', healthReason: undefined }), lane({ healthReason: 'process_crashed' })]) {
      const service = { inspect: vi.fn(async () => healthy), resolveIndeterminate: vi.fn(), reset: vi.fn() }
      const { call } = register(service)
      for (const action of ['resolve', 'reset']) {
        const result = await call(`session_id=session-1&action=${action}&revision=7`)
        expect(result.status()).toBe(409)
        expect(result.json()).toMatchObject({ error: 'LANE_NOT_CLOSED' })
      }
      expect(service.reset).not.toHaveBeenCalled()
      expect(service.resolveIndeterminate).not.toHaveBeenCalled()
    }
  })

  it('resolves the lane\'s own latest command, never one named by the caller, at the revision the owner saw', async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce(lane())
      .mockResolvedValueOnce(lane({ health: 'ok', healthReason: undefined, stateRevision: 8 }))
    const service = { inspect, resolveIndeterminate: vi.fn(async () => {}), reset: vi.fn() }
    const { call } = register(service)
    const result = await call('session_id=session-1&action=resolve&revision=7&command_id=attacker-command')
    expect(result.status()).toBe(200)
    expect(result.json()).toMatchObject({ session: { sessionId: 'session-1', health: 'ok', stateRevision: 8 } })
    expect(service.resolveIndeterminate).toHaveBeenCalledWith({ commandId: 'command-9', decision: 'abandon', expectedStateRevision: 7 })
    expect(service.reset).not.toHaveBeenCalled()
  })

  it('refuses to resolve when the latest turn is not the indeterminate one', async () => {
    const service = {
      inspect: vi.fn(async () => lane({ latestTurn: { commandId: 'command-9', turnId: 'turn-9', state: 'settled', updatedAt: '2026-10-14T00:00:00.000Z' } })),
      resolveIndeterminate: vi.fn(), reset: vi.fn(),
    }
    const result = await register(service).call('session_id=session-1&action=resolve&revision=7')
    expect(result.status()).toBe(409)
    expect(result.json()).toMatchObject({ error: 'STATE_CHANGED' })
    expect(service.resolveIndeterminate).not.toHaveBeenCalled()
  })

  it('resets with a fixed reason at the revision the owner saw', async () => {
    const inspect = vi.fn()
      .mockResolvedValueOnce(lane())
      .mockResolvedValueOnce(lane({ health: 'ok', healthReason: undefined, stateRevision: 8 }))
    const service = { inspect, resolveIndeterminate: vi.fn(), reset: vi.fn(async () => lane()) }
    const result = await register(service).call('session_id=session-1&action=reset&revision=7&reason=anything')
    expect(result.status()).toBe(200)
    expect(service.reset).toHaveBeenCalledWith({
      sessionId: 'session-1', expectedStateRevision: 7, reason: 'owner reset of a lane closed by an unconfirmed native turn',
    })
  })

  it('answers a state change as 409, other failures as 503, and a lane that stays closed as not released', async () => {
    const conflicting = {
      inspect: vi.fn(async () => lane()),
      resolveIndeterminate: vi.fn(async () => { throw Object.assign(new Error('revision moved'), { code: 'REVISION_CONFLICT' }) }),
      reset: vi.fn(),
    }
    const conflict = await register(conflicting).call('session_id=session-1&action=resolve&revision=7')
    expect(conflict.status()).toBe(409)
    expect(conflict.json()).toMatchObject({ error: 'STATE_CHANGED' })

    const broken = {
      inspect: vi.fn(async () => lane()), resolveIndeterminate: vi.fn(),
      reset: vi.fn(async () => { throw new Error('daemon down') }),
    }
    const failed = await register(broken).call('session_id=session-1&action=reset&revision=7')
    expect(failed.status()).toBe(503)
    expect(failed.json()).toEqual({ error: 'RESIDENT_RECOVERY_FAILED', message: 'daemon down' })

    const stillClosed = {
      inspect: vi.fn(async () => lane()), resolveIndeterminate: vi.fn(async () => {}), reset: vi.fn(),
    }
    const closed = await register(stillClosed).call('session_id=session-1&action=resolve&revision=7')
    expect(closed.status()).toBe(409)
    expect(closed.json()).toMatchObject({ error: 'LANE_STILL_CLOSED' })
  })

  it('answers a request without a reader as unauthorized, and reads a missing URL as a missing session', async () => {
    let handler: ((request: unknown, response: unknown) => Promise<void>) | undefined
    registerResidentSessionRecovery({
      residentOperators: {},
      webServer: { register: vi.fn((route: { handler: typeof handler }) => { handler = route.handler; return () => {} }) },
      get: () => undefined,
      logger: { warn: vi.fn() },
    } as unknown as Context)
    const denied = responseRecorder()
    await handler?.({ method: 'POST', url: '/x', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, denied.response)
    expect(denied.status()).toBe(503)

    const { call } = register({ inspect: vi.fn() })
    expect((await call('')).json()).toEqual({ error: 'SESSION_REQUIRED' })
  })

  it('reports a failure that is not an Error as its text', async () => {
    const service = {
      inspect: vi.fn(async () => lane()), reset: vi.fn(() => new Promise((_resolve, reject) => { reject('daemon gone') })), resolveIndeterminate: vi.fn(),
    }
    const failed = await register(service).call('session_id=session-1&action=reset&revision=7')
    expect(failed.json()).toEqual({ error: 'RESIDENT_RECOVERY_FAILED', message: 'daemon gone' })
  })

  it('registers the dashboard, CLI and recovery routes as effects of the plugin', () => {
    const labels: string[] = []
    const paths: string[] = []
    const ctx = {
      effect: (run: () => unknown, label: string) => { labels.push(label); run() },
      webServer: { register: vi.fn((route: { path: string }) => { paths.push(route.path); return () => {} }) },
    } as unknown as Context
    apply(ctx)
    expect(labels).toEqual([
      'ui-physical-operator: Resident dashboard route',
      'ui-physical-operator: native CLI route',
      'ui-physical-operator: closed-lane recovery route',
    ])
    expect(paths).toEqual(['/api/resident-operators', '/api/resident-operators/cli', '/api/resident-operators/session-recovery'])
  })

  it('lists a closed lane even when its workspace is a diagnostic one', async () => {
    const closed = lane({ workspace: '/private/tmp/dsh-resident-canary-1' })
    const service = {
      providers: vi.fn(async () => []),
      list: vi.fn(async () => [closed, lane({ sessionId: 'session-2', workspace: '/private/tmp/dsh-resident-canary-2', health: 'ok', healthReason: undefined })]),
      readEvents: vi.fn(async () => ({ events: [], nextSequence: 0 })),
    }
    const dashboard = await readResidentDashboard({ residentOperators: service } as unknown as Context)
    expect(dashboard.sessions.map(value => value.sessionId)).toEqual(['session-1'])
    expect(dashboard.hiddenDiagnosticSessions).toBe(1)
  })
})
