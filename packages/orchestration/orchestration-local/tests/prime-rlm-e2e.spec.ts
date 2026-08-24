import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { LogicalTaskGraphV1, OrchestrationAdmissionTraceV1, OrchestrationNodeSpecV1 } from '@deepseek-ai/dsh-orchestration'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { OrchestrationDaemonClient } from '../src/client.ts'
import { OrchestrationDaemon } from '../src/daemon.ts'

interface ModelToolBridgeFixture {
  readonly version: 1
  readonly socketPath: string
  readonly sessionId: string
  readonly tools: readonly { readonly name: string }[]
}

interface ResidentRequestFixture {
  readonly commandId: string
  readonly operatorId: string
  readonly laneId?: string
  readonly profile?: { readonly model: string }
  readonly prompt?: readonly { readonly type: string; readonly text?: string }[]
  readonly modelToolBridge?: ModelToolBridgeFixture
  readonly workspace: string
}

interface ToolCellResult {
  readonly value?: unknown
  readonly stateRevision: number
}

type ResidentResult = {
  readonly output: readonly { readonly type: 'text'; readonly text: string }[]
  readonly stopReason: 'completed'
}

async function callTypescriptRepl(
  request: ResidentRequestFixture,
  commandId: string,
  code: string,
): Promise<ToolCellResult> {
  const bridge = request.modelToolBridge
  if (bridge === undefined) throw new Error('Prime RLM fixture expected a model-tool bridge')
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
    }) as ToolCellResult
  } finally {
    transport.close()
    socket.destroy()
  }
}

class KeylessResidentProvider {
  readonly requests: ResidentRequestFixture[] = []
  readonly cellResults = new Map<string, ToolCellResult>()
  readonly activeCommands = new Set<string>()
  readonly maxConcurrentByPhase: number[] = []
  readonly compactions: Array<{ readonly commandId: string; readonly sessionId: string }> = []
  onExecute?: (request: ResidentRequestFixture) => Promise<void>
  deferred = false
  private readonly pending = new Map<string, (result: ResidentResult) => void>()
  private readonly sessions = new Map<string, {
    sessionId: string
    operatorId: string
    workspace: string
    laneId: string
    lifecycle: 'idle'
    health: 'ok'
    control: 'automation'
    stateRevision: number
    nativeSessionId: string
    updatedAt: string
  }>()

