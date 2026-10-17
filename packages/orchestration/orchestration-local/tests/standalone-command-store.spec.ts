import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PhysicalOperatorExecutionId, PhysicalOperatorId } from '@deepseek-ai/dsh-physical-operator'
import { buildOperatorContextEnvelope, parseOperatorContextEnvelope } from '@deepseek-ai/dsh-system-prompt'
import { OrchestrationRunId, type LogicalTaskGraphV1, type OrchestrationCompilationV1, type StandaloneRlmStartRequest } from '@deepseek-ai/dsh-orchestration'
import { StandaloneRlmCommands } from '../src/standalone-commands.ts'
import type { IntentIRV1 } from '@deepseek-ai/dsh-intent-compiler'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson, canonicalSha256 } from '../src/canonical.ts'
import { graphCertificate } from '../src/graph.ts'
import { OrchestrationStore, ORCHESTRATION_STATE_SCHEMA_VERSION, STANDALONE_RLM_START_METHOD, type RuntimeRunRecord } from '../src/store.ts'

const stores: OrchestrationStore[] = []
const roots: string[] = []

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-standalone-command-'))
  roots.push(root)
  const store = new OrchestrationStore(root)
  stores.push(store)
  return store
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function fixture(store: OrchestrationStore) {
  const graph: LogicalTaskGraphV1 = {
    version: 1, title: 'store fixture', workspace: store.root, maxParallel: 1, risk: 'low',
    nodes: [{
      id: 'task', title: 'fixture', task: 'fixture input', role: 'analysis',
      dependsOn: [], requiredForCompletion: true, capabilityRequirements: [], capabilityBudget: [],
      contextPolicy: { maxTokens: 4096, allowedSourceKinds: ['intent', 'artifact'], unavailableSource: 'block' },
      effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
      readScopes: [], writeScopes: [], approvedSecretRefs: [],
      acceptance: [{ id: 'done', description: 'fixture completes', kind: 'operator-completed' }],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
    }],
  }
  const intent: IntentIRV1 = {
    version: 1, objective: 'store fixture', expectedOutcomes: [], constraints: [], nonGoals: [],
    acceptanceRequirements: [], sourceRefs: [], attachmentRefs: [], riskHints: [], ambiguities: [],
    requiresClarification: false,
    provenance: { compilerId: 'fixture', compilerVersion: '1', inputSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64) },
  }
  const compilation: OrchestrationCompilationV1 = {
    version: 1, compilationId: 'fixture-compilation', intent, graph,
    intentRef: store.putArtifact(intent), graphRef: store.putArtifact(graph),
    certificate: graphCertificate(graph), requiresClarification: false, blockers: [],
  }
  store.saveCompilation(compilation)
  const at = '2026-10-17T00:00:00.000Z'
  const record: RuntimeRunRecord = {
    snapshot: {
      runId: OrchestrationRunId('fixture-run'), title: graph.title, workspace: graph.workspace,
      state: 'running', revision: 1, graphRevision: 1, certificate: compilation.certificate,
      nodes: [{
        id: 'task', title: 'fixture', role: 'analysis', dependsOn: [], state: 'pending',
        attempt: 0, capabilityGeneration: 1, evidenceRefs: [], blockers: [], updatedAt: at,
      }],
      blockers: [], createdAt: at, updatedAt: at,
    },
    graph, intent, intentRef: compilation.intentRef, graphRef: compilation.graphRef, retryAfter: {},
  }
  const events = [{ runId: record.snapshot.runId, type: 'run.started', time: at, data: { state: 'running' } }]
  return { compilation, record, events }
}

