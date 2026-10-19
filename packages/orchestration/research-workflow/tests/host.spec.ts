import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResearchWorkflowHosts } from '../src/index.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as invariant from '../src/invariant.ts'
import type { ResearchActionRequest, ResearchDriverId, ResearchDriverRequest, ResearchDriverQualification,
  ResearchDriverReceipt, ResearchHostPolicy, ResearchOwnerId, ResearchRunId, ResearchWorkflowDefinitionInput,
  ResearchWorkflowCollector, ResearchWorkflowCollectionRequest, ResearchWorkflowOutputInput,
  ResearchWorkflowObservationId } from '@deepseek-ai/dsh-research-handoff'
import * as provider from '@deepseek-ai/dsh-research-handoff-local'
import { readResearchPromptTemplate, renderResearchPrompt } from '../../research-handoff-local/src/prompt.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
type Stage = ResearchWorkflowDefinitionInput['stages'][number]
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const question = '\ufeff原问题😀 $&\n完整尾部\n'
const body = '\ufeff原始完整报告😀 $&\n原尾部\n'

function agentFor(session: Session, ctx: Context): Agent {
  const unused = (): never => { throw Error('fake Agent driving is outside this keyless fixture') }
  return { id: session.id, session, ctx, options: {}, status: 'idle',
    inbox: new Inbox(session, { inserted: unused, discarded: unused, claimed: unused }),
    cancel: unused, whenIdle: async () => {}, runMaintenance: unused,
    send: unused, followup: unused, steer: unused, inject: unused }
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'research-live-host-')), ctx = new Context(), agentCtx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: join(dir, 'logs'), compression: 'none' })
  await ctx.plugin(provider, { filename: join(dir, 'research.sqlite') })
  cleanups.push(async () => { await ctx.root.fiber.dispose(); await agentCtx.root.fiber.dispose()
    await rm(dir, { recursive: true, force: true }) })
  const session = ctx.sessions.prepare(SessionId('original-session'), { meta: { cwd: dir } })
  const detachSession = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const agent = agentFor(session, agentCtx), detachAgent = ctx.agents.enter(agent, undefined)
  ctx.agents.announce(agent)
  const hosts = new ResearchWorkflowHosts(ctx), driverId = 'fake-gemini' as ResearchDriverId
  const target = { workspace: 'fixture', page: 'original-page', conversation: null }
  const selection = { model: 'fake', mode: 'fake-research', effort: { kind: 'not-requested' as const }, tools: ['web'] }
  const policy: ResearchHostPolicy = { version: 'fixture', ownerId: 'owner' as ResearchOwnerId, judgmentChannel: 'human',
    workspace: target.workspace, sourceConfigurationSha256s: ['source-config'],
    destinations: [{ bindingSha256: 'destination', target }], drivers: [{ id: driverId, platform: 'gemini', selection }],
    inputMaxBytes: 1000000 }
  const base = ctx.researchHandoff.bindHost(ctx, policy).control
  const run = base.create('run' as ResearchRunId, { questionSha256: hash(question), sourcesSha256: 'source-config',
    modeSha256: base.modeFingerprint(driverId), destinationSha256: 'destination', plan: null })
  base.confirm(run.runId, run.revision, run.bindingSha256)
  const template = readResearchPromptTemplate('gemini-deep-research')
  const values = Object.fromEntries([...template.text.matchAll(/<([a-z_]+)>/g)].map(x =>
    [x[1]!, [x[1] === 'user_question' ? question : 'explicit ' + x[1]!]]))
  const chatTemplate = readResearchPromptTemplate('chatgpt-verify-synthesize')
  const chatValues = Object.fromEntries([...chatTemplate.text.matchAll(/<([a-z_]+)>/g)].map(x =>
    [x[1]!, [x[1] === 'user_question' ? question : 'explicit ' + x[1]!]]))
  const seed = { workflowId: 'flow' as ResearchWorkflowDefinitionInput['workflowId'], sessionId: session.id, question, sourcesSha256: 'source-config',
    gemini: { driverId, selection, target, destinationSha256: 'destination' },
    chatgpt: { driverId: 'fake-chatgpt' as ResearchWorkflowDefinitionInput['chatgpt']['driverId'], selection, target: { ...target, page: 'chatgpt' }, destinationSha256: 'chatgpt' },
    templateVersions: { gemini: template.version, chatgpt: chatTemplate.version }, values: { gemini: values, chatgpt: chatValues },
    stages: ['gemini-plan-submit', 'gemini-research-start', 'chatgpt-upload', 'chatgpt-submit'].map((kind, index) => ({
      kind,
      actionId: ('action-' + String(index)) as Stage['actionId'],
      stepId: ('step-' + String(index)) as Stage['stepId'],
      preparedPromptId: index === 0 || index === 3 ? ('prompt-' + String(index)) as Stage['preparedPromptId'] : null,
    })) } as ResearchWorkflowDefinitionInput
  base.claimWorkflowDefinition(run.runId, seed)
  const stage = seed.stages[0]!, prepared = base.preparePrompt(run.runId, { inputId: stage.preparedPromptId!,
    revision: run.revision, templateId: template.id, values: Object.fromEntries(Object.entries(values).map(([key, parts]) =>
      [key, parts.map(text => ({ kind: 'text' as const, text }))])) })
  const request: ResearchActionRequest = { runId: run.runId, actionId: stage.actionId, stepId: stage.stepId,
    revision: run.revision, binding: run.binding, bindingSha256: run.bindingSha256, driverId, selection,
    kind: stage.kind, target, input: prepared.renderedText, preparedPromptId: prepared.inputId }
  const resource = { ...target, page: 'assigned-page', conversation: 'actual-conversation', report: 'actual-report',
    evidence: 'fake original correlation' }
  const qualify = vi.fn(async (input: ResearchDriverRequest, _signal: AbortSignal): Promise<ResearchDriverQualification> => ({
    status: 'available', requestSha256: input.requestSha256, target: input.request.target, selection: input.request.selection,
    effort: { kind: 'not_observed' }, inputMaxBytes: 1000000, evidence: 'fake normal interface' }))
  const execute = vi.fn(async (input: ResearchDriverRequest, _signal: AbortSignal, guard: () => void): Promise<ResearchDriverReceipt> => {
    guard()
    return { state: 'completed', requestSha256: input.requestSha256, target: input.request.target,
      acceptedResource: resource, receipt: 'original complete' }
  })
  const observe = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverReceipt> => ({ state: 'completed',
    requestSha256: input.requestSha256, target: input.request.target, acceptedResource: input.acceptedResource, receipt: 'original complete' }))
  ctx.researchHandoff.registerDriver(ctx, { id: driverId, platform: 'gemini', qualify, execute, observe })
  const observation = (input: ResearchWorkflowCollectionRequest): ResearchWorkflowOutputInput => ({
    actionId: input.snapshot.request.actionId, observationId: 'actual-read' as ResearchWorkflowObservationId,
    requestSha256: input.snapshot.inputSha256, resource: input.snapshot.acceptedResource!,
    source: { page: resource.page, conversation: resource.conversation, method: 'dom-text', capturedAt: '2026-10-18T00:00:00Z',
      extent: 'complete', endEvidence: 'actual original end' }, bytes: Buffer.from(body) })
  const collect = vi.fn(async (input: ResearchWorkflowCollectionRequest, _signal: AbortSignal, guard: () => void) => {
    guard(); return observation(input)
  })
  const collector: ResearchWorkflowCollector = { collect: (input, signal, guard) => collect(input, signal, guard) }
  const settings = { runId: run.runId, policy, collector }
  const registered = await hosts.register(ctx, agent, session, settings), host = registered.host
  return { dir, ctx, session, agent, agentCtx, hosts, registered, host, base, run, seed, request, resource, settings,
    qualify, execute, observe, collect, observation, detachAgent, detachSession }
}


