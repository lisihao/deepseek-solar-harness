import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LogicalTaskGraphV1 } from '@deepseek-ai/dsh-orchestration'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { OrchestrationDaemonClient } from '../src/client.ts'
import { canonicalSha256 } from '../src/canonical.ts'
import { OrchestrationDaemon } from '../src/daemon.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})

type TestResult = { output: Array<{ type: 'text'; text: string }>; stopReason: 'completed' }

class FakeResidentClient {
  starts: string[] = []
  requests: Array<{ commandId: string; operatorId: string; laneId?: string; prompt?: Array<{ type: string; text?: string }> }> = []
  available = true
  unavailableOperators = new Set<string>()
  defer = false
  failNext = 0
  private readonly deferredResolvers: Array<() => void> = []
  turns = new Map<string, { state: 'running' | 'settled'; result?: TestResult }>()

  async providers() {
    return ['codex', 'claude-code'].map(operatorId => ({
      operatorId,
      product: operatorId,
      available: this.available && !this.unavailableOperators.has(operatorId),
      authentication: 'native-subscription',
      productVersion: 'test',
      protocolHash: 'test',
      models: [],
    }))
  }

  async execute(request: { commandId: string; operatorId: string; laneId?: string; prompt?: Array<{ type: string; text?: string }> }) {
    this.requests.push(request)
    this.starts.push(`${request.operatorId}:${request.commandId}`)
    const turnId = `turn:${request.commandId}`
    const result = { output: [{ type: 'text' as const, text: `completed ${request.commandId}` }], stopReason: 'completed' as const }
    const resultPromise = this.failNext > 0
      ? (() => {
        this.failNext -= 1
        const error = Object.assign(new Error('transient product failure'), { code: 'RUNTIME_UNAVAILABLE' })
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
      sessionId: `session:${request.operatorId}`,
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
    if (Date.now() >= deadline) throw new Error('orchestration state did not converge')
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
    const events = await client.readEvents({ runId: started.runId, limit: 200 })
    expect(events.events.map(value => value.type)).toEqual(expect.arrayContaining([
      'intent.compiled', 'graph.compiled', 'capsule.resolved', 'context.compiled',
      'execution_plan.sealed', 'node.dispatched', 'node.evidence.accepted', 'run.completed',
    ]))
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
    const approved = await client.decide({ runId: started.runId, expectedRevision: recovered.revision, decision: 'approve', reason: 'test approval' })
    expect(approved.state).toBe('running')
    await eventually(() => client.inspect(String(started.runId)), value => value.state === 'completed')
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
      runId: run.runId, expectedRevision: waiting.revision, decision: 'approve', reason: 'cannot widen in place',
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
      blockers: [{ code: 'ORCHESTRATION_UNAVAILABLE' }],
    })
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
})