describe('standalone command persistence', () => {
  function request(store: OrchestrationStore, graph = fixture(store).record.graph): StandaloneRlmStartRequest {
    return {
      input: {
        version: 1, operatorId: PhysicalOperatorId('rlm-wrapper'), executionId: PhysicalOperatorExecutionId('outer-async'),
        prompt: [{ type: 'text', text: 'fixture input' }],
        driver: { kind: 'model-worker', operatorId: PhysicalOperatorId('fixture-api'), model: 'fixture-model' },
      },
      compile: { intent: { request: 'fixture input' }, graph },
    }
  }

  it('registers the accepted command before compiler re-entry and shares one asynchronous compilation', async () => {
    const store = await openStore()
    const { compilation, record, events } = fixture(store)
    const input = request(store, record.graph)
    const deferred = Promise.withResolvers<OrchestrationCompilationV1>()
    let calls = 0
    let scheduled = 0
    let duplicate: ReturnType<StandaloneRlmCommands['start']> | undefined
    const owner = new StandaloneRlmCommands(store, {
      compile: (fixed) => {
        calls++
        expect(store.commandReceipt(fixed.input.executionId)?.standaloneRequest).toEqual(fixed)
        duplicate = owner.start(structuredClone(fixed))
        return deferred.promise
      },
      initial: () => ({ record, events }),
      scheduled: () => { scheduled++ },
      observation: () => ({ settlement: 'running' }),
      cancel: () => { throw new Error('unexpected cancel') },
    })
    const first = owner.start(input)
    expect(calls).toBe(1)
    expect(store.listRuns()).toEqual([])
    ;(input.input.prompt[0] as { text: string }).text = 'caller mutation'
    await expect(owner.start(input)).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' })
    deferred.resolve(compilation)
    const [a, b] = await Promise.all([first, duplicate!])
    expect(a.run?.runId).toBe(b.run?.runId)
    expect(calls).toBe(1)
    expect(scheduled).toBe(1)
    expect(store.listRuns()).toHaveLength(1)
    expect(store.getRun(String(record.snapshot.runId)).standaloneRlmCommandId).toBe(input.input.executionId)
    await owner.start({ ...input, input: { ...input.input, prompt: [{ type: 'text', text: 'fixture input' }] } })
    expect(calls).toBe(1)
  })

  it('fences fresh identities after recovery while identical old input remains observable without replay', async () => {
    const store = await openStore()
    const input = request(store)
    store.acceptStandaloneCommand(input.input.executionId, input as unknown as Record<string, unknown>)
    let calls = 0
    const owner = new StandaloneRlmCommands(store, {
      compile: async () => { calls++; throw new Error('must not compile') },
      initial: () => { throw new Error('must not create run') },
      scheduled: () => { throw new Error('must not schedule') },
      observation: () => ({ settlement: 'running' }), cancel: () => {},
    })
    await expect(owner.start(input)).resolves.toMatchObject({ state: 'indeterminate', settlement: 'unknown' })
    await expect(owner.start({ ...input, input: { ...input.input, executionId: PhysicalOperatorExecutionId('new-identity') } }))
      .rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    expect(calls).toBe(0)
    expect(store.listRuns()).toEqual([])
  })

  it('retains uncertainty after a compiler failure and never creates a business run or retries compilation', async () => {
    const store = await openStore()
    const input = request(store)
    let calls = 0
    const owner = new StandaloneRlmCommands(store, {
      compile: async () => { calls++; throw new Error('response lost after compilation persistence') },
      initial: () => { throw new Error('must not create run') },
      scheduled: () => { throw new Error('must not schedule') },
      observation: () => ({ settlement: 'running' }), cancel: () => {},
    })
    await expect(owner.start(input)).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    await expect(owner.start(input)).resolves.toMatchObject({ state: 'indeterminate', settlement: 'unknown' })
    expect(calls).toBe(1)
    expect(store.listRuns()).toEqual([])
  })

  it('honors cancellation during compilation before run creation and reports the proven non-start', async () => {
    const store = await openStore()
    const { compilation, record, events } = fixture(store)
    const input = request(store, record.graph)
    const deferred = Promise.withResolvers<OrchestrationCompilationV1>()
    const owner = new StandaloneRlmCommands(store, {
      compile: () => deferred.promise, initial: () => ({ record, events }),
      scheduled: () => { throw new Error('cancelled command must not schedule') },
      observation: () => ({ settlement: 'running' }),
      cancel: () => { throw new Error('no business run exists to cancel') },
    })
    const started = owner.start(input)
    expect(owner.cancel(input.input.executionId, owner.inspect(input.input.executionId).requestSha256).settlement).toBe('not-started')
    deferred.resolve(compilation)
    await expect(started).resolves.toMatchObject({
      state: 'failed', settlement: 'settled', phase: 'compiled', error: { code: 'STANDALONE_CANCELLED_BEFORE_RUN' },
    })
    expect(store.listRuns()).toEqual([])
  })
  it('persists the accepted immutable request before any compilation or run association', async () => {
    const store = await openStore()
    const id = PhysicalOperatorExecutionId('outer-accepted')
    const input = { prompt: 'original', model: 'fixture-model' }
    const expectedHash = canonicalSha256({ method: STANDALONE_RLM_START_METHOD, request: input })
    store.acceptStandaloneCommand(id, input)
    input.prompt = 'mutated caller value'
    expect(store.commandReceipt(id)).toMatchObject({
      state: 'accepted', standalonePhase: 'accepted', standaloneRequest: { prompt: 'original' }, requestSha256: expectedHash,
    })
    expect(store.commandReceipt(id)?.runId).toBeUndefined()
    expect(store.listRuns()).toEqual([])
    expect(store.unfinishedStandaloneCommands().map(value => value.commandId)).toEqual([id])
  })

  it('commits one command/run association with its initial events', async () => {
    const store = await openStore()
    const { compilation, record, events } = fixture(store)
    const id = PhysicalOperatorExecutionId('outer-started')
    store.acceptStandaloneCommand(id, { prompt: 'fixture' })
    store.linkStandaloneCompilation(id, compilation.compilationId)
    store.createStandaloneRunForCommand(id, compilation.compilationId, record, events)
    expect(store.commandReceipt(id)).toMatchObject({
      state: 'accepted', standalonePhase: 'started', compilationId: compilation.compilationId, runId: record.snapshot.runId,
    })
    expect(store.standaloneCommandForRun(record.snapshot.runId)?.commandId).toBe(id)
    expect(store.readEvents(String(record.snapshot.runId), 0, 10).events).toHaveLength(1)
    expect(store.getRun(String(record.snapshot.runId))).toEqual(record)
  })

  it('preserves the original envelope representation through SQLite restart while hashing whole input canonically', async () => {
    const store = await openStore()
    const id = PhysicalOperatorExecutionId('outer-envelope-order')
    const envelope = buildOperatorContextEnvelope({
      systemText: 'Retain original context.', task: [{ type: 'text', text: 'first part\nsecond part' }],
      contexts: [{ name: 'workspace', text: 'read-only fixture' }],
      source: { kind: 'tool', requestHeaderEventSeq: 7, toolCallId: 'original-tool' },
    })
    const request = { input: { contextEnvelope: envelope } }
    expect(() => parseOperatorContextEnvelope(JSON.parse(canonicalJson(envelope)))).toThrow('digest mismatch')
    store.acceptStandaloneCommand(id, request)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = new OrchestrationStore(store.root)
    stores.push(reopened)
    const receipt = reopened.commandReceipt(id)
    const input = receipt?.standaloneRequest?.input
    if (input === null || typeof input !== 'object' || !('contextEnvelope' in input)) throw new Error('missing persisted envelope')
    expect(JSON.stringify(input.contextEnvelope)).toBe(JSON.stringify(envelope))
    expect(parseOperatorContextEnvelope(input.contextEnvelope)).toEqual(envelope)
    expect(receipt?.requestSha256).toBe(canonicalSha256({ method: STANDALONE_RLM_START_METHOD, request }))
  })

  it('rolls a run and events back when the command is not in the matching compiled phase', async () => {
    const store = await openStore()
    const { compilation, record, events } = fixture(store)
    const id = PhysicalOperatorExecutionId('outer-uncompiled')
    store.acceptStandaloneCommand(id, { prompt: 'fixture' })
    expect(() =>{  store.createStandaloneRunForCommand(id, compilation.compilationId, record, events) }).toThrow('unmatched compiled command')
    expect(store.listRuns()).toEqual([])
    expect(store.readEvents(String(record.snapshot.runId), 0, 10).events).toEqual([])
    expect(store.commandReceipt(id)?.standalonePhase).toBe('accepted')
  })

  it('requires the association UPDATE to hit even when a database trigger ignores it', async () => {
    const store = await openStore()
    const { compilation, record, events } = fixture(store)
    const id = PhysicalOperatorExecutionId('outer-update-fault')
    store.acceptStandaloneCommand(id, { prompt: 'fixture' })
    store.linkStandaloneCompilation(id, compilation.compilationId)
    store.db.exec('CREATE TRIGGER refuse_standalone_link BEFORE UPDATE OF run_id ON command_receipts BEGIN SELECT RAISE(IGNORE); END;')
    expect(() =>{  store.createStandaloneRunForCommand(id, compilation.compilationId, record, events) }).toThrow('unmatched compiled command')
    expect(store.listRuns()).toEqual([])
    expect(store.commandReceipt(id)).toMatchObject({ standalonePhase: 'compiled' })
    expect(store.commandReceipt(id)?.runId).toBeUndefined()
    store.db.exec('DROP TRIGGER refuse_standalone_link')
    store.createStandaloneRunForCommand(id, compilation.compilationId, record, events)
    expect(store.commandReceipt(id)?.runId).toBe(record.snapshot.runId)
  })

  it('retains the original run when the same command is offered a second run', async () => {
    const store = await openStore()
    const { compilation, record, events } = fixture(store)
    const id = PhysicalOperatorExecutionId('outer-one-run')
    store.acceptStandaloneCommand(id, { prompt: 'fixture' })
    store.linkStandaloneCompilation(id, compilation.compilationId)
    store.createStandaloneRunForCommand(id, compilation.compilationId, record, events)
    const replacement: RuntimeRunRecord = { ...record, snapshot: { ...record.snapshot, runId: OrchestrationRunId('replacement-run') } }
    expect(() =>{  store.createStandaloneRunForCommand(id, compilation.compilationId, replacement, []) }).toThrow('unmatched compiled command')
    expect(store.listRuns().map(value => value.snapshot.runId)).toEqual([record.snapshot.runId])
    expect(store.commandReceipt(id)?.runId).toBe(record.snapshot.runId)
  })

  it('rolls back run creation when its initial event cannot be written', async () => {
    const store = await openStore()
    const { compilation, record, events } = fixture(store)
    const id = PhysicalOperatorExecutionId('outer-event-fault')
    store.acceptStandaloneCommand(id, { prompt: 'fixture' })
    store.linkStandaloneCompilation(id, compilation.compilationId)
    store.db.exec("CREATE TRIGGER refuse_initial_event BEFORE INSERT ON orchestration_events BEGIN SELECT RAISE(ABORT, 'fixture event failure'); END;")
    expect(() =>{  store.createStandaloneRunForCommand(id, compilation.compilationId, record, events) }).toThrow('fixture event failure')
    expect(store.listRuns()).toEqual([])
    expect(store.commandReceipt(id)?.standalonePhase).toBe('compiled')
    expect(store.commandReceipt(id)?.runId).toBeUndefined()
  })

  it('retains unresolved input across restart without creating a run or replacing an ordinary receipt', async () => {
    const store = await openStore()
    const id = PhysicalOperatorExecutionId('outer-recovery')
    store.acceptStandaloneCommand(id, { prompt: 'unresolved fixture' })
    store.acceptCommand('ordinary', 'orchestration.start', 'digest')
    store.settleCommand('ordinary', { retained: true })
    store.markCommandIndeterminate(id)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const reopened = new OrchestrationStore(store.root)
    stores.push(reopened)
    expect(reopened.unfinishedStandaloneCommands()).toEqual([
      expect.objectContaining({ commandId: id, state: 'indeterminate', standaloneRequest: { prompt: 'unresolved fixture' } }),
    ])
    expect(reopened.commandReceipt('ordinary')).toMatchObject({ state: 'settled', response: { retained: true } })
    expect(reopened.listRuns()).toEqual([])
  })

  it('backs up schema 7 before adding standalone columns and preserves ordinary receipts', async () => {
    const store = await openStore()
    store.acceptCommand('retained', 'orchestration.start', 'old-input')
    store.settleCommand('retained', { original: true })
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const databasePath = join(store.root, 'state.sqlite')
    const schema7 = new DatabaseSync(databasePath)
    try {
      schema7.exec('DROP INDEX standalone_command_run')
      for (const column of ['run_id', 'compilation_id', 'standalone_phase', 'request_json']) {
        schema7.exec('ALTER TABLE command_receipts DROP COLUMN ' + column)
      }
      schema7.exec('PRAGMA user_version = 7')
    } finally { schema7.close() }
    const upgraded = new OrchestrationStore(store.root)
    stores.push(upgraded)
    expect(upgraded.db.prepare('PRAGMA user_version').get()?.user_version).toBe(ORCHESTRATION_STATE_SCHEMA_VERSION)
    expect(upgraded.commandReceipt('retained')).toMatchObject({ state: 'settled', response: { original: true } })
    expect((await stat(databasePath + '.before-schema-8')).size).toBeGreaterThan(0)
    const backup = new DatabaseSync(databasePath + '.before-schema-8', { readOnly: true })
    try {
      expect(backup.prepare('PRAGMA user_version').get()?.user_version).toBe(7)
      expect(backup.prepare("SELECT response_json FROM command_receipts WHERE command_id = 'retained'").get()?.response_json).toBe('{"original":true}')
    } finally { backup.close() }
  })

  it('replicates the command input and run association in the same schema', async () => {
    const leader = await openStore()
    const follower = await openStore()
    const { compilation, record, events } = fixture(leader)
    const id = PhysicalOperatorExecutionId('outer-replicated')
    leader.acceptStandaloneCommand(id, { prompt: 'replicated fixture' })
    leader.linkStandaloneCompilation(id, compilation.compilationId)
    leader.createStandaloneRunForCommand(id, compilation.compilationId, record, events)
    expect(follower.installClusterReplica(leader.exportClusterReplica())).toBe('applied')
    expect(follower.commandReceipt(id)).toEqual(leader.commandReceipt(id))
    expect(follower.getRun(String(record.snapshot.runId))).toEqual(record)
    expect(follower.standaloneCommandForRun(record.snapshot.runId)?.commandId).toBe(id)
  })
})
