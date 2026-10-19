import type {
  ResearchDriverId,
  ResearchActionId,
  ResearchActionObservation,
  ResearchActionRequest,
  ResearchConfirmationBinding,
  ResearchOwnerId,
  ResearchRunId,
  ResearchStepId,
} from '@deepseek-ai/dsh-research-handoff/api'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResearchActionStore, researchActionFingerprint, researchModeFingerprint } from '../src/action-store.ts'

const owner = 'owner-a' as ResearchOwnerId
const otherOwner = 'owner-b' as ResearchOwnerId
const runId = 'run-a' as ResearchRunId
const actionId = 'action-a' as ResearchActionId
const fixtureAcceptedResource = { workspace: 'research-a', page: 'page-a', conversation: null, report: null,
  evidence: 'explicit fake original acceptance; no website request' }
const binding: ResearchConfirmationBinding = {
  questionSha256: 'question-v1', sourcesSha256: 'public-web-v1',
  modeSha256: 'observed-mode-v1', destinationSha256: 'gemini-page-v1', plan: null,
}

describe('research action durable ownership', () => {
  let directory: string
  let filename: string
  const opened = new Set<ResearchActionStore>()
  const open = (): ResearchActionStore => {
    const store = new ResearchActionStore(filename)
    opened.add(store)
    return store
  }
  const close = (store: ResearchActionStore): void => { store.close(); opened.delete(store) }
  const ready = (store: ResearchActionStore): ResearchActionRequest => {
    const run = store.create(owner, runId, binding)
    store.confirm(owner, runId, run.revision, run.bindingSha256)
    return {
      runId, actionId, stepId: 'gemini-plan' as ResearchStepId, revision: run.revision, bindingSha256: run.bindingSha256,
      binding: run.binding, driverId: 'fixture-driver' as ResearchDriverId,
      selection: { model: 'fixture-model', mode: 'fixture-mode', effort: { kind: 'not-requested' }, tools: [] },
      kind: 'gemini-plan-submit', preparedPromptId: null, input: '完整问题与获准材料\n末尾',
      target: { workspace: 'research-a', page: 'page-a', conversation: null },
    }
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'dsh-research-action-'))
    filename = join(directory, 'research.sqlite')
  })
  afterEach(() => {
    for (const store of opened) store.close()
    opened.clear()
    rmSync(directory, { recursive: true, force: true })
  })

  it('commits exact unknown intent before invoking any external Driver effect', async () => {
    const store = open()
    const request = ready(store)
    const observer = open()
    const result = await store.execute(owner, request, async (recorded) => {
      const intent = observer.readAction(owner, runId, actionId)
      expect(intent.state).toBe('unknown')
      expect(intent.receipt).toBeNull()
      expect(intent.request).toEqual(request)
      expect(recorded).toEqual(intent.request)
      return { state: 'accepted', receipt: 'visible exact research conversation accepted', acceptedResource: fixtureAcceptedResource }
    })
    expect(result.state).toBe('accepted')
  })

  it('binds assigned resources once and reopens them without rewriting the original target', async () => {
    const store = open()
    const request = ready(store)
    const resource = { workspace: 'research-a', page: 'assigned-page', conversation: 'assigned-conversation',
      report: 'assigned-report', evidence: 'original submit receipt links these exact resources' }
    const accepted = await store.execute(owner, request, async () => ({
      state: 'accepted', receipt: 'original submit accepted', acceptedResource: resource,
    }))
    expect(accepted.request.target).toEqual(request.target)
    expect(accepted.acceptedResource).toEqual(resource)
    close(store)
    const reopened = open()
    expect(reopened.readAction(owner, runId, actionId).acceptedResource).toEqual(resource)
    expect(() => reopened.recordObservation(owner, runId, actionId, accepted.inputSha256, {
      state: 'completed', receipt: 'another report', acceptedResource: { ...resource, report: 'replacement' },
    })).toThrow('resource conflicts')
    expect(reopened.readAction(owner, runId, actionId).state).toBe('accepted')
    reopened.recordObservation(owner, runId, actionId, accepted.inputSha256, {
      state: 'completed', receipt: 'original report done', acceptedResource: resource,
    })
    expect(reopened.readObservations(owner, runId, 0, 10).map(x => x.acceptedResource)).toEqual([resource, resource])
  })

  it('fills a previously unassigned report once using later correlated evidence', async () => {
    const store = open()
    const request = ready(store)
    const initial = { workspace: 'research-a', page: 'assigned-page', conversation: 'assigned-conversation',
      report: null, evidence: 'submit receipt assigns conversation' }
    const accepted = await store.execute(owner, request, async () => ({
      state: 'accepted', receipt: 'accepted', acceptedResource: initial,
    }))
    const assigned = { ...initial, report: 'original-report', evidence: 'same conversation now links original report' }
    store.recordObservation(owner, runId, actionId, accepted.inputSha256, {
      state: 'completed', receipt: 'original report ready', acceptedResource: assigned,
    })
    expect(store.readAction(owner, runId, actionId).acceptedResource).toEqual(assigned)
    expect(store.readObservations(owner, runId, 0, 10).map(x => x.acceptedResource)).toEqual([initial, assigned])
    expect(() => store.recordObservation(owner, runId, actionId, accepted.inputSha256, {
      state: 'completed', receipt: 'replacement', acceptedResource: { ...assigned, report: 'new-report' },
    })).toThrow('resource conflicts')
  })

  it('rejects another workspace acceptance without losing the original unknown intent', async () => {
    const store = open()
    const request = ready(store)
    await expect(store.execute(owner, request, async () => ({
      state: 'accepted', receipt: 'unrelated resource', acceptedResource: { workspace: 'other', page: 'page',
        conversation: 'conversation', report: null, evidence: 'wrong workspace' },
    }))).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(store.readAction(owner, runId, actionId)).toMatchObject({ state: 'unknown', acceptedResource: null })
  })

  it('binds requested effort into action and mode digests without assuming an observed website value', async () => {
    const store = open()
    const request = ready(store)
    const high = { ...request, selection: { ...request.selection, effort: { kind: 'required' as const, value: 'high' } } }
    const inapplicable = { ...request, selection: { ...request.selection, effort: { kind: 'not-applicable' as const } } }
    expect(new Set([request, high, inapplicable].map(researchActionFingerprint)).size).toBe(3)
    expect(new Set([request, high, inapplicable].map(x => researchModeFingerprint(x.driverId, x.selection))).size).toBe(3)
    await store.execute(owner, high, async () => ({ state: 'accepted', receipt: 'fixture', acceptedResource: fixtureAcceptedResource }))
    close(store)
    const reopened = open()
    expect(reopened.readAction(owner, runId, actionId).request.selection.effort).toEqual({ kind: 'required', value: 'high' })
    await expect(reopened.execute(owner, request, async () => { throw Error('must not execute') }))
      .rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('two instances and a changed action id cannot duplicate an unresolved submission', async () => {
    const store = open()
    const request = ready(store)
    const second = open()
    const reply = Promise.withResolvers<ResearchActionObservation>()
    const invoke = vi.fn(() => reply.promise)
    const original = store.execute(owner, request, invoke)
    const duplicate = vi.fn(async (): Promise<ResearchActionObservation> => ({ state: 'completed', receipt: 'wrong duplicate', acceptedResource: fixtureAcceptedResource }))
    expect((await second.execute(owner, request, duplicate)).state).toBe('unknown')
    await expect(second.execute(owner, { ...request, actionId: 'new-id' as ResearchActionId }, duplicate))
      .rejects.toMatchObject({ code: 'PENDING' })
    expect(duplicate).not.toHaveBeenCalled()
    reply.resolve({ state: 'accepted', receipt: 'original acceptance', acceptedResource: fixtureAcceptedResource })
    await expect(original).resolves.toMatchObject({ state: 'accepted' })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('surfaces a lost reply and preserves unknown across reopening without replay', async () => {
    const store = open()
    const request = ready(store)
    await expect(store.execute(owner, request, async () => { throw new Error('reply lost after click') }))
      .rejects.toThrow('reply lost after click')
    close(store)
    const recovered = open()
    const replay = vi.fn(async (): Promise<ResearchActionObservation> => ({ state: 'completed', receipt: 'replayed', acceptedResource: fixtureAcceptedResource }))
    const result = await recovered.execute(owner, request, replay)
    expect(result.state).toBe('unknown')
    expect(result.request.target).toEqual(request.target)
    expect(result.request.input).toBe(request.input)
    expect(replay).not.toHaveBeenCalled()
  })

  it('a second click with another action id cannot repeat an already completed logical step', async () => {
    const store = open()
    const request = ready(store)
    await store.execute(owner, request, async () => ({ state: 'completed', receipt: 'plan already generated', acceptedResource: fixtureAcceptedResource }))
    const invoke = vi.fn(async (): Promise<ResearchActionObservation> => ({ state: 'completed', receipt: 'duplicate', acceptedResource: fixtureAcceptedResource }))
    await expect(store.execute(owner, { ...request, actionId: 'second-click' as ResearchActionId }, invoke))
      .rejects.toMatchObject({ code: 'CONFLICT' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each([
    ['input', { input: 'changed question' }],
    ['page', { target: { workspace: 'research-a', page: 'new-page', conversation: null } }],
    ['kind', { kind: 'gemini-research-start' as const }],
  ])('rejects conflicting %s for the original action without invoking the Driver', async (_name, change) => {
    const store = open()
    const request = ready(store)
    await store.execute(owner, request, async () => ({ state: 'accepted', receipt: 'original accepted', acceptedResource: fixtureAcceptedResource }))
    const invoke = vi.fn(async (): Promise<ResearchActionObservation> => ({ state: 'completed', receipt: 'wrong', acceptedResource: fixtureAcceptedResource }))
    await expect(store.execute(owner, { ...request, ...change }, invoke)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(invoke).not.toHaveBeenCalled()
    expect(store.readAction(owner, runId, actionId).receipt).toBe('original accepted')
  })

  it.each<Partial<ResearchConfirmationBinding>>([
    { questionSha256: 'different-question' }, { sourcesSha256: 'private-source-added' },
    { modeSha256: 'different-mode' }, { destinationSha256: 'different-destination' },
    { plan: { version: 1, sha256: 'new-plan' } },
  ])('invalidates an earlier confirmation when its binding changes: %j', async (change) => {
    const store = open()
    const request = ready(store)
    const current = store.revise(owner, runId, request.revision, { ...binding, ...change })
    expect(current.confirmed).toBe(false)
    expect(() => store.confirm(owner, runId, request.revision, request.bindingSha256))
      .toThrow('confirmation does not match')
    const invoke = vi.fn(async (): Promise<ResearchActionObservation> => ({ state: 'accepted', receipt: 'wrong', acceptedResource: fixtureAcceptedResource }))
    await expect(store.execute(owner, request, invoke)).rejects.toMatchObject({ code: 'CONFIRMATION' })
    expect(invoke).not.toHaveBeenCalled()
    store.confirm(owner, runId, current.revision, current.bindingSha256)
    await expect(store.execute(owner, {
      ...request, revision: current.revision, bindingSha256: current.bindingSha256, binding: current.binding,
    }, async () => ({ state: 'accepted', receipt: 'new exact confirmation', acceptedResource: fixtureAcceptedResource }))).resolves.toMatchObject({ state: 'accepted' })
  })

  it('requires an initial explicit confirmation for generating a Gemini plan', async () => {
    const store = open()
    const run = store.create(owner, runId, binding)
    const request: ResearchActionRequest = {
      runId, actionId, stepId: 'gemini-plan' as ResearchStepId,
      revision: 1, bindingSha256: run.bindingSha256, kind: 'gemini-plan-submit',
      binding: run.binding, driverId: 'fixture-driver' as ResearchDriverId,
      selection: { model: 'fixture-model', mode: 'fixture-mode', effort: { kind: 'not-requested' }, tools: [] },
      target: { workspace: 'research', page: 'original', conversation: null }, preparedPromptId: null, input: 'question',
    }
    const invoke = vi.fn(async (): Promise<ResearchActionObservation> => ({ state: 'accepted', receipt: 'wrong', acceptedResource: fixtureAcceptedResource }))
    await expect(store.execute(owner, request, invoke)).rejects.toMatchObject({ code: 'CONFIRMATION' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects another owner for run, action, confirmation, and projection reads', async () => {
    const store = open()
    const request = ready(store)
    await store.execute(owner, request, async () => ({ state: 'accepted', receipt: 'private observation', acceptedResource: fixtureAcceptedResource }))
    expect(() => store.inspect(otherOwner, runId)).toThrow('another owner')
    expect(() => store.confirm(otherOwner, runId, 1, request.bindingSha256)).toThrow('another owner')
    expect(() => store.readAction(otherOwner, runId, actionId)).toThrow('another owner')
    expect(() => store.readObservations(otherOwner, runId, 0, 10)).toThrow('another owner')
  })

  it('retains append-only acceptance and completion with stable projection sequence ids', async () => {
    const store = open()
    const request = ready(store)
    const accepted = await store.execute(owner, request, async () => ({ state: 'accepted', receipt: 'accepted evidence', acceptedResource: fixtureAcceptedResource }))
    const complete = { state: 'completed' as const, receipt: 'original report completed evidence', acceptedResource: fixtureAcceptedResource }
    store.recordObservation(owner, runId, actionId, accepted.inputSha256, complete)
    store.recordObservation(owner, runId, actionId, accepted.inputSha256, complete)
    const events = store.readObservations(owner, runId, 0, 10)
    expect(events.map(x => [x.state, x.receipt])).toEqual([
      ['accepted', 'accepted evidence'], ['completed', 'original report completed evidence'],
    ])
    close(store)
    const reopened = open()
    expect(reopened.readObservations(owner, runId, 0, 10)).toEqual(events)
    expect(reopened.readObservations(owner, runId, events[0]!.seq, 1)).toEqual([events[1]])
    expect(() => reopened.recordObservation(owner, runId, actionId, accepted.inputSha256,
      { state: 'not-sent', receipt: 'contradiction', acceptedResource: null })).toThrow('contradicts')
  })

  it('does not retry a proven not-sent action automatically and preserves its receipt', async () => {
    const store = open()
    const request = ready(store)
    await store.execute(owner, request, async () => ({ state: 'not-sent', receipt: 'mode unavailable before submit', acceptedResource: null }))
    const invoke = vi.fn(async (): Promise<ResearchActionObservation> => ({ state: 'accepted', receipt: 'wrong', acceptedResource: fixtureAcceptedResource }))
    expect((await store.execute(owner, request, invoke)).state).toBe('not-sent')
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(['accepted', 'completed'] as const)('refuses an unbound %s observation without changing unknown', async (state) => {
    const store = open()
    const request = ready(store)
    await expect(store.execute(owner, request, async () => { throw Error('unknown submit effect') })).rejects.toThrow('unknown')
    expect(() => store.recordObservation(owner, runId, actionId, researchActionFingerprint(request),
      { state, receipt: 'unbound state claim', acceptedResource: null })).toThrow('resource is missing')
    expect(store.readAction(owner, runId, actionId)).toMatchObject({ state: 'unknown', acceptedResource: null })
    expect(store.readObservations(owner, runId, 0, 10)).toEqual([])
  })

  it.each(['action', 'observation'])('rejects durable accepted %s data whose resource association is missing', async (where) => {
    const store = open()
    const request = ready(store)
    await store.execute(owner, request, async () => ({
      state: 'accepted', receipt: 'fixture accepted', acceptedResource: fixtureAcceptedResource,
    }))
    const db = new DatabaseSync(filename)
    if (where === 'action') db.prepare('UPDATE research_actions SET accepted_resource_json=NULL').run()
    else db.prepare('UPDATE research_action_observations SET accepted_resource_json=NULL').run()
    db.close()
    expect(() => where === 'action' ? store.readAction(owner, runId, actionId) : store.readObservations(owner, runId, 0, 10))
      .toThrow('matching acceptance resource')
  })

  it('refuses a corrupted durable request instead of trusting its stored identity', async () => {
    const store = open()
    const request = ready(store)
    await store.execute(owner, request, async () => ({ state: 'accepted', receipt: 'accepted', acceptedResource: fixtureAcceptedResource }))
    const db = new DatabaseSync(filename)
    db.prepare('UPDATE research_actions SET request_json=?').run('{}')
    db.close()
    expect(() => store.readAction(owner, runId, actionId)).toThrow('invalid durable research action')
  })

  it('refuses an unsupported database version without rewriting it', () => {
    const db = new DatabaseSync(filename)
    db.exec('PRAGMA user_version=99')
    db.close()
    expect(() => open()).toThrow('unsupported research database version')
    const check = new DatabaseSync(filename)
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(99)
    check.close()
  })
})
