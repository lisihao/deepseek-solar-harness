/** Node-safe remote Resident client behavior. */

import { describe, expect, it, vi } from 'vitest'
import { createRemotePhysicalOperators } from '../src/remote-physical-operator.ts'
import { RemoteSyncHttpClient } from '../src/remote-sync-http-client.ts'

describe('RemoteSyncHttpClient', () => {
  it('uses authenticated correlated requests for the durable operator lifecycle', async () => {
    const methods: string[] = []
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer access')
      const call = JSON.parse(init.body) as { rpcId: string; method: string }
      methods.push(call.method)
      const value = call.method === 'operator.providers' ? [{
        operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code operator',
        tags: ['code'], maxConcurrency: 2, injectionBoundaries: ['pre-dispatch', 'next-turn'],
        available: true, authentication: 'native-subscription', productVersion: '0.200.0', protocolHash: 'schema-1',
        models: [{
          model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Fast worker',
          supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true,
          supportsAdaptiveThinking: true,
        }],
      }] : call.method === 'operator.execute'
        ? { sessionId: 'session-1', turnId: 'turn-1', stateRevision: 2 }
        : call.method === 'operator.inspect'
          ? {
            commandId: 'command-1', sessionId: 'session-1', turnId: 'turn-1',
            state: 'settled', stateRevision: 3, stopReason: 'completed',
            updatedAt: '2026-08-27T12:00:00.000Z',
            result: { output: [], stopReason: 'completed' },
          }
          : call.method === 'operator.events'
            ? { events: [], nextSequence: 0 }
            : { interrupted: true }
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
    })
    const client = new RemoteSyncHttpClient('https://server.example/base', 'access', request)

    await expect(client.operatorProviders()).resolves.toMatchObject([{ operatorId: 'codex' }])
    await expect(client.operatorExecute({
      commandId: 'command-1', operatorId: 'codex', workspace: '/repo', laneId: 'lane-1', prompt: [],
    })).resolves.toMatchObject({ turnId: 'turn-1' })
    await expect(client.operatorInspect('turn-1')).resolves.toMatchObject({ state: 'settled' })
    await expect(client.operatorEvents('session-1', 0, 100)).resolves.toEqual({ events: [], nextSequence: 0 })
    await expect(client.operatorInterrupt('session-1', 'turn-1')).resolves.toBeUndefined()
    expect(methods).toEqual([
      'operator.providers', 'operator.execute', 'operator.inspect', 'operator.events', 'operator.interrupt',
    ])
    expect(request.mock.calls.map(([input]) => input instanceof URL
      ? input.href
      : typeof input === 'string'
        ? input
        : input.url)).toEqual([
      'https://server.example/remote-sync/operator.providers',
      'https://server.example/remote-sync/operator.execute',
      'https://server.example/remote-sync/operator.inspect',
      'https://server.example/remote-sync/operator.events',
      'https://server.example/remote-sync/operator.interrupt',
    ])
  })

  it('fails loud on transport, correlation, and remote protocol errors', async () => {
    const transport = new RemoteSyncHttpClient('https://server.example', undefined, async () => (
      new Response('offline', { status: 503 })
    ))
    await expect(transport.operatorProviders()).rejects.toThrow('HTTP 503')

    const mismatch = new RemoteSyncHttpClient('https://server.example', undefined, async () => Response.json({
      type: 'server-response', rpcId: 'different', result: { ok: true, value: [] },
    }))
    await expect(mismatch.operatorProviders()).rejects.toThrow('rpcId mismatch')

    const remote = new RemoteSyncHttpClient('https://server.example', undefined, async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: call.rpcId,
        result: { ok: false, error: { code: 'internal', message: 'SESSION_BUSY: busy', details: {} } },
      })
    })
    await expect(remote.operatorProviders()).rejects.toThrow('internal: SESSION_BUSY: busy')
  })

  it('validates vote and heartbeat responses at the remote cluster boundary', async () => {
    const client = new RemoteSyncHttpClient('https://server.example', undefined, async (_input, init) => {
      const call = JSON.parse(String(init?.body)) as { rpcId: string; method: string }
      const value = call.method === 'cluster.vote'
        ? { term: 2, voterId: 'b', granted: true, commitIndex: 7 }
        : call.method === 'cluster.heartbeat'
          ? { term: 2, followerId: 'b', accepted: true, commitIndex: 7 }
          : { nodeId: 'b', commitIndex: 7, state: 'applied' }
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
    })
    await expect(client.clusterRequestVote({ term: 2, candidateId: 'a', commitIndex: 7 }))
      .resolves.toEqual({ term: 2, voterId: 'b', granted: true, commitIndex: 7 })
    await expect(client.clusterHeartbeat({ term: 2, leaderId: 'a', commitIndex: 7, leaseUntil: 10_000 }))
      .resolves.toEqual({ term: 2, followerId: 'b', accepted: true, commitIndex: 7 })
    await expect(client.clusterInstallReplica({ term: 2, leaderId: 'a', replica: {} as never }))
      .resolves.toEqual({ nodeId: 'b', commitIndex: 7, state: 'applied' })

    const invalid = new RemoteSyncHttpClient('https://server.example', undefined, async (_input, init) => {
      const call = JSON.parse(String(init?.body)) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: call.rpcId,
        result: { ok: true, value: { term: 2, voterId: 'b', granted: 'yes', commitIndex: 7 } },
      })
    })
    await expect(invalid.clusterRequestVote({ term: 2, candidateId: 'a', commitIndex: 7 }))
      .rejects.toThrow('granted must be boolean')
  })
})

