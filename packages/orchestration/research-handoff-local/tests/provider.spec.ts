import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResearchActionId, ResearchActionRequest, ResearchDriverId, ResearchDriverRequest,
  ResearchDriverQualification, ResearchDriverReceipt, ResearchHostPolicy, ResearchOwnerId,
  ResearchPlatformDriver, ResearchRunId, ResearchStepId } from '@deepseek-ai/dsh-research-handoff/api'
import * as provider from '../src/index.ts'
import { ResearchActionStore } from '../src/action-store.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function setup(effort: ResearchActionRequest['selection']['effort'] = { kind: 'not-requested' }) {
  const directory = mkdtempSync(join(tmpdir(), 'research-host-'))
  const ctx = new Context()
  const filename = join(directory, 'private.sqlite')
  await ctx.plugin(provider, { filename })
  cleanup.push(async () => { await ctx.root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const id = 'fake-gemini' as ResearchDriverId
  const target = { workspace: 'fixture-workspace', page: 'original-page', conversation: null }
  const selection = { model: 'fake-model', mode: 'fake-research', effort, tools: ['web'] }
  const policy: ResearchHostPolicy = { version: 'fixture-policy-1', judgmentChannel: 'imported', ownerId: 'owner' as ResearchOwnerId,
    workspace: target.workspace, sourceConfigurationSha256s: ['public-sources'],
    destinations: [{ bindingSha256: 'destination', target }], drivers: [{ id, platform: 'gemini', selection }], inputMaxBytes: 1024 }
  const registration = ctx.researchHandoff.bindHost(ctx, policy)
  const control = registration.control
  const run = control.create('run' as ResearchRunId, { questionSha256: 'question', sourcesSha256: 'public-sources',
    destinationSha256: 'destination', modeSha256: control.modeFingerprint(id), plan: null })
  control.confirm(run.runId, run.revision, run.bindingSha256)
  const request: ResearchActionRequest = { runId: run.runId, actionId: 'original' as ResearchActionId,
    stepId: 'gemini-plan' as ResearchStepId, revision: run.revision, binding: run.binding, bindingSha256: run.bindingSha256,
    driverId: id, selection, kind: 'gemini-plan-submit', target, preparedPromptId: null, input: '完整问题\n全部材料' }
  const resource = { workspace: target.workspace, page: 'assigned-page', conversation: 'assigned-conversation',
    report: null, evidence: 'fake original submission receipt correlates assigned conversation' }
  const qualify = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverQualification> => ({ status: 'available',
    requestSha256: input.requestSha256, target: input.request.target, selection: input.request.selection,
    effort: { kind: 'not_observed' }, inputMaxBytes: 1024, evidence: 'fake actual interface observation' }))
  const execute = vi.fn(async (input: ResearchDriverRequest, _signal: AbortSignal, guard: () => void): Promise<ResearchDriverReceipt> => {
    guard()
    return { state: 'accepted', receipt: 'fake accepted', requestSha256: input.requestSha256,
      target: input.request.target, acceptedResource: resource }
  })
  const observe = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverReceipt> => ({ state: 'completed',
    receipt: 'fake original complete', requestSha256: input.requestSha256, target: input.request.target,
    acceptedResource: input.acceptedResource }))
  const driver: ResearchPlatformDriver = { id, platform: 'gemini', qualify, execute, observe }
  const disposeDriver = ctx.researchHandoff.registerDriver(ctx, driver)
  return { ctx, control, registration, request, policy, resource, qualify, execute, observe, driver, disposeDriver, filename }
}

