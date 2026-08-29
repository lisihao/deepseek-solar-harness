import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelWorkerExecuteRequest, ModelWorkerProvider, ModelWorkerResult } from '@deepseek-ai/dsh-model-worker'
import {
  OrchestrationArtifactRef,
  type LogicalTaskGraphV1,
  type OrchestrationExecutionEvidenceV1,
} from '@deepseek-ai/dsh-orchestration'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { OrchestrationDaemonClient } from '../src/client.ts'
import { canonicalSha256 } from '../src/canonical.ts'
import type { OrchestrationClusterPeerTransport } from '../src/cluster.ts'
import { OrchestrationDaemon } from '../src/daemon.ts'
import type { RemotePhysicalOperatorServer } from '../src/remote-physical-operator.ts'

const cleanup: Array<() => Promise<void>> = []
const run = promisify(execFile)
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
  vi.unstubAllGlobals()
})

type TestResult = {
  output: Array<{ type: 'text'; text: string }>
  stopReason: 'completed'
  usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; costUsd?: number }
}
interface FakeResidentRequest {
  commandId: string
  operatorId: string
  laneId?: string
  profile?: { model: string }
  prompt?: Array<{ type: string; text?: string }>
  modelToolBridge?: { version: 1; socketPath: string; sessionId: string; tools: readonly { name: string }[] }
  workspace: string
}

async function callRlmTool(
  request: Pick<FakeResidentRequest, 'modelToolBridge'>,
  commandId: string,
  code: string,
): Promise<unknown> {
  const bridge = request.modelToolBridge
  if (bridge === undefined) throw new Error('fixture expected a model-tool bridge')
  const socket = createConnection(bridge.socketPath)
  await once(socket, 'connect')
  const transport = new JsonRpcLineTransport(socket, socket)
  transport.start()
  try {
    return await transport.request('tool.call', {
      session_id: bridge.sessionId,
      command_id: commandId,
      tool: 'typescript_repl',
      arguments: { code },
    })
  } finally {
    transport.close()
    socket.destroy()
  }
}

class FakeResidentClient {
  starts: string[] = []
  requests: FakeResidentRequest[] = []
  available = true
  maxConcurrency = 4
  unavailableOperators = new Set<string>()
  defer = false
  failNext = 0
  failNextCode = 'RUNTIME_UNAVAILABLE'
  claudeQuotaKnown = true
  onExecute?: (request: FakeResidentRequest) => Promise<void>
  private readonly deferredResolvers: Array<() => void> = []
  turns = new Map<string, { state: 'running' | 'settled'; result?: TestResult }>()
  residentEvents = new Map<string, Array<{
    sequence: number
    sessionId: string
    type: string
    time: string
    data: Record<string, unknown>
  }>>()

