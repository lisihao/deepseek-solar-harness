import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResearchActionRequest, ResearchDriverId, ResearchDriverRequest, ResearchDriverQualification,
  ResearchDriverReceipt, ResearchHostPolicy, ResearchOwnerId, ResearchRunId, ResearchWorkflowDefinitionInput,
  ResearchWorkflowCollector, ResearchWorkflowCollectionRequest, ResearchWorkflowOutputInput,
  ResearchWorkflowObservationId, ResearchWorkflowId, ResearchActionId } from '@deepseek-ai/dsh-research-handoff/api'
import * as provider from '../src/index.ts'
import { ResearchActionStore } from '../src/action-store.ts'
import { readResearchPromptTemplate } from '../src/prompt.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
type Stage = ResearchWorkflowDefinitionInput['stages'][number]
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const question = '\ufeff原问题😀 $&\n完整尾部\n'
const body = '\ufeff完整原报告😀 $&\n尾部\n'

async function setup(completed = true, unassigned = false) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-output-')), filename = join(dir, 'research.sqlite')
  const ctx = new Context()
  await ctx.plugin(provider, { filename })
  cleanups.push(async () => { await ctx.root.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const driverId = 'fake-gemini' as ResearchDriverId
  const target = { workspace: 'fixture', page: 'original-page', conversation: null }
  const selection = { model: 'fake', mode: 'fake-research', effort: { kind: 'not-requested' as const }, tools: ['web'] }
  const policy: ResearchHostPolicy = { version: 'fixture', ownerId: 'owner' as ResearchOwnerId, judgmentChannel: 'human',
    workspace: target.workspace, sourceConfigurationSha256s: ['source-config'],
    destinations: [{ bindingSha256: 'destination', target }], drivers: [{ id: driverId, platform: 'gemini', selection }],
    inputMaxBytes: 1000000 }
  const registration = ctx.researchHandoff.bindHost(ctx, policy), control = registration.control
  const run = control.create('run' as ResearchRunId, { questionSha256: hash(question), sourcesSha256: 'source-config',
    modeSha256: control.modeFingerprint(driverId), destinationSha256: 'destination', plan: null })
  control.confirm(run.runId, run.revision, run.bindingSha256)
  const template = readResearchPromptTemplate('gemini-deep-research')
  const slots = [...template.text.matchAll(/<([a-z_]+)>/g)].map(x => x[1]!)
  const values = Object.fromEntries(slots.map(name => [name, [name === 'user_question' ? question : 'explicit ' + name]]))
  const seed = { workflowId: 'flow' as ResearchWorkflowDefinitionInput['workflowId'], sessionId: 'session', question, sourcesSha256: 'source-config',
    gemini: { driverId, selection, target, destinationSha256: 'destination' },
    chatgpt: { driverId: 'fake-chatgpt' as ResearchWorkflowDefinitionInput['chatgpt']['driverId'], selection, target: { ...target, page: 'chatgpt' }, destinationSha256: 'chatgpt-target' },
    templateVersions: { gemini: template.version, chatgpt: '1.0' }, values: { gemini: values, chatgpt: { user_question: [question] } },
    stages: ['gemini-plan-submit', 'gemini-research-start', 'chatgpt-upload', 'chatgpt-submit'].map((kind, index) => ({
      kind,
      actionId: ('action-' + String(index)) as Stage['actionId'],
      stepId: ('step-' + String(index)) as Stage['stepId'],
      preparedPromptId: index === 0 || index === 3 ? ('prompt-' + String(index)) as Stage['preparedPromptId'] : null,
    })) } as ResearchWorkflowDefinitionInput
  control.claimWorkflowDefinition(run.runId, seed)
  const stage = seed.stages[0]!
  const prepared = control.preparePrompt(run.runId, { inputId: stage.preparedPromptId!, revision: run.revision,
    templateId: template.id, values: Object.fromEntries(Object.entries(values).map(([key, parts]) =>
      [key, parts.map(text => ({ kind: 'text' as const, text }))])) })
  const request: ResearchActionRequest = { runId: run.runId, actionId: stage.actionId, stepId: stage.stepId,
    revision: run.revision, binding: run.binding, bindingSha256: run.bindingSha256, driverId, selection,
    kind: stage.kind, target, input: prepared.renderedText, preparedPromptId: prepared.inputId }
  const resource = { ...target, page: 'assigned-page', conversation: unassigned ? null : 'actual-conversation',
    report: unassigned ? null : 'actual-report', evidence: 'original action correlation' }
  const qualify = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverQualification> => ({
    status: 'available', requestSha256: input.requestSha256, target: input.request.target, selection: input.request.selection,
    effort: { kind: 'not_observed' }, inputMaxBytes: 1000000, evidence: 'fake available original interface' }))
  const execute = vi.fn(async (input: ResearchDriverRequest, _signal: AbortSignal, guard: () => void): Promise<ResearchDriverReceipt> => {
    guard()
    return { state: completed ? 'completed' : 'accepted', requestSha256: input.requestSha256,
      target: input.request.target, acceptedResource: resource, receipt: completed ? 'original complete' : 'original accepted' }
  })
  const observe = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverReceipt> => ({ state: 'completed',
    requestSha256: input.requestSha256, target: input.request.target, acceptedResource: input.acceptedResource, receipt: 'original complete' }))
  const disposeDriver = ctx.researchHandoff.registerDriver(ctx, { id: driverId, platform: 'gemini', qualify, execute, observe })
  await control.execute(request)
  const observation = (input: ResearchWorkflowCollectionRequest, id = 'read-1', extent: 'partial' | 'complete' = 'partial',
    text = 'partial original'): ResearchWorkflowOutputInput => ({
    actionId: input.snapshot.request.actionId, observationId: id as ResearchWorkflowObservationId,
    requestSha256: input.snapshot.inputSha256, resource: input.snapshot.acceptedResource!,
    source: { page: resource.page, conversation: resource.conversation, method: 'dom-text', capturedAt: '2026-10-18T00:00:00Z',
      extent, endEvidence: extent === 'complete' ? 'actual original report end' : null }, bytes: Buffer.from(text),
  })
  const collect = vi.fn(async (input: ResearchWorkflowCollectionRequest, _signal: AbortSignal, guard: () => void) => {
    guard(); return observation(input)
  })
  const collector: ResearchWorkflowCollector = { collect }
  const capture = () => control.captureWorkflowOutput(run.runId, seed.workflowId, request.actionId, collector)
  const inspect = () => {
    const store = new ResearchActionStore(filename)
    try { return store.workflows.outputs(policy.ownerId, run.runId, seed.workflowId) }
    finally { store.close() }
  }
  return { ctx, control, registration, run, seed, request, resource, filename, policy, collect, collector, capture,
    observation, inspect, execute, observe, disposeDriver }
}