async function standardSetup() {
  const f = await setup(), calls: string[] = []
  const reportText = '\ufeff自动原Gemini完整报告😀 $&\n原报告尾部\n'
  const finalText = '\ufeff自动原ChatGPT完整报告😀\n最终尾部\n'
  let observationVersion = 1
  const disk = async () => {
    const location = f.ctx.sessionPersistence.locate(f.session.header)
    if (location === undefined || location.kind !== 'jsonl') throw Error('fixture requires real JSONL')
    return (await readFile(location.path, 'utf8')).trimEnd().split('\n').slice(1)
      .map(line => JSON.parse(line) as import('@deepseek-ai/dsh-session').SessionEvent)
  }
  const assertDisk = async (input: ResearchDriverRequest) => {
    const rows = await disk()
    expect(rows.some(x => x.type === 'research/workflow' && x.data.definition.sha256
      === f.base.readWorkflowDefinition(f.run.runId)?.sha256)).toBe(true)
    expect(rows.some(x => x.type === 'research/input' && JSON.stringify(x.data.request) === JSON.stringify(input.request))).toBe(true)
    expect(rows.some(x => x.type === 'research/workflow-update' && x.data.state.previews.some(p =>
      p.confirmed && JSON.stringify(p.input.request) === JSON.stringify(input.request)))).toBe(true)
  }
  const message = (input: ResearchDriverRequest) => ({ kind: input.request.kind === 'chatgpt-upload' ? 'attachment' as const : 'message' as const,
    externalId: ('original-' + input.request.actionId) as import('@deepseek-ai/dsh-research-handoff').ResearchExternalDeliveryId,
    observedAt: '2026-10-18T00:00:00.000Z', evidence: 'fake actual original identity',
    readBack: { kind: 'complete-text' as const, text: input.request.input, evidence: 'fake original complete text' } })
  const originalGemini = f.execute.getMockImplementation()!
  f.execute.mockImplementation(async (input, signal, guard) => {
    guard(); await assertDisk(input); guard()
    calls.push(input.request.kind)
    const receipt = await originalGemini(input, signal, guard)
    return input.request.kind === 'gemini-plan-submit' ? { ...receipt, delivery: message(input) } : receipt
  })
  const chatResource = { workspace: 'fixture', page: 'assigned-chatgpt', conversation: 'original-chatgpt', report: 'chatgpt-report',
    evidence: 'fake original ChatGPT resource' }
  const chatQualify = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverQualification> => ({
    status: 'available', requestSha256: input.requestSha256, target: input.request.target, selection: input.request.selection,
    effort: { kind: 'not_observed' }, inputMaxBytes: 1000000, evidence: 'fake normal ChatGPT qualification' }))
  const chatExecute = vi.fn(async (input: ResearchDriverRequest, _signal: AbortSignal,
    guard: () => void): Promise<ResearchDriverReceipt> => {
    guard(); await assertDisk(input); guard()
    calls.push(input.request.kind)
    return { state: 'completed', requestSha256: input.requestSha256, target: input.request.target,
      acceptedResource: chatResource, receipt: 'fake ChatGPT complete', delivery: message(input) }
  })
  const chatObserve = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverReceipt> => ({ state: 'completed',
    requestSha256: input.requestSha256, target: input.request.target, acceptedResource: input.acceptedResource,
    receipt: 'fake original ChatGPT observation', delivery: message(input) }))
  f.ctx.researchHandoff.registerDriver(f.ctx, { id: f.seed.chatgpt.driverId, platform: 'chatgpt',
    qualify: chatQualify, execute: chatExecute, observe: chatObserve })
  const target = (r: typeof f.resource) => ({ workspace: r.workspace, page: r.page, conversation: r.conversation })
  const policy: ResearchHostPolicy = { ...f.settings.policy,
    destinations: [...f.settings.policy.destinations, { bindingSha256: f.seed.gemini.destinationSha256, target: target(f.resource) },
      { bindingSha256: f.seed.chatgpt.destinationSha256, target: f.seed.chatgpt.target },
      { bindingSha256: f.seed.chatgpt.destinationSha256, target: target(chatResource) }],
    drivers: [...f.settings.policy.drivers, { id: f.seed.chatgpt.driverId, platform: 'chatgpt', selection: f.seed.chatgpt.selection }] }
  f.collect.mockImplementation(async (input, _signal, guard) => {
    guard()
    const resource = input.snapshot.acceptedResource!
    return { actionId: input.snapshot.request.actionId,
      observationId: (input.snapshot.request.kind + '-' + String(observationVersion)) as ResearchWorkflowObservationId,
      requestSha256: input.snapshot.inputSha256, resource, source: { page: resource.page,
        conversation: resource.conversation, method: 'dom-text', capturedAt: '2026-10-18T00:00:00Z',
        extent: 'complete', endEvidence: 'fake actual end' }, bytes: Buffer.from(input.snapshot.request.kind === 'gemini-plan-submit'
        ? body : input.snapshot.request.kind === 'gemini-research-start' ? reportText : finalText) }
  })
  const registration = await f.hosts.register(f.ctx, f.agent, f.session, { ...f.settings, policy }), host = registration.host
  const workflow = host.workflow, invocation = { agent: f.agent, source: { kind: 'user' } }
  const approve = async (kind: ResearchActionRequest['kind'], id: string) => {
    const p = await workflow.preview(kind, id as import('@deepseek-ai/dsh-research-handoff').ResearchWorkflowPreviewId)
    const run = host.inspect()
    await f.hosts.confirmRunAndSyncFromCommand(invocation, run.revision, run.bindingSha256)
    expect(host.readPreview(p.input.previewId).sha256).toBe(p.sha256)
    await f.hosts.confirmPreviewAndSyncFromCommand(invocation, p.input.previewId, p.sha256)
    return host.readPreview(p.input.previewId)
  }
  return { ...f, host, workflow, registration, policy, invocation, approve, disk, calls, reportText, finalText,
    chatExecute, chatObserve, chatQualify, nextObservation: () => { observationVersion++ } }
}

