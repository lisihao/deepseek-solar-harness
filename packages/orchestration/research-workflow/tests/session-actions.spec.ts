import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResearchActionId, ResearchActionRequest, ResearchDriverId, ResearchDriverRequest,
  ResearchDriverQualification, ResearchDriverReceipt, ResearchOwnerId, ResearchRunId, ResearchStepId,
  ResearchPromptInputId, ResearchExternalDeliveryId } from '@deepseek-ai/dsh-research-handoff'
import * as provider from '@deepseek-ai/dsh-research-handoff-local'
import { readResearchPromptTemplate } from '../../research-handoff-local/src/prompt.ts'
import { ResearchSessionActions } from '../src/index.ts'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as invariant from '../src/invariant.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const question = '原问题中😀文 $& <scope>\n'
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')

async function setup(persist = true) {
  const dir = await mkdtemp(join(tmpdir(), 'research-session-'))
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  if (persist) await ctx.plugin(JsonlSessionPersistence, { root: join(dir, 'logs'), compression: 'none' })
  await ctx.plugin(provider, { filename: join(dir, 'research.sqlite') })
  cleanups.push(async () => { await ctx.root.fiber.dispose(); await rm(dir, { recursive: true, force: true }) })
  const session = ctx.sessions.prepare(SessionId('journal'), { meta: { cwd: dir } })
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  const id = 'fake-gemini' as ResearchDriverId
  const target = { workspace: 'fixture', page: 'original-page', conversation: null }
  const selection = { model: 'fake', mode: 'fake-research', effort: { kind: 'not-requested' as const }, tools: ['web'] }
  const control = ctx.researchHandoff.bindHost(ctx, { version: 'fixture', judgmentChannel: 'human',
    ownerId: 'owner' as ResearchOwnerId, workspace: target.workspace, sourceConfigurationSha256s: ['public'],
    destinations: [{ bindingSha256: 'target', target }], drivers: [{ id, platform: 'gemini', selection }],
    inputMaxBytes: 100000 }).control
  const run = control.create('run' as ResearchRunId, { questionSha256: hash(question), sourcesSha256: 'public',
    destinationSha256: 'target', modeSha256: control.modeFingerprint(id), plan: null })
  control.confirm(run.runId, run.revision, run.bindingSha256)
  const request: ResearchActionRequest = { runId: run.runId, actionId: 'original' as ResearchActionId,
    stepId: 'plan' as ResearchStepId, revision: run.revision, bindingSha256: run.bindingSha256, binding: run.binding,
    driverId: id, selection, kind: 'gemini-plan-submit', target, preparedPromptId: null, input: question }
  const resource = { ...target, conversation: 'actual-conversation', report: null, evidence: 'fake receipt binds original action' }
  const qualify = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverQualification> => ({
    status: 'available', requestSha256: input.requestSha256, target: input.request.target, selection: input.request.selection,
    effort: { kind: 'not_observed' }, inputMaxBytes: 100000, evidence: 'fake observed normal interface' }))
  const execute = vi.fn(async (input: ResearchDriverRequest, _signal: AbortSignal, guard: () => void): Promise<ResearchDriverReceipt> => {
    guard()
    return { state: 'accepted', requestSha256: input.requestSha256, target: input.request.target,
      acceptedResource: resource, receipt: 'fake accepted original' }
  })
  const observe = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverReceipt> => ({
    state: 'completed', requestSha256: input.requestSha256, target: input.request.target,
    acceptedResource: input.acceptedResource, receipt: 'fake completed original' }))
  ctx.researchHandoff.registerDriver(ctx, { id, platform: 'gemini', qualify, execute, observe })
  const actions = new ResearchSessionActions(ctx.sessions, session, control, run.runId)
  const disk = async (): Promise<SessionEvent[]> => {
    const location = ctx.sessionPersistence.locate(session.header)
    if (location === undefined || location.kind !== 'jsonl') throw Error('fixture needs JSONL')
    const rows = (await readFile(location.path, 'utf8')).trimEnd().split('\n').slice(1)
    return rows.map(line => JSON.parse(line) as SessionEvent)
  }
  return { ctx, session, control, request, resource, qualify, execute, observe, actions, detach, disk }
}

