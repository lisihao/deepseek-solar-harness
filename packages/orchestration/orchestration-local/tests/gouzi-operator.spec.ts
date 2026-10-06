/** Grant issuance and the wire request of a Gouzi execution member, against a real store and git repository. */

import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gouziRequestHash } from '@deepseek-ai/dsh-client-connection'
import {
  GouziAuthorityEpoch, GouziHostId, GouziId, GouziOwnerId, type NodeExecutionPlanV1,
} from '@deepseek-ai/dsh-orchestration'
import { PhysicalOperatorExecutionId, type PhysicalOperatorProviderStartRequest } from '@deepseek-ai/dsh-physical-operator'
import { gouziOperatorServer } from '../src/gouzi-operator.ts'
import { RemotePhysicalOperator } from '../src/remote-physical-operator.ts'
import { OrchestrationStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function repository(): Promise<string> {
  const root = await temporary('dsh-gouzi-operator-repo-')
  await writeFile(join(root, 'README.md'), 'fixture\n')
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'DSH Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'dsh-test@example.invalid'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/lisihao/gouzi-fixture.git'], { cwd: root })
  return root
}

const EXECUTION_ID = 'orch:run-1:node-1:1'
const GOUZI = GouziId('gouzi-1')

/** A registered, enabled member plus the attempt and sealed plan the grant is derived from. */
async function registered(): Promise<OrchestrationStore> {
  const store = new OrchestrationStore(await temporary('dsh-gouzi-operator-'))
  store.gouzi.pairHost({
    hostId: GouziHostId('host-1'), label: 'Mac mini',
    authorityEpoch: GouziAuthorityEpoch('epoch-7'), credentialRef: 'gouzi-host-1',
  })
  store.gouzi.create({
    gouziId: GOUZI, ownerId: GouziOwnerId('owner-1'), hostId: GouziHostId('host-1'),
    name: 'Mochi', avatarId: 'shiba', role: 'development', grantDeadlineMs: 60_000,
  })
  store.gouzi.setMembership(GOUZI, 'enabled')
  store.gouzi.setEndpoint(GOUZI, 'http://127.0.0.1:4100/')
  const plan = {
    version: 1, runId: 'run-1', nodeId: 'node-1', attempt: 1, executionId: EXECUTION_ID, operatorPlan: { operatorId: 'gouzi.gouzi-1.codex' },
    effectiveReadScopes: ['src'], effectiveWriteScopes: ['out'],
    effectiveEffects: { read: [], write: [], execute: ['pnpm test'], network: ['registry'], cost: [], risk: ['low'] },
  } as unknown as NodeExecutionPlanV1
  const ref = store.putArtifact(plan)
  store.createRun({
    snapshot: { runId: 'run-1', state: 'running', revision: 1, updatedAt: '2026-10-03T12:00:00.000Z' },
  } as unknown as Parameters<OrchestrationStore['createRun']>[0], [])
  // The fixture needs an attempt row without compiling a whole run.
  store.db.exec('PRAGMA foreign_keys = OFF')
  store.saveAttempt({
    runId: 'run-1', nodeId: 'node-1', attempt: 1, generation: 1, executionId: EXECUTION_ID, state: 'accepted',
    executionPlanRef: String(ref), createdAt: '2026-10-03T12:00:00.000Z', updatedAt: '2026-10-03T12:00:00.000Z',
  })
  return store
}

const PLAN: Parameters<NonNullable<ReturnType<typeof gouziOperatorServer>['gouzi']>['issue']>[0] = {
  commandId: EXECUTION_ID, operatorId: 'codex', laneId: EXECUTION_ID, prompt: [{ type: 'text', text: 'do it' }],
  workspaceIdentity: { version: 1, repository: 'github.com/lisihao/gouzi-fixture', commit: 'a'.repeat(40) },
}
const NOW = Date.parse('2026-10-03T12:00:00.000Z')
const PROJECT = 'b'.repeat(64)
const DIRECTORY_PROVIDER = {
  operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code', tags: [],
  maxConcurrency: 1, injectionBoundaries: [], available: true, authentication: 'native-subscription',
  productVersion: '1', protocolHash: 'h', models: [],
  gouziWorkspace: { gouziId: String(GOUZI), generation: 1, projectId: PROJECT },
}


