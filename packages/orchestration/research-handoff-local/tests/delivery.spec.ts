import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResearchActionId, ResearchActionRequest, ResearchDriverDelivery, ResearchDriverId,
  ResearchDriverRequest, ResearchDriverQualification, ResearchDriverReceipt, ResearchHostPolicy, ResearchExternalDeliveryId,
  ResearchOwnerId, ResearchRunId, ResearchStepId } from '@deepseek-ai/dsh-research-handoff'
import * as provider from '../src/index.ts'
import { ResearchActionStore } from '../src/action-store.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

async function setup(kind: ResearchActionRequest['kind'] = 'gemini-plan-submit') {
  const dir = mkdtempSync(join(tmpdir(), 'research-delivery-'))
  const filename = join(dir, 'private.sqlite')
  const ctx = new Context()
  await ctx.plugin(provider, { filename })
  cleanup.push(async () => { await ctx.root.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const platform = kind.startsWith('gemini-') ? 'gemini' as const : 'chatgpt' as const
  const driverId = 'fake-driver' as ResearchDriverId
  const target = { workspace: 'fixture', page: 'original-page', conversation: null }
  const selection = { model: 'fake', mode: 'fake-research', effort: { kind: 'not-requested' as const }, tools: [] }
  const policy: ResearchHostPolicy = { version: 'policy', judgmentChannel: 'human', ownerId: 'owner' as ResearchOwnerId,
    workspace: target.workspace, sourceConfigurationSha256s: ['sources'], destinations: [{ bindingSha256: 'dest', target }],
    drivers: [{ id: driverId, platform, selection }], inputMaxBytes: 10000 }
  const control = ctx.researchHandoff.bindHost(ctx, policy).control
  const run = control.create('run' as ResearchRunId, { questionSha256: 'question', sourcesSha256: 'sources',
    destinationSha256: 'dest', modeSha256: control.modeFingerprint(driverId), plan: null })
  control.confirm(run.runId, run.revision, run.bindingSha256)
  const request: ResearchActionRequest = { runId: run.runId, actionId: 'original' as ResearchActionId,
    stepId: 'original-step' as ResearchStepId, revision: run.revision, bindingSha256: run.bindingSha256, binding: run.binding,
    driverId, selection, kind, target, input: '\uFEFF完整原文😀 $&\n尾部\n', preparedPromptId: null }
  const resource = { ...target, report: null, evidence: 'fake original resource correlation' }
  const delivery: ResearchDriverDelivery = { kind: kind === 'chatgpt-upload' ? 'attachment' : 'message',
    externalId: 'original-external-id' as ResearchExternalDeliveryId, observedAt: '2026-10-18T00:00:00.000Z',
    evidence: 'fake normal interface identity observation',
    readBack: { kind: 'complete-text', text: request.input, evidence: 'fake full text read-back, including final newline' } }
  const qualify = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverQualification> => ({ status: 'available',
    requestSha256: input.requestSha256, target: input.request.target, selection, effort: { kind: 'not_observed' },
    inputMaxBytes: 10000, evidence: 'fake actual controls' }))
  const execute = vi.fn(async (input: ResearchDriverRequest, _signal: AbortSignal, guard: () => void): Promise<ResearchDriverReceipt> => {
    guard()
    return { state: 'accepted', receipt: 'fake accepted', acceptedResource: resource, requestSha256: input.requestSha256,
      target: input.request.target, delivery }
  })
  const observe = vi.fn(async (input: ResearchDriverRequest): Promise<ResearchDriverReceipt> => ({
    state: 'completed', receipt: 'fake completed', acceptedResource: input.acceptedResource, requestSha256: input.requestSha256,
    target: input.request.target, delivery }))
  ctx.researchHandoff.registerDriver(ctx, { id: driverId, platform, qualify, execute, observe })
  const records = () => control.readDeliveryRecords(run.runId, request.actionId)
  return { ctx, filename, policy, control, request, resource, delivery, qualify, execute, observe, records }
}

describe('actual Driver delivery observations after independent action acceptance', () => {
  it.each(['gemini-plan-submit', 'chatgpt-upload', 'chatgpt-submit'] as const)('records exact complete UTF-8 for %s and reopens it', async (kind) => {
    const f = await setup(kind)
    await f.control.execute(f.request)
    const [record] = f.records()
    expect(record).toMatchObject({ contentStatus: 'matched', observation: f.delivery, resource: f.resource })
    expect(record?.requestSha256).toBe(f.control.readAction(f.request.runId, f.request.actionId).inputSha256)
    const reopened = new ResearchActionStore(f.filename)
    try { expect(reopened.deliveries.read(f.policy.ownerId, f.request.runId, f.request.actionId)).toEqual(f.records()) }
    finally { reopened.close() }
  })

  it('keeps missing delivery absent rather than inventing receipt or non-receipt', async () => {
    const f = await setup()
    const execute = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (...args) => { const { delivery: _, ...receipt } = await execute(...args); return receipt })
    await f.control.execute(f.request)
    expect(f.records()).toEqual([])
  })

  it.each(['unavailable', 'partial-text'] as const)('does not infer a full match from %s', async (kind) => {
    const f = await setup()
    Object.assign(f.delivery, { readBack: kind === 'unavailable' ? { kind, reason: 'only filename visible' }
      : { kind, text: f.request.input, evidence: 'only preview extent observed' } })
    await f.control.execute(f.request)
    expect(f.records()[0]?.contentStatus).toBe('not-read-back')
  })

  it('keeps exact mismatched and later matched read-backs as separate evidence', async () => {
    const f = await setup()
    Object.assign(f.delivery, { readBack: { kind: 'complete-text', text: f.request.input.trim(), evidence: 'fake complete different text' } })
    await f.control.execute(f.request)
    expect(f.records()[0]?.contentStatus).toBe('mismatched')
    Object.assign(f.delivery, { readBack: { kind: 'complete-text', text: f.request.input, evidence: 'fake complete original text' } })
    await f.control.observe(f.request.runId, f.request.actionId)
    expect(f.records().map(x => x.contentStatus)).toEqual(['mismatched', 'matched'])
    await f.control.observe(f.request.runId, f.request.actionId)
    expect(f.records()).toHaveLength(2)
  })

  it('preserves accepted after malformed delivery and same-ID retry never executes again', async () => {
    const f = await setup()
    Object.assign(f.delivery, { readBack: { kind: 'unavailable' } })
    await expect(f.control.execute(f.request)).rejects.toMatchObject({ code: 'FORMAT' })
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('accepted')
    expect((await f.control.execute(f.request)).state).toBe('accepted')
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.records()).toEqual([])
  })

  it('preserves completed after a conflicting external ID without replacing its earlier mapping', async () => {
    const f = await setup()
    await f.control.execute(f.request)
    Object.assign(f.delivery, { externalId: 'replacement-id' })
    await expect(f.control.observe(f.request.runId, f.request.actionId)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('completed')
    expect(f.records().map(x => x.observation.externalId)).toEqual(['original-external-id'])
    await f.control.execute(f.request)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('preserves accepted when delivery SQLite insertion fails independently', async () => {
    const f = await setup()
    const db = new DatabaseSync(f.filename)
    db.exec("CREATE TRIGGER reject_delivery BEFORE INSERT ON research_deliveries BEGIN SELECT RAISE(ABORT,'fake delivery disk failure'); END")
    try {
      await expect(f.control.execute(f.request)).rejects.toThrow('fake delivery disk failure')
      expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('accepted')
      await f.control.execute(f.request)
      expect(f.execute).toHaveBeenCalledTimes(1)
      expect(f.records()).toEqual([])
      db.exec('DROP TRIGGER reject_delivery')
      await f.control.observe(f.request.runId, f.request.actionId)
      expect(f.records()).toHaveLength(1)
    } finally { db.close() }
  })

  it('adds late delivery to already completed identical action facts without changing its terminal receipt', async () => {
    const f = await setup()
    const execute = f.execute.getMockImplementation()!
    f.execute.mockImplementation(async (...args) => {
      const { delivery: _, ...receipt } = await execute(...args)
      return { ...receipt, state: 'completed', receipt: 'same terminal receipt' }
    })
    await f.control.execute(f.request)
    f.observe.mockImplementation(async input => ({ state: 'completed', receipt: 'same terminal receipt',
      acceptedResource: input.acceptedResource, requestSha256: input.requestSha256, target: input.request.target, delivery: f.delivery }))
    await f.control.observe(f.request.runId, f.request.actionId)
    expect(f.records()).toHaveLength(1)
    expect(f.control.readAction(f.request.runId, f.request.actionId).receipt).toBe('same terminal receipt')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('keeps an old null resource snapshot readable after valid identity completion', async () => {
    const f = await setup()
    await f.control.execute(f.request)
    const before = f.records()[0]
    const filled = { ...f.resource, conversation: 'assigned-conversation', report: 'assigned-report' }
    f.observe.mockImplementation(async input => ({ state: 'completed', receipt: 'fake completed',
      acceptedResource: filled, requestSha256: input.requestSha256, target: input.request.target }))
    await f.control.observe(f.request.runId, f.request.actionId)
    expect(f.records()[0]).toEqual(before)
    f.observe.mockImplementation(async input => ({ state: 'completed', receipt: 'fake completed',
      acceptedResource: { ...filled, report: 'replacement-report' }, requestSha256: input.requestSha256,
      target: input.request.target, delivery: f.delivery }))
    await expect(f.control.observe(f.request.runId, f.request.actionId)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.records()[0]).toEqual(before)
    expect(f.control.readAction(f.request.runId, f.request.actionId).acceptedResource).toEqual(filled)
  })

  it('does not use delivery to bypass a completed action receipt conflict', async () => {
    const f = await setup()
    await f.control.execute(f.request)
    await f.control.observe(f.request.runId, f.request.actionId)
    const before = f.records()
    f.observe.mockImplementation(async input => ({ state: 'accepted', receipt: 'terminal rewrite',
      acceptedResource: input.acceptedResource, requestSha256: input.requestSha256,
      target: input.request.target, delivery: { ...f.delivery, externalId: 'new-id' as typeof f.delivery.externalId } }))
    await expect(f.control.observe(f.request.runId, f.request.actionId)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(f.records()).toEqual(before)
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('completed')
  })

  it('ignores imported matching flags and never promotes a partial preview', async () => {
    const f = await setup()
    Object.assign(f.delivery, { contentStatus: 'matched', confirmed: true,
      readBack: { kind: 'partial-text', text: f.request.input, evidence: 'preview only', complete: true } })
    await f.control.execute(f.request)
    expect(f.records()[0]?.contentStatus).toBe('not-read-back')
    expect(f.records()[0]?.observation).not.toHaveProperty('confirmed')
    expect(f.records()[0]?.observation.readBack).not.toHaveProperty('complete')
  })

  it.each(['pdf', 'missing-extent', 'lossy-unicode'] as const)('refuses %s content evidence after preserving acceptance', async (variant) => {
    const f = await setup('chatgpt-upload')
    const readBack = variant === 'pdf' ? { kind: 'pdf', text: 'binary preview', evidence: 'not supported' }
      : variant === 'missing-extent' ? { text: f.request.input, evidence: 'extent missing' }
        : { kind: 'complete-text', text: '\ud800', evidence: 'lossy text' }
    Object.assign(f.delivery, { readBack })
    await expect(f.control.execute(f.request)).rejects.toMatchObject({ code: 'FORMAT' })
    expect(f.control.readAction(f.request.runId, f.request.actionId).state).toBe('accepted')
    expect(f.records()).toEqual([])
  })

  it('rejects a persisted content-status lie even when its outer digest is recomputed', async () => {
    const f = await setup()
    await f.control.execute(f.request)
    const db = new DatabaseSync(f.filename)
    try {
      const row = db.prepare('SELECT input_json FROM research_deliveries').get()!
      const packet = JSON.parse(row.input_json as string) as Record<string, unknown>
      packet.contentStatus = 'not-read-back'
      const json = JSON.stringify(packet)
      db.prepare('UPDATE research_deliveries SET input_json=?,sha256=?').run(json, hash(json))
      expect(f.records).toThrow('content status differs')
    } finally { db.close() }
  })

  it('isolates run identities and requires the current owner for retained delivery reads', async () => {
    const f = await setup()
    await f.control.execute(f.request)
    const other = f.control.create('other-run' as ResearchRunId, f.request.binding)
    f.control.confirm(other.runId, other.revision, other.bindingSha256)
    await f.control.execute({ ...f.request, runId: other.runId, binding: other.binding, bindingSha256: other.bindingSha256 })
    expect(f.control.readDeliveryRecords(other.runId, f.request.actionId)[0]?.runId).toBe(other.runId)
    expect(f.records()[0]?.runId).toBe(f.request.runId)
    const otherOwner = f.ctx.researchHandoff.bindHost(f.ctx, { ...f.policy, ownerId: 'other-owner' as ResearchOwnerId }).control
    expect(() => otherOwner.readDeliveryRecords(f.request.runId, f.request.actionId)).toThrow('owner')
    expect(f.records).toThrow('revoked')
  })

  it('leaves an unknown action without invented delivery after a lost Driver reply', async () => {
    const f = await setup()
    f.execute.mockRejectedValue(Error('fake reply lost'))
    await expect(f.control.execute(f.request)).rejects.toThrow('reply lost')
    expect(f.records()).toEqual([])
    expect((await f.control.execute(f.request)).state).toBe('unknown')
    expect(f.execute).toHaveBeenCalledTimes(1)
  })

  it('refuses schema14 without migrating or rewriting its bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'research-delivery-old-'))
    const filename = join(dir, 'old.sqlite')
    const db = new DatabaseSync(filename)
    db.exec('PRAGMA user_version=14')
    db.close()
    const before = hash(readFileSync(filename))
    try {
      expect(() => new ResearchActionStore(filename)).toThrow('unsupported research database version')
      expect(hash(readFileSync(filename))).toBe(before)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects conflicting persisted external identities even with recomputed per-row digests', async () => {
    const f = await setup()
    await f.control.execute(f.request)
    Object.assign(f.delivery, { readBack: { kind: 'unavailable', reason: 'read-back currently unavailable' } })
    await f.control.observe(f.request.runId, f.request.actionId)
    const db = new DatabaseSync(f.filename)
    try {
      const row = db.prepare('SELECT seq,input_json FROM research_deliveries ORDER BY seq DESC LIMIT 1').get()!
      const packet = JSON.parse(row.input_json as string) as { observation: { externalId: string } }
      packet.observation.externalId = 'tampered-replacement'
      const json = JSON.stringify(packet)
      db.prepare('UPDATE research_deliveries SET input_json=?,sha256=? WHERE seq=?').run(json, hash(json), Number(row.seq))
      expect(f.records).toThrow('external identity differs across history')
    } finally { db.close() }
  })
})