describe('live workflow Host using actual AgentRegistry, SessionStore, SQLite and JSONL', () => {
  it('stops a cancelled call after a held flush and permits a later explicit call with the same unadmitted action', async () => {
    const f = await standardSetup(), p = await f.approve('gemini-plan-submit', 'cancel-flush')
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const flushed = Promise.withResolvers<undefined>()
    const originalFlush = f.ctx.sessions.flush.bind(f.ctx.sessions), cancellation = new AbortController()
    vi.spyOn(f.ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      const result = await originalFlush(session)
      flushed.resolve(undefined)
      return result
    })
    const pending = f.workflow.execute(p.input.previewId, p.sha256, cancellation.signal)
    await entered.promise
    cancellation.abort(new Error('only this command cancelled'))
    await expect(pending).rejects.toThrow('only this command cancelled')
    release.resolve(undefined)
    await flushed.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.qualify).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    expect(() => f.base.readAction(f.run.runId, p.input.request.actionId)).toThrow('not found')
    expect(f.hosts.get(f.agent)).toBe(f.host)
    const resumed = await f.workflow.execute(p.input.previewId, p.sha256)
    expect(resumed.stages[0]?.action?.state).toBe('completed')
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.execute.mock.calls[0]?.[0].request.actionId).toBe(p.input.request.actionId)
  })

  it('keeps the original unknown after qualification cancellation without reaching Driver execute or replaying', async () => {
    const f = await standardSetup(), p = await f.approve('gemini-plan-submit', 'cancel-qualification')
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const returned = Promise.withResolvers<undefined>()
    const original = f.qualify.getMockImplementation()!, cancellation = new AbortController()
    f.qualify.mockImplementationOnce(async (input, signal) => {
      entered.resolve(undefined)
      await release.promise
      const result = await original(input, signal)
      returned.resolve(undefined)
      return result
    })
    const pending = f.workflow.execute(p.input.previewId, p.sha256, cancellation.signal)
    await entered.promise
    cancellation.abort(new Error('qualification command cancelled'))
    await expect(pending).rejects.toThrow('qualification command cancelled')
    release.resolve(undefined)
    await returned.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.collect).not.toHaveBeenCalled()
    expect(f.base.readAction(f.run.runId, p.input.request.actionId).state).toBe('unknown')
    expect(f.hosts.get(f.agent)).toBe(f.host)
    const state = await f.workflow.execute(p.input.previewId, p.sha256)
    expect(state.stages[0]?.action?.state).toBe('unknown')
    expect(f.qualify).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('retains late acceptance and delivery after call cancellation without automatically collecting', async () => {
    const f = await standardSetup(), p = await f.approve('gemini-plan-submit', 'cancel-after-acceptance')
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const original = f.execute.getMockImplementation()!, cancellation = new AbortController()
    f.execute.mockImplementationOnce(async (input, signal, guard) => {
      const receipt = await original(input, signal, guard)
      entered.resolve(undefined)
      await release.promise
      return receipt
    })
    const pending = f.workflow.execute(p.input.previewId, p.sha256, cancellation.signal)
    await entered.promise
    cancellation.abort(new Error('accepted command cancelled'))
    await expect(pending).rejects.toThrow('accepted command cancelled')
    release.resolve(undefined)
    await vi.waitFor(() => { expect(f.base.readAction(f.run.runId, p.input.request.actionId).state).toBe('completed') })
    expect(f.base.readAction(f.run.runId, p.input.request.actionId).acceptedResource).toEqual(f.resource)
    expect(f.base.readDeliveryRecords(f.run.runId, p.input.request.actionId)).toHaveLength(1)
    expect(f.collect).not.toHaveBeenCalled()
    expect(f.hosts.get(f.agent)).toBe(f.host)
    await f.workflow.execute(p.input.previewId, p.sha256)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.collect).not.toHaveBeenCalled()
  })

  it('cancels a duplicate waiter without cancelling the original live submission', async () => {
    const f = await standardSetup(), p = await f.approve('gemini-plan-submit', 'cancel-waiter')
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const original = f.execute.getMockImplementation()!, waiter = new AbortController()
    f.execute.mockImplementationOnce(async (input, signal, guard) => {
      entered.resolve(undefined)
      await release.promise
      expect(signal.aborted).toBe(false)
      return original(input, signal, guard)
    })
    const first = f.workflow.execute(p.input.previewId, p.sha256)
    await entered.promise
    const second = f.workflow.execute(p.input.previewId, p.sha256, waiter.signal)
    waiter.abort(new Error('waiter cancelled'))
    await expect(second).rejects.toThrow('waiter cancelled')
    release.resolve(undefined)
    expect((await first).stages[0]?.action?.state).toBe('completed')
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.collect).toHaveBeenCalledTimes(1)
  })

  it('returns each concurrent caller own exact durable workflow event', async () => {
    const f = await standardSetup()
    const first = f.workflow.syncReceipt(), second = f.workflow.syncReceipt()
    const [left, right] = await Promise.all([first, second])
    expect(left.eventSeq).not.toBe(right.eventSeq)
    const rows = await f.disk()
    for (const receipt of [left, right]) {
      const event = rows.find(x => x.seq === receipt.eventSeq)
      expect(event?.type).toBe('research/workflow-update')
      if (event?.type !== 'research/workflow-update') throw Error('fixture requires the exact durable workflow event')
      expect(event.data.state).toEqual(receipt.state)
    }
  })

  it('rejects a report in the task-brief slot before preparing and rejects its raw persisted association', async () => {
    const f = await standardSetup()
    for (const [i, kind] of f.seed.stages.slice(0, 3).entries()) {
      const p = await f.approve(kind.kind, 'slot-stage-' + String(i))
      await f.workflow.execute(p.input.previewId, p.sha256)
    }
    const p = await f.workflow.preview('chatgpt-submit', 'correct-slot' as import('@deepseek-ai/dsh-research-handoff').ResearchWorkflowPreviewId)
    const original = p.input.preparedPrompt!
    const values = { ...original.values, trusted_task_brief: original.values.handoff_manifest_and_artifacts!,
      handoff_manifest_and_artifacts: f.seed.values.chatgpt.handoff_manifest_and_artifacts!.map(text => ({ kind: 'text' as const, text })) }
    const prompt = { inputId: original.inputId, revision: original.revision, templateId: original.template.id, values }
    const request = { ...p.input.request, input: renderResearchPrompt(original.template, values) }
    expect(() => f.host.preview({ previewId: 'wrong-slot' as typeof p.input.previewId, workflowId: f.seed.workflowId,
      request, prompt, artifactIds: p.input.materials.map(x => x.artifactId) })).toThrow('report slot')
    expect(() => f.host.read(c => c.readPreparedPrompt(f.run.runId, prompt.inputId))).toThrow('not found')
    expect(() => f.host.read(c => c.readAction(f.run.runId, request.actionId))).toThrow('not found')
    const prepared = f.host.read(c => c.preparePrompt(f.run.runId, prompt))
    expect(prepared.renderedText).toBe(request.input)
    f.chatExecute.mockImplementation(async input => ({ state: 'completed', requestSha256: input.requestSha256,
      target: input.request.target, acceptedResource: p.input.prerequisites.stages.at(-1)!.action!.acceptedResource,
      receipt: 'fake raw accepted wrong-slot request', delivery: { kind: 'message',
        externalId: 'raw-wrong-slot' as import('@deepseek-ai/dsh-research-handoff').ResearchExternalDeliveryId,
        observedAt: '2026-10-18T00:00:00Z', evidence: 'fake exact original message',
        readBack: { kind: 'complete-text', text: input.request.input, evidence: 'fake complete original read' } } }))
    await f.host.run(current => current.control.execute(request))
    const stage = f.host.read(c => c.readWorkflowStage(f.run.runId, 'chatgpt-submit'))
    expect(stage.blockers).toContain('original-input-unlinked')
    expect(stage.deliveryVerified).toBe(true)
  })
  it('rejects a newly observed prerequisite mismatch after qualification and preserves the unknown original action', async () => {
    const f = await setup(), original = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (input, signal, guard) => ({ ...await original(input, signal, guard), delivery: {
      kind: 'message', externalId: 'same-message' as import('@deepseek-ai/dsh-research-handoff').ResearchExternalDeliveryId,
      observedAt: '2026-10-18T00:00:00Z', evidence: 'fake original message',
      readBack: { kind: 'complete-text', text: input.request.input, evidence: 'fake full read' } } }))
    await f.host.execute(f.request)
    const output = await f.host.collect(f.seed.workflowId, f.request.actionId)
    const target = { workspace: f.resource.workspace, page: f.resource.page, conversation: f.resource.conversation }
    const registered = await f.hosts.register(f.ctx, f.agent, f.session, { ...f.settings,
      policy: { ...f.settings.policy, destinations: [...f.settings.policy.destinations,
        { bindingSha256: 'destination', target }] } })
    const host = registered.host, current = f.base.inspect(f.run.runId)
    const run = f.base.revise(current.runId, current.revision, { ...current.binding,
      plan: { version: output.artifact.version, sha256: output.artifact.sha256 } })
    const invocation = { agent: f.agent, source: { kind: 'user' } }
    f.hosts.confirmRunFromCommand(invocation, run.revision, run.bindingSha256)
    const stage = f.seed.stages[1]!, request: ResearchActionRequest = { ...f.request,
      actionId: stage.actionId, stepId: stage.stepId, kind: stage.kind, preparedPromptId: null,
      revision: run.revision, binding: run.binding, bindingSha256: run.bindingSha256, target, input: body }
    const preview = host.preview({ previewId: 'research-preview' as import('@deepseek-ai/dsh-research-handoff').ResearchWorkflowPreviewId,
      workflowId: f.seed.workflowId, request, prompt: null, artifactIds: [output.artifact.artifactId] })
    f.hosts.confirmPreviewFromCommand(invocation, preview.input.previewId, preview.sha256)
    const fixed = host.freezePreview(preview.input.previewId, preview.sha256)
    const qualify = f.qualify.getMockImplementation()!, observe = f.observe.getMockImplementation()!
    f.observe.mockImplementation(async input => ({ ...await observe(input), delivery: {
      kind: 'message', externalId: 'same-message' as import('@deepseek-ai/dsh-research-handoff').ResearchExternalDeliveryId,
      observedAt: '2026-10-18T00:01:00Z', evidence: 'fake later full read',
      readBack: { kind: 'complete-text', text: 'newly observed mismatch', evidence: 'fake original item read' } } }))
    f.qualify.mockImplementation(async (input, signal) => {
      const qualified = await qualify(input, signal)
      await f.base.observe(f.run.runId, f.request.actionId)
      return qualified
    })
    await expect(host.execute(fixed, host.previewGuard(preview.input.previewId, preview.sha256))).rejects.toThrow('exact input')
    expect(f.base.readAction(run.runId, stage.actionId).state).toBe('unknown')
    expect(f.base.readDeliveryRecords(run.runId, f.request.actionId).map(x => x.contentStatus)).toEqual(['matched', 'mismatched'])
    expect(host.readPreview(preview.input.previewId).input).toEqual(preview.input)
    expect(host.readPreview(preview.input.previewId).confirmed).toBe(false)
    expect(f.execute).toHaveBeenCalledTimes(1)
    await expect(host.execute(fixed, host.previewGuard(preview.input.previewId, preview.sha256))).rejects.toThrow('exact input')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('treats exact mismatches only through the actual user-source and live registered Agent', async () => {
    const f = await setup(), original = f.execute.getMockImplementation()!
    const delivery = (text: string, at: string) => ({ kind: 'message' as const,
      externalId: 'same-original-message' as import('@deepseek-ai/dsh-research-handoff').ResearchExternalDeliveryId,
      observedAt: at, evidence: 'fake original message', readBack: { kind: 'complete-text' as const, text, evidence: 'fake full read' } })
    f.execute.mockImplementation(async (input, signal, guard) => ({ ...await original(input, signal, guard),
      delivery: delivery('wrong delivered text', '2026-10-18T00:00:00Z') }))
    await f.host.execute(f.request)
    await f.host.collect(f.seed.workflowId, f.request.actionId)
    const observe = f.observe.getMockImplementation()!
    f.observe.mockImplementation(async input => ({ ...await observe(input),
      delivery: delivery(f.request.input, '2026-10-18T00:01:00Z') }))
    await f.host.observe(f.request.actionId)
    const before = f.base.readWorkflowStage(f.run.runId, f.request.kind), history = before.history
    expect(before.deliveryVerified).toBe(false)
    const negative = history[0]!, correction = history[1]!
    const input = { dispositionId: 'human-treatment', actionId: f.request.actionId, expectedPreviousId: null,
      negative: [{ seq: negative.seq, sha256: negative.sha256 }], correction: { seq: correction.seq, sha256: correction.sha256 },
      reason: 'reviewed original mismatch and later exact same-message full read-back' }
    const invocation = { agent: f.agent, source: { kind: 'user' } }
    expect(() => f.hosts.treatDeliveryFromCommand({ ...invocation, source: { kind: 'model' } }, input)).toThrow('user command')
    expect(() => f.hosts.treatDeliveryFromCommand({ ...invocation, agent: agentFor(f.session, f.agentCtx) }, input)).toThrow('not configured')
    const retained = f.hosts.treatDeliveryFromCommand(invocation, input)
    expect(f.base.readWorkflowStage(f.run.runId, f.request.kind).deliveryVerified).toBe(true)
    f.observe.mockImplementation(async observed => ({ ...await observe(observed),
      delivery: delivery('new mismatch', '2026-10-18T00:02:00Z') }))
    await f.host.observe(f.request.actionId)
    expect(f.base.readWorkflowStage(f.run.runId, f.request.kind).deliveryVerified).toBe(false)
    expect(f.base.readWorkflowDeliveryDisposition(f.run.runId, retained.input.dispositionId)).toEqual(retained)
    f.detachAgent()
    expect(() => f.hosts.treatDeliveryFromCommand(invocation, input)).toThrow()
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('confirms exact previews through the actual user-source entry and same registered Agent', () => {
    return setup().then((f) => {
      const retained = f.base.readPreparedPrompt(f.run.runId, f.request.preparedPromptId!)
      const input = { previewId: 'full-preview' as import('@deepseek-ai/dsh-research-handoff').ResearchWorkflowPreviewId,
        workflowId: f.seed.workflowId, request: f.request, artifactIds: [],
        prompt: { inputId: retained.inputId, revision: retained.revision, templateId: retained.template.id,
          values: retained.values } }
      const p = f.host.preview(input), invocation = { agent: f.agent, source: { kind: 'user' } }
      expect(() => f.hosts.confirmPreviewFromCommand({ ...invocation, source: { kind: 'model' } }, p.input.previewId, p.sha256)).toThrow('user command')
      expect(() => f.hosts.confirmPreviewFromCommand({ ...invocation, agent: agentFor(f.session, f.agentCtx) }, p.input.previewId, p.sha256)).toThrow('not configured')
      f.hosts.confirmRunFromCommand(invocation, f.run.revision, f.run.bindingSha256)
      expect(f.host.readPreview(p.input.previewId).sha256).toBe(p.sha256)
      expect(f.hosts.confirmPreviewFromCommand(invocation, p.input.previewId, p.sha256).confirmed).toBe(true)
      const fixed = f.host.freezePreview(p.input.previewId, p.sha256), guard = f.host.previewGuard(p.input.previewId, p.sha256)
      expect(fixed).toEqual(f.request)
      expect(() => { guard({ ...fixed, input: 'other full request' }) }).toThrow('exact input')
      expect(() => { guard(fixed) }).not.toThrow()
      f.detachAgent()
      expect(() => f.hosts.confirmPreviewFromCommand(invocation, p.input.previewId, p.sha256)).toThrow()
      expect(f.execute).not.toHaveBeenCalled()
    })
  })
  it('carries the exact logged request check through the current Host after an asynchronous qualification', async () => {
    const f = await setup(), qualify = f.qualify.getMockImplementation()!
    let current = true
    f.qualify.mockImplementation(async (input, signal) => {
      const observed = await qualify(input, signal)
      current = false
      return observed
    })
    await expect(f.host.execute(f.request, (fixed) => {
      expect(fixed).toEqual(f.request)
      if (!current) throw Error('standard preview expired')
    })).rejects.toThrow('standard preview expired')
    expect(f.base.readAction(f.run.runId, f.request.actionId).state).toBe('unknown')
    expect(f.session.events.find(x => x.type === 'research/input')).toMatchObject({ data: { request: f.request } })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('uses the exact registered Agent and same Session for logged original execution and automatic collection', async () => {
    const f = await setup()
    expect(f.ctx.agents.get(f.agent.id)).toBe(f.agent)
    expect(f.hosts.get(f.agent)).toBe(f.host)
    expect((await f.host.execute(f.request)).state).toBe('completed')
    const output = await f.host.collect(f.seed.workflowId, f.request.actionId)
    expect(Buffer.from(output.artifact.bytes).toString()).toBe(body)
    expect(f.session.events.find(x => x.type === 'research/input')?.type).toBe('research/input')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('refuses an unregistered same-id Agent object instead of selecting by its ID', async () => {
    const f = await setup(), other = agentFor(f.session, f.agentCtx)
    expect(() => f.hosts.get(other)).toThrow('not configured')
    await expect(f.hosts.register(f.ctx, other, f.session, f.settings)).rejects.toThrow('no longer current')
    expect(f.hosts.get(f.agent)).toBe(f.host)
  })

  it('refuses a different live Session even with a live original Agent', async () => {
    const f = await setup(), other = f.ctx.sessions.prepare(SessionId('other-session'))
    const detach = f.ctx.sessions.enter(other)
    await expect(f.hosts.register(f.ctx, f.agent, other, f.settings)).rejects.toThrow('no longer current')
    detach()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('rechecks changed agent.session before the actual Driver submission', async () => {
    const f = await setup(), original = f.qualify.getMockImplementation()!
    f.qualify.mockImplementation(async (input, signal) => {
      const observed = await original(input, signal)
      Object.assign(f.agent, { session: f.ctx.sessions.prepare(SessionId('mutated-session')) })
      return observed
    })
    await expect(f.host.execute(f.request)).rejects.toThrow('no longer current')
    expect(f.base.readAction(f.run.runId, f.request.actionId).state).toBe('unknown')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('aborts a held qualification when the actual Agent is removed and never submits', async () => {
    const f = await setup(), original = f.qualify.getMockImplementation()!
    f.qualify.mockImplementation(async (input, signal) => {
      const observed = await original(input, signal)
      f.detachAgent()
      expect(signal.aborted).toBe(true)
      return observed
    })
    await expect(f.host.execute(f.request)).rejects.toThrow()
    expect(f.base.readAction(f.run.runId, f.request.actionId).state).toBe('unknown')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('refuses current access after the original Session leaves the actual store', async () => {
    const f = await setup()
    f.detachSession()
    expect(() => f.host.inspect()).toThrow()
    await expect(f.host.execute(f.request)).rejects.toThrow()
    expect(f.qualify).not.toHaveBeenCalled()
  })

  it('replaces a registration without an old disposer removing the new one', async () => {
    const f = await setup(), replacement = await f.hosts.register(f.ctx, f.agent, f.session, f.settings)
    expect(() => f.host.inspect()).toThrow()
    await f.registered.dispose()
    expect(f.hosts.get(f.agent)).toBe(replacement.host)
    expect(replacement.host.inspect().runId).toBe(f.run.runId)
  })

  it('keeps late actual acceptance in the original owner after Agent revocation but refuses a successful advance', async () => {
    const f = await setup(), original = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (input, signal, guard) => {
      const receipt = await original(input, signal, guard)
      f.detachAgent()
      return receipt
    })
    await expect(f.host.execute(f.request)).rejects.toThrow()
    expect(f.base.readAction(f.run.runId, f.request.actionId).state).toBe('completed')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('keeps an admitted late output after revocation but does not return a new advancement capability', async () => {
    const f = await setup()
    await f.host.execute(f.request)
    f.collect.mockImplementation(async (input, signal, guard) => {
      guard()
      const observed = f.observation(input)
      await f.registered.dispose()
      expect(signal.aborted).toBe(true)
      return observed
    })
    await expect(f.host.collect(f.seed.workflowId, f.request.actionId)).rejects.toThrow()
    const outputs = f.base.readWorkflowOutputs(f.run.runId, f.seed.workflowId)
    expect(outputs).toHaveLength(1)
    expect(Buffer.from(outputs[0]!.artifact.bytes).toString()).toBe(body)
    await expect(f.host.collect(f.seed.workflowId, f.request.actionId)).rejects.toThrow()
    expect(f.collect).toHaveBeenCalledTimes(1)
  })

  it('refuses another legitimately registered Agent and Session claiming the same canonical run', async () => {
    const f = await setup(), otherCtx = new Context()
    cleanups.push(async () => { await otherCtx.root.fiber.dispose() })
    const session = f.ctx.sessions.prepare(SessionId('another-live-session'))
    const detachSession = f.ctx.sessions.enter(session)
    f.ctx.sessions.announce(session)
    const other = agentFor(session, otherCtx), detachAgent = f.ctx.agents.enter(other, undefined)
    f.ctx.agents.announce(other)
    await expect(f.hosts.register(f.ctx, other, session, f.settings)).rejects.toThrow('another Session')
    expect(f.hosts.get(f.agent)).toBe(f.host)
    detachAgent(); detachSession()
  })

  it('revokes access with the contribution owner even when Agent and Session remain live', async () => {
    const f = await setup(), owner = new Context()
    cleanups.push(async () => { await owner.root.fiber.dispose() })
    const registered = await f.hosts.register(owner, f.agent, f.session, f.settings)
    await owner.root.fiber.dispose()
    expect(f.ctx.agents.get(f.agent.id)).toBe(f.agent)
    expect(f.ctx.sessions.get(f.session.id)).toBe(f.session)
    expect(() => registered.host.inspect()).toThrow()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('checks live identity at the collector guard after its internal wait, before reading resource bytes', async () => {
    const f = await setup()
    await f.host.execute(f.request)
    const readBytes = vi.fn()
    f.collect.mockImplementation(async (input, _signal, guard) => {
      await Promise.resolve()
      Object.assign(f.agent, { session: f.ctx.sessions.prepare(SessionId('changed-during-read')) })
      guard()
      readBytes()
      return f.observation(input)
    })
    await expect(f.host.collect(f.seed.workflowId, f.request.actionId)).rejects.toThrow('no longer current')
    expect(readBytes).not.toHaveBeenCalled()
    expect(f.base.readWorkflowOutputs(f.run.runId, f.seed.workflowId)).toEqual([])
  })

  it('rechecks live identity after an asynchronous Consumer wait even without an external action', async () => {
    const f = await setup()
    await expect(f.host.run(async ({ control, runId }) => {
      const original = control.inspect(runId)
      await Promise.resolve()
      f.detachAgent()
      return original
    })).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled()
  })
})

describe('standard fixed-stage coordinator with actual Session, SQLite and two fake Drivers', () => {
  it('rejects mismatched definition and computed-state event relationships before append and disposes the companion', async () => {
    const f = await standardSetup()
    await f.ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await f.ctx.plugin(invariant)
    const state = await f.workflow.start(f.seed), seq = f.session.seq
    expect(() => f.session.append('research/workflow', { version: 1, ownerId: state.ownerId, runId: state.run.runId,
      sessionId: 'wrong-session', definition: state.definition })).toThrow('original Session')
    const packet = { version: 1 as const, ownerId: state.ownerId, runId: state.run.runId, sessionId: f.session.id, state }
    expect(() => f.session.append('research/workflow-update', { ...packet, state: { ...state, fullInputVerified: true } })).toThrow('computed state')
    expect(() => f.session.append('research/workflow-update', { ...packet, state: { ...state,
      run: { ...state.run, runId: 'other-run' as ResearchRunId } } })).toThrow('original owner')
    expect(f.session.seq).toBe(seq)
    await fiber.dispose()
    expect(() => f.session.append('research/workflow-update', { ...packet, state: { ...state, fullInputVerified: true } })).not.toThrow()
  })
  it('reaches every fixed stage with full durable original inputs, automatic collection and separate verification state', async () => {
    const f = await standardSetup()
    await f.workflow.start(f.seed)
    const states = []
    for (const [index, kind] of ['gemini-plan-submit', 'gemini-research-start', 'chatgpt-upload', 'chatgpt-submit'].entries()) {
      const stage = f.seed.stages[index]!
      expect(stage.kind).toBe(kind)
      const p = await f.approve(stage.kind, 'preview-' + String(index))
      states.push(await f.workflow.execute(p.input.previewId, p.sha256))
    }
    const state = states.at(-1)!
    expect(f.calls).toEqual(f.seed.stages.map(x => x.kind))
    expect(f.collect).toHaveBeenCalledTimes(3)
    expect(state).toMatchObject({ fullInputVerified: true, readyForVerification: true, state: 'partial' })
    expect(state.finalStatus.issues).toContain('inventory-confirmation')
    expect(state.outputs.map(x => x.artifact.text)).toEqual([body, f.reportText, f.finalText])
    const upload = f.chatExecute.mock.calls[0]![0], verify = f.chatExecute.mock.calls[1]![0]
    expect(upload.request.input).toBe(f.reportText)
    expect(verify.request.input).toContain(f.reportText)
    expect(verify.request.input).toContain(question)
    expect(verify.request.target).toEqual({ workspace: 'fixture', page: 'assigned-chatgpt', conversation: 'original-chatgpt' })
    const rows = await f.disk(), last = rows.filter(x => x.type === 'research/workflow-update').at(-1)!
    expect(last.type === 'research/workflow-update' && last.data.state).toEqual(state)
    expect(rows.filter(x => x.type === 'research/workflow')).toHaveLength(1)
    const reread = await f.ctx.sessionPersistence.readFrom(f.session.id, 0)
    expect(reread.events).toEqual(rows)
    expect(reread.events.filter(x => x.type === 'research/workflow' || x.type === 'research/workflow-update')
      .every(x => x.data.version === 1)).toBe(true)
    await f.workflow.start(f.seed)
    expect(f.calls).toHaveLength(4)
    expect((await f.workflow.sync()).definition).toEqual(state.definition)
  })

  it('keeps repeated preview revisions stable and requires both exact human confirmations before execution', async () => {
    const f = await standardSetup()
    const p = await f.workflow.preview('gemini-plan-submit', 'preview' as import('@deepseek-ai/dsh-research-handoff').ResearchWorkflowPreviewId)
    const revision = f.host.inspect().revision
    expect((await f.workflow.preview('gemini-plan-submit', p.input.previewId)).sha256).toBe(p.sha256)
    expect(f.host.inspect().revision).toBe(revision)
    await expect(f.workflow.execute(p.input.previewId, p.sha256)).rejects.toThrow('cannot freeze')
    expect(() => f.base.readAction(f.run.runId, f.seed.stages[0]!.actionId)).toThrow('not found')
    await expect(f.hosts.confirmPreviewAndSyncFromCommand({ ...f.invocation, source: { kind: 'model' } },
      p.input.previewId, p.sha256)).rejects.toThrow('user command')
    await f.hosts.confirmRunAndSyncFromCommand(f.invocation, revision, f.host.inspect().bindingSha256)
    await expect(f.workflow.execute(p.input.previewId, p.sha256)).rejects.toThrow('cannot freeze')
    await f.hosts.confirmPreviewAndSyncFromCommand(f.invocation, p.input.previewId, p.sha256)
    await f.workflow.execute(p.input.previewId, p.sha256)
    expect(f.calls).toEqual(['gemini-plan-submit'])
  })

  it('shares the original in-flight stage and reads it on a later repeated execute without replay', async () => {
    const f = await standardSetup(), p = await f.approve('gemini-plan-submit', 'preview')
    const first = f.workflow.execute(p.input.previewId, p.sha256), second = f.workflow.execute(p.input.previewId, p.sha256)
    expect(second).toBe(first)
    await first
    await f.workflow.execute(p.input.previewId, p.sha256)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.collect).toHaveBeenCalledTimes(1)
  })

  it('retains unknown after a lost qualification and neither repeats execution nor visits another resource', async () => {
    const f = await standardSetup(), p = await f.approve('gemini-plan-submit', 'preview')
    f.qualify.mockRejectedValue(Error('fake lost qualification'))
    await expect(f.workflow.execute(p.input.previewId, p.sha256)).rejects.toThrow('lost qualification')
    expect((await f.workflow.execute(p.input.previewId, p.sha256)).stages[0]?.action?.state).toBe('unknown')
    expect((await f.workflow.observe('gemini-plan-submit')).stages[0]?.action?.state).toBe('unknown')
    expect(f.qualify).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.collect).not.toHaveBeenCalled()
  })

  it('refuses a failed definition flush before standard action admission', async () => {
    const f = await standardSetup(), off = f.ctx.on('session/flush', () => { throw Error('workflow definition flush failed') })
    await expect(f.workflow.preview('gemini-plan-submit', 'preview' as import('@deepseek-ai/dsh-research-handoff').ResearchWorkflowPreviewId))
      .rejects.toThrow('definition flush failed')
    off()
    expect(f.execute).not.toHaveBeenCalled()
    expect(() => f.base.readAction(f.run.runId, f.seed.stages[0]!.actionId)).toThrow('not found')
  })

  it('preserves completed original action and output after the returning workflow projection flush fails', async () => {
    const f = await standardSetup(), p = await f.approve('gemini-plan-submit', 'preview')
    const off = f.ctx.on('session/flush', () => {
      const last = f.session.events.at(-1)
      if (last?.type === 'research/workflow-update' && last.data.state.stages[0]?.action?.state === 'completed') {
        throw Error('returning workflow projection failed')
      }
    })
    await expect(f.workflow.execute(p.input.previewId, p.sha256)).rejects.toThrow('returning workflow projection failed')
    off()
    const state = await f.workflow.execute(p.input.previewId, p.sha256)
    expect(state.stages[0]?.action?.state).toBe('completed')
    expect(state.outputs[0]?.artifact.text).toBe(body)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('keeps late actual acceptance after live Agent revocation without collecting or advancing', async () => {
    const f = await standardSetup(), p = await f.approve('gemini-plan-submit', 'preview')
    const execute = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (...args) => { const receipt = await execute(...args); f.detachAgent(); return receipt })
    await expect(f.workflow.execute(p.input.previewId, p.sha256)).rejects.toThrow()
    expect(f.base.readAction(f.run.runId, f.seed.stages[0]!.actionId).state).toBe('completed')
    expect(f.collect).not.toHaveBeenCalled()
    expect(f.calls).toEqual(['gemini-plan-submit'])
  })

  it('keeps mismatches blocking despite a collected plan and later matched message until exact actual-user treatment', async () => {
    const f = await standardSetup(), p = await f.approve('gemini-plan-submit', 'preview'), execute = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (...args) => ({ ...await execute(...args), delivery: { kind: 'message',
      externalId: 'original-action-0' as import('@deepseek-ai/dsh-research-handoff').ResearchExternalDeliveryId,
      observedAt: '2026-10-18T00:00:00Z', evidence: 'fake mismatch',
      readBack: { kind: 'complete-text', text: 'wrong actual message', evidence: 'fake original read' } } }))
    await f.workflow.execute(p.input.previewId, p.sha256)
    await expect(f.workflow.preview('gemini-research-start', 'research' as typeof p.input.previewId)).rejects.toThrow('prerequisites')
    const observe = f.observe.getMockImplementation()!
    f.observe.mockImplementation(async input => ({ ...await observe(input), delivery: { kind: 'message',
      externalId: 'original-action-0' as import('@deepseek-ai/dsh-research-handoff').ResearchExternalDeliveryId,
      observedAt: '2026-10-18T00:01:00Z', evidence: 'fake full later read',
      readBack: { kind: 'complete-text', text: input.request.input, evidence: 'fake complete original' } } }))
    const state = await f.workflow.observe('gemini-plan-submit'), history = state.stages[0]!.history
    expect(state.stages[0]?.deliveryVerified).toBe(false)
    const negative = history[0]!, correction = history[1]!
    const treated = await f.hosts.treatDeliveryAndSyncFromCommand(f.invocation, { dispositionId: 'treatment',
      actionId: f.seed.stages[0]!.actionId, expectedPreviousId: null,
      negative: [{ seq: negative.seq, sha256: negative.sha256 }], correction: { seq: correction.seq, sha256: correction.sha256 },
      reason: 'reviewed exact original mismatch and same-item later complete correction' })
    expect(treated.stages[0]?.deliveryVerified).toBe(true)
    await f.approve('gemini-research-start', 'research')
    expect(f.calls).toEqual(['gemini-plan-submit'])
  })

  it('retains partial collection and later full original observation versions without replaying the stage', async () => {
    const f = await standardSetup(), p = await f.approve('gemini-plan-submit', 'preview'), collect = f.collect.getMockImplementation()!
    f.collect.mockImplementation(async (...args) => { const output = await collect(...args)
      return { ...output, source: { ...output.source, extent: 'partial', endEvidence: null } } })
    const partial = await f.workflow.execute(p.input.previewId, p.sha256)
    expect(partial.outputs[0]?.artifact.source.extent).toBe('partial')
    await expect(f.workflow.preview('gemini-research-start', 'research' as typeof p.input.previewId)).rejects.toThrow('prerequisites')
    f.nextObservation(); f.collect.mockImplementation(collect)
    const full = await f.workflow.observe('gemini-plan-submit')
    expect(full.outputs.map(x => x.artifact.version)).toEqual([1, 2])
    expect(full.outputs.map(x => x.artifact.source.extent)).toEqual(['partial', 'complete'])
    await f.approve('gemini-research-start', 'research')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
})