describe('current Host research Provider with fake transport', () => {
  it('rejects an expired request check before creating an action and keeps the fixed ID available', async () => {
    const f = await setup()
    await expect(f.control.execute(f.request, undefined, () => { throw Error('preview expired') })).rejects.toThrow('preview expired')
    expect(() => f.control.readAction(f.request.runId, f.request.actionId)).toThrow()
    expect(f.qualify).not.toHaveBeenCalled()
    expect((await f.control.execute(f.request)).state).toBe('accepted')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('checks the exact recorded request again after qualification and holds unknown without replay', async () => {
    const f = await setup(), qualify = f.qualify.getMockImplementation()!
    let current = true
    const guard = vi.fn((request: ResearchActionRequest) => {
      expect(request).toEqual(f.request)
      if (!current) throw Error('material changed')
    })
    f.qualify.mockImplementation(async (input) => { const result = await qualify(input); current = false; return result })
    await expect(f.control.execute(f.request, undefined, guard)).rejects.toThrow('material changed')
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('unknown')
    expect(f.control.readQualification(f.request.runId, f.request.actionId)?.observation.status).toBe('available')
    expect(f.execute).not.toHaveBeenCalled()
    current = true
    expect((await f.control.execute(f.request, undefined, guard)).state).toBe('unknown')
    expect(f.qualify).toHaveBeenCalledTimes(1)
  })

  it('checks request prerequisites after internal Driver waits before physical submission', async () => {
    const f = await setup(), physicalSubmit = vi.fn()
    let current = true
    f.execute.mockImplementation(async (_input, _signal, guard) => {
      await Promise.resolve()
      current = false
      guard()
      physicalSubmit()
      throw Error('unreachable submit')
    })
    await expect(f.control.execute(f.request, undefined, () => {
      if (!current) throw Error('material changed')
    })).rejects.toThrow('material changed')
    expect(physicalSubmit).not.toHaveBeenCalled()
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('unknown')
  })

  it('retains actual acceptance and delivery before a late request check refuses advancement', async () => {
    const f = await setup()
    let current = true
    f.execute.mockImplementation(async (input, _signal, guard) => {
      guard()
      current = false
      return { state: 'accepted', receipt: 'actual acceptance', requestSha256: input.requestSha256,
        target: input.request.target, acceptedResource: f.resource, delivery: { kind: 'message',
          externalId: 'actual-message' as import('@deepseek-ai/dsh-research-handoff/api').ResearchExternalDeliveryId,
          observedAt: '2026-10-18T00:00:00Z', evidence: 'actual full read',
          readBack: { kind: 'complete-text', text: input.request.input, evidence: 'whole message' } } }
    })
    await expect(f.control.execute(f.request, undefined, () => {
      if (!current) throw Error('material changed')
    })).rejects.toThrow('material changed')
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('accepted')
    expect(f.control.readDeliveryRecords(f.request.runId, f.request.actionId)).toMatchObject([{ contentStatus: 'matched' }])
    current = true
    expect((await f.control.execute(f.request)).state).toBe('accepted')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('rechecks its original grant when a trusted live-scope callback replaces that grant', async () => {
    const f = await setup()
    let replaceOnCheck = false
    let replacement: ReturnType<typeof f.ctx.researchHandoff.bindHost> | undefined
    const scoped = f.ctx.researchHandoff.bindHost(f.ctx, f.policy, undefined, { assertCurrent: () => {
      if (replaceOnCheck) {
        replaceOnCheck = false
        replacement = f.ctx.researchHandoff.bindHost(f.ctx, f.policy)
      }
    } })
    replaceOnCheck = true
    expect(() => scoped.control.inspect(f.request.runId)).toThrow('revoked')
    expect(replacement?.control.inspect(f.request.runId).runId).toBe(f.request.runId)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('persists unknown before qualification and rejects reentrant duplicate execution', async () => {
    const f = await setup()
    const qualify = f.qualify.getMockImplementation()!
    f.qualify.mockImplementation(async (input) => {
      expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('unknown')
      expect((await f.control.execute(f.request)).state).toBe('unknown')
      expect(f.execute).not.toHaveBeenCalled()
      return qualify(input)
    })
    const accepted = await f.control.execute(f.request)
    expect(accepted).toMatchObject({ state: 'accepted', acceptedResource: f.resource })
    expect(f.execute).toHaveBeenCalledTimes(1)
    await f.control.execute(f.request)
    expect(f.qualify).toHaveBeenCalledTimes(1)
    expect((await f.control.observe(f.request.runId, f.request.actionId)).state).toBe('completed')
    expect(f.observe.mock.calls[0]![0].acceptedResource).toEqual(f.resource)
    expect(f.observe.mock.calls[0]![0].request.target).toEqual(f.request.target)
  })

  it('revokes during qualification before any submission and preserves unknown without replay', async () => {
    const f = await setup()
    const qualify = f.qualify.getMockImplementation()!
    f.qualify.mockImplementation(async (input) => { await f.registration.dispose(); return qualify(input) })
    await expect(f.control.execute(f.request)).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled()
    expect(() => f.control.inspect(f.request.runId)).toThrow('revoked')
    const replacement = f.ctx.researchHandoff.bindHost(f.ctx, f.policy).control
    expect((await replacement.execute(f.request)).state).toBe('unknown')
    expect(replacement.readQualification(f.request.runId, f.request.actionId)?.observation.status).toBe('available')
    expect(f.qualify).toHaveBeenCalledTimes(1)
  })

  it('rejects replacement of a Driver registration even when its id is unchanged', async () => {
    const f = await setup()
    const qualify = f.qualify.getMockImplementation()!
    f.qualify.mockImplementation(async (input) => {
      await f.disposeDriver()
      f.ctx.researchHandoff.registerDriver(f.ctx, f.driver)
      return qualify(input)
    })
    await expect(f.control.execute(f.request)).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('unknown')
  })

  it('rechecks the grant after internal Driver awaits immediately before submission', async () => {
    const f = await setup()
    f.execute.mockImplementation(async (_input, _signal, guard) => {
      await f.registration.dispose()
      guard()
      throw Error('must not submit')
    })
    await expect(f.control.execute(f.request)).rejects.toThrow()
    const replacement = f.ctx.researchHandoff.bindHost(f.ctx, f.policy).control
    expect(replacement.readAction(f.request.runId, f.request.actionId).state).toBe('unknown')
  })

  it('retains a correlated late acceptance after revocation without restoring the grant', async () => {
    const f = await setup()
    const execute = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (input, signal, guard) => {
      const receipt = await execute(input, signal, guard)
      await f.registration.dispose()
      return receipt
    })
    expect((await f.control.execute(f.request)).acceptedResource).toEqual(f.resource)
    expect(() => f.control.inspect(f.request.runId)).toThrow('revoked')
    const replacement = f.ctx.researchHandoff.bindHost(f.ctx, f.policy).control
    expect((await replacement.execute(f.request)).state).toBe('accepted')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('does not downgrade required effort when the actual interface has no observed effort control', async () => {
    const f = await setup({ kind: 'required', value: 'high' })
    await expect(f.control.execute(f.request)).rejects.toMatchObject({ code: 'DRIVER_NOT_OBSERVED' })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('unknown')
  })

  it('refuses out-of-policy sources and full inputs over the Host byte limit without invoking a Driver', async () => {
    const f = await setup()
    await expect(f.control.execute({ ...f.request, binding: { ...f.request.binding, sourcesSha256: 'private' } }))
      .rejects.toMatchObject({ code: 'POLICY' })
    await expect(f.control.execute({ ...f.request, input: '中'.repeat(400) })).rejects.toMatchObject({ code: 'INPUT_LIMIT' })
    expect(f.qualify).not.toHaveBeenCalled()
  })

  it('retains qualification before submission and allows owner reads while the Driver executes', async () => {
    const f = await setup()
    const execute = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (input, signal, guard) => {
      expect(f.control.readQualification(f.request.runId, f.request.actionId)).toMatchObject({
        requestSha256: input.requestSha256, observation: { status: 'available', effort: { kind: 'not_observed' } },
      })
      return execute(input, signal, guard)
    })
    await f.control.execute(f.request)
  })

  it('does not synthesize a qualification for a thrown observation or replay the original action', async () => {
    const f = await setup()
    f.qualify.mockRejectedValue(new Error('fake observation reply lost'))
    await expect(f.control.execute(f.request)).rejects.toThrow('reply lost')
    expect(f.control.readQualification(f.request.runId, f.request.actionId)).toBeNull()
    expect((await f.control.execute(f.request)).state).toBe('unknown')
    expect(f.qualify).toHaveBeenCalledTimes(1)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it.each(['unsupported', 'not_observed'] as const)('retains actual %s before surfacing unavailable capability', async (status) => {
    const f = await setup()
    f.qualify.mockResolvedValue({ status, reason: 'fake explicit interface limitation' })
    await expect(f.control.execute(f.request)).rejects.toMatchObject({
      code: status === 'unsupported' ? 'DRIVER_UNSUPPORTED' : 'DRIVER_NOT_OBSERVED',
    })
    expect(f.control.readQualification(f.request.runId, f.request.actionId)?.observation)
      .toEqual({ status, reason: 'fake explicit interface limitation' })
    expect(f.execute).not.toHaveBeenCalled()
    expect((await f.control.execute(f.request)).state).toBe('unknown')
    expect(f.qualify).toHaveBeenCalledTimes(1)
  })

  it.each(['imported', 'model', 'human'] as const)('stamps the Host %s channel independently of JSON human claims', async (channel) => {
    const f = await setup()
    const control = f.ctx.researchHandoff.bindHost(f.ctx, { ...f.policy, judgmentChannel: channel, version: 'channel-fixture' }).control
    const question = 'a'.repeat(64)
    const run = control.revise(f.request.runId, 1, { ...f.request.binding, questionSha256: question })
    const inventory = control.appendClaimInventory(run.runId, { expectedVersion: 0, questionSha256: question, materials: [],
      claims: [{ id: 'candidate', text: 'fixture proposition', critical: true, origins: [{ kind: 'question', artifactId: null, sha256: question }] }],
      changes: [{ kind: 'add', from: [], to: ['candidate'], reason: 'fixture initial candidate' }] })
    const judgment = control.appendClaimJudgment(run.runId, { judgmentId: 'judgment', inventoryVersion: inventory.version,
      claimId: 'candidate', by: 'human', status: 'supported', rationale: 'imported declaration only', materialArtifactIds: [],
      attribution: { channel: 'human', ownerId: 'forged', hostPolicyVersion: 'forged' }, verifiedCoverage: 1, verificationComplete: true })
    expect(judgment.by).toBe('human')
    expect(judgment.attribution).toEqual({ channel, ownerId: f.policy.ownerId, hostPolicyVersion: 'channel-fixture' })
    expect(judgment).not.toHaveProperty('verifiedCoverage')
    expect(judgment).not.toHaveProperty('verificationComplete')
    const reader = new ResearchActionStore(f.filename)
    try { expect(reader.readClaimJudgments(f.policy.ownerId, run.runId, inventory.version, 0, 10)).toEqual([judgment]) }
    finally { reader.close() }
    expect(control.readClaimInventory(run.runId, inventory.version).denominatorConfirmed).toBe(false)
  })

  it.each(['qualify', 'driver-wait'] as const)('blocks an old confirmation revised during %s before actual submission', async (where) => {
    const f = await setup()
    let submitted = 0
    const revise = () => f.control.revise(f.request.runId, f.request.revision, { ...f.request.binding,
      plan: { version: 1, sha256: 'replacement-plan' } })
    const qualify = f.qualify.getMockImplementation()!
    const execute = f.execute.getMockImplementation()!
    if (where === 'qualify') f.qualify.mockImplementation(async (input) => { await Promise.resolve(); revise(); return qualify(input) })
    f.execute.mockImplementation(async (input, signal, guard) => {
      if (where === 'driver-wait') { await Promise.resolve(); revise() }
      guard()
      submitted++
      return execute(input, signal, guard)
    })
    await expect(f.control.execute(f.request)).rejects.toMatchObject({ code: 'CONFIRMATION' })
    expect(submitted).toBe(0)
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('unknown')
    expect(f.control.inspect(f.request.runId)).toMatchObject({ revision: 2, confirmed: false })
    expect((await f.control.execute(f.request)).state).toBe('unknown')
    expect(f.qualify).toHaveBeenCalledTimes(1)
  })

  it('retains original late acceptance when the run is revised after actual submission', async () => {
    const f = await setup()
    let submitted = 0
    f.execute.mockImplementation(async (input, _signal, guard) => {
      guard()
      submitted++
      await Promise.resolve()
      f.control.revise(f.request.runId, f.request.revision, { ...f.request.binding, plan: { version: 1, sha256: 'later-plan' } })
      return { state: 'accepted', receipt: 'late original acceptance', acceptedResource: f.resource,
        requestSha256: input.requestSha256, target: input.request.target }
    })
    const original = await f.control.execute(f.request)
    expect(submitted).toBe(1)
    expect(original).toMatchObject({ state: 'accepted', request: { revision: 1 }, acceptedResource: f.resource })
    expect(f.control.inspect(f.request.runId)).toMatchObject({ revision: 2, confirmed: false })
    expect((await f.control.execute(f.request)).state).toBe('accepted')
    expect(submitted).toBe(1)
  })

  it('blocks actual submission when a correlated observe has already completed the original action', async () => {
    const f = await setup()
    let submitted = 0
    f.observe.mockImplementation(async input => ({ state: 'completed', receipt: 'original completion observed',
      acceptedResource: f.resource, requestSha256: input.requestSha256, target: input.request.target }))
    f.execute.mockImplementation(async (input, _signal, guard) => {
      await f.control.observe(f.request.runId, f.request.actionId)
      guard()
      submitted++
      return { state: 'accepted', receipt: 'must not happen', acceptedResource: f.resource,
        requestSha256: input.requestSha256, target: input.request.target }
    })
    await expect(f.control.execute(f.request)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(submitted).toBe(0)
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('completed')
  })

  it.each(['accepted', 'completed'] as const)('refuses first observe %s without any correlated resource and preserves unknown', async (state) => {
    const f = await setup()
    f.qualify.mockRejectedValue(new Error('reply lost'))
    await expect(f.control.execute(f.request)).rejects.toThrow('reply lost')
    f.observe.mockImplementation(async input => ({ state, receipt: 'unbound state claim', acceptedResource: null,
      requestSha256: input.requestSha256, target: input.request.target }))
    await expect(f.control.observe(f.request.runId, f.request.actionId)).rejects.toMatchObject({ code: 'DRIVER_NOT_OBSERVED' })
    expect(f.control.readAction(f.request.runId, f.request.actionId)).toMatchObject({ state: 'unknown', acceptedResource: null })
    expect(f.control.readObservations(f.request.runId, 0, 10)).toEqual([])
  })

  it('reuses an already correlated resource when a later completed observation omits the resource', async () => {
    const f = await setup()
    await f.control.execute(f.request)
    f.observe.mockImplementation(async input => ({ state: 'completed', receipt: 'same original resource completed',
      acceptedResource: null, requestSha256: input.requestSha256, target: input.request.target }))
    expect(await f.control.observe(f.request.runId, f.request.actionId)).toMatchObject({
      state: 'completed', acceptedResource: f.resource,
    })
  })

  it('waits for an owned late reply before closing the database', async () => {
    const f = await setup()
    const entered = Promise.withResolvers<undefined>()
    const reply = Promise.withResolvers<undefined>()
    f.execute.mockImplementation(async (input, _signal, guard) => {
      guard()
      entered.resolve(undefined)
      await reply.promise
      return { state: 'accepted', receipt: 'late receipt', acceptedResource: f.resource,
        requestSha256: input.requestSha256, target: input.request.target }
    })
    const action = f.control.execute(f.request)
    await entered.promise
    const service = f.ctx.researchHandoff as provider.LocalResearchHandoffService
    let closed = false
    const draining = service.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    await expect(f.control.execute(f.request)).rejects.toMatchObject({ code: 'HOST_REVOKED' })
    reply.resolve(undefined)
    expect((await action).state).toBe('accepted')
    await draining
    expect(closed).toBe(true)
  })
})