describe('gouziOperatorServer', () => {
  it('projects the member as a server and seals the attempt in the grant', async () => {
    const store = await registered()
    const server = gouziOperatorServer({ store, gouziId: GOUZI, accessToken: 'token', now: () => NOW })
    expect(server).toMatchObject({ label: 'Mochi', endpoint: 'http://127.0.0.1:4100/', accessToken: 'token' })
    const start = {} as PhysicalOperatorProviderStartRequest
    expect(server.gouzi!.issue(PLAN, start)).toEqual({
      runId: 'run-1', nodeId: 'node-1', attempt: 1, executionId: EXECUTION_ID, gouziId: GOUZI,
      generation: 1, authorityEpoch: 'epoch-7', planHash: gouziRequestHash(PLAN),
      scopes: { read: ['src'], write: ['out'], effects: ['execute:pnpm test', 'network:registry', 'risk:low'] },
      credentialRefs: [], deadline: '2026-10-03T12:01:00.000Z', offlineUntil: '2026-10-03T12:01:00.000Z',
    })
    store.close()
  })

  it('refuses a member that is missing, not enabled, or asked to run something that is not a TaskGraph attempt', async () => {
    const store = await registered()
    expect(() => gouziOperatorServer({ store, gouziId: GouziId('nobody'), accessToken: 't' }))
      .toThrow('is not registered')
    store.gouzi.create({
      gouziId: GouziId('unstarted'), ownerId: GouziOwnerId('owner-1'), hostId: GouziHostId('host-1'),
      name: 'Unstarted', avatarId: 'corgi', role: 'testing', grantDeadlineMs: 60_000,
    })
    expect(() => gouziOperatorServer({ store, gouziId: GouziId('unstarted') })).toThrow('has not been started')
    const server = gouziOperatorServer({ store, gouziId: GOUZI, accessToken: 't' })
    const start = {} as PhysicalOperatorProviderStartRequest
    expect(() => server.gouzi!.issue({ ...PLAN, commandId: 'orch:run-1:node-1:1:rlm:child' }, start))
      .toThrow('TaskGraph attempts only')
    store.gouzi.setMembership(GOUZI, 'retiring')
    expect(() => server.gouzi!.issue(PLAN, start)).toThrow('is not enabled')
    store.close()
  })

  it('rejects a sealed recipient with a stale generation, mismatched operator, or removed registration at grant issuance', async () => {
    const store = await registered()
    const record = store.getRun('run-1')
    store.saveRun({ ...record, snapshot: { ...record.snapshot, admission: {
      policy: 'direct', route: 'taskgraph', sourceSessionId: 'source',
      gouziRecipient: { gouziId: GOUZI, generation: 1, operatorIds: ['gouzi.gouzi-1.codex'] as never },
    } } })
    let available = true
    const server = gouziOperatorServer({ store, gouziId: GOUZI, validateRecipientOperator: id => available && id === 'gouzi.gouzi-1.codex' })
    expect(server.gouzi!.issue(PLAN, {} as PhysicalOperatorProviderStartRequest)).toMatchObject({ generation: 1 })
    expect(() => server.gouzi!.issue({ ...PLAN, operatorId: 'claude' }, {} as PhysicalOperatorProviderStartRequest)).toThrow('unavailable at grant issuance')
    available = false
    expect(() => server.gouzi!.issue(PLAN, {} as PhysicalOperatorProviderStartRequest)).toThrow('unavailable at grant issuance')
    available = true
    store.db.prepare('UPDATE gouzi_members SET generation = 2 WHERE gouzi_id = ?').run(String(GOUZI))
    expect(() => server.gouzi!.issue(PLAN, {} as PhysicalOperatorProviderStartRequest)).toThrow('unavailable at grant issuance')
    store.close()
  })

  it('binds a directory grant to the qualified member generation and default project', async () => {
    const store = await registered()
    const server = gouziOperatorServer({ store, gouziId: GOUZI, now: () => NOW })
    const plan = { ...PLAN, workspaceIdentity: { version: 1 as const, kind: 'gouzi-project' as const, projectId: PROJECT } }
    const start = {} as PhysicalOperatorProviderStartRequest
    const binding = DIRECTORY_PROVIDER.gouziWorkspace
    expect(server.gouzi!.issue(plan, start, binding)).toMatchObject({ planHash: gouziRequestHash(plan), generation: 1 })
    for (const invalid of [undefined, { ...binding, projectId: 'c'.repeat(64) }, { ...binding, generation: 2 }, { ...binding, gouziId: 'other' }]) {
      expect(() => server.gouzi!.issue(plan, start, invalid)).toThrow('project or generation is unavailable')
    }
    store.close()
  })

  it('reads the generation and epoch again for every attempt', async () => {
    const store = await registered()
    const server = gouziOperatorServer({ store, gouziId: GOUZI, accessToken: 't', now: () => NOW })
    store.db.prepare('UPDATE gouzi_members SET generation = 2 WHERE gouzi_id = ?').run(String(GOUZI))
    store.db.prepare("UPDATE gouzi_hosts SET authority_epoch = 'epoch-8' WHERE host_id = 'host-1'").run()
    expect(server.gouzi!.issue(PLAN, {} as PhysicalOperatorProviderStartRequest))
      .toMatchObject({ generation: 2, authorityEpoch: 'epoch-8' })
    store.close()
  })
})

