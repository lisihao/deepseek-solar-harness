import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { LogicalTaskGraphV1, OrchestrationAdmissionTraceV1, OrchestrationNodeSpecV1 } from '@deepseek-ai/dsh-orchestration'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import {
  assertRestores, correlateResident, dispatchFacts, projectResident, serializeRequest, Tokens,
  type SerializedRequest,
} from '../../../../examples/acp-agent/tests/fixtures/prime-rlm-terminal/capture.ts'
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
  readonly nativeToolPolicy?: 'inherit' | 'disabled'
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
          { model: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', supportedEfforts: ['medium'], defaultEffort: 'medium' },
          { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', supportedEfforts: ['high'], defaultEffort: 'high' },
        ]
        : [
          { model: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', supportedEfforts: [] },
          { model: 'claude-opus-4-6', displayName: 'Claude Opus 4.6', supportedEfforts: [] },
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
    readonly retryPolicy?: OrchestrationNodeSpecV1['retryPolicy']
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
    retryPolicy: options.retryPolicy ?? { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
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
  const seededAt = '2026-08-24T00:00:00.000Z'
  await writeFile(join(home, 'task-templates.json'), JSON.stringify({
    formatVersion: 1,
    templates: [{
      id: 'coding-method', enabled: true, createdAt: seededAt, version: 1,
      name: 'Coding method', rank: 10, match: { objectiveKeywords: ['formatting'] },
      method: 'Apply the bounded coding method to {{objective}}.', updatedAt: seededAt, history: [],
    }],
    personalization: { 'coding-method': { preferences: 'Keep verification proportional.' } },
  }), 'utf8')
  const harnessRoot = join(root, 'continual-harness')
  await mkdir(harnessRoot, { recursive: true })
  await writeFile(join(harnessRoot, 'state.json'), JSON.stringify({
    version: 3,
    generation: 1,
    legacyEntries: [],
    managedEntries: [{
      version: 2,
      entryId: 'summarize-evidence',
      entryVersion: 1,
      scope: 'global',
      scopeId: 'global',
      kind: 'skill',
      title: 'Summarize evidence',
      content: 'Summarize bounded evidence through the trusted TypeScript Provider.',
      reference: { type: 'typescript', import: 'prime-e2e-skill-provider', callable: 'summarizeEvidence' },
      arguments: { text: '' },
      tags: [],
      evidenceRefs: [],
      provenance: 'prime-e2e-fixture',
      immutableBase: false,
      createdAt: seededAt,
      updatedAt: seededAt,
      digest: 'prime-e2e-seeded-skill',
    }],
    refinements: [],
    refinementQueue: [],
  }), 'utf8')
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
        admission: admission({
          sourceSessionId: direct.sourceSessionId,
          rlm: direct.rlm,
          runtimeContext: {
            version: 1,
            sourceSessionId: direct.sourceSessionId,
            contextSnapshotMessageId: `snapshot:${direct.sourceSessionId}`,
            sections: [{ name: 'mnemon:runtime-memory', text: 'USER preference: concise Chinese evidence.' }],
          },
        }),
        graph: taskGraph(fixture.workspace, [node('direct', direct.task, { operatorId: 'codex' })]),
      })
      const run = await fixture.client.start({ commandId: `start:${compiled.compilationId}`, compilationId: compiled.compilationId })
      const complete = await eventually(() => fixture.client.inspect(String(run.runId)), value => value.state === 'completed')
      expect(complete.nodes[0]).toMatchObject({ state: 'passed', rlm: 'disabled' })
      const request = fixture.resident.requests.at(-1)
      expect(request?.modelToolBridge).toBeUndefined()
      const context = request?.prompt?.[0]?.text
      const parsedContext = context === undefined
        ? undefined
        : JSON.parse(context) as { dshRuntimeContext?: { contexts?: unknown[] } }
      expect(parsedContext?.dshRuntimeContext?.contexts).toEqual(expect.arrayContaining([
        { name: 'mnemon:runtime-memory', text: 'USER preference: concise Chinese evidence.' },
      ]))
      const events = await fixture.client.readEvents({ runId: run.runId, limit: 200 })
      expect(events.events.find(event => event.type === 'operator.context.received')?.data).toMatchObject({
        format: 'native', roleFidelity: 'native',
      })
      const templateEvent = events.events.find(event => event.type === 'task-template.selected')
      expect(templateEvent?.data).toMatchObject(direct.sourceSessionId === 'auto-simple'
        ? { decision: 'inject', templateId: 'coding-method' }
        : { decision: 'skip', templateId: null })
      expect(events.events.find(event => event.type === 'rlm.resolved')?.data).toMatchObject({
        enabled: false,
        reason: direct.expectedReason,
      })
    }

    let mutateSealedSkillAfterSnapshot = false
    fixture.resident.onExecute = async (request) => {
      if (request.modelToolBridge === undefined) return
      let result: ToolCellResult
      if (request.commandId.endsWith(':rlm:root')) {
        const shouldMutateSealedSkill = mutateSealedSkillAfterSnapshot
        mutateSealedSkillAfterSnapshot = false
        result = await callTypescriptRepl(request, `${request.commandId}:root-program`, [
          'const children = await Promise.all([',
          '  rlm("produce independent evidence A", { name: "worker-a" }),',
          '  rlm("produce independent evidence B", { name: "worker-b" }),',
          ']);',
          'const skillCatalog = await skills.list();',
          'const managedSkill = skillCatalog.result.find(skill => skill.alias === "summarize-evidence");',
          ...(shouldMutateSealedSkill ? [
            'await harness.update({ scope: "global", entryId: "summarize-evidence", expectedEntryVersion: 1, reference: { type: "typescript", import: "prime-e2e-replacement-skill-provider", callable: "summarizeReplacement" }, provenance: "prime-e2e-live-override" });',
          ] : []),
          'const skillResult = managedSkill === undefined ? null : await skills.call("summarize-evidence", { text: "bounded family evidence" });',
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
          '({ childCount: children.length, refinementState: queued.state, managedSkill: managedSkill?.alias ?? null, skillCatalog, skillResult, nativeCompact })',
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
      admission: admission({ sourceSessionId: 'explicit-rlm', rlm: 'enabled', continualHarness: 'global' }),
      graph: taskGraph(fixture.workspace, [node('explicit-rlm', 'Finish the bounded root goal.', {
        role: 'implementation',
        knowledge: true,
        retryPolicy: { maxAttempts: 3, backoffMs: 25, retryableCodes: ['TIMEOUT'] },
      })]),
    })
    mutateSealedSkillAfterSnapshot = true
    const explicitRun = await fixture.client.start({ commandId: `start:${explicitCompiled.compilationId}`, compilationId: explicitCompiled.compilationId })
    const explicitComplete = await eventually(
      () => fixture.client.inspect(String(explicitRun.runId)),
      value => value.state === 'completed',
    )
    expect(explicitComplete.nodes[0]).toMatchObject({ state: 'passed', rlm: 'enabled' })
    const explicitEvents = await fixture.client.readEvents({ runId: explicitRun.runId, limit: 400 })
    expect(explicitEvents.events.find(event => event.type === 'rlm.resolved')?.data).toMatchObject({
      enabled: true,
      fidelity: 'prime-strict',
      childModelPolicy: 'parent-inherit',
      defaultChildModelOrigin: 'parent-inherited',
      inheritsParentModelByDefault: true,
    })
    expect(explicitEvents.events.some(event => event.type === 'rlm.worker.allocated')).toBe(false)
    const started = explicitEvents.events.find(event => event.type === 'rlm.execution.started')?.data
    const childDispatches = explicitEvents.events.filter(event => event.type === 'rlm.child.dispatched')
    expect(childDispatches).toHaveLength(2)
    expect(childDispatches.every(event => (
      event.data.operatorId === started?.rootOperatorId
      && event.data.model === started?.rootModel
      && event.data.modelOrigin === 'parent-inherited'
      && event.data.inheritsParentModel === true
    ))).toBe(true)
    for (const childDispatch of childDispatches) {
      expect(childDispatch.data.executionOptions).toMatchObject({
        toolNames: ['typescript_repl'],
        skillAliases: ['summarize-evidence'],
        retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['TIMEOUT'], initialDelayMs: 25 },
      })
    }
    expect(explicitEvents.events.filter(event => event.type === 'rlm.child.settled')).toHaveLength(2)
    // Messages queued together share one continuation, so the count of continuation events depends on arrival; the messages they
    // name do not. The runtime's own record says which two messages the children sent and in which order they were delivered; the
    // continuation events must name exactly those, each once, in that order, under the commands the runtime delivered them with.
    const runtimeState = JSON.parse(await readFile(join(fixture.root, 'rlm-runtime', 'state.json'), 'utf8')) as {
      messages: Array<{ messageId: string; source?: string; deliveryStatus: string; deliveredAt?: string }>
      events: Array<{ type: string; data: { messageId?: string; commandId?: string; batchIndex?: number; batchSize?: number } }>
      messageBatchDispatches: unknown[]
    }
    const childMessages = runtimeState.messages.filter(message => message.source !== 'control')
    expect(childMessages).toHaveLength(2)
    expect(new Set(childMessages.map(message => message.messageId)).size).toBe(2)
    expect(childMessages.every(message => message.deliveryStatus === 'delivered')).toBe(true)
    const messageContinuations = explicitEvents.events.filter(event => event.type === 'rlm.message.continuation.settled')
    expect(messageContinuations.flatMap(event => event.data.messageIds as string[]))
      .toEqual(runtimeState.events.filter(event => event.type === 'rlm.message.delivered').map(event => event.data.messageId))
    expect(messageContinuations.flatMap(event => event.data.messageIds as string[]).sort())
      .toEqual(childMessages.map(message => message.messageId).sort())
    for (const continuation of messageContinuations) {
      const members = continuation.data.messageIds as string[]
      const deliveredEvents = runtimeState.events
        .filter(event => event.type === 'rlm.message.delivered' && members.includes(event.data.messageId ?? ''))
      expect(deliveredEvents.map(event => event.data.messageId)).toEqual(members)
      expect(new Set(deliveredEvents.map(event => event.data.commandId))).toEqual(new Set([continuation.data.commandId]))
      expect(deliveredEvents.map(event => [event.data.batchIndex, event.data.batchSize]))
        .toEqual(members.map((_, index) => [index, members.length]))
    }
    // Nothing is left held or in flight once the run has completed.
    expect(runtimeState.messageBatchDispatches).toEqual([])
    expect(runtimeState.events.some(event => event.type === 'rlm.message.dispatch_unknown')).toBe(false)
    expect(explicitEvents.events).toContainEqual(expect.objectContaining({ type: 'rlm.goal.continuation.settled' }))
    expect(explicitEvents.events).toContainEqual(expect.objectContaining({ type: 'rlm.compaction.settled' }))
    expect(explicitEvents.events).toContainEqual(expect.objectContaining({ type: 'harness.refinement.applied' }))
    expect(explicitEvents.events.find(event => event.type === 'rlm.execution.settled')?.data).toMatchObject({ childCount: 2 })
    const rootRequest = fixture.resident.requests.find(request => request.commandId.endsWith(':rlm:root'))
    if (rootRequest === undefined) throw new Error('explicit RLM root request was not dispatched')
    expect(rootRequest.modelToolBridge?.tools.map(tool => tool.name)).toEqual(['typescript_repl'])
    expect(rootRequest.nativeToolPolicy).toBe('disabled')
    expect(fixture.resident.requests
      .filter(request => request.modelToolBridge !== undefined)
      .every(request => request.nativeToolPolicy === 'disabled')).toBe(true)
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
    const autoRun = await fixture.client.start({ commandId: `start:${autoCompiled.compilationId}`, compilationId: autoCompiled.compilationId })
    const autoComplete = await eventually(() => fixture.client.inspect(String(autoRun.runId)), value => value.state === 'completed')
    expect(autoComplete.nodes[0]).toMatchObject({ state: 'passed', rlm: 'enabled' })
    const autoEvents = await fixture.client.readEvents({ runId: autoRun.runId, limit: 300 })
    expect(autoEvents.events.find(event => event.type === 'rlm.resolved')?.data).toMatchObject({
      enabled: true,
      fidelity: 'dsh-optimized',
      reason: 'auto-explicit-decomposition',
      childModelPolicy: 'allocator-default',
      defaultChildModelOrigin: 'allocator-default',
      inheritsParentModelByDefault: false,
    })
    expect(autoEvents.events.find(event => event.type === 'rlm.worker.allocated')?.data).toMatchObject({
      childModelPolicy: 'allocator-default',
      defaultChildModelOrigin: 'allocator-default',
      inheritsParentModelByDefault: false,
    })
  }, 30_000)

  it('fails an explicit incompatible child thinking request before native child dispatch', async () => {
    const fixture = await e2eHarness('dsh-p-ep-')
    fixture.resident.onExecute = async (request) => {
      if (request.modelToolBridge === undefined) return
      const result = await callTypescriptRepl(request, `${request.commandId}:explicit-profile`, [
        'let rejection: unknown;',
        'try {',
        '  await rlm("use an incompatible effort", {',
        '    name: "incompatible-thinking", model: "codex/gpt-5.6-luna", thinking: "high"',
        '  });',
        '} catch (error) { rejection = error; }',
        '({',
        '  code: (rejection as { code?: string } | undefined)?.code,',
        '  message: rejection instanceof Error ? rejection.message : String(rejection),',
        '})',
      ].join('\n'))
      fixture.resident.cellResults.set(request.commandId, result)
    }
    const compiled = await fixture.client.compile({
      intent: { request: 'Reject incompatible explicit RLM child thinking.' },
      admission: admission({ sourceSessionId: 'explicit-profile', rlm: 'enabled' }),
      graph: taskGraph(fixture.workspace, [node('explicit-profile', 'Validate child selection.', { operatorId: 'codex' })]),
    })
    const run = await fixture.client.start({ commandId: `start:${compiled.compilationId}`, compilationId: compiled.compilationId })
    await eventually(() => fixture.client.inspect(String(run.runId)), value => value.state === 'completed')
    const rootRequest = fixture.resident.requests.find(request => request.commandId.endsWith(':rlm:root'))
    if (rootRequest === undefined) throw new Error('explicit profile root was not dispatched')
    const result = fixture.resident.cellResults.get(rootRequest.commandId)?.value
    expect(result).toMatchObject({ code: 'ORCHESTRATION_UNAVAILABLE' })
    expect(result).toHaveProperty('message', expect.stringContaining(
      'explicit RLM child thinking is unsupported by codex/gpt-5.6-luna: high',
    ))
    expect(fixture.resident.requests.filter(request => request.commandId.includes(':rlm:rlm-child-'))).toHaveLength(0)
  })

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
    const run = await fixture.client.start({ commandId: `start:${compiled.compilationId}`, compilationId: compiled.compilationId })
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

