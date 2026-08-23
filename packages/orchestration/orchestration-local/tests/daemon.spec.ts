import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationArtifactRef, type LogicalTaskGraphV1 } from '@deepseek-ai/dsh-orchestration'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { OrchestrationDaemonClient } from '../src/client.ts'
import { canonicalSha256 } from '../src/canonical.ts'
import { OrchestrationDaemon } from '../src/daemon.ts'

const cleanup: Array<() => Promise<void>> = []
const run = promisify(execFile)
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})

type TestResult = { output: Array<{ type: 'text'; text: string }>; stopReason: 'completed' }
interface FakeResidentRequest {
  commandId: string
  operatorId: string
  laneId?: string
  profile?: { model: string }
  prompt?: Array<{ type: string; text?: string }>
  workspace: string
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
          { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', efforts: ['high'], defaultEffort: 'high' },
        ]
        : [
          { model: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', efforts: [] },
          { model: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', efforts: [] },
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
    const result = { output: [{ type: 'text' as const, text: `completed ${request.commandId}` }], stopReason: 'completed' as const }
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
    if (turn === undefined) throw new Error('unknown turn')
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
): OrchestrationDaemon {
  return new OrchestrationDaemon({
    root,
    dshHome,
    residentClient: residentClient as unknown as ResidentDaemonClient,
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

  it('executes bounded low-tier Resident RLM branches and high-tier synthesis while DSH owns the graph', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-home-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
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
    const compilation = await client.compile({ intent: { request: 'Synthesize alternatives.' }, graph: rlmGraph })
    const run = await client.start({ compilationId: compilation.compilationId })
    const completed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(completed.nodes[0]).toMatchObject({ operatorId: 'claude-code', rlm: 'enabled', state: 'passed' })
    expect(fake.requests).toHaveLength(5)
    expect(fake.requests.slice(0, 4).every(request => (
      request.operatorId === 'codex' && request.profile?.model === 'gpt-5.6-luna'
    ))).toBe(true)
    expect(fake.requests[4]).toMatchObject({
      operatorId: 'claude-code',
      profile: { model: 'claude-opus-4-6' },
    })
    expect(new Set(fake.requests.map(request => request.laneId)).size).toBe(5)
    expect(fake.requests.slice(0, 4).every(request => (
      request.prompt?.map(block => block.text).join('\n').includes('Do not delegate') === true
    ))).toBe(true)
    const executionPlan = daemon.store.readArtifact(completed.nodes[0]!.executionPlanRef!) as {
      taskRef: string
      allocationPlan: { model: string; suggestedParallelism: number }
      rlmWorkerPlan?: { model: string; tier: string }
    }
    expect(executionPlan).toMatchObject({
      allocationPlan: { model: 'claude-opus-4-6', suggestedParallelism: 1 },
      rlmWorkerPlan: { model: 'gpt-5.6-luna', tier: 'low' },
    })
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
    expect(events.events.filter(value => value.type === 'rlm.branch.settled')).toHaveLength(4)
    expect(events.events.find(value => value.type === 'rlm.execution.settled')?.data).toMatchObject({
      depthUsed: 2,
      turnsUsed: 5,
      branchCount: 2,
    })
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
    const run = await client.start({ compilationId: compilation.compilationId })
    await eventually(() => client.inspect(String(run.runId)), value => value.nodes[0]?.state === 'running' && firstFake.requests.length === 2)
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

  it('compiles, seals, dispatches Resident nodes, records Evidence, and completes a graph', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-orch-home-'))
    const root = join(home, 'orchestrations')
    const fake = new FakeResidentClient()
    const daemon = createDaemon(root, home, fake, 10)
    await daemon.start()
    cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
    const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
    const compilation = await client.compile({ intent: { request: 'Implement then review.' }, graph: graph(home) })
    const started = await client.start({ compilationId: compilation.compilationId })
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
    const started = await client.start({ compilationId: compilation.compilationId })
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
    const run = await client.start({ compilationId: compilation.compilationId })
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
    const run = await client.start({ compilationId: compilation.compilationId })
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
    const started = await client.start({ compilationId: compilation.compilationId })
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
    const started = await client.start({ compilationId: compilation.compilationId })
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
    const started = await client.start({ compilationId: compilation.compilationId })
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
    const run = await client.start({ compilationId: compilation.compilationId })
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
    const run = await client.start({ compilationId: compilation.compilationId })
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
    const run = await client.start({ compilationId: compilation.compilationId })
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
    const run = await client.start({ compilationId: compilation.compilationId })
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
    const run = await client.start({ compilationId: compilation.compilationId })
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
    const run = await client.start({ compilationId: compilation.compilationId })
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
    const started = await client.start({ compilationId: compilation.compilationId })
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
    const started = await client.start({ compilationId: compilation.compilationId })
    await eventually(() => client.inspect(String(started.runId)), value => value.state === 'completed')
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({ operatorId: 'codex', profile: { model: 'gpt-5.6-sol' } })
  })

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
    const run = await client.start({ compilationId: compilation.compilationId })
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
    const retryRun = await client.start({ compilationId: retryCompilation.compilationId })
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
    const run = await client.start({ compilationId: compilation.compilationId })
    const completed = await eventually(() => client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(completed.nodes[0]).toMatchObject({ state: 'passed', attempt: 2 })
    expect(fake.requests[0]?.profile?.model).toBe('gpt-5.6-luna')
    expect(fake.requests[1]?.profile?.model).not.toBe('gpt-5.6-luna')
  })
})