describe('RemotePhysicalOperator for a gouzi member', () => {
  it('does not post execution when a sealed member changes generation during project qualification', async () => {
    const store = await registered()
    const record = store.getRun('run-1')
    store.saveRun({ ...record, snapshot: { ...record.snapshot, admission: {
      policy: 'direct', route: 'taskgraph', sourceSessionId: 'source',
      gouziRecipient: { gouziId: GOUZI, generation: 1, operatorIds: ['gouzi.gouzi-1.codex'] as never },
    } } })
    const repo = await repository()
    let posts = 0
    const request: typeof fetch = (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body')
      const call = JSON.parse(init.body) as { method: string; rpcId: string }
      if (call.method === 'operator.providers') {
        return Promise.resolve(Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value: [DIRECTORY_PROVIDER] } }))
      }
      posts++
      throw new Error('execution must not be posted')
    }
    const server = gouziOperatorServer({ store, gouziId: GOUZI, validateRecipientOperator: () => true })
    const operator = new RemotePhysicalOperator(server, {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code', tags: [],
      maxConcurrency: 1, injectionBoundaries: [], available: true, authentication: 'native-subscription',
      productVersion: '1', protocolHash: 'h', models: [],
    } as never, store, request)
    const starting = operator.start({
      executionId: PhysicalOperatorExecutionId(EXECUTION_ID), parent: { session: { header: { cwd: repo } } },
      prompt: [], signal: new AbortController().signal,
    } as unknown as PhysicalOperatorProviderStartRequest)
    store.db.prepare('UPDATE gouzi_members SET generation = 2 WHERE gouzi_id = ?').run(String(GOUZI))
    await expect(starting).rejects.toThrow('unavailable at grant issuance')
    expect(posts).toBe(0)
    store.close()
  })

  it.each(['rejected', 'unknown'] as const)('reports remote %s admission after one execute without replay', async (outcome) => {
    const store = await registered()
    const record = store.getRun('run-1')
    store.saveRun({ ...record, snapshot: { ...record.snapshot, admission: {
      policy: 'direct', route: 'taskgraph', sourceSessionId: 'source',
      gouziRecipient: { gouziId: GOUZI, generation: 1, operatorIds: ['gouzi.gouzi-1.codex'] as never },
    } } })
    const repo = await repository()
    const methods: string[] = []
    const request: typeof fetch = (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body')
      const call = JSON.parse(init.body) as { method: string; rpcId: string }
      methods.push(call.method)
      if (call.method === 'operator.providers') {
        return Promise.resolve(Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value: [DIRECTORY_PROVIDER] } }))
      }
      if (outcome === 'unknown') throw new Error('reply lost')
      return Promise.resolve(Response.json({ type: 'server-response', rpcId: call.rpcId,
        result: { ok: false, error: { code: 'internal', message: 'Provider unavailable', details: {} } } }))
    }
    const server = gouziOperatorServer({ store, gouziId: GOUZI, validateRecipientOperator: () => true })
    const operator = new RemotePhysicalOperator(server, {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code', tags: [],
      maxConcurrency: 1, injectionBoundaries: [], available: true, authentication: 'native-subscription',
      productVersion: '1', protocolHash: 'h', models: [],
    } as never, store, request)
    await expect(operator.start({
      executionId: PhysicalOperatorExecutionId(EXECUTION_ID), parent: { session: { header: { cwd: repo } } },
      prompt: [], signal: new AbortController().signal,
    } as unknown as PhysicalOperatorProviderStartRequest)).rejects.toMatchObject({
      code: outcome === 'rejected' ? 'OPERATOR_UNAVAILABLE' : 'COMMAND_INDETERMINATE',
    })
    expect(methods).toEqual(['operator.providers', 'operator.execute'])
    store.close()
  })

  it('is addressed as gouzi.<id>.<operator> and sends a grant sealing the exact request it posts', async () => {
    const store = await registered()
    const repo = await repository()
    const posted: Record<string, { payload: Record<string, unknown> }> = {}
    const fetchFake: typeof fetch = (input, init) => {
      const body = JSON.parse(init?.body as string) as { rpcId: string; method: string; payload: Record<string, unknown> }
      posted[body.method] = body
      const value = body.method === 'operator.providers'
        ? [DIRECTORY_PROVIDER]
        : body.method === 'operator.execute'
          ? { sessionId: 'resident-session', turnId: 'resident-turn', stateRevision: 1 }
          : { commandId: EXECUTION_ID, sessionId: 'resident-session', turnId: 'resident-turn', state: 'running', stateRevision: 1, updatedAt: '2026-10-03T12:00:00.000Z' }
      void input
      return Promise.resolve(new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })))
    }
    const server = gouziOperatorServer({ store, gouziId: GOUZI, accessToken: 'token', now: () => NOW })
    const operator = new RemotePhysicalOperator(server, {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code operator', tags: ['code'],
      maxConcurrency: 1, injectionBoundaries: [], available: true, authentication: 'native-subscription',
      productVersion: '1', protocolHash: 'h', models: [],
    } as never, store, fetchFake)
    expect(String(operator.descriptor.id)).toBe('gouzi.gouzi-1.codex')
    expect(operator.descriptor.tags).toEqual(expect.arrayContaining(['gouzi', 'gouzi.gouzi-1', 'remote']))

    const run = await operator.start({
      executionId: PhysicalOperatorExecutionId(EXECUTION_ID),
      parent: { session: { header: { cwd: repo } } },
      prompt: [{ type: 'text', text: 'do it' }],
      signal: new AbortController().signal,
    } as unknown as PhysicalOperatorProviderStartRequest)
    const detached = run.result.then(() => undefined, (error: unknown) => error)
    await run.dispose()
    expect(String(await detached)).toContain('observer detached')

    const payload = posted['operator.execute']!.payload
    const { gouziGrant, protocol: _protocol, ...request } = payload
    expect(request).toMatchObject({ commandId: EXECUTION_ID, operatorId: 'codex', workspaceIdentity: { version: 1, kind: 'gouzi-project', projectId: PROJECT } })
    expect(gouziGrant).toMatchObject({
      gouziId: 'gouzi-1', generation: 1, authorityEpoch: 'epoch-7', executionId: EXECUTION_ID,
      planHash: gouziRequestHash(request as never),
    })
    store.close()
  })

  it('preserves exact-commit execution for an existing Gouzi Git allowlist without a registered directory', async () => {
    const store = await registered()
    const repo = await repository()
    const { gouziWorkspace: _directory, ...legacyProvider } = DIRECTORY_PROVIDER
    let sent: Record<string, unknown> | undefined
    const request: typeof fetch = (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body')
      const call = JSON.parse(init.body) as { method: string; rpcId: string; payload: Record<string, unknown> }
      if (call.method === 'operator.execute') sent = call.payload
      const value = call.method === 'operator.providers' ? [legacyProvider]
        : call.method === 'operator.execute' ? { sessionId: 's', turnId: 't', stateRevision: 1 }
          : { commandId: EXECUTION_ID, sessionId: 's', turnId: 't', state: 'running', stateRevision: 1, updatedAt: '2026-10-03T12:00:00.000Z' }
      return Promise.resolve(Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } }))
    }
    const operator = new RemotePhysicalOperator(gouziOperatorServer({ store, gouziId: GOUZI }), legacyProvider as never, store, request)
    const run = await operator.start({
      executionId: PhysicalOperatorExecutionId(EXECUTION_ID), parent: { session: { header: { cwd: repo } } },
      prompt: [], signal: new AbortController().signal,
    } as unknown as PhysicalOperatorProviderStartRequest)
    const detached = run.result.catch(() => undefined)
    await run.dispose()
    await detached
    expect(sent?.workspaceIdentity).toMatchObject({ repository: 'github.com/lisihao/gouzi-fixture', commit: expect.stringMatching(/^[a-f0-9]{40}$/u) as unknown })
    expect(sent?.workspaceIdentity).not.toHaveProperty('kind')
    expect(sent?.gouziGrant).toMatchObject({ gouziId: String(GOUZI), generation: 1 })
    store.close()
  })

  it('keeps the remote.<server>.<operator> address and sends no grant for an ordinary server', async () => {
    const store = await registered()
    const repo = await repository()
    let sent: Record<string, unknown> | undefined
    const fetchFake: typeof fetch = (_input, init) => {
      const body = JSON.parse(init?.body as string) as { rpcId: string; method: string; payload: Record<string, unknown> }
      if (body.method === 'operator.execute') sent = body.payload
      const value = body.method === 'operator.execute'
        ? { sessionId: 's', turnId: 't', stateRevision: 1 }
        : { commandId: EXECUTION_ID, sessionId: 's', turnId: 't', state: 'running', stateRevision: 1, updatedAt: '2026-10-03T12:00:00.000Z' }
      return Promise.resolve(new Response(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })))
    }
    const operator = new RemotePhysicalOperator(
      { id: 'mini', label: 'Mini', endpoint: 'http://127.0.0.1:1/' },
      {
        operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'd', tags: [], maxConcurrency: 1,
        injectionBoundaries: [], available: true, authentication: 'native-subscription', productVersion: '1',
        protocolHash: 'h', models: [],
      } as never,
      store,
      fetchFake,
    )
    expect(String(operator.descriptor.id)).toBe('remote.mini.codex')
    const run = await operator.start({
      executionId: PhysicalOperatorExecutionId(EXECUTION_ID),
      parent: { session: { header: { cwd: repo } } },
      prompt: [], signal: new AbortController().signal,
    } as unknown as PhysicalOperatorProviderStartRequest)
    const detached = run.result.then(() => undefined, (error: unknown) => error)
    await run.dispose()
    expect(String(await detached)).toContain('observer detached')
    expect(sent).not.toHaveProperty('gouziGrant')
    store.close()
  })
})