  providers() {
    return Promise.resolve(['codex', 'claude-code'].map(operatorId => ({
      operatorId,
      product: operatorId,
      displayName: operatorId === 'codex' ? 'Codex' : 'Claude Code',
      description: 'Keyless offline E2E provider.',
      tags: operatorId === 'codex' ? ['coding'] : ['analysis'],
      maxConcurrency: 4,
      injectionBoundaries: ['pre-dispatch', 'next-turn'] as const,
      available: true,
      authentication: 'native-subscription',
      productVersion: 'offline-fixture',
      protocolHash: 'offline-fixture',
      models: operatorId === 'codex'
        ? [
          { model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', efforts: ['medium'], defaultEffort: 'medium' },
          { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', efforts: ['high'], defaultEffort: 'high' },
        ]
        : [
          { model: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', efforts: [] },
          { model: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', efforts: [] },
        ],
      ...operatorId === 'claude-code' ? {
        quotaPools: [{
          poolId: 'offline-claude', displayName: 'Offline Claude fixture',
          models: ['claude-sonnet-4-6', 'claude-opus-4-6'], meter: 'native-subscription' as const,
          primary: { usedPercent: 50 }, observedAt: '2026-08-24T00:00:00.000Z',
        }],
      } : {},
    })))
  }

  async execute(request: ResidentRequestFixture) {
    this.requests.push(request)
    this.activeCommands.add(request.commandId)
    this.maxConcurrentByPhase.push(this.activeCommands.size)
    await this.onExecute?.(request)
    const turnId = `turn:${request.commandId}`
    const sessionId = `session:${request.operatorId}:${request.laneId ?? 'default'}`
    this.sessions.set(sessionId, {
      sessionId,
      operatorId: request.operatorId,
      workspace: request.workspace,
      laneId: request.laneId ?? request.commandId,
      lifecycle: 'idle',
      health: 'ok',
      control: 'automation',
      stateRevision: this.sessions.get(sessionId)?.stateRevision ?? 1,
      nativeSessionId: `native:${sessionId}`,
      updatedAt: new Date().toISOString(),
    })
    const settled: ResidentResult = {
      output: [{ type: 'text', text: `offline completed ${request.commandId}` }],
      stopReason: 'completed',
    }
    const result = this.deferred
      ? new Promise<ResidentResult>((resolve) => {
        this.pending.set(request.commandId, resolve)
      }).finally(() => { this.activeCommands.delete(request.commandId) })
      : Promise.resolve(settled).finally(() => { this.activeCommands.delete(request.commandId) })
    return { turnId, sessionId, stateRevision: 1, result, dispose: async () => {} }
  }

  readEvents(_sessionId: string, afterSequence = 0) {
    return Promise.resolve({ events: [], nextSequence: afterSequence })
  }

  list() { return Promise.resolve([...this.sessions.values()]) }

  compact(request: {
    readonly commandId: string
    readonly sessionId: string
    readonly expectedStateRevision: number
    readonly instructions?: string
  }) {
    const session = this.sessions.get(request.sessionId)
    if (session === undefined) throw new Error(`unknown Resident Session: ${request.sessionId}`)
    if (session.stateRevision !== request.expectedStateRevision) throw new Error('fixture Resident revision conflict')
    const revised = { ...session, stateRevision: session.stateRevision + 1, updatedAt: new Date().toISOString() }
    this.sessions.set(request.sessionId, revised)
    this.compactions.push({ commandId: request.commandId, sessionId: request.sessionId })
    return Promise.resolve({ session: revised, nativeSessionId: revised.nativeSessionId, compactedAt: revised.updatedAt })
  }

  interrupt() { return Promise.resolve() }

  settle(commandId: string): void {
    const resolve = this.pending.get(commandId)
    if (resolve === undefined) throw new Error(`no deferred Resident turn: ${commandId}`)
    this.pending.delete(commandId)
    resolve({ output: [{ type: 'text', text: `offline completed ${commandId}` }], stopReason: 'completed' })
  }
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action()
})

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 6_000
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error(`Prime E2E did not converge: ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

function node(
  id: string,
  task: string,
  options: {
    readonly role?: string
    readonly dependsOn?: readonly string[]
    readonly writeScopes?: readonly string[]
    readonly operatorId?: string
    readonly knowledge?: boolean
  } = {},
): OrchestrationNodeSpecV1 {
  return {
    id,
    title: id,
    task,
    role: options.role ?? 'implementation',
    dependsOn: [...options.dependsOn ?? []],
    requiredForCompletion: true,
    capabilityRequirements: [],
    capabilityBudget: [],
    contextPolicy: {
      maxTokens: 4_096,
      allowedSourceKinds: options.knowledge === true
        ? ['intent', 'artifact', 'capsule', 'knowledge']
        : ['intent', 'artifact', 'capsule'],
      unavailableSource: 'block',
    },
    effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
    approvedSecretRefs: [],
    readScopes: [],
    writeScopes: [...options.writeScopes ?? [`fixture/${id}`]],
    acceptance: [{ id: 'done', description: 'offline provider completes', kind: 'operator-completed' }],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
    ...options.operatorId === undefined ? {} : { operator: { preferredIds: [options.operatorId] } },
  }
}

function taskGraph(workspace: string, nodes: readonly OrchestrationNodeSpecV1[], maxParallel = 4): LogicalTaskGraphV1 {
  return { version: 1, title: 'Prime RLM offline E2E', workspace, maxParallel, risk: 'low', nodes: [...nodes] }
}

function admission(overrides: Partial<OrchestrationAdmissionTraceV1>): OrchestrationAdmissionTraceV1 {
  return {
    policy: 'auto',
    route: 'taskgraph',
    sourceSessionId: 'prime-e2e-root',
    rlm: 'auto',
    continualHarness: 'off',
    optimization: 'balanced',
    ...overrides,
  }
}

async function e2eHarness(prefix: string): Promise<{
  readonly home: string
  readonly root: string
  readonly workspace: string
  readonly daemon: OrchestrationDaemon
  readonly client: OrchestrationDaemonClient
  readonly resident: KeylessResidentProvider
}> {
  const home = await mkdtemp(join(tmpdir(), prefix))
  const root = join(home, 'orchestrations')
  const workspace = join(home, 'workspace')
  await mkdir(workspace)
  const resident = new KeylessResidentProvider()
  const skillProviderModule = fileURLToPath(new URL('./fixtures/managed-skill-provider.ts', import.meta.url))
  const daemon = new OrchestrationDaemon({
    root,
    dshHome: home,
    residentClient: resident as unknown as ResidentDaemonClient,
    modelWorkerProviders: [],
    schedulerIntervalMs: 10,
    autoRefine: { enabled: false },
    skillProviderModules: [skillProviderModule],
  })
  await daemon.start()
  cleanup.push(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }) })
  const client = new OrchestrationDaemonClient({
    root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000,
    skillProviderModules: [skillProviderModule],
  })
  await client.ready()
  return { home, root, workspace, daemon, client, resident }
}

describe('Prime-compatible orchestration offline E2E', () => {
  it('keeps Standard direct, lets Auto choose, and runs explicit RLM through two async children, family messages, a goal, and a boundary refinement', async () => {
    const fixture = await e2eHarness('dsh-prime-modes-')
    const directRuns = [
      {
        sourceSessionId: 'standard-recursive',
        rlm: 'disabled' as const,
        task: 'Recursively explore alternatives, but execute in Standard mode.',
        expectedReason: 'user-disabled',
      },
      {
        sourceSessionId: 'auto-simple',
        rlm: 'auto' as const,
        task: 'Apply one bounded formatting fix.',
        expectedReason: 'auto-balanced-direct-node',
      },
    ]
    for (const direct of directRuns) {
      const compiled = await fixture.client.compile({
        intent: { request: direct.task },
        admission: admission({ sourceSessionId: direct.sourceSessionId, rlm: direct.rlm }),
        graph: taskGraph(fixture.workspace, [node('direct', direct.task, { operatorId: 'codex' })]),
      })
      const run = await fixture.client.start({ compilationId: compiled.compilationId })
      const complete = await eventually(() => fixture.client.inspect(String(run.runId)), value => value.state === 'completed')
      expect(complete.nodes[0]).toMatchObject({ state: 'passed', rlm: 'disabled' })
      const request = fixture.resident.requests.at(-1)
      expect(request?.modelToolBridge).toBeUndefined()
      const events = await fixture.client.readEvents({ runId: run.runId, limit: 200 })
      expect(events.events.find(event => event.type === 'rlm.resolved')?.data).toMatchObject({
        enabled: false,
        reason: direct.expectedReason,
      })
    }

    fixture.resident.onExecute = async (request) => {
      if (request.modelToolBridge === undefined) return
      let result: ToolCellResult
      if (request.commandId.endsWith(':rlm:root')) {
        result = await callTypescriptRepl(request, `${request.commandId}:root-program`, [
          'const children = await Promise.all([',
          '  rlm("produce independent evidence A", { name: "worker-a" }),',
          '  rlm("produce independent evidence B", { name: "worker-b" }),',
          ']);',
          'const managedSkill = await harness.create({',
          '  entryId: "summarize-evidence", kind: "skill", title: "Summarize evidence",',
          '  content: "Summarize bounded evidence through the trusted TypeScript Provider.",',
          '  reference: { type: "typescript", import: "prime-e2e-skill-provider", callable: "summarizeEvidence" },',
          '  arguments: { text: "" }, provenance: "prime-e2e"',
          '});',
          'const skillCatalog = await skills.list();',
          'const skillResult = await skills.call("summarize-evidence", { text: "bounded family evidence" });',
          'const proposal = await harness.planRefinement({',
          '  trigger: "prime-e2e",',
          '  observation: "family evidence should be retained at a real turn boundary",',
          '  evidenceRefs: ["fixture://prime-e2e"],',
          '  plannerId: "prime-e2e",',
          '  plannerVersion: "1",',
          '  changes: [{ operation: "create", entry: {',
          '    kind: "memory", title: "family evidence", content: "retain verified family evidence",',
          '    tags: ["prime-e2e"], evidenceRefs: ["fixture://prime-e2e"], provenance: "prime-e2e"',
          '  } }],',
          '});',
          'const queued = await harness.applyRefinement({',
          '  refinementId: proposal.refinementId, expectedGeneration: proposal.plannedGeneration, boundary: "turn-end"',
          '});',
          'const compactNonce = "namespace-survives-native-compact";',
          'const nativeCompact = await compact.run();',
          'await goal.create("finish after both family messages arrive", { continuationBudget: 2 });',
          '({ childCount: children.length, refinementState: queued.state, managedSkill: managedSkill.entryId, skillCatalog, skillResult, nativeCompact })',
        ].join('\n'))
      } else if (request.commandId.includes(':goal-continuation:')) {
        result = await callTypescriptRepl(request, `goal:${request.commandId}`, [
          'const family = await agentMessage.read();',
          'await goal.complete();',
          '({ familyCount: family.length, goalStatus: "complete", compactNonce })',
        ].join('\n'))
      } else if (request.commandId.endsWith(':deliver')) {
        result = await callTypescriptRepl(request, `delivery:${request.commandId}`, '({ received: (await agentMessage.read()).length })')
      } else {
        result = await callTypescriptRepl(request, `child:${request.commandId}`, [
          'await agentMessage.send("bounded child evidence", { receiverRole: "parent", mode: "follow_up" });',
          '({ sent: true })',
        ].join('\n'))
      }
      fixture.resident.cellResults.set(request.commandId, result)
    }

    const explicitCompiled = await fixture.client.compile({
      intent: { request: 'Execute a simple task through explicitly selected RLM.' },
      admission: admission({ sourceSessionId: 'explicit-rlm', rlm: 'enabled', continualHarness: 'session' }),
      graph: taskGraph(fixture.workspace, [node('explicit-rlm', 'Finish the bounded root goal.', {
        role: 'implementation',
        knowledge: true,
      })]),
    })
    const explicitRun = await fixture.client.start({ compilationId: explicitCompiled.compilationId })
    const explicitComplete = await eventually(
      () => fixture.client.inspect(String(explicitRun.runId)),
      value => value.state === 'completed',
    )
    expect(explicitComplete.nodes[0]).toMatchObject({ state: 'passed', rlm: 'enabled' })
    const explicitEvents = await fixture.client.readEvents({ runId: explicitRun.runId, limit: 400 })
    expect(explicitEvents.events.filter(event => event.type === 'rlm.child.settled')).toHaveLength(2)
    expect(explicitEvents.events.filter(event => event.type === 'rlm.message.continuation.settled')).toHaveLength(2)
    expect(explicitEvents.events).toContainEqual(expect.objectContaining({ type: 'rlm.goal.continuation.settled' }))
    expect(explicitEvents.events).toContainEqual(expect.objectContaining({ type: 'rlm.compaction.settled' }))
    expect(explicitEvents.events).toContainEqual(expect.objectContaining({ type: 'harness.refinement.applied' }))
    expect(explicitEvents.events.find(event => event.type === 'rlm.execution.settled')?.data).toMatchObject({ childCount: 2 })
    const rootRequest = fixture.resident.requests.find(request => request.commandId.endsWith(':rlm:root'))
    if (rootRequest === undefined) throw new Error('explicit RLM root request was not dispatched')
    expect(rootRequest.modelToolBridge?.tools.map(tool => tool.name)).toEqual(['typescript_repl'])
    const rootCell = fixture.resident.cellResults.get(rootRequest.commandId)
    expect(rootCell?.value).toMatchObject({
      childCount: 2,
      refinementState: 'queued',
      managedSkill: 'summarize-evidence',
      skillCatalog: {
        ok: true,
        result: [expect.objectContaining({ alias: 'summarize-evidence', available: true })],
      },
      skillResult: {
        ok: true,
        result: { summary: 'skill:bounded family evidence', source: 'trusted-typescript-provider' },
      },
      nativeCompact: { scheduled: true },
    })
    const goalCell = [...fixture.resident.cellResults.entries()].find(([commandId]) => commandId.includes(':goal-continuation:'))?.[1]
    expect(goalCell?.value).toMatchObject({
      familyCount: 2,
      goalStatus: 'complete',
      compactNonce: 'namespace-survives-native-compact',
    })
    expect(fixture.resident.compactions).toHaveLength(1)
    const harnessState = JSON.parse(await readFile(join(fixture.root, 'continual-harness', 'state.json'), 'utf8')) as {
      generation: number
      managedEntries: readonly { title: string; content: string }[]
      refinementQueue: readonly { state: string; requestedBoundary: string }[]
    }
    expect(harnessState.generation).toBeGreaterThan(0)
    expect(harnessState.managedEntries).toContainEqual(expect.objectContaining({
      title: 'family evidence',
      content: 'retain verified family evidence',
    }))
    expect(harnessState.refinementQueue).toContainEqual(expect.objectContaining({
      state: 'applied',
      requestedBoundary: 'turn-end',
    }))

    const autoCompiled = await fixture.client.compile({
      intent: { request: 'Automatically decompose this recursive exploration.' },
      admission: admission({ sourceSessionId: 'auto-complex', rlm: 'auto', continualHarness: 'off' }),
      graph: taskGraph(fixture.workspace, [node('auto-rlm', 'Recursively explore two alternatives.', { role: 'synthesis' })]),
    })
    const autoRun = await fixture.client.start({ compilationId: autoCompiled.compilationId })
    const autoComplete = await eventually(() => fixture.client.inspect(String(autoRun.runId)), value => value.state === 'completed')
    expect(autoComplete.nodes[0]).toMatchObject({ state: 'passed', rlm: 'enabled' })
    const autoEvents = await fixture.client.readEvents({ runId: autoRun.runId, limit: 300 })
    expect(autoEvents.events.find(event => event.type === 'rlm.resolved')?.data).toMatchObject({
      enabled: true,
      reason: 'auto-explicit-decomposition',
    })
  }, 15_000)

  it('runs independent TaskGraph nodes in parallel, then serializes a shared scope without deadlock', async () => {
    const fixture = await e2eHarness('dsh-prime-dag-')
    fixture.resident.deferred = true
    const compiled = await fixture.client.compile({
      intent: { request: 'Exercise DAG concurrency and scope admission.' },
      admission: admission({ sourceSessionId: 'dag-e2e', rlm: 'disabled' }),
      graph: taskGraph(fixture.workspace, [
        node('parallel-a', 'Independent A.', { writeScopes: ['parallel/a'], operatorId: 'codex' }),
        node('parallel-b', 'Independent B.', { writeScopes: ['parallel/b'], operatorId: 'claude-code' }),
        node('shared-a', 'Shared writer A.', { dependsOn: ['parallel-a', 'parallel-b'], writeScopes: ['shared'], operatorId: 'codex' }),
        node('shared-b', 'Shared writer B.', { dependsOn: ['parallel-a', 'parallel-b'], writeScopes: ['shared'], operatorId: 'claude-code' }),
      ], 4),
    })
    const run = await fixture.client.start({ compilationId: compiled.compilationId })
    await eventually(
      () => fixture.client.inspect(String(run.runId)),
      value => value.nodes.filter(candidate => candidate.state === 'running').length === 2,
    )
    expect(fixture.resident.activeCommands.size).toBe(2)
    expect([...fixture.resident.activeCommands].map(command => command.split(':').at(-2)).sort()).toEqual(['parallel-a', 'parallel-b'])
    for (const command of [...fixture.resident.activeCommands]) fixture.resident.settle(command)

    const serialized = await eventually(
      () => fixture.client.inspect(String(run.runId)),
      value => value.nodes.some(candidate => candidate.state === 'running' && candidate.id.startsWith('shared-'))
        && value.nodes.some(candidate => candidate.waitReason?.code === 'SCOPE_CONFLICT'),
    )
    expect(serialized.nodes.filter(candidate => candidate.state === 'running')).toHaveLength(1)
    expect(fixture.resident.activeCommands.size).toBe(1)
    fixture.resident.settle([...fixture.resident.activeCommands][0]!)
    await eventually(() => fixture.client.inspect(String(run.runId)), () => fixture.resident.activeCommands.size === 1)
    fixture.resident.settle([...fixture.resident.activeCommands][0]!)

    const complete = await eventually(() => fixture.client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(complete.nodes.every(candidate => candidate.state === 'passed')).toBe(true)
    expect(fixture.resident.maxConcurrentByPhase).toContain(2)
    expect(fixture.resident.maxConcurrentByPhase.filter(count => count > 1)).toEqual([2])
    const events = await fixture.client.readEvents({ runId: run.runId, limit: 300 })
    expect(events.events.filter(event => event.type === 'node.dispatched')).toHaveLength(4)
    expect(events.events.at(-1)?.type).toBe('run.completed')
  }, 15_000)
})