describe('Session research actions with real SQLite and JSONL persistence', () => {
  it('reads the full durable input at the first fake Driver entrance and retains actual action evidence', async () => {
    const f = await setup()
    const execute = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (input, signal, guard) => {
      const event = (await f.disk()).find(x => x.type === 'research/input')
      expect(event?.type).toBe('research/input')
      if (event?.type !== 'research/input') throw Error('input not persisted')
      expect(event.data.request).toEqual(input.request)
      expect(event.data.request.input).toBe(question)
      expect(event.data.preparedPrompt).toBeNull()
      return execute(input, signal, guard)
    })
    expect((await f.actions.execute(f.request)).state).toBe('accepted')
    const events = await f.disk()
    const fact = events.find(x => x.type === 'research/action')
    expect(fact?.type).toBe('research/action')
    if (fact?.type !== 'research/action') throw Error('facts not persisted')
    expect(fact.data.snapshot.acceptedResource).toEqual(f.resource)
    expect(fact.data.qualification?.observation.status).toBe('available')
    expect(fact.data.observations).toHaveLength(1)
    expect(events.every(x => x.ignorable !== true)).toBe(true)
  })

  it('retains every original template slot and full rendered input', async () => {
    const f = await setup()
    const template = readResearchPromptTemplate('gemini-deep-research')
    const slots = [...template.text.matchAll(/<([a-z_]+)>/g)].map(x => x[1]!)
    const prompt = f.control.preparePrompt(f.request.runId, { inputId: 'prepared' as ResearchPromptInputId,
      revision: 1, templateId: template.id, values: Object.fromEntries(slots.map(name =>
        [name, [{ kind: 'text' as const, text: name === 'user_question' ? question : '明确提供的 ' + name }]])) })
    await f.actions.execute({ ...f.request, input: prompt.renderedText, preparedPromptId: prompt.inputId })
    const event = (await f.disk()).find(x => x.type === 'research/input')
    expect(event?.type === 'research/input' && event.data.preparedPrompt).toEqual(prompt)
    expect(f.execute.mock.calls[0]![0].request.input).toBe(prompt.renderedText)
  })

  it('uses the logged request when the caller mutates its object during flush', async () => {
    const f = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const off = f.ctx.on('session/flush', async () => { entered.resolve(undefined); await release.promise })
    const fixed = structuredClone(f.request)
    const result = f.actions.execute(f.request)
    await entered.promise
    Object.assign(f.request, { input: 'replacement', target: { ...f.request.target, page: 'changed' } })
    release.resolve(undefined)
    await result
    off()
    expect(f.execute.mock.calls[0]![0].request).toEqual(fixed)
    const event = (await f.disk()).find(x => x.type === 'research/input')
    expect(event?.type === 'research/input' && event.data.request).toEqual(fixed)
  })

  it('blocks a missing durability listener before any Driver call', async () => {
    const f = await setup(false)
    await expect(f.actions.execute(f.request)).rejects.toThrow('no durability listener')
    expect(f.qualify).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('blocks a rejecting flush without inventing an action receipt', async () => {
    const f = await setup()
    const off = f.ctx.on('session/flush', () => { throw Error('fixture flush refused') })
    await expect(f.actions.execute(f.request)).rejects.toThrow('fixture flush refused')
    off()
    expect(f.execute).not.toHaveBeenCalled()
    expect(() => f.control.readAction(f.request.runId, f.request.actionId)).toThrow('not found')
  })

  it('blocks a Session detached while its input flush is pending', async () => {
    const f = await setup()
    const off = f.ctx.on('session/flush', () => { f.detach() })
    await expect(f.actions.execute(f.request)).rejects.toThrow('not live')
    off()
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('rejects a different run before writing an input or invoking a Driver', async () => {
    const f = await setup()
    await expect(f.actions.execute({ ...f.request, runId: 'other' as ResearchRunId })).rejects.toMatchObject({ code: 'OWNER' })
    expect(f.session.events).toHaveLength(0)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('keeps unknown after a lost reply and syncs without replay or invented qualification', async () => {
    const f = await setup()
    f.qualify.mockRejectedValue(Error('fake qualifier reply lost'))
    await expect(f.actions.execute(f.request)).rejects.toThrow('reply lost')
    expect((await f.actions.sync(f.request.actionId)).state).toBe('unknown')
    expect((await f.actions.execute(f.request)).state).toBe('unknown')
    expect(f.qualify).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
    const event = (await f.disk()).find(x => x.type === 'research/action')
    expect(event?.type === 'research/action' && event.data.qualification).toBeNull()
    expect(event?.type === 'research/action' && event.data.observations).toEqual([])
  })

  it('recovers an accepted action after the returning projection flush fails without resubmitting', async () => {
    const f = await setup()
    const off = f.ctx.on('session/flush', () => {
      if (f.session.events.some(x => x.type === 'research/action')) throw Error('returning flush refused')
    })
    await expect(f.actions.execute(f.request)).rejects.toThrow('returning flush refused')
    off()
    expect((await f.actions.sync(f.request.actionId)).state).toBe('accepted')
    await f.actions.execute(f.request)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect((await f.actions.observe(f.request.actionId)).state).toBe('completed')
    expect(f.observe.mock.calls[0]![0].acceptedResource).toEqual(f.resource)
    const fact = (await f.disk()).filter(x => x.type === 'research/action').at(-1)
    expect(fact?.data.observations.map(x => x.state)).toEqual(['accepted', 'completed'])
  })

  it('keeps concurrent duplicate requests under the same SQLite action owner', async () => {
    const f = await setup()
    await Promise.all([f.actions.execute(f.request), f.actions.execute(f.request)])
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.qualify).toHaveBeenCalledTimes(1)
  })

  it('rejects prepared input for another exact stage before any Driver call', async () => {
    const f = await setup()
    const template = readResearchPromptTemplate('gemini-deep-research')
    const slots = [...template.text.matchAll(/<([a-z_]+)>/g)].map(x => x[1]!)
    const prompt = f.control.preparePrompt(f.request.runId, { inputId: 'wrong-stage' as ResearchPromptInputId,
      revision: 1, templateId: template.id, values: Object.fromEntries(slots.map(name =>
        [name, [{ kind: 'text' as const, text: name === 'user_question' ? question : 'provided ' + name }]])) })
    await expect(f.actions.execute({ ...f.request, kind: 'gemini-research-start',
      preparedPromptId: prompt.inputId, input: prompt.renderedText })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.session.events).toHaveLength(0)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('retains only the original action observations when other actions share its run', async () => {
    const f = await setup()
    await f.actions.execute(f.request)
    await f.actions.observe(f.request.actionId)
    const second = { ...f.request, actionId: 'second' as ResearchActionId, stepId: 'other' as ResearchStepId,
      kind: 'gemini-research-start' as const }
    await f.actions.execute(second)
    await f.actions.sync(f.request.actionId)
    const event = (await f.disk()).filter(x => x.type === 'research/action').at(-1)
    expect(event?.data.observations.map(x => x.actionId)).toEqual([f.request.actionId, f.request.actionId])
    expect(event?.data.observations.map(x => x.state)).toEqual(['accepted', 'completed'])
  })

  it('rejects conflicting original-run events before append and removes the companion on disposal', async () => {
    const f = await setup()
    await f.ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = await f.ctx.plugin(invariant)
    const invalid = { ownerId: f.control.ownerId, runId: 'other' as ResearchRunId,
      request: f.request, preparedPrompt: null }
    expect(() => f.session.append('research/input', invalid)).toThrow('research input belongs')
    expect(f.session.seq).toBe(0)
    await f.actions.execute(f.request)
    const snapshot = f.control.readAction(f.request.runId, f.request.actionId)
    expect(() => f.session.append('research/action', { ownerId: f.control.ownerId,
      runId: f.request.runId, snapshot, qualification: null, deliveries: [],
      observations: [{ seq: 1, runId: f.request.runId, actionId: 'wrong' as ResearchActionId,
        state: 'accepted', receipt: 'unrelated', acceptedResource: f.resource }] })).toThrow('conflicts')
    await fiber.dispose()
    expect(() => f.session.append('research/input', invalid)).not.toThrow()
  })

  it('retains actual delivery read-back in the durable Session action projection', async () => {
    const f = await setup()
    const execute = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (...args) => ({ ...await execute(...args), delivery: {
      kind: 'message', externalId: 'observed-message' as ResearchExternalDeliveryId, observedAt: '2026-10-18T00:00:00.000Z',
      evidence: 'fake normal-interface message identity',
      readBack: { kind: 'complete-text', text: question, evidence: 'fake complete body read-back' },
    } }))
    await f.actions.execute(f.request)
    const event = (await f.disk()).filter(x => x.type === 'research/action').at(-1)
    expect(event?.data.deliveries).toEqual(f.control.readDeliveryRecords(f.request.runId, f.request.actionId))
    expect(event?.data.deliveries[0]?.observation.readBack).toEqual({
      kind: 'complete-text', text: question, evidence: 'fake complete body read-back',
    })
    expect(event?.data.deliveries[0]?.contentStatus).toBe('matched')
  })
})