describe('workflow output collection using the original Provider, SQLite and fake resource reader', () => {
  it('appends partial then complete once and reopens every original byte', async () => {
    const f = await setup(), first = await f.capture()
    f.collect.mockImplementation(async (input, _signal, guard) => { guard(); return f.observation(input, 'read-2', 'complete', body) })
    const complete = await f.capture(), duplicate = await f.capture()
    expect(first.artifact.version).toBe(1)
    expect(complete.artifact.version).toBe(2)
    expect(duplicate).toEqual(complete)
    expect(Buffer.from(complete.artifact.bytes).toString()).toBe(body)
    expect(f.inspect()).toEqual([first, complete])
    expect(f.control.readArtifact(f.run.runId, first.artifact.artifactId)).toEqual(first.artifact)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('checks the held Driver registration again before the resource read', async () => {
    const f = await setup()
    f.collect.mockImplementation(async (input, signal, guard) => {
      await f.disposeDriver()
      expect(signal.aborted).toBe(true)
      guard()
      return f.observation(input)
    })
    await expect(f.capture()).rejects.toThrow()
    expect(f.inspect()).toEqual([])
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('retains a late result from the already admitted read after Driver revocation', async () => {
    const f = await setup()
    f.collect.mockImplementation(async (input, signal, guard) => {
      guard()
      const observed = f.observation(input, 'late-driver-result', 'complete', body)
      await f.disposeDriver()
      expect(signal.aborted).toBe(true)
      return observed
    })
    const original = await f.capture()
    expect(f.inspect()).toEqual([original])
    await expect(f.capture()).rejects.toThrow('current Host research policy')
    expect(f.collect).toHaveBeenCalledTimes(1)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('refuses changed bytes under the same actual observation identity', async () => {
    const f = await setup(), first = await f.capture()
    f.collect.mockImplementation(async input => f.observation(input, 'read-1', 'complete', body))
    await expect(f.capture()).rejects.toThrow('observation conflicts')
    expect(f.inspect()).toEqual([first])
    expect(f.control.readAction(f.run.runId, f.request.actionId).state).toBe('completed')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('rolls back an artifact when saving its observation association fails', async () => {
    const f = await setup(), db = new DatabaseSync(f.filename)
    cleanups.push(async () => { db.close() })
    db.exec("CREATE TRIGGER fail_output BEFORE INSERT ON research_workflow_outputs BEGIN SELECT RAISE(ABORT,'injected output failure'); END")
    await expect(f.capture()).rejects.toThrow('injected output failure')
    expect(db.prepare('SELECT COUNT(*) AS n FROM research_artifacts').get()?.n).toBe(0)
    expect(f.inspect()).toEqual([])
    db.exec('DROP TRIGGER fail_output')
    expect((await f.capture()).artifact.version).toBe(1)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('does not save an observation when its original artifact append fails', async () => {
    const f = await setup(), db = new DatabaseSync(f.filename)
    cleanups.push(async () => { db.close() })
    db.exec("CREATE TRIGGER fail_artifact BEFORE INSERT ON research_artifacts BEGIN SELECT RAISE(ABORT,'injected artifact failure'); END")
    await expect(f.capture()).rejects.toThrow('injected artifact failure')
    expect(f.inspect()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM research_artifacts').get()?.n).toBe(0)
  })

  it('blocks collection before original completion and observes that original action without replay', async () => {
    const f = await setup(false)
    await expect(f.capture()).rejects.toThrow('not completed')
    expect(f.collect).not.toHaveBeenCalled()
    await f.control.observe(f.run.runId, f.request.actionId)
    expect((await f.capture()).artifact.version).toBe(1)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it.each(['resource', 'action', 'request'] as const)('rejects substituted %s from a collector', async (kind) => {
    const f = await setup()
    f.collect.mockImplementation(async (input) => {
      const result = f.observation(input)
      return kind === 'resource' ? { ...result, resource: { ...result.resource, report: 'foreign-report' } }
        : kind === 'action' ? { ...result, actionId: 'foreign-action' as ResearchActionId }
          : { ...result, requestSha256: 'foreign-request' }
    })
    await expect(f.capture()).rejects.toThrow('admitted original resource')
    expect(f.inspect()).toEqual([])
  })

  it('does not read another workflow or an action outside the canonical stage identities', async () => {
    const f = await setup()
    await expect(f.control.captureWorkflowOutput(f.run.runId, 'other' as ResearchWorkflowId,
      f.request.actionId, f.collector)).rejects.toThrow('canonical workflow differs')
    const other = { ...f.request, actionId: 'other' as ResearchActionId, stepId: 'other-step' as ResearchActionRequest['stepId'] }
    await f.control.execute(other)
    await expect(f.control.captureWorkflowOutput(f.run.runId, f.seed.workflowId, other.actionId, f.collector)).rejects.toThrow('not completed')
    expect(f.collect).not.toHaveBeenCalled()
  })

  it('retains late material only from an admitted read and cannot collect again through the revoked Host', async () => {
    const f = await setup()
    f.collect.mockImplementation(async (input, signal, guard) => {
      guard()
      const observed = f.observation(input, 'late-original', 'complete', body)
      await f.registration.dispose()
      expect(signal.aborted).toBe(true)
      return observed
    })
    const output = await f.capture()
    expect(f.inspect()).toEqual([output])
    expect(() => f.capture()).toThrow('revoked')
    expect(f.collect).toHaveBeenCalledTimes(1)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('refuses a read whose guard is checked after revocation', async () => {
    const f = await setup()
    f.collect.mockImplementation(async (input, _signal, guard) => {
      await f.registration.dispose()
      guard()
      return f.observation(input)
    })
    await expect(f.capture()).rejects.toThrow()
    expect(f.inspect()).toEqual([])
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('fences a reentrant collection before its first callback can start another read', async () => {
    const f = await setup()
    f.collect.mockImplementation(async (input, _signal, guard) => {
      guard()
      await expect(f.capture()).rejects.toThrow('in flight')
      return f.observation(input)
    })
    expect((await f.capture()).artifact.version).toBe(1)
    expect(f.collect).toHaveBeenCalledTimes(1)
  })

  it('drains an admitted late read and its atomic write before closing SQLite', async () => {
    const f = await setup(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    f.collect.mockImplementation(async (input, _signal, guard) => {
      guard()
      const observed = f.observation(input, 'before-close', 'complete', body)
      entered.resolve(undefined)
      await release.promise
      return observed
    })
    const pending = f.capture()
    await entered.promise
    let closed = false
    const closing = f.ctx.root.fiber.dispose().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve(undefined)
    const output = await pending
    await closing
    expect(f.inspect()).toEqual([output])
  })

  it('preserves completed captures when later observations conflict with terminal resource facts', async () => {
    const f = await setup(true, true), original = await f.capture()
    f.observe.mockImplementation(async input => ({ state: 'completed', requestSha256: input.requestSha256,
      target: input.request.target, receipt: 'original complete', acceptedResource: { ...f.resource,
        conversation: 'later-assigned', report: 'later-report', evidence: 'correlated later identity' } }))
    await expect(f.control.observe(f.run.runId, f.request.actionId)).rejects.toThrow('contradicts prior acceptance or termination')
    expect(f.control.readWorkflowOutputs(f.run.runId, f.seed.workflowId)).toEqual([original])
    expect(f.control.readArtifact(f.run.runId, original.artifact.artifactId)).toEqual(original.artifact)
    expect(f.inspect()).toEqual([original])
  })

  it('shares role versions with intermediate captures instead of replacing their bytes', async () => {
    const f = await setup(), snapshot = f.control.readAction(f.run.runId, f.request.actionId)
    const input = f.observation({ runId: f.run.runId, workflowId: f.seed.workflowId, snapshot })
    const intermediate = f.control.captureArtifact(f.run.runId, { artifactId: 'intermediate' as ReturnType<typeof f.control.readArtifact>['artifactId'],
      actionId: f.request.actionId, role: 'gemini-plan', expectedVersion: 0,
      source: { ...input.source, method: 'manual-import' }, bytes: Buffer.from('separate intermediate bytes') })
    const actual = await f.capture()
    expect(intermediate.version).toBe(1)
    expect(actual.artifact.version).toBe(2)
    expect(f.control.readArtifact(f.run.runId, intermediate.artifactId)).toEqual(intermediate)
  })

  it.each(['manual-import', 'invalid-utf8'] as const)('refuses %s as a standard resource observation', async (bad) => {
    const f = await setup()
    f.collect.mockImplementation(async (input) => {
      const observed = f.observation(input)
      return bad === 'manual-import' ? { ...observed, source: { ...observed.source, method: 'manual-import' as const } }
        : { ...observed, bytes: Uint8Array.of(255) }
    })
    await expect(f.capture()).rejects.toThrow()
    expect(f.inspect()).toEqual([])
  })

  it('rejects a foreign durable resource even when the outer digest is recomputed', async () => {
    const f = await setup()
    await f.capture()
    const db = new DatabaseSync(f.filename)
    cleanups.push(async () => { db.close() })
    const row = db.prepare('SELECT input_json FROM research_workflow_outputs').get()!
    const input = JSON.parse(String(row.input_json)) as Record<string, unknown>
    input.resource = { ...f.resource, report: 'another-report' }
    const raw = JSON.stringify(input)
    db.prepare('UPDATE research_workflow_outputs SET input_json=?,sha256=?').run(raw, hash(raw))
    expect(() => f.control.readWorkflowOutputs(f.run.runId, f.seed.workflowId)).toThrow('completed original action')
  })

  it('does not turn a new Host owner into access to the original outputs', async () => {
    const f = await setup()
    await f.capture()
    const other = f.ctx.researchHandoff.bindHost(f.ctx, { ...f.policy, ownerId: 'another-owner' as ResearchOwnerId }).control
    expect(() => other.readWorkflowOutputs(f.run.runId, f.seed.workflowId)).toThrow()
    expect(() => f.control.readWorkflowOutputs(f.run.runId, f.seed.workflowId)).toThrow('revoked')
  })
})