  async providers() {
    return ['codex', 'claude-code'].map(operatorId => ({
      operatorId,
      product: operatorId,
      displayName: operatorId === 'codex' ? 'Codex' : 'Claude Code',
      description: 'Test Resident provider.',
      tags: operatorId === 'codex' ? ['coding'] : ['analysis'],
      maxConcurrency: this.maxConcurrency,
      injectionBoundaries: ['pre-dispatch', 'next-turn'] as const,
      available: this.available && !this.unavailableOperators.has(operatorId),
      authentication: 'native-subscription',
      productVersion: 'test',
      protocolHash: 'test',
      models: operatorId === 'codex'
        ? [
          { model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', efforts: ['medium'], defaultEffort: 'medium' },
          { model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', efforts: ['high'], defaultEffort: 'high' },
          { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', efforts: ['high'], defaultEffort: 'high' },
        ]
        : [
          { model: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', efforts: [] },
          { model: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', efforts: [] },
          {
            model: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5',
            displayName: 'Claude Fable 5', efforts: [],
          },
          {
            model: 'opus', resolvedModel: 'claude-opus-5',
            displayName: 'Claude Opus 5', efforts: [],
          },
        ],
      ...operatorId !== 'claude-code' || !this.claudeQuotaKnown ? {} : {
        quotaPools: [{
          poolId: 'claude-test', displayName: 'Claude test quota',
          models: ['claude-sonnet-4-6', 'claude-opus-4-6'], meter: 'native-subscription' as const,
          primary: { usedPercent: 50 }, observedAt: '2026-08-21T00:00:00.000Z',
        }],
      },
    }))
  }

  async execute(request: FakeResidentRequest) {
    await this.onExecute?.(request)
    this.requests.push(request)
    this.starts.push(`${request.operatorId}:${request.commandId}`)
    const turnId = `turn:${request.commandId}`
    const sessionId = `session:${request.operatorId}`
    this.residentEvents.set(sessionId, ['reasoning', 'tool_activity', 'finalizing'].map((phase, index) => ({
      sequence: index + 1,
      sessionId,
      type: 'turn.progress',
      time: `2026-08-21T00:00:0${String(index)}.000Z`,
      data: { turnId, phase },
    })))
    const result = {
      output: [{ type: 'text' as const, text: `completed ${request.commandId}` }],
      stopReason: 'completed' as const,
      usage: { inputTokens: 11, outputTokens: 7, cacheReadInputTokens: 3, costUsd: 0.01 },
    }
    const resultPromise = this.failNext > 0
      ? (() => {
        this.failNext -= 1
        const error = Object.assign(new Error('transient product failure'), { code: this.failNextCode })
        return Promise.reject(error)
      })()
      : this.defer
        ? new Promise<typeof result>((resolve) => {
          this.turns.set(turnId, { state: 'running' })
          this.deferredResolvers.push(() => {
            this.turns.set(turnId, { state: 'settled', result })
            resolve(result)
          })
        })
        : Promise.resolve(result)
    if (!this.defer && this.failNext === 0) this.turns.set(turnId, { state: 'settled', result })
    return {
      turnId,
      sessionId,
      stateRevision: 1,
      result: resultPromise,
      dispose: async () => {},
    }
  }

  async inspectTurn(turnId: string) {
    const turn = this.turns.get(turnId)
    if (turn === undefined) throw Object.assign(new Error('unknown turn'), { code: 'SESSION_UNAVAILABLE' })
    return { turnId, sessionId: 'session:recovered', commandId: 'command', stateRevision: 1, updatedAt: new Date().toISOString(), ...turn }
  }

  async readEvents(sessionId: string, afterSequence = 0, limit = 100) {
    const events = (this.residentEvents.get(sessionId) ?? [])
      .filter(value => value.sequence > afterSequence)
      .slice(0, limit)
    return { events, nextSequence: events.at(-1)?.sequence ?? afterSequence }
  }

  async interrupt() {}

  resolveDeferred(): void {
    this.deferredResolvers.shift()?.()
  }

  resolveAllDeferred(): void {
    for (const resolve of this.deferredResolvers.splice(0)) resolve()
  }
}

class KeylessModelWorker implements ModelWorkerProvider {
  readonly id = 'deepseek-keyless-fixture'
  readonly requests: ModelWorkerExecuteRequest[] = []
  onExecute?: (request: ModelWorkerExecuteRequest) => Promise<void>

  offers() {
    const common = {
      operatorId: this.id,
      provider: 'deepseek-official-fixture',
      displayName: 'Keyless DeepSeek fixture',
      source: 'metered-api' as const,
      available: true,
      maxConcurrency: 8,
      activeCount: 0,
      tags: ['api', 'deepseek', 'offline-fixture'],
    }
    return Promise.resolve([{
      ...common,
      offerId: `000-${this.id}:fixture-high`,
      model: 'deepseek-fixture-high',
      tier: 'high' as const,
    }, {
      ...common,
      offerId: `000-${this.id}:fixture-low`,
      model: 'deepseek-fixture-low',
      tier: 'low' as const,
    }])
  }

  async execute(request: ModelWorkerExecuteRequest): Promise<ModelWorkerResult> {
    this.requests.push(request)
    await this.onExecute?.(request)
    const usage = request.commandId.endsWith(':rlm:root')
      ? { inputTokens: 10, outputTokens: 2 }
      : request.commandId.includes(':goal-continuation:')
        ? { inputTokens: 5, outputTokens: 2 }
        : { inputTokens: 3, outputTokens: 1 }
    return {
      output: [{ type: 'text', text: `completed ${request.commandId}` }],
      stopReason: 'completed',
      usage,
    }
  }
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) {
      throw new Error(`orchestration state did not converge: ${JSON.stringify(value)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function startCompilation(
  client: OrchestrationDaemonClient,
  compilationId: string,
  commandId = `start:${compilationId}`,
) {
  return client.start({ commandId, compilationId })
}

function graph(workspace: string, risk: 'low' | 'medium' = 'low'): LogicalTaskGraphV1 {
  const common = {
    requiredForCompletion: true,
    capabilityRequirements: [], capabilityBudget: [],
    contextPolicy: { maxTokens: 4_096, allowedSourceKinds: ['intent', 'artifact', 'capsule'] as const, unavailableSource: 'block' as const },
    effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
    approvedSecretRefs: [],
    acceptance: [{ id: 'done', description: 'operator completes', kind: 'operator-completed' as const }],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
  }
  return {
    version: 1, title: 'integration graph', workspace, maxParallel: 2, risk,
    nodes: [{
      ...common, id: 'code', title: 'Implement', task: 'Implement fixture.', role: 'implementation', dependsOn: [],
      readScopes: ['src'], writeScopes: ['src/code'], operator: { preferredIds: ['codex'] },
    }, {
      ...common, id: 'review', title: 'Review', task: 'Review fixture.', role: 'review', dependsOn: ['code'],
      readScopes: ['src/code'], writeScopes: ['reports'], operator: { preferredIds: ['claude-code'] },
    }],
  }
}

function createDaemon(
  root: string,
  dshHome: string,
  residentClient: FakeResidentClient,
  schedulerIntervalMs?: number,
  modelWorkerProviders?: readonly ModelWorkerProvider[],
  remoteOperatorServers?: readonly RemotePhysicalOperatorServer[],
): OrchestrationDaemon {
  return new OrchestrationDaemon({
    root,
    dshHome,
    residentClient: residentClient as unknown as ResidentDaemonClient,
    modelWorkerProviders: modelWorkerProviders ?? [],
    ...remoteOperatorServers === undefined ? {} : { remoteOperatorServers },
    ...schedulerIntervalMs === undefined ? {} : { schedulerIntervalMs },
  })
}

async function installInstructionCapsule(root: string): Promise<void> {
  const capsuleRoot = join(root, 'capsules')
  await mkdir(capsuleRoot, { recursive: true })
  const manifest = {
    version: 1 as const, id: 'extra-instruction', capsuleVersion: '1.0.0', kind: 'instruction' as const, digest: '',
    provenance: { publisher: 'test', sourceRef: 'fixture' }, applicability: ['test'], capabilityTags: ['extra.instruction'],
    inputs: [], outputs: [], preconditions: [], postconditions: [], invariants: [],
    consumes: [], produces: [], requires: [], compatible: [], incompatible: [],
    effects: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
    bindings: { instructions: ['Apply the extra instruction.'], skills: [], toolsAllow: [], toolsDeny: [], mcpServers: [], resourceRefs: [], dataRefs: [], secretRefs: [], guardRefs: [] },
    verification: [], operatorCompatibility: ['codex'],
  }
  await writeFile(join(capsuleRoot, 'extra.json'), JSON.stringify({ ...manifest, digest: canonicalSha256(manifest) }))
}

describe('orchestration daemon', () => {
  it('waits for an in-flight election tick before closing daemon-owned state', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-close-quiescence-'))
    const root = join(home, 'orchestrations')
    const voteStarted = Promise.withResolvers<undefined>()
    const vote = Promise.withResolvers<{ term: number; voterId: string; granted: boolean; commitIndex: number }>()
    const daemon = new OrchestrationDaemon({
      root,
      dshHome: home,
      residentClient: new FakeResidentClient() as unknown as ResidentDaemonClient,
      modelWorkerProviders: [],
      schedulerIntervalMs: 60_000,
      clusterConfig: {
        version: 1, nodeId: 'a', leaseMs: 1_000,
        members: [
          { id: 'a', label: 'A', endpoint: 'http://a.example/' },
          { id: 'b', label: 'B', endpoint: 'http://b.example/' },
          { id: 'c', label: 'C', endpoint: 'http://c.example/' },
        ],
      },
      clusterTransport: {
        requestVote: async () => { voteStarted.resolve(undefined); return vote.promise },
        heartbeat: async (member, request) => ({
          term: request.term, followerId: member.id, accepted: member.id === 'b', commitIndex: 0,
        }),
        installReplica: async (member, request) => ({
          nodeId: member.id, commitIndex: request.replica.commitIndex, state: 'applied',
        }),
      },
    })
    await daemon.start()
    await voteStarted.promise
    let closed = false
    const closing = daemon.close().then(() => { closed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(closed).toBe(false)
    vote.resolve({ term: 1, voterId: 'b', granted: true, commitIndex: 0 })
    await closing
    expect(closed).toBe(true)
    await rm(home, { recursive: true, force: true })
  })

  it('persists a bounded fatal diagnostic when a detached scheduler tick rejects', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-tick-fatal-'))
    const root = join(home, 'orchestrations')
    const daemon = createDaemon(root, home, new FakeResidentClient(), 60_000)
    await daemon.start()
    const internals = daemon as unknown as {
      tickInFlight?: Promise<void>
      runTick: () => Promise<void>
      triggerTick: () => void
    }
    await internals.tickInFlight
    internals.runTick = async () => { throw new Error(`fatal-${'x'.repeat(5_000)}`) }
    internals.triggerTick()
    const diagnostic = await eventually(async () => {
      try { return JSON.parse(await readFile(join(root, 'scheduler-fatal.json'), 'utf8')) as { message: string } }
      catch { return { message: '' } }
    }, value => value.message.startsWith('fatal-'))
    expect(diagnostic.message.length).toBe(4_096)
    await daemon.close()
    await rm(home, { recursive: true, force: true })
  })

  it('returns no cluster status when standalone mode is configured', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-standalone-'))
    const root = join(home, 'orchestrations')
    const daemon = createDaemon(root, home, new FakeResidentClient())
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })

    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    await expect(client.clusterStatus()).resolves.toBeUndefined()
  })

  it('blocks Scheduler mutations until a majority lease is acquired', async () => {
    const home = await mkdtemp(join(tmpdir(), 'oc-'))
    const root = join(home, 'orchestrations')
    const resident = new FakeResidentClient()
    let quorumAvailable = false
    const replicatedCommitIndexes: number[] = []
    const transport: OrchestrationClusterPeerTransport = {
      requestVote: async (member, request) => {
        if (!quorumAvailable) throw new Error('peer unavailable')
        return { term: request.term, voterId: member.id, granted: member.id === 'b', commitIndex: 0 }
      },
      heartbeat: async (member, request) => {
        if (!quorumAvailable) throw new Error('peer unavailable')
        return { term: request.term, followerId: member.id, accepted: member.id === 'b', commitIndex: 0 }
      },
      installReplica: async (member, request) => {
        if (replicatedCommitIndexes.length === 0) expect(resident.starts).toEqual([])
        replicatedCommitIndexes.push(request.replica.commitIndex)
        return { nodeId: member.id, commitIndex: request.replica.commitIndex, state: 'applied' }
      },
    }
    const daemon = new OrchestrationDaemon({
      root,
      dshHome: home,
      residentClient: resident as unknown as ResidentDaemonClient,
      modelWorkerProviders: [],
      schedulerIntervalMs: 10,
      clusterConfig: {
        version: 1,
        nodeId: 'a',
        leaseMs: 1_000,
        members: [
          { id: 'a', label: 'A', endpoint: 'http://a.example/' },
          { id: 'b', label: 'B', endpoint: 'http://b.example/' },
          { id: 'c', label: 'C', endpoint: 'http://c.example/' },
        ],
      },
      clusterTransport: transport,
    })
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    await expect(client.clusterStatus()).resolves.toMatchObject({ role: 'follower', canSchedule: false, quorum: 2 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    await expect(client.compile({ intent: { request: 'blocked fixture' }, graph: graph(workspace) }))
      .rejects.toMatchObject({ code: 'NOT_CLUSTER_LEADER' })

    quorumAvailable = true
    await eventually(() => client.clusterStatus(), value => value?.canSchedule === true)
    const compilation = await client.compile({ intent: { request: 'leader fixture' }, graph: graph(workspace) })
    expect(compilation).toMatchObject({ graph: { title: 'integration graph' } })
    const started = await startCompilation(client, compilation.compilationId)
    await eventually(() => client.inspect(String(started.runId)), value => value.state === 'completed')
    expect(replicatedCommitIndexes.length).toBeGreaterThan(0)
    expect(resident.starts).toEqual([
      `codex:orch:${String(started.runId)}:code:1`,
      `claude-code:orch:${String(started.runId)}:review:1`,
    ])
  })

  it('reattaches a remote subscription turn after Scheduler restart and projects its progress', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-ro-'))
    const root = join(home, 'orchestrations')
    const local = new FakeResidentClient()
    const methods: string[] = []
    let remoteSettled = false
    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Remote Codex',
      tags: ['coding'], maxConcurrency: 2, injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true, authentication: 'native-subscription', productVersion: 'test', protocolHash: 'test',
      models: [{
        model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', description: 'Fast worker',
        supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true,
        supportsAdaptiveThinking: true,
      }],
    }
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string }
      methods.push(call.method)
      const value = call.method === 'operator.providers' ? [provider]
        : call.method === 'operator.execute'
          ? { sessionId: 'remote-session', turnId: 'remote-turn', stateRevision: 1 }
          : call.method === 'operator.inspect'
            ? remoteSettled ? {
              commandId: 'remote-command', sessionId: 'remote-session', turnId: 'remote-turn',
              state: 'settled', stateRevision: 2, updatedAt: '2026-08-27T12:00:01.000Z',
              result: { output: [{ type: 'text', text: 'remote result' }], stopReason: 'completed' },
            } : {
              commandId: 'remote-command', sessionId: 'remote-session', turnId: 'remote-turn',
              state: 'running', stateRevision: 1, updatedAt: '2026-08-27T12:00:00.000Z',
            }
            : call.method === 'operator.events'
              ? {
                events: [{
                  sequence: 1, sessionId: 'remote-session', type: 'turn.progress',
                  time: '2026-08-27T12:00:00.000Z', data: { turnId: 'remote-turn', phase: 'reasoning' },
                }],
                nextSequence: 1,
              }
              : { interrupted: true }
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
    }))
    const daemon = createDaemon(root, home, local, 10, [], [{
      id: 'mini', label: 'Mac mini', endpoint: 'http://127.0.0.1:13300', pollIntervalMs: 10,
    }])
    await daemon.start()
    cleanup.push(async () => { await daemon.close() })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'fixture.txt'), 'remote reattach fixture\n')
    await run('git', ['init', '--initial-branch=main'], { cwd: workspace })
    await run('git', ['config', 'user.name', 'DSH Test'], { cwd: workspace })
    await run('git', ['config', 'user.email', 'dsh-test@example.invalid'], { cwd: workspace })
    await run('git', ['add', '.'], { cwd: workspace })
    await run('git', ['commit', '-m', 'fixture'], { cwd: workspace })
    await run('git', ['remote', 'add', 'origin', 'https://github.com/lisihao/remote-fixture.git'], { cwd: workspace })
    const fixture = graph(workspace)
    const compilation = await client.compile({
      intent: { request: 'Analyze the fixture remotely.' },
      admission: {
        policy: 'auto', route: 'taskgraph', sourceSessionId: 'remote-read-only',
        rlm: 'disabled', continualHarness: 'off', optimization: 'economy',
      },
      graph: {
        ...fixture,
        nodes: [{
          ...fixture.nodes[0]!,
          title: 'Analyze', task: 'Analyze the fixture without modifying files.', role: 'analysis',
          writeScopes: [], operator: { preferredIds: ['remote.mini.codex'] },
        }],
      },
    })
    const orchestrationRun = await startCompilation(client, compilation.compilationId)
    await eventually(() => client.inspect(String(orchestrationRun.runId)), value => value.nodes[0]?.state === 'running')
    await daemon.close()
    remoteSettled = true
    const recoveredDaemon = createDaemon(root, home, local, 10, [], [{
      id: 'mini', label: 'Mac mini', endpoint: 'http://127.0.0.1:13300', pollIntervalMs: 10,
    }])
    await recoveredDaemon.start()
    cleanup.push(async () => { await recoveredDaemon.close(); await rm(home, { recursive: true, force: true }) })
    const recoveredClient = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const completed = await eventually(
      () => recoveredClient.inspect(String(orchestrationRun.runId)),
      value => value.state === 'completed',
    )
    expect(completed.nodes[0]).toMatchObject({ operatorId: 'remote.mini.codex', state: 'passed' })
    expect(local.requests).toHaveLength(0)
    const events = await recoveredClient.readEvents({ runId: orchestrationRun.runId, limit: 200 })
    expect(events.events.find(value => value.type === 'node.operator.progress')?.data).toMatchObject({
      operatorId: 'remote.mini.codex', phase: 'reasoning',
    })
    expect(methods).toEqual(expect.arrayContaining([
      'operator.providers', 'operator.execute', 'operator.inspect', 'operator.events',
    ]))
  })

  it('closes accepted control sockets before shutdown settles', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-close-'))
    const root = join(home, 'orchestrations')
    const daemon = createDaemon(root, home, new FakeResidentClient(), 10)
    await daemon.start()
    const socket = createConnection(daemon.socketPath)
    await once(socket, 'connect')

    await daemon.close()

    expect(socket.destroyed).toBe(true)
    await rm(home, { recursive: true, force: true })
  })

  it('classifies an older daemon build as a version mismatch', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-upgrade-'))
    const root = join(home, 'orchestrations')
    const previousBuild = process.env.DSH_BUILD_COMMIT
    const oldDaemon = new OrchestrationDaemon({
      root,
      dshHome: home,
      buildCommit: 'desktop-old',
      residentClient: new FakeResidentClient() as unknown as ResidentDaemonClient,
      modelWorkerProviders: [],
    })
    await oldDaemon.start()
    process.env.DSH_BUILD_COMMIT = 'desktop-current'
    const client = new OrchestrationDaemonClient({
      root,
      dshHome: home,
      autoStart: false,
      connectTimeoutMs: 2_000,
    })
    try {
      await expect(client.ready()).rejects.toMatchObject({ code: 'ORCHESTRATION_VERSION_MISMATCH' })
    } finally {
      await oldDaemon.close()
      if (previousBuild === undefined) Reflect.deleteProperty(process.env, 'DSH_BUILD_COMMIT')
      else process.env.DSH_BUILD_COMMIT = previousBuild
      await rm(home, { recursive: true, force: true })
    }
  })

  it('lets the root model create asynchronous children through the persistent TypeScript RLM tool', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-home-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    fake.onExecute = async (request) => {
      if (request.modelToolBridge === undefined) return
      if (request.commandId.endsWith(':rlm:root')) {
        await callRlmTool(request, 'root-cell', [
          'const worker = await rlm("analyze one bounded alternative", { name: "worker" });',
          'const received = await agentMessage.read();',
          '({ worker, received })',
        ].join('\n'))
      } else if (request.commandId.endsWith(':deliver')) {
        await callRlmTool(request, `delivery-cell:${request.commandId}`, 'await agentMessage.read()')
      } else {
        await callRlmTool(request, `child-cell:${request.commandId}`, 'await agentMessage.send("bounded child evidence", { receiverRole: "parent", mode: "auto" }); "sent"')
      }
    }
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const fixture = graph(workspace)
    const { operator: _preferredOperator, ...rlmNode } = fixture.nodes[0]!
    const rlmGraph: LogicalTaskGraphV1 = {
      ...fixture,
      nodes: [{
        ...rlmNode,
        role: 'recursive synthesis',
        task: 'Use bounded RLM recursion to synthesize the alternatives.',
      }],
    }
    const compilation = await client.compile({
      intent: { request: 'Synthesize alternatives.' },
      admission: {
        policy: 'auto', route: 'taskgraph', sourceSessionId: 'forced-rlm-mode',
        rlm: 'enabled', continualHarness: 'off', optimization: 'balanced',
      },
      graph: rlmGraph,
    })
    const run = await startCompilation(client, compilation.compilationId)
    const completed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(completed.nodes[0]).toMatchObject({ operatorId: 'claude-code', rlm: 'enabled', state: 'passed' })
    expect(fake.requests).toHaveLength(3)
    expect(fake.requests.every(request => (
      request.operatorId === 'claude-code' && request.profile?.model === 'claude-opus-4-6'
    ))).toBe(true)
    expect(fake.requests[0]).toMatchObject({
      operatorId: 'claude-code',
      profile: { model: 'claude-opus-4-6' },
    })
    expect(fake.requests.every(request => request.modelToolBridge?.tools[0]?.name === 'typescript_repl')).toBe(true)
    expect(fake.requests[1]?.prompt?.map(block => block.text).join('\n')).toContain('rlm(...) returns an admission handle immediately')
    const executionPlan = daemon.store.readArtifact(completed.nodes[0]!.executionPlanRef!) as {
      taskRef: string
      allocationPlan: { model: string; suggestedParallelism: number }
      rlmPlan: { fidelity: string }
      rlmWorkerPlan?: { model: string; tier: string }
    }
    expect(executionPlan).toMatchObject({
      allocationPlan: { model: 'claude-opus-4-6', suggestedParallelism: 2 },
      rlmPlan: { fidelity: 'prime-strict' },
    })
    expect(executionPlan).not.toHaveProperty('rlmWorkerPlan')
    expect(daemon.store.readArtifact(OrchestrationArtifactRef(executionPlan.taskRef))).toMatchObject({
      version: 1,
      repository: { workspace: await realpath(workspace) },
      objective: 'Synthesize alternatives.',
      models: {
        executor: { operatorId: 'claude-code', model: 'claude-opus-4-6', tier: 'high' },
      },
      quota: { class: 'native-subscription' },
    })
    const events = await client.readEvents({ runId: run.runId, limit: 200 })
    expect(events.events.filter(value => value.type === 'rlm.child.settled')).toHaveLength(1)
    expect(events.events.filter(value => value.type === 'rlm.message.continuation.settled')).toHaveLength(1)
    expect(events.events.find(value => value.type === 'rlm.execution.settled')?.data).toMatchObject({
      childCount: 1,
    })
  })

  it('does not let one RLM allocation serialize an independent TaskGraph node', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rlm-cap-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    fake.defer = true
    fake.onExecute = async (request) => {
      if (request.modelToolBridge === undefined) return
      if (request.commandId.endsWith(':rlm:root')) {
        await callRlmTool(request, 'parallel-root-cell', '"root admitted"')
      }
    }
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const fixture = graph(workspace)
    const independentGraph: LogicalTaskGraphV1 = {
      ...fixture,
      maxParallel: 2,
      nodes: [{
        ...fixture.nodes[0]!,
        role: 'recursive synthesis',
        task: 'Use RLM without owning unrelated DAG capacity.',
        readScopes: [],
        writeScopes: ['rlm-output'],
        rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 2, maxTurns: 4 },
      }, {
        ...fixture.nodes[1]!,
        dependsOn: [],
        readScopes: [],
        writeScopes: ['independent-output'],
        rlm: { mode: 'disabled', maxDepth: 1, maxChildren: 2, maxTurns: 4 },
      }],
    }
    const compilation = await client.compile({
      intent: { request: 'Run independent RLM and standard nodes.' },
      admission: {
        policy: 'auto', route: 'taskgraph', sourceSessionId: 'rlm-dag-capacity',
        rlm: 'auto', continualHarness: 'off', optimization: 'balanced',
      },
      graph: independentGraph,
    })
    const run = await startCompilation(client, compilation.compilationId)
    const concurrent = await eventually(
      () => client.inspect(String(run.runId)),
      value => value.nodes.filter(node => node.state === 'running').length === 2,
    )
    expect(concurrent).toMatchObject({ maxParallel: 2, effectiveParallelism: 2 })
    expect(concurrent.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'code', rlm: 'enabled', state: 'running' }),
      expect.objectContaining({ id: 'review', rlm: 'disabled', state: 'running' }),
    ]))
    fake.defer = false
    fake.resolveAllDeferred()
    await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
  })

  it('keeps Standard mode on the direct execution path without creating an RLM session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-standard-mode-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const fixture = graph(workspace)
    const compilation = await client.compile({
      intent: { request: 'Use standard execution for a recursive-sounding task.' },
      admission: {
        policy: 'auto', route: 'taskgraph', sourceSessionId: 'forced-standard-mode',
        rlm: 'disabled', continualHarness: 'off', optimization: 'balanced',
      },
      graph: {
        ...fixture,
        nodes: [
          { ...fixture.nodes[0]!, role: 'recursive synthesis', task: 'Recursively explore alternatives, but obey Standard mode.' },
        ],
      },
    })
    const run = await startCompilation(client, compilation.compilationId)
    const completed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(completed.nodes[0]).toMatchObject({ state: 'passed', rlm: 'disabled' })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]?.modelToolBridge).toBeUndefined()
    const events = await client.readEvents({ runId: run.runId, limit: 200 })
    expect(events.events.find(value => value.type === 'rlm.resolved')?.data).toMatchObject({ enabled: false, reason: 'user-disabled' })
    expect(events.events.some(value => value.type === 'rlm.execution.started')).toBe(false)
  })

  it('marks an interrupted Resident RLM composite indeterminate instead of replaying child turns after restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-r-'))
    const root = join(home, 'orchestrations')
    const firstFake = new FakeResidentClient()
    firstFake.defer = true
    const first = createDaemon(root, home, firstFake, 10)
    await first.start()
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const fixture = graph(workspace)
    const { operator: _preferredOperator, ...rlmNode } = fixture.nodes[0]!
    const compilation = await client.compile({
      intent: { request: 'Persist bounded recursion.' },
      graph: {
        ...fixture,
        nodes: [{ ...rlmNode, role: 'recursive synthesis', task: 'Recursively synthesize alternatives.' }],
      },
    })
    const run = await startCompilation(client, compilation.compilationId)
    await eventually(() => client.inspect(String(run.runId)), value => value.nodes[0]?.state === 'running' && firstFake.requests.length === 1)
    await first.close()

    const secondFake = new FakeResidentClient()
    const second = createDaemon(root, home, secondFake, 10)
    await second.start()
    cleanup.push(async () => { await second.close(); await rm(home, { recursive: true, force: true }) })
    const recoveredClient = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const recovered = await eventually(
      () => recoveredClient.inspect(String(run.runId)),
      value => value.state === 'indeterminate',
    )
    expect(recovered.nodes[0]).toMatchObject({ state: 'indeterminate' })
    expect(secondFake.requests).toHaveLength(0)
  })

  it('continues an explicit Prime goal until the model completes it without changing the TaskGraph', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rlm-goal-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    fake.onExecute = async (request) => {
      if (request.modelToolBridge === undefined) return
      if (request.commandId.endsWith(':rlm:root')) {
        await callRlmTool(request, 'goal-create-cell', 'await goal.create("complete the bounded objective", { continuationBudget: 2 }); "goal active"')
      } else if (request.commandId.includes(':goal-continuation:1')) {
        await callRlmTool(request, 'goal-complete-cell', 'await goal.complete(); "goal complete"')
      }
    }
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const fixture = graph(workspace)
    const { operator: _preferredOperator, ...rlmNode } = fixture.nodes[0]!
    const compilation = await client.compile({
      intent: { request: 'Complete a persistent goal.' },
      graph: { ...fixture, nodes: [{ ...rlmNode, role: 'recursive synthesis', task: 'Complete one persistent goal.' }] },
    })
    const run = await startCompilation(client, compilation.compilationId)
    const completed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(completed.nodes[0]).toMatchObject({ state: 'passed', rlm: 'enabled' })
    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[0]?.laneId).toBe(fake.requests[1]?.laneId)
    expect(fake.requests[0]?.modelToolBridge?.sessionId).toBe(fake.requests[1]?.modelToolBridge?.sessionId)
    const events = await client.readEvents({ runId: run.runId, limit: 200 })
    expect(events.events.some(value => value.type === 'rlm.goal.continuation.settled')).toBe(true)
  })

  it('runs Prime Autonomous quality gates in the same sealed RLM lane and lets a passing gate complete', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-auto-pass-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const fixture = graph(workspace)
    const { operator: _preferredOperator, ...baseNode } = fixture.nodes[0]!
    const compilation = await client.compile({
      intent: { request: 'Let the host verifier decide completion.' },
      graph: {
        ...fixture,
        nodes: [{
          ...baseNode,
          role: 'recursive synthesis',
          effectBudget: { ...baseNode.effectBudget, execute: ['autonomous-gate'] },
          rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 2, maxTurns: 4 },
          autonomous: {
            mode: 'enabled',
            gates: { commands: [`${process.execPath} -e "process.exit(0)"`] },
          },
        }],
      },
    })
    const run = await startCompilation(client, compilation.compilationId)
    const completed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(completed.nodes[0]).toMatchObject({ state: 'passed', rlm: 'enabled', autonomous: 'enabled' })
    expect(fake.requests).toHaveLength(1)
    const events = await client.readEvents({ runId: run.runId, limit: 200 })
    expect(events.events.find(value => value.type === 'rlm.autonomous.resolved')?.data).toMatchObject({
      enabled: true,
      gateCount: 1,
    })
    expect(events.events.find(value => value.type === 'rlm.autonomous.stopped')?.data).toMatchObject({
      reason: 'gate_passed',
      continuationsUsed: 0,
      turnsUsed: 1,
    })
    expect(events.events.filter(value => value.type.startsWith('rlm.autonomous.')).map(value => ({
      type: value.type,
      ...value.type === 'rlm.autonomous.resolved' ? {
        enabled: value.data.enabled,
        gateCount: value.data.gateCount,
      } : value.type === 'rlm.autonomous.usage' ? {
        turnsUsed: value.data.turnsUsed,
        tokensUsed: value.data.tokensUsed,
      } : {
        reason: value.data.reason,
        continuationsUsed: value.data.continuationsUsed,
        turnsUsed: value.data.turnsUsed,
      },
    }))).toMatchInlineSnapshot(`
      [
        {
          "enabled": true,
          "gateCount": 1,
          "type": "rlm.autonomous.resolved",
        },
        {
          "tokensUsed": 0,
          "turnsUsed": 1,
          "type": "rlm.autonomous.usage",
        },
        {
          "continuationsUsed": 0,
          "reason": "gate_passed",
          "turnsUsed": 1,
          "type": "rlm.autonomous.stopped",
        },
      ]
    `)
  })

  it('settles a task-specific Autonomous end condition from host evidence and a registered evaluator', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-aec-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    const evaluator = vi.fn(() => 'pass' as const)
    const daemon = new OrchestrationDaemon({
      root,
      dshHome: home,
      residentClient: fake as unknown as ResidentDaemonClient,
      modelWorkerProviders: [],
      schedulerIntervalMs: 10,
      autonomousEndConditionEvaluators: { quality: evaluator },
    })
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const fixture = graph(workspace)
    const { operator: _preferredOperator, ...baseNode } = fixture.nodes[0]!
    const compilation = await client.compile({
      intent: { request: 'Stop when the declared completion evidence is observed.' },
      graph: {
        ...fixture,
        nodes: [{
          ...baseNode,
          role: 'recursive synthesis',
          rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 2, maxTurns: 4 },
          autonomous: {
            mode: 'enabled',
            endCondition: {
              version: 1,
              operator: 'all',
              checks: [
                { id: 'completed', kind: 'acceptance', ref: 'done' },
                { id: 'quality', kind: 'evaluator', ref: 'quality' },
              ],
            },
          },
        }],
      },
    })
    const run = await startCompilation(client, compilation.compilationId)
    const completed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(completed.nodes[0]).toMatchObject({ state: 'passed', autonomous: 'enabled' })
    expect(fake.requests).toHaveLength(1)
    expect(evaluator).toHaveBeenCalledOnce()
    const events = await client.readEvents({ runId: run.runId, limit: 200 })
    expect(events.events.find(value => value.type === 'rlm.autonomous.stopped')?.data).toMatchObject({
      reason: 'end_condition_passed',
      continuationsUsed: 0,
      turnsUsed: 1,
    })
  })

  it('does not report Autonomous limit exhaustion as a successful TaskGraph node', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-auto-limit-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const fixture = graph(workspace)
    const { operator: _preferredOperator, ...baseNode } = fixture.nodes[0]!
    const compilation = await client.compile({
      intent: { request: 'Bound autonomous work without a host verifier.' },
      graph: {
        ...fixture,
        nodes: [{
          ...baseNode,
          role: 'recursive synthesis',
          retryPolicy: { ...baseNode.retryPolicy, maxAttempts: 1 },
          rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 2, maxTurns: 4 },
          autonomous: { mode: 'enabled', maxContinuations: 1 },
        }],
      },
    })
    const run = await startCompilation(client, compilation.compilationId)
    const failed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'failed')
    expect(failed.nodes[0]).toMatchObject({ state: 'failed', autonomous: 'enabled' })
    expect(fake.requests).toHaveLength(2)
    const events = await client.readEvents({ runId: run.runId, limit: 200 })
    expect(events.events.find(value => value.type === 'rlm.autonomous.stopped')?.data).toMatchObject({
      reason: 'maxContinuations',
      continuationsUsed: 1,
    })
    expect(events.events.find(value => value.type === 'node.failed')?.data).toMatchObject({
      code: 'AUTONOMOUS_LIMIT_REACHED',
    })
  })

  it('retains normalized usage in non-RLM model-worker Evidence', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-mwu-'))
    const root = join(home, 'orchestrations')
    const resident = new FakeResidentClient()
    resident.available = false
    const worker = new KeylessModelWorker()
    const daemon = createDaemon(root, home, resident, 10, [worker])
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const fixture = graph(workspace)
    const { operator: _preferredOperator, ...node } = fixture.nodes[0]!
    const compilation = await client.compile({
      intent: { request: 'Retain one-shot model usage in Evidence.' },
      admission: {
        policy: 'auto', route: 'taskgraph', sourceSessionId: 'model-worker-usage-fixture',
        rlm: 'disabled', continualHarness: 'off', optimization: 'economy',
      },
      graph: {
        ...fixture,
        nodes: [{ ...node, role: 'analysis', writeScopes: [] }],
      },
    })
    const run = await startCompilation(client, compilation.compilationId)
    const completed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
    const evidenceRef = completed.nodes[0]?.evidenceRefs[0]
    expect(evidenceRef).toBeDefined()
    const evidence = await client.readArtifact(evidenceRef!) as OrchestrationExecutionEvidenceV1
    expect(evidence).toMatchObject({
      version: 1,
      stopReason: 'completed',
      usage: {
        inputTokens: 3,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
    })
  })

  it('serially accounts keyless DeepSeek root, concurrent child, and active goal-continuation usage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-rlm-goal-usage-'))
    const root = join(home, 'orchestrations')
    const resident = new FakeResidentClient()
    resident.available = false
    const worker = new KeylessModelWorker()
    const daemon = createDaemon(root, home, resident, 10, [worker])
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const fixture = graph(workspace)
    const { operator: _preferredOperator, ...baseNode } = fixture.nodes[0]!
    const rlmGraph: LogicalTaskGraphV1 = {
      ...fixture,
      nodes: [{
        ...baseNode,
        role: 'recursive synthesis',
        task: 'Exercise the keyless RLM Goal usage fixture.',
        writeScopes: [],
      }],
    }
    const admission = {
      policy: 'codex' as const,
      route: 'taskgraph' as const,
      sourceSessionId: 'goal-usage-fixture',
      rlm: 'enabled' as const,
      continualHarness: 'off' as const,
      optimization: 'balanced' as const,
    }

    const noGoalCompilation = await client.compile({
      intent: { request: 'Run keyless RLM without creating a Goal.' },
      admission,
      graph: rlmGraph,
    })
    const noGoalRun = await startCompilation(client, noGoalCompilation.compilationId)
    await eventually(() => client.inspect(String(noGoalRun.runId)), value => value.state === 'completed')
    const noGoalEvents = await client.readEvents({ runId: noGoalRun.runId, limit: 200 })
    expect(noGoalEvents.events.filter(value => value.type === 'rlm.goal.usage')).toHaveLength(0)
    expect(noGoalEvents.events.filter(value => value.type === 'rlm.usage')).toHaveLength(1)

    worker.onExecute = async (request) => {
      if (request.commandId.endsWith(':rlm:root')) {
        await callRlmTool(request, 'goal-usage-root-cell', [
          'await goal.create("account every active DeepSeek turn", { continuationBudget: 2 });',
          'await Promise.all([rlm("bounded child one", { name: "worker-one" }), rlm("bounded child two", { name: "worker-two" })]);',
          '"goal active"',
        ].join('\n'))
      } else if (request.commandId.includes(':goal-continuation:2')) {
        await callRlmTool(request, 'goal-usage-complete-cell', 'await goal.complete(); "goal complete"')
      }
    }
    const goalCompilation = await client.compile({
      intent: { request: 'Account root, child, and active continuation usage.' },
      admission,
      graph: rlmGraph,
    })
    const goalRun = await startCompilation(client, goalCompilation.compilationId)
    await eventually(() => client.inspect(String(goalRun.runId)), value => value.state === 'completed')
    const goalEvents = await client.readEvents({ runId: goalRun.runId, limit: 300 })
    const allUsageEvents = goalEvents.events.filter(value => value.type === 'rlm.usage')
    expect(allUsageEvents).toHaveLength(5)
    expect(allUsageEvents.map(value => value.data.source).sort()).toEqual([
      'child',
      'child',
      'goal-continuation',
      'goal-continuation',
      'root',
    ])
    expect(allUsageEvents.at(-1)?.data).toMatchObject({
      operatorId: 'deepseek-keyless-fixture',
      authMode: 'api',
      inputTokens: 5,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
    })
    const usageEvents = goalEvents.events.filter(value => value.type === 'rlm.goal.usage')
    expect(usageEvents).toHaveLength(4)
    expect(usageEvents.map(value => value.data.source).sort()).toEqual([
      'child',
      'child',
      'goal-continuation',
      'root',
    ])
    expect(usageEvents.at(-1)?.data).toMatchObject({
      source: 'goal-continuation',
      inputTokens: 5,
      outputTokens: 2,
      tokensUsed: 27,
      status: 'active',
    })
  })

  it('compiles, seals, dispatches Resident nodes, records Evidence, and completes a graph', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-home-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const compilation = await client.compile({ intent: { request: 'Implement then review.' }, graph: graph(home) })
    const started = await startCompilation(client, compilation.compilationId)
    const settled = await eventually(() => client.inspect(String(started.runId)), value => value.state === 'completed')
    expect(settled.nodes.map(value => value.state)).toEqual(['passed', 'passed'])
    expect(settled.nodes).toEqual([
      expect.objectContaining({ id: 'code', role: 'implementation', dependsOn: [] }),
      expect.objectContaining({ id: 'review', role: 'review', dependsOn: ['code'] }),
    ])
    expect(settled.nodes.every(value => value.evidenceRefs.length === 1)).toBe(true)
    expect(settled.nodes.every(value => (
      value.capabilityPlanRef !== undefined
      && value.contextPacketRef !== undefined
      && value.executionPlanRef !== undefined
    ))).toBe(true)
    expect(fake.starts).toEqual([
      `codex:orch:${String(started.runId)}:code:1`,
      `claude-code:orch:${String(started.runId)}:review:1`,
    ])
    expect(fake.requests[1]?.prompt?.map(block => block.text).join('\n')).toContain(
      `completed orch:${String(started.runId)}:code:1`,
    )
    const events = await client.readEvents({ runId: started.runId, limit: 200 })
    expect(events.events.map(value => value.type)).toEqual(expect.arrayContaining([
      'intent.compiled', 'graph.compiled', 'capsule.resolved', 'context.compiled',
      'execution_plan.sealed', 'node.dispatched', 'node.operator.progress',
      'node.evidence.accepted', 'run.completed',
    ]))
    const codexEvidence = events.events.find(value => value.type === 'node.evidence.accepted' && value.nodeId === 'code')
    expect(codexEvidence?.data).toMatchObject({
      operatorId: 'codex',
      outputTruncated: false,
      stopReason: 'completed',
    })
    expect(String(codexEvidence?.data.outputPreview)).toContain('completed orch:')
    const evidence = await client.readArtifact(
      OrchestrationArtifactRef(String(codexEvidence?.data.evidenceRef)),
    ) as OrchestrationExecutionEvidenceV1
    expect(evidence).toMatchObject({
      version: 1,
      output: [{ type: 'text', text: `completed orch:${String(started.runId)}:code:1` }],
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadInputTokens: 3,
        costUsd: 0.01,
      },
    })
    expect(events.events.filter(value => value.type === 'node.operator.progress').map(value => value.data.phase))
      .toEqual(expect.arrayContaining(['reasoning', 'tool_activity', 'finalizing']))
  })

  it('runs mutating nodes in isolated worktrees and integrates their branches into the certified repository', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-worktree-'))
    const root = join(home, 'orchestrations')
    const repository = join(home, 'repository')
    await mkdir(repository)
    await run('git', ['-C', repository, 'init', '-b', 'main'])
    await writeFile(join(repository, 'README.md'), 'base\n')
    await run('git', ['-C', repository, 'add', 'README.md'])
    await run('git', [
      '-C', repository,
      '-c', 'user.name=DSH Test',
      '-c', 'user.email=dsh-test@local',
      'commit', '-m', 'base',
    ])
    const baseSha = (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim()
    const fake = new FakeResidentClient()
    fake.onExecute = async (request) => {
      const file = request.commandId.includes(':code:') ? 'implementation.txt' : 'verification.txt'
      await writeFile(join(request.workspace, file), `${request.operatorId}\n`)
    }
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const fixture = graph(repository)
    const compilation = await client.compile({
      intent: { request: 'Implement and verify in isolated branches.' },
      graph: { ...fixture, baseSha, workspaceIsolation: 'git-worktree' },
    })
    const started = await startCompilation(client, compilation.compilationId)
    const settled = await eventually(() => client.inspect(String(started.runId)), value => value.state === 'completed')
    expect(settled.nodes.map(value => value.state)).toEqual(['passed', 'passed'])
    await expect(readFile(join(repository, 'implementation.txt'), 'utf8')).resolves.toBe('codex\n')
    await expect(readFile(join(repository, 'verification.txt'), 'utf8')).resolves.toBe('claude-code\n')
    expect(fake.requests.every(request => request.workspace !== repository)).toBe(true)
    expect(new Set(fake.requests.map(request => request.workspace)).size).toBe(2)
    const events = await client.readEvents({ runId: started.runId, limit: 200 })
    expect(events.events.filter(value => value.type === 'worktree.prepared')).toHaveLength(2)
    expect(events.events.filter(value => value.type === 'worktree.integrated')).toHaveLength(2)
  })

  it('does not dispatch an intent that requires clarification', async () => {
    const home = await mkdtemp(join(tmpdir(), 'do-c-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const compilation = await client.compile({ intent: { request: 'TBD: clarify the required outcome.' }, graph: graph(home) })
    expect(compilation.requiresClarification).toBe(true)
    const run = await startCompilation(client, compilation.compilationId)
    expect(run.state).toBe('awaiting_clarification')
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(fake.starts).toEqual([])
  })

  it('persists a pre-dispatch Context failure as a blocker without calling a product', async () => {
    const home = await mkdtemp(join(tmpdir(), 'do-b-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const base = graph(home)
    const tinyContext = {
      ...base,
      nodes: base.nodes.map(value => value.id === 'code'
        ? { ...value, contextPolicy: { ...value.contextPolicy, maxTokens: 1 } }
        : value),
    }
    const compilation = await client.compile({ intent: { request: 'Context failure fixture.' }, graph: tinyContext })
    const run = await startCompilation(client, compilation.compilationId)
    const failed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'failed')
    expect(failed.nodes[0]).toMatchObject({ state: 'blocked' })
    expect(failed.nodes[0]?.blockers[0]?.code).toBe('CONTEXT_BUDGET_EXCEEDED')
    expect(fake.starts).toEqual([])
  })

  it('persists an approval-gated run across daemon restart', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-restart-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    const first = createDaemon(root, home, fake)
    await first.start()
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const compilation = await client.compile({ intent: { request: 'Approval fixture.' }, graph: graph(home, 'medium') })
    const started = await startCompilation(client, compilation.compilationId)
    expect(started.state).toBe('awaiting_approval')
    await first.close()
    const second = createDaemon(root, home, fake)
    await second.start()
    cleanup.push(async () => { await second.close(); await rm(home, { recursive: true, force: true }) })
    const recovered = await client.inspect(String(started.runId))
    expect(recovered).toMatchObject({ runId: started.runId, state: 'awaiting_approval', revision: started.revision })
    const approved = await client.decide({ commandId: 'approve-recovered', runId: started.runId, expectedRevision: recovered.revision, decision: 'approve', reason: 'test approval' })
    expect(approved.state).toBe('running')
    await eventually(() => client.inspect(String(started.runId)), value => value.state === 'completed')
  })

  it('reuses one caller-stable start command and fences an accepted crash without replay', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-start-receipt-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    fake.defer = true
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const firstCompilation = await client.compile({
      intent: { request: 'Start receipt fixture one.' },
      graph: graph(home),
    })
    const secondCompilation = await client.compile({
      intent: { request: 'Start receipt fixture two.' },
      graph: graph(home),
    })
    const request = { commandId: 'start-command-1', compilationId: firstCompilation.compilationId }
    const started = await client.start(request)
    expect(await client.start(request)).toEqual(started)
    expect(await client.list()).toHaveLength(1)
    await expect(client.start({
      commandId: request.commandId,
      compilationId: secondCompilation.compilationId,
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' })

    const crashedRequest = { commandId: 'start-command-crashed', compilationId: secondCompilation.compilationId }
    daemon.store.acceptCommand(
      crashedRequest.commandId,
      'orchestration.start',
      canonicalSha256({ method: 'orchestration.start', request: crashedRequest }),
    )
    await expect(client.start(crashedRequest)).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    expect(daemon.store.commandReceipt(crashedRequest.commandId)?.state).toBe('indeterminate')
    expect(await client.list()).toHaveLength(1)
    fake.resolveAllDeferred()
  })

  it('returns one cached control result for an identical command and rejects identity reuse', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-command-receipt-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    fake.defer = true
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const compilation = await client.compile({ intent: { request: 'Command receipt fixture.' }, graph: graph(home, 'medium') })
    const started = await startCompilation(client, compilation.compilationId)
    const request = {
      commandId: 'approve-command-1', runId: started.runId, expectedRevision: started.revision,
      decision: 'approve' as const, reason: 'approve once',
    }
    const accepted = await client.decide(request)
    const replay = await client.decide(request)
    expect(replay).toEqual(accepted)
    await expect(client.decide({ ...request, decision: 'reject' })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' })
    fake.resolveAllDeferred()
  })

  it('reconciles an accepted native turn after the orchestration daemon restarts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-active-restart-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    fake.defer = true
    const first = createDaemon(root, home, fake, 10)
    await first.start()
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const compilation = await client.compile({ intent: { request: 'Active restart fixture.' }, graph: graph(home) })
    const started = await startCompilation(client, compilation.compilationId)
    await eventually(() => client.inspect(String(started.runId)), value => value.nodes[0]?.state === 'running')
    await first.close()
    const second = createDaemon(root, home, fake, 10)
    await second.start()
    cleanup.push(async () => { await second.close(); await rm(home, { recursive: true, force: true }) })
    expect((await client.inspect(String(started.runId))).nodes[0]?.state).toBe('running')
    fake.defer = false
    fake.resolveDeferred()
    const settled = await eventually(() => client.inspect(String(started.runId)), value => value.state === 'completed')
    expect(settled.nodes.map(value => value.evidenceRefs.length)).toEqual([1, 1])
    expect(fake.starts).toEqual([
      `codex:orch:${String(started.runId)}:code:1`,
      `claude-code:orch:${String(started.runId)}:review:1`,
    ])
  })

  it('generation-fences a pre-dispatch capability update', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-capability-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    const daemon = createDaemon(root, home, fake, 60_000)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const base = graph(home, 'medium')
    const compilation = await client.compile({
      intent: { request: 'Capability update fixture.' },
      graph: { ...base, nodes: base.nodes.map(value => value.id === 'code' ? { ...value, capabilityBudget: ['extra.instruction'] } : value) },
    })
    const run = await startCompilation(client, compilation.compilationId)
    const queued = await client.proposeCapabilityUpdate({
      runId: run.runId, nodeId: 'code', expectedRevision: run.revision,
      requestedCapabilities: ['extra.instruction'], applyAt: 'next-turn',
    })
    expect(queued).toMatchObject({ state: 'queued', generation: 2 })
    expect((await client.inspect(String(run.runId))).nodes[0]?.capabilityGeneration).toBe(2)
  })

  it('rejects immediate capability hot swap while a native turn is running', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-hotswap-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    fake.defer = true
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const compilation = await client.compile({ intent: { request: 'Running hot-swap fixture.' }, graph: graph(home) })
    const run = await startCompilation(client, compilation.compilationId)
    const running = await eventually(() => client.inspect(String(run.runId)), value => value.nodes[0]?.state === 'running')
    const rejected = await client.proposeCapabilityUpdate({
      runId: run.runId, nodeId: 'code', expectedRevision: running.revision,
      requestedCapabilities: ['extra.tool'], applyAt: 'immediate',
    })
    expect(rejected).toMatchObject({ state: 'rejected', generation: 1, errorCode: 'CAPABILITY_HOTSWAP_UNSUPPORTED' })
    fake.defer = false
    fake.resolveDeferred()
    await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
  })

  it('applies a queued next-turn capsule with a new generation and execution plan', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-next-turn-'))
    const root = join(home, 'orchestrations')
    await installInstructionCapsule(root)
    const fake = new FakeResidentClient()
    fake.defer = true
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const base = graph(home)
    const updateGraph = {
      ...base,
      nodes: base.nodes.map(value => value.id === 'code' ? { ...value, capabilityBudget: ['extra.instruction'] } : value),
    }
    const compilation = await client.compile({ intent: { request: 'Next turn fixture.' }, graph: updateGraph })
    const run = await startCompilation(client, compilation.compilationId)
    const running = await eventually(() => client.inspect(String(run.runId)), value => value.nodes[0]?.state === 'running')
    const queued = await client.proposeCapabilityUpdate({
      runId: run.runId, nodeId: 'code', expectedRevision: running.revision,
      requestedCapabilities: ['extra.instruction'], applyAt: 'next-turn',
    })
    expect(queued).toMatchObject({ state: 'queued', generation: 2 })
    fake.defer = false
    fake.resolveDeferred()
    const settled = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(settled.nodes[0]).toMatchObject({ state: 'passed', attempt: 2, capabilityGeneration: 2 })
    expect(fake.starts.filter(value => value.startsWith('codex:'))).toHaveLength(2)
    const events = await client.readEvents({ runId: run.runId, limit: 200 })
    expect(events.events).toContainEqual(expect.objectContaining({ type: 'capability_update.applied', generation: 2 }))
  })

  it('requires a new certified graph when a capability update expands authority', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-recompile-'))
    const root = join(home, 'orchestrations')
    const daemon = createDaemon(root, home, new FakeResidentClient(), 60_000)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const compilation = await client.compile({ intent: { request: 'Expansion fixture.' }, graph: graph(home, 'medium') })
    const run = await startCompilation(client, compilation.compilationId)
    const receipt = await client.proposeCapabilityUpdate({
      runId: run.runId, nodeId: 'code', expectedRevision: run.revision,
      requestedCapabilities: ['network.admin'], applyAt: 'next-turn',
    })
    expect(receipt).toMatchObject({ state: 'awaiting_approval', errorCode: 'CAPABILITY_RECOMPILE_REQUIRED' })
    const waiting = await client.inspect(String(run.runId))
    expect(waiting).toMatchObject({ state: 'awaiting_approval' })
    expect(waiting.nodes[0]).toMatchObject({ state: 'awaiting_recompile', capabilityGeneration: 1 })
    await expect(client.decide({
      commandId: 'approve-widening', runId: run.runId, expectedRevision: waiting.revision, decision: 'approve', reason: 'cannot widen in place',
    })).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' })
  })

  it('dispatches independent non-conflicting nodes in parallel', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-parallel-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    fake.defer = true
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const base = graph(home)
    const parallel = {
      ...base,
      nodes: base.nodes.map((value, index) => ({
        ...value,
        dependsOn: [],
        readScopes: [],
        writeScopes: [`parallel/${String(index)}`],
        operator: { preferredIds: [index === 0 ? 'codex' : 'claude-code'] },
        rlm: { mode: 'disabled' as const, maxDepth: 1, maxChildren: 2, maxTurns: 4 },
      })),
    }
    const compilation = await client.compile({ intent: { request: 'Parallel fixture.' }, graph: parallel })
    const run = await startCompilation(client, compilation.compilationId)
    await eventually(() => client.inspect(String(run.runId)), value => value.nodes.every(node => node.state === 'running'))
    expect(fake.starts).toHaveLength(2)
    expect(fake.requests.map(request => request.laneId)).toEqual([
      `orch:${String(run.runId)}:code:1`,
      `orch:${String(run.runId)}:review:1`,
    ])
    expect(fake.requests.every(request => request.prompt?.[0]?.text?.includes('fork_turns: "none"') === true)).toBe(true)
    const events = await client.readEvents({ runId: run.runId, limit: 200 })
    const capsuleEvent = events.events.find(event => event.type === 'capsule.resolved')
    expect(capsuleEvent).toBeDefined()
    expect((capsuleEvent?.data as { cleanContext?: boolean } | undefined)?.cleanContext).toBe(true)
    fake.defer = false
    fake.resolveAllDeferred()
    await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
  })

  it('enforces the allocator concurrency ceiling below graph maxParallel', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-capacity-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    fake.defer = true
    fake.maxConcurrency = 1
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const base = graph(home)
    const capacityBound = {
      ...base,
      maxParallel: 4,
      nodes: base.nodes.map((value, index) => ({
        ...value,
        dependsOn: [],
        readScopes: [],
        writeScopes: [`capacity/${String(index)}`],
        operator: { preferredIds: ['codex'] },
      })),
    }
    const compilation = await client.compile({ intent: { request: 'Capacity fixture.' }, graph: capacityBound })
    const run = await startCompilation(client, compilation.compilationId)
    const limited = await eventually(
      () => client.inspect(String(run.runId)),
      value => value.nodes.filter(node => node.state === 'running').length === 1
        && value.nodes.some(node => node.waitReason?.code === 'MAX_PARALLEL_REACHED'),
    )
    expect(limited).toMatchObject({ maxParallel: 4, effectiveParallelism: 1 })
    expect(fake.starts).toHaveLength(1)
    fake.resolveDeferred()
    await eventually(() => client.inspect(String(run.runId)), () => fake.starts.length === 2)
    fake.resolveDeferred()
    await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
  })

  it('does not replace an unavailable explicitly preferred operator', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-pinned-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    fake.unavailableOperators.add('claude-code')
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const compilation = await client.compile({ intent: { request: 'Pinned provider fixture.' }, graph: graph(home) })
    const started = await startCompilation(client, compilation.compilationId)
    const failed = await eventually(() => client.inspect(String(started.runId)), value => value.state === 'failed')
    expect(fake.starts).toHaveLength(1)
    expect(fake.starts[0]).toMatch(/^codex:/u)
    expect(failed.nodes.find(node => node.id === 'review')).toMatchObject({
      state: 'blocked',
      blockers: [{ code: 'EXPLICIT_MODEL_UNAVAILABLE' }],
    })
  })

  it('does not auto-schedule Claude while its protected subscription quota is unknown', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-claude-quota-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    fake.claudeQuotaKnown = false
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const base = graph(home)
    const planningNode = { ...base.nodes[0]! }
    delete planningNode.operator
    const quotaProtected = {
      ...base,
      nodes: [{
        ...planningNode,
        title: 'Architecture review', role: 'architect', task: 'Review the architecture.', phase: 'planning' as const,
      }],
    }
    const compilation = await client.compile({ intent: { request: 'Quota-protected planning fixture.' }, graph: quotaProtected })
    const started = await startCompilation(client, compilation.compilationId)
    await eventually(() => client.inspect(String(started.runId)), value => value.state === 'completed')
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({ operatorId: 'codex', profile: { model: 'gpt-5.6-sol' } })
  })

  it('canonicalizes explicit Claude resolved-model bindings and admits them when quota telemetry is unknown', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-claude-explicit-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    fake.claudeQuotaKnown = false
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const base = graph(home)
    const explicitClaude = {
      ...base,
      maxParallel: 1,
      nodes: base.nodes.map((node, index) => ({
        ...node,
        id: index === 0 ? 'fable' : 'opus',
        dependsOn: index === 0 ? [] : ['fable'],
        readScopes: [],
        writeScopes: [],
        operator: {
          preferredIds: ['claude-code'],
          profile: { model: index === 0 ? 'claude-fable-5' : 'claude-opus-5' },
        },
      })),
    }
    const compilation = await client.compile({ intent: { request: 'Explicit Claude Debate roster fixture.' }, graph: explicitClaude })
    const started = await startCompilation(client, compilation.compilationId)
    const completed = await eventually(
      () => client.inspect(String(started.runId)),
      value => value.state === 'completed' || value.state === 'failed' || value.state === 'indeterminate',
    )
    expect(completed.state, JSON.stringify(completed, null, 2)).toBe('completed')
    expect(completed.nodes.every(node => node.state === 'passed')).toBe(true)
    expect(fake.requests.map(request => request.profile?.model).sort()).toEqual(['claude-fable-5[1m]', 'opus'])
  }, 10_000)

  it('serializes conflicting scopes and retries only an explicitly retryable failure', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-conflict-retry-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    fake.defer = true
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const base = graph(home)
    const conflicting = {
      ...base,
      nodes: base.nodes.map((value, index) => ({
        ...value, dependsOn: [], writeScopes: ['shared'], readScopes: [],
        operator: { preferredIds: [index === 0 ? 'codex' : 'claude-code'] },
      })),
    }
    const compilation = await client.compile({ intent: { request: 'Conflict fixture.' }, graph: conflicting })
    const run = await startCompilation(client, compilation.compilationId)
    const waiting = await eventually(
      () => client.inspect(String(run.runId)),
      value => value.nodes.some(node => node.state === 'running') && value.nodes.some(node => node.waitReason?.code === 'SCOPE_CONFLICT'),
    )
    expect(fake.starts).toHaveLength(1)
    expect(waiting.nodes.find(node => node.state === 'ready')?.waitReason?.code).toBe('SCOPE_CONFLICT')
    fake.resolveDeferred()
    await eventually(() => client.inspect(String(run.runId)), () => fake.starts.length === 2)
    fake.resolveDeferred()
    await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')

    fake.defer = false
    fake.failNext = 1
    const retryBase = graph(home)
    const retryGraph = {
      ...retryBase,
      nodes: retryBase.nodes.map(value => value.id === 'code' ? {
        ...value,
        retryPolicy: { maxAttempts: 2, backoffMs: 0, retryableCodes: ['RUNTIME_UNAVAILABLE'] },
      } : value),
    }
    const retryCompilation = await client.compile({ intent: { request: 'Retry fixture.' }, graph: retryGraph })
    const retryRun = await startCompilation(client, retryCompilation.compilationId)
    const retried = await eventually(() => client.inspect(String(retryRun.runId)), value => value.state === 'completed')
    expect(retried.nodes[0]).toMatchObject({ state: 'passed', attempt: 2 })
  })

  it('excludes an exhausted model offer before an explicitly allowed retry', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-quota-retry-'))
    const root = join(home, 'o')
    const fake = new FakeResidentClient()
    fake.failNext = 1
    fake.failNextCode = 'QUOTA_EXHAUSTED'
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const base = graph(home)
    const retryGraph = {
      ...base,
      nodes: base.nodes.map(value => value.id === 'code' ? {
        ...value,
        retryPolicy: { maxAttempts: 2, backoffMs: 0, retryableCodes: ['QUOTA_EXHAUSTED'] },
      } : value),
    }
    const compilation = await client.compile({
      intent: { request: 'Quota failover fixture.' },
      admission: {
        policy: 'auto', route: 'taskgraph', sourceSessionId: 'quota-failover',
        rlm: 'auto', continualHarness: 'off', optimization: 'economy',
      },
      graph: retryGraph,
    })
    const run = await startCompilation(client, compilation.compilationId)
    const completed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(completed.nodes[0]).toMatchObject({ state: 'passed', attempt: 2 })
    expect(fake.requests[0]?.profile?.model).toBe('gpt-5.6-luna')
    expect(fake.requests[1]?.profile?.model).toBe('gpt-5.6-terra')
  })
})