describe('RemotePhysicalOperator', () => {
  it('projects a namespaced catalog and reconnectable remote run through the generic seam', async () => {
    let inspections = 0
    const methods: string[] = []
    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code operator',
      tags: ['code'], maxConcurrency: 2, injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true, authentication: 'native-subscription', productVersion: '0.200.0', protocolHash: 'schema-1',
      models: [{
        model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Fast worker',
        supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true,
        supportsAdaptiveThinking: true,
      }],
      quotaPools: [{
        poolId: 'spark', displayName: 'Spark', models: ['gpt-5.6-luna'], meter: 'native-subscription',
        observedAt: '2026-08-27T12:00:00.000Z', primary: { usedPercent: 10 },
      }],
    }
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string }
      methods.push(call.method)
      const value = call.method === 'operator.providers' ? [provider]
        : call.method === 'operator.execute'
          ? { sessionId: 'session-1', turnId: 'turn-1', stateRevision: 2 }
          : call.method === 'operator.inspect'
            ? ++inspections === 1
              ? {
                commandId: 'command-1', sessionId: 'session-1', turnId: 'turn-1', state: 'running',
                stateRevision: 2, updatedAt: '2026-08-27T12:00:00.000Z',
              }
              : {
                commandId: 'command-1', sessionId: 'session-1', turnId: 'turn-1', state: 'settled',
                stateRevision: 3, updatedAt: '2026-08-27T12:00:01.000Z',
                result: { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' },
              }
            : call.method === 'operator.events'
              ? {
                events: [{
                  sequence: 1, sessionId: 'session-1', type: 'turn.progress',
                  time: '2026-08-27T12:00:00.000Z', data: { phase: 'reasoning' },
                }],
                nextSequence: 1,
              }
              : { interrupted: true }
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
    })
    const [operator] = await createRemotePhysicalOperators({
      id: 'mini', label: 'Mac mini', endpoint: 'https://mini.example', accessToken: 'access', pollIntervalMs: 1,
    }, request)
    expect(operator?.descriptor.id).toBe('remote.mini.codex')
    await expect(operator?.residentCatalog()).resolves.toMatchObject({
      operatorId: 'remote.mini.codex', location: 'remote', supportsModelToolBridge: false,
      supportsWorkspaceMutationReturn: false, quotaPools: [{ poolId: 'remote.mini.spark' }],
    })
    const controller = new AbortController()
    const run = await operator!.start({
      executionId: 'command-1' as never,
      mode: 'resident', prompt: [], signal: controller.signal,
      parent: { session: { header: { cwd: '/repo' } } } as never,
    })
    expect(run.receipt).toEqual({ sessionId: 'session-1', turnId: 'turn-1', stateRevision: 2 })
    await expect(run.readEvents?.(0, 100)).resolves.toMatchObject({
      events: [{ type: 'turn.progress', data: { phase: 'reasoning' } }],
    })
    await expect(run.result).resolves.toMatchObject({
      output: [{ type: 'text', text: 'done' }], continuity: { sessionId: 'session-1', stateRevision: 3 },
    })
    await run.dispose()
    expect(methods).toEqual([
      'operator.providers', 'operator.providers', 'operator.execute', 'operator.inspect',
      'operator.events', 'operator.inspect',
    ])
  })

  it('isolates an unavailable member catalog and restores it after qualification recovers', async () => {
    let providerReads = 0
    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code operator',
      tags: ['code'], maxConcurrency: 2, injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true, authentication: 'native-subscription', productVersion: '0.200.0', protocolHash: 'schema-1',
      models: [{
        model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Fast worker',
        supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true,
        supportsAdaptiveThinking: true,
      }],
    }
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string }
      if (call.method !== 'operator.providers') throw new Error(`unexpected method ${call.method}`)
      providerReads += 1
      if (providerReads === 2) throw new TypeError('network offline')
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value: [provider] } })
    })
    const [operator] = await createRemotePhysicalOperators({
      id: 'mini', label: 'Mac mini', endpoint: 'https://mini.example', pollIntervalMs: 1,
    }, request)

    await expect(operator?.residentCatalog()).resolves.toMatchObject({
      operatorId: 'remote.mini.codex', available: false,
      unavailableReason: expect.stringContaining('qualification failed'),
    })
    expect(operator?.availability()).toMatchObject({ available: false })
    await expect(operator?.residentCatalog()).resolves.toMatchObject({
      operatorId: 'remote.mini.codex', available: true,
    })
    expect(operator?.availability()).toEqual({ available: true })
  })

  it('keeps an accepted remote turn attached across a transient transport outage', async () => {
    let inspections = 0
    const methods: string[] = []
    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code operator',
      tags: ['code'], maxConcurrency: 2, injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true, authentication: 'native-subscription', productVersion: '0.200.0', protocolHash: 'schema-1',
      models: [{
        model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Fast worker',
        supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true,
        supportsAdaptiveThinking: true,
      }],
    }
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string }
      methods.push(call.method)
      if (call.method === 'operator.inspect' && ++inspections === 1) throw new TypeError('temporary disconnect')
      const value = call.method === 'operator.providers' ? [provider]
        : call.method === 'operator.execute'
          ? { sessionId: 'session-1', turnId: 'turn-1', stateRevision: 1 }
          : {
            commandId: 'command-1', sessionId: 'session-1', turnId: 'turn-1', state: 'settled',
            stateRevision: 2, updatedAt: '2026-08-27T12:00:01.000Z',
            result: { output: [{ type: 'text', text: 'done after reconnect' }], stopReason: 'completed' },
          }
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
    })
    const [operator] = await createRemotePhysicalOperators({
      id: 'mini', label: 'Mac mini', endpoint: 'https://mini.example', pollIntervalMs: 1,
    }, request)
    const run = await operator!.start({
      executionId: 'command-1' as never,
      mode: 'resident', prompt: [], signal: new AbortController().signal,
      parent: { session: { header: { cwd: '/repo' } } } as never,
    })

    await expect(run.result).resolves.toMatchObject({
      output: [{ type: 'text', text: 'done after reconnect' }],
    })
    expect(methods.filter(value => value === 'operator.execute')).toHaveLength(1)
    expect(methods.filter(value => value === 'operator.inspect')).toHaveLength(2)
  })

  it('marks an uncorrelated admission loss indeterminate instead of replaying remotely', async () => {
    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code operator',
      tags: ['code'], maxConcurrency: 2, injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true, authentication: 'native-subscription', productVersion: '0.200.0', protocolHash: 'schema-1',
      models: [{
        model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Fast worker',
        supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true,
        supportsAdaptiveThinking: true,
      }],
    }
    let executeCalls = 0
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string }
      if (call.method === 'operator.execute') {
        executeCalls += 1
        throw new TypeError('connection reset after write')
      }
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value: [provider] } })
    })
    const [operator] = await createRemotePhysicalOperators({
      id: 'mini', label: 'Mac mini', endpoint: 'https://mini.example', pollIntervalMs: 1,
    }, request)

    await expect(operator!.start({
      executionId: 'command-1' as never,
      mode: 'resident', prompt: [], signal: new AbortController().signal,
      parent: { session: { header: { cwd: '/repo' } } } as never,
    })).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    expect(executeCalls).toBe(1)
  })
})
