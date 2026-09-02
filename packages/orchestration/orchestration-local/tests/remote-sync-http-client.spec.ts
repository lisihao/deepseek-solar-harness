/** Node-safe remote Resident client behavior. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createRemotePhysicalOperators } from '../src/remote-physical-operator.ts'
import { RemoteSyncHttpClient } from '../src/remote-sync-http-client.ts'
import { OrchestrationStore } from '../src/store.ts'

function fixtureStore(): OrchestrationStore {
  return new OrchestrationStore(mkdtempSync(join(tmpdir(), 'dsh-remote-result-store-')))
}

function fixtureWorkspace(): { readonly workspace: string; readonly store: OrchestrationStore } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-remote-workspace-'))
  mkdirSync(join(root, 'packages', 'core'), { recursive: true })
  writeFileSync(join(root, 'packages', 'core', 'fixture.txt'), 'fixture\n')
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'DSH Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'dsh-test@example.invalid'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root })
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:lisihao/remote-fixture.git'], { cwd: root })
  return { workspace: join(root, 'packages', 'core'), store: fixtureStore() }
}

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
      commandId: 'command-1', operatorId: 'codex', laneId: 'lane-1', prompt: [],
      workspaceIdentity: {
        version: 1, repository: 'github.com/lisihao/remote-fixture', commit: 'a'.repeat(40),
      },
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
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string }
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
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string }
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
    const fixture = fixtureWorkspace()
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
    }, fixture.store, request)
    expect(operator?.descriptor.id).toBe('remote.mini.codex')
    await expect(operator?.residentCatalog()).resolves.toMatchObject({
      operatorId: 'remote.mini.codex', location: 'remote', supportsModelToolBridge: false,
      supportsWorkspaceMutationReturn: false, quotaPools: [{ poolId: 'remote.mini.spark' }],
    })
    const controller = new AbortController()
    const run = await operator!.start({
      executionId: 'command-1' as never,
      mode: 'resident', prompt: [], signal: controller.signal,
      nativeToolPolicy: 'disabled',
      parent: { session: { header: { cwd: fixture.workspace } } } as never,
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
    const executeBody = JSON.parse(request.mock.calls.find(([, init]) => {
      if (typeof init?.body !== 'string') return false
      return (JSON.parse(init.body) as { method: string }).method === 'operator.execute'
    })?.[1]?.body as string) as { payload: Record<string, unknown> }
    expect(executeBody.payload).not.toHaveProperty('workspace')
    expect(executeBody.payload.nativeToolPolicy).toBe('disabled')
    expect(executeBody.payload.workspaceIdentity).toMatchObject({
      version: 1, repository: 'github.com/lisihao/remote-fixture', subdir: 'packages/core',
    })
    fixture.store.close()
  }, 15_000)

  it('rejects a local DSH-tool-authoritative policy before remote admission', async () => {
    const fixture = fixtureWorkspace()
    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code operator',
      tags: ['code'], maxConcurrency: 1, injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true, authentication: 'native-subscription', productVersion: '0.200.0', protocolHash: 'schema-1',
      models: [{
        model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Fast worker',
        supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true,
        supportsAdaptiveThinking: true,
      }],
    }
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: call.rpcId, result: { ok: true, value: [provider] },
      })
    })
    const [operator] = await createRemotePhysicalOperators({
      id: 'mini', label: 'Mac mini', endpoint: 'https://mini.example', pollIntervalMs: 1,
    }, fixture.store, request)
    await expect(operator!.start({
      executionId: 'command-authority' as never,
      mode: 'resident', prompt: [], signal: new AbortController().signal,
      nativeToolPolicy: 'dsh-tools-authoritative',
      parent: { session: { header: { cwd: fixture.workspace } } } as never,
    })).rejects.toMatchObject({ code: 'OPERATOR_MODE_UNSUPPORTED' })
    expect(request).toHaveBeenCalledTimes(1)
    fixture.store.close()
  })

  it('isolates an unavailable member catalog and restores it after qualification recovers', async () => {
    const store = fixtureStore()
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
    }, store, request)

    const unavailableCatalog = await operator?.residentCatalog()
    expect(unavailableCatalog).toMatchObject({ operatorId: 'remote.mini.codex', available: false })
    expect(unavailableCatalog?.unavailableReason).toContain('qualification failed')
    expect(operator?.availability()).toMatchObject({ available: false })
    await expect(operator?.residentCatalog()).resolves.toMatchObject({
      operatorId: 'remote.mini.codex', available: true,
    })
    expect(operator?.availability()).toEqual({ available: true })
    store.close()
  })

  it('keeps an accepted remote turn attached across a transient transport outage', async () => {
    const fixture = fixtureWorkspace()
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
    }, fixture.store, request)
    const run = await operator!.start({
      executionId: 'command-1' as never,
      mode: 'resident', prompt: [], signal: new AbortController().signal,
      parent: { session: { header: { cwd: fixture.workspace } } } as never,
    })

    await expect(run.result).resolves.toMatchObject({
      output: [{ type: 'text', text: 'done after reconnect' }],
    })
    expect(methods.filter(value => value === 'operator.execute')).toHaveLength(1)
    expect(methods.filter(value => value === 'operator.inspect')).toHaveLength(2)
    fixture.store.close()
  })

  it('downloads, verifies, expands, and locally persists an oversized remote result artifact', async () => {
    const fixture = fixtureWorkspace()
    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code operator',
      tags: ['code'], maxConcurrency: 1, injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true, authentication: 'native-subscription', productVersion: '0.200.0', protocolHash: 'schema-1',
      models: [{
        model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Fast worker', supportedEfforts: ['medium'],
        defaultEffort: 'medium', isDefault: true, supportsAdaptiveThinking: true,
      }],
    }
    const complete = {
      output: [{ type: 'text', text: 'complete artifact output' }],
      stopReason: 'completed',
      usage: { inputTokens: 17, outputTokens: 9, cacheReadInputTokens: 3, costUsd: 0.02 },
    }
    const json = JSON.stringify(complete)
    const remoteRef = `sha256:${createHash('sha256').update(json).digest('hex')}`
    const methods: string[] = []
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string }
      methods.push(call.method)
      const value = call.method === 'operator.providers' ? [provider]
        : call.method === 'operator.execute'
          ? { sessionId: 'session-artifact', turnId: 'turn-artifact', stateRevision: 1 }
          : call.method === 'operator.inspect'
            ? {
              commandId: 'command-artifact', sessionId: 'session-artifact', turnId: 'turn-artifact',
              state: 'settled', stateRevision: 2, updatedAt: '2026-08-27T12:00:01.000Z',
              resultRef: remoteRef,
              result: {
                output: [{ type: 'text', text: `Resident result stored at ${remoteRef}.` }],
                stopReason: 'completed', resultRef: remoteRef,
              },
            }
            : call.method === 'operator.artifact.read'
              ? { ref: remoteRef, json }
              : { interrupted: true }
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
    })
    const [operator] = await createRemotePhysicalOperators({
      id: 'mini', label: 'Mac mini', endpoint: 'https://mini.example', pollIntervalMs: 1,
    }, fixture.store, request)
    const run = await operator!.start({
      executionId: 'command-artifact' as never,
      mode: 'resident', prompt: [], signal: new AbortController().signal,
      parent: { session: { header: { cwd: fixture.workspace } } } as never,
    })
    await expect(run.result).resolves.toMatchObject({
      output: [{ type: 'text', text: 'complete artifact output' }],
      usage: { inputTokens: 17, outputTokens: 9, cacheReadInputTokens: 3, costUsd: 0.02 },
    })
    expect(methods).toContain('operator.artifact.read')
    const indexed = fixture.store.db.prepare('SELECT artifact_ref FROM compilation_artifacts').all() as { artifact_ref: string }[]
    expect(indexed).toHaveLength(1)
    expect(fixture.store.readArtifact(indexed[0]!.artifact_ref as never)).toMatchObject({
      kind: 'remote-physical-operator-result', serverId: 'mini', remoteResultRef: remoteRef, result: complete,
    })
    fixture.store.close()
  })

  it('marks an uncorrelated admission loss indeterminate instead of replaying remotely', async () => {
    const fixture = fixtureWorkspace()
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
    }, fixture.store, request)

    await expect(operator!.start({
      executionId: 'command-1' as never,
      mode: 'resident', prompt: [], signal: new AbortController().signal,
      parent: { session: { header: { cwd: fixture.workspace } } } as never,
    })).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    expect(executeCalls).toBe(1)
    fixture.store.close()
  })
})