describe('what a Resident root and a Resident child are given', () => {
  const CANARY = 'CANARY-ONLY-IN-THE-ROOT-TASK-7731'
  const ROOT_TASK = `Run the capture scenario. Private note for the root only: ${CANARY}. Final rule: reply with only {"verdict": "<text>"}. ROOT-TAIL-RULE`
  const CHILD_TAIL = 'Final rule: end the report with the exact token CHILD-TAIL-RULE.'
  // Long enough to cross any small cap on a task; the only statement of the output rule is its last line.
  const CHILD_TASK = `Inspector task: read your context and report. ${'Detail line of the inspector task. '.repeat(160)}${CHILD_TAIL}`

  /**
   * Runs one explicit RLM node whose root spawns one child, the child messages the root, and the root is continued. Returns what
   * the Resident provider seam (the daemon's call into the ResidentClient) was asked, each request tied to its dispatch by the
   * events the daemon and the runtime recorded, and what the child's REPL showed. The native driver's own model requests and tool
   * rounds happen behind this seam and are not captured.
   */
  async function capture() {
    const fixture = await e2eHarness('dsh-prime-capture-')
    const childContext: { value: string | undefined } = { value: undefined }
    // Every request is serialized the moment it arrives, before the fixture touches it.
    const seam: Array<{ ordinal: number; serialized: SerializedRequest; keys: string[] }> = []
    fixture.resident.onExecute = async (request) => {
      seam.push({ ordinal: fixture.resident.requests.length - 1, serialized: serializeRequest(request), keys: Object.keys(request) })
      if (request.modelToolBridge === undefined) return
      if (request.commandId.endsWith(':rlm:root')) {
        const result = await callTypescriptRepl(request, `${request.commandId}:program`, `await rlm(${JSON.stringify(CHILD_TASK)}, { name: "inspector" }); "spawned"`)
        fixture.resident.cellResults.set(request.commandId, result)
      } else if (request.commandId.includes(':rlm:rlm-child-')) {
        const result = await callTypescriptRepl(request, `${request.commandId}:program`, 'JSON.stringify(context)')
        childContext.value = typeof result.value === 'string' ? result.value : undefined
        await callTypescriptRepl(request, `${request.commandId}:report`, 'await agentMessage.send("inspector figure is 6", { receiverRole: "parent", mode: "auto" }); "sent"')
        fixture.resident.cellResults.set(request.commandId, result)
      } else if (request.commandId.endsWith(':deliver')) {
        const result = await callTypescriptRepl(request, `${request.commandId}:read`, '({ received: (await agentMessage.read()).length })')
        fixture.resident.cellResults.set(request.commandId, result)
      }
    }
    const compiled = await fixture.client.compile({
      intent: { request: ROOT_TASK },
      admission: admission({ sourceSessionId: 'capture-rlm', rlm: 'enabled' }),
      graph: taskGraph(fixture.workspace, [node('capture', ROOT_TASK, { operatorId: 'codex' })]),
    })
    const run = await fixture.client.start({ commandId: `start:${compiled.compilationId}`, compilationId: compiled.compilationId })
    await eventually(() => fixture.client.inspect(String(run.runId)), value => value.state === 'completed')
    await eventually(() => Promise.resolve(childContext.value), value => value !== undefined)
    await eventually(
      () => Promise.resolve(fixture.resident.requests.filter(request => request.commandId.endsWith(':deliver'))),
      continuations => continuations.length > 0 && continuations.every(request => fixture.resident.cellResults.has(request.commandId)),
    )
    const events = (await fixture.client.readEvents({ runId: run.runId, limit: 400 })).events
    const runtime = JSON.parse(await readFile(join(fixture.root, 'rlm-runtime', 'state.json'), 'utf8')) as {
      events: Array<{ type: string; sessionId: string; data: { commandId?: string } }>
    }
    const facts = dispatchFacts(events, runtime.events)
    const withBridge = seam.filter(entry => fixture.resident.requests[entry.ordinal]?.modelToolBridge !== undefined)
    const correlated = correlateResident(withBridge.map(entry => ({
      ordinal: entry.ordinal,
      commandId: String(entry.serialized.value.commandId),
      bridgeSessionId: (entry.serialized.value.modelToolBridge as { sessionId?: string } | undefined)?.sessionId,
    })), facts)
    const tokens = new Tokens()
    const requests = correlated.map((entry) => {
      const { serialized, keys } = withBridge.find(candidate => candidate.ordinal === entry.ordinal) as (typeof withBridge)[number]
      // Nothing is dropped without a name: every field of the request is saved or excluded with a reason.
      const accounted = [...Object.keys(serialized.value).filter(key => !key.endsWith('Aborted')), ...serialized.excluded.map(item => item.field)]
      expect([...new Set(accounted)].sort()).toEqual([...keys].sort())
      const projection = projectResident(serialized.value, tokens)
      assertRestores(`Resident request ${String(entry.ordinal)}`, serialized.value, projection, tokens)
      const prompt = (serialized.value.prompt as Array<{ text?: string }> | undefined)?.map(block => block.text ?? '').join('\n') ?? ''
      return {
        ordinal: entry.ordinal, who: entry.who, value: serialized.value, excluded: serialized.excluded, projection, prompt,
        sha256: createHash('sha256').update(JSON.stringify(serialized.value)).digest('hex'),
        tools: (serialized.value.modelToolBridge as { tools?: Array<{ name: string }> } | undefined)?.tools?.map(tool => tool.name) ?? [],
        nativeToolPolicy: serialized.value.nativeToolPolicy,
      }
    })
    const context = JSON.parse(childContext.value ?? 'null') as Record<string, unknown> | null
    const directory = process.env.DSH_REQUEST_CAPTURE_DIR
    if (directory !== undefined) {
      await mkdir(directory, { recursive: true })
      const write = (name: string, value: unknown): Promise<void> => writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
      await write('resident-raw.json', {
        covers: 'the call from the orchestration daemon into the ResidentClient; not the native driver\'s own model requests or tool rounds',
        requests: seam.map(entry => ({
          ordinal: entry.ordinal, sha256: createHash('sha256').update(JSON.stringify(entry.serialized.value)).digest('hex'),
          request: entry.serialized.value, excluded: entry.serialized.excluded,
        })),
      })
      await write('resident-correlation.json', {
        facts, requests: correlated.map(({ ordinal, who, commandId, bridgeSessionId }) => ({ ordinal, who, commandId, bridgeSessionId })),
      })
      await write('resident-projection.json', {
        tokens: tokens.table(), requests: requests.map(({ ordinal, who, projection }) => ({ ordinal, who, projection })),
        childContext: context,
      })
    }
    return { requests, context }
  }

  it('gives the root, the child and the root\'s message continuation what they should be given, each tied to its recorded dispatch', async () => {
    const { requests } = await capture()
    expect(requests.map(request => request.who)).toEqual(['root', 'child', 'continuation'])
    const [root, child, continuation] = requests as [(typeof requests)[number], (typeof requests)[number], (typeof requests)[number]]
    expect(root.prompt).toContain(CANARY)
    expect(root.prompt).toContain('ROOT-TAIL-RULE')
    expect(child.prompt).toContain(CHILD_TASK)
    expect(child.prompt).toContain(CHILD_TAIL)
    expect(child.prompt).not.toContain(CANARY)
    expect(continuation.prompt).toContain('Agent message from')
    expect(continuation.prompt).toContain('inspector figure is 6')
    expect(continuation.prompt).toContain(ROOT_TASK)
    for (const request of requests) {
      expect(request.tools).toEqual(['typescript_repl'])
      expect(request.excluded).toEqual([expect.objectContaining({ field: 'signal' })])
    }
    expect(child.nativeToolPolicy).toBe('disabled')
    // The command, session and workspace are what the daemon sent, not a projection of them.
    expect(new Set(requests.map(request => request.sha256)).size).toBe(3)
  })

  it('lets the root read its child\'s stored result in segments through the real daemon, and returns the same text as the store holds', async () => {
    const fixture = await e2eHarness('dsh-prime-read-result-')
    interface Read {
      readonly text: string
      readonly fullSha256: string
      readonly count: number
      readonly ref: string
      readonly status: string
      readonly parts: ReadonlyArray<{ readonly text: string; readonly segmentSha256: string; readonly offset: number }>
    }
    const read: { value: Read | undefined } = { value: undefined }
    fixture.resident.onExecute = async (request) => {
      if (request.modelToolBridge === undefined || !request.commandId.endsWith(':rlm:root')) return
      const id = request.commandId
      await callTypescriptRepl(request, `${id}:spawn`, 'await rlm("Reader task.", { name: "reader" }); "spawned"')
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const summaries = await callTypescriptRepl(request, `${id}:poll-${String(attempt)}`, 'await rlm.childSummaries()')
        const first = (summaries.value as Array<{ lifecycle?: string }> | undefined)?.[0]
        if (first?.lifecycle === 'settled') break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      const result = await callTypescriptRepl(request, `${id}:read`, [
        'const kid = (await rlm.listSubagents())[0];',
        'let offset = 0, text = "", count = 0, fullSha256 = "", ref = "", status = ""; const parts = [];',
        'for (;;) {',
        '  const part = await rlm.readChildResult(kid, { offset, limit: 40 });',
        '  status = part.status;',
        '  if (status !== "settled") break;',
        '  text += part.text; count += 1; fullSha256 = part.fullSha256; ref = part.resultRef;',
        '  parts.push({ text: part.text, segmentSha256: part.segmentSha256, offset: part.offset });',
        '  if (part.nextOffset === null) break;',
        '  offset = part.nextOffset;',
        '}',
        '({ text, count, fullSha256, ref, status, parts })',
      ].join('\n'))
      read.value = result.value as Read
    }
    const compiled = await fixture.client.compile({
      intent: { request: 'Read a child result.' },
      admission: admission({ sourceSessionId: 'read-result-rlm', rlm: 'enabled' }),
      graph: taskGraph(fixture.workspace, [node('reader-node', 'Read a child result.', { operatorId: 'codex' })]),
    })
    const run = await fixture.client.start({ commandId: `start:${compiled.compilationId}`, compilationId: compiled.compilationId })
    await eventually(() => fixture.client.inspect(String(run.runId)), value => value.state === 'completed')
    await eventually(() => Promise.resolve(read.value), value => value !== undefined)
    const events = await fixture.client.readEvents({ runId: run.runId, limit: 300 })
    const settled = events.events.find(event => event.type === 'rlm.child.settled')
    const ref = String(settled?.data.artifactRef) as Parameters<typeof fixture.client.readArtifact>[0]
    const stored = await fixture.client.readArtifact(ref) as { output: Array<{ text: string }>; executionId: string }
    const whole = stored.output.map(block => block.text).join('\n')
    expect(read.value?.status).toBe('settled')
    expect(read.value?.text).toBe(whole)
    expect(read.value?.text).toMatch(/^offline completed .*:rlm:rlm-child-/u)
    expect(read.value?.count).toBeGreaterThan(1)
    expect(read.value?.fullSha256).toBe(createHash('sha256').update(whole, 'utf8').digest('hex'))
    expect(read.value?.ref).toBe(settled?.data.artifactRef)
    // Each segment carries the hash of its own text, and the segments start where the one before ended.
    let expectedOffset = 0
    for (const part of read.value?.parts ?? []) {
      expect(part.segmentSha256).toBe(createHash('sha256').update(part.text, 'utf8').digest('hex'))
      expect(part.offset).toBe(expectedOffset)
      expectedOffset += part.text.length
    }
    expect(expectedOffset).toBe(whole.length)
  })

  it('completes an explicit RLM node whose root creates no child, with no child dispatched and a child count of zero', async () => {
    const fixture = await e2eHarness('dsh-prime-zero-child-')
    fixture.resident.onExecute = async (request) => {
      if (request.modelToolBridge === undefined || !request.commandId.endsWith(':rlm:root')) return
      await callTypescriptRepl(request, `${request.commandId}:program`, '({ answer: "solved directly", children: (await rlm.listSubagents()).length })')
    }
    const compiled = await fixture.client.compile({
      intent: { request: 'A small task that needs no helpers.' },
      admission: admission({ sourceSessionId: 'zero-child-rlm', rlm: 'enabled' }),
      graph: taskGraph(fixture.workspace, [node('zero', 'A small task that needs no helpers.', { operatorId: 'codex' })]),
    })
    const run = await fixture.client.start({ commandId: `start:${compiled.compilationId}`, compilationId: compiled.compilationId })
    const complete = await eventually(() => fixture.client.inspect(String(run.runId)), value => value.state === 'completed')
    expect(complete.nodes[0]).toMatchObject({ state: 'passed', rlm: 'enabled' })
    const events = (await fixture.client.readEvents({ runId: run.runId, limit: 300 })).events
    expect(events.filter(event => event.type === 'rlm.child.dispatched')).toEqual([])
    expect(events.find(event => event.type === 'rlm.execution.settled')?.data).toMatchObject({ childCount: 0 })
  })

  it('shows the child\'s REPL its own task and none of the root\'s private note', async () => {
    const { context } = await capture()
    expect(context?.task).toBe(CHILD_TASK)
    expect(JSON.stringify(context)).not.toContain(CANARY)
  })
})
