import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResearchDriverId, ResearchHostPolicy, ResearchOwnerId, ResearchRunId, ResearchSourceAccess,
  ResearchSourceReader, ResearchSourceReaderId, ResearchSourceReadId, ResearchSourceReaderInput,
  ResearchSourceReadRequest, ResearchSourceObservation } from '@deepseek-ai/dsh-research-handoff/api'
import * as provider from '../src/index.ts'
import { ResearchActionStore } from '../src/action-store.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const readerId = 'fake-reader' as ResearchSourceReaderId
const url = 'https://source.invalid/original?version=1'
function observed(input: ResearchSourceReaderInput, state: ResearchSourceObservation['state'] = 'completed',
  finalUrl = url): ResearchSourceObservation {
  const accepted = state === 'accepted' || state === 'completed'
  const text = '﻿完整原文😀\n末尾\n'
  return { requestSha256: input.requestSha256, state, resource: accepted ? { id: 'original-doc', evidence: 'fake original resource' } : null,
    capture: state === 'completed' ? { finalUrl, title: null, author: 'fake institution', publishedAt: null, version: 'v1',
      extent: 'full', text, textSha256: hash(text), completeness: 'complete', limitation: null } : null,
    observedAt: new Date().toISOString(), evidence: 'fake actual Reader reply; no website access' }
}
async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'research-source-'))
  const filename = join(directory, 'private.sqlite')
  const ctx = new Context()
  await ctx.plugin(provider, { filename })
  cleanup.push(async () => { await ctx.root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const ownerId = 'owner' as ResearchOwnerId
  const driverId = 'unused-research-driver' as ResearchDriverId
  const policy: ResearchHostPolicy = { version: 'fake-current-1', judgmentChannel: 'imported', ownerId, workspace: 'fixture',
    sourceConfigurationSha256s: ['public-v1'], destinations: [], drivers: [{ id: driverId, platform: 'gemini',
      selection: { model: 'fake', mode: 'fake', effort: { kind: 'not-requested' }, tools: [] } }], inputMaxBytes: 10000 }
  const visits: string[] = []
  const access: ResearchSourceAccess = { readers: [readerId],
    authorizeSourceUrl: vi.fn((_request: ResearchSourceReadRequest, actualUrl: string) => ({ allowed: actualUrl.startsWith('https://source.invalid/'),
      evidence: 'fake current public-source policy' })) }
  let registration = ctx.researchHandoff.bindHost(ctx, policy, access)
  const control = registration.control
  const run = control.create('run' as ResearchRunId, { questionSha256: 'question', sourcesSha256: 'public-v1',
    modeSha256: control.modeFingerprint(driverId), destinationSha256: 'unused', plan: null })
  control.confirm(run.runId, run.revision, run.bindingSha256)
  const request: ResearchSourceReadRequest = { runId: run.runId, readId: 'read-1' as ResearchSourceReadId,
    readerId, revision: run.revision, bindingSha256: run.bindingSha256, requestedUrl: url, sourceLabel: 'fake original', inventoryVersion: null }
  const read = vi.fn<ResearchSourceReader['read']>(async (input, _signal, guard) => {
    guard(input.request.requestedUrl)
    visits.push(input.request.requestedUrl)
    return observed(input, 'completed', input.request.requestedUrl)
  })
  const observe = vi.fn<ResearchSourceReader['observe']>(async input => observed(input))
  const reader: ResearchSourceReader = { id: readerId, read, observe }
  const disposeReader = ctx.researchHandoff.registerSourceReader(ctx, reader)
  return { ctx, filename, ownerId, policy, access, control, request, visits, read, observe, reader, disposeReader,
    registration, rebind: () => { registration = ctx.researchHandoff.bindHost(ctx, policy, access); return registration.control } }
}

describe('actual source records through current Host and fake Reader', () => {
  it('observes the original accepted resource after a new confirmed run revision without revisiting', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => { guard(url); f.visits.push(url); return observed(input, 'accepted') })
    await f.control.readSource(f.request)
    const run = f.control.inspect(f.request.runId)
    const revised = f.control.revise(run.runId, run.revision, { ...run.binding, questionSha256: 'revised-question' })
    f.control.confirm(run.runId, revised.revision, revised.bindingSha256)
    const completed = await f.control.observeSourceRead(run.runId, f.request.readId)
    expect(completed.state).toBe('completed')
    expect(completed.request.revision).toBe(f.request.revision)
    expect(completed.resource?.id).toBe('original-doc')
    expect(f.visits).toEqual([url])
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  it('still requires current source permission and Reader registration to observe the original resource', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => { guard(url); f.visits.push(url); return observed(input, 'accepted') })
    await f.control.readSource(f.request)
    const denied = f.ctx.researchHandoff.bindHost(f.ctx, f.policy, { readers: [readerId],
      authorizeSourceUrl: () => ({ allowed: false, evidence: 'current source access removed' }) }).control
    await expect(denied.observeSourceRead(f.request.runId, f.request.readId)).rejects.toThrow('not authorized')
    expect(f.observe).not.toHaveBeenCalled()
    const allowed = f.rebind()
    await f.disposeReader()
    await expect(allowed.observeSourceRead(f.request.runId, f.request.readId)).rejects.toThrow('unavailable')
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.visits).toEqual([url])
  })
  it.each([
    ['full', 'partial', 'fake extraction truncated'], ['full', 'unknown', 'completion evidence absent'],
    ['relevant-passage', 'complete', null], ['relevant-passage', 'partial', 'passage truncated'],
  ] as const)('retains %s extraction completeness %s across a SQLite reopen', async (extent, completeness, limitation) => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => { guard(url); f.visits.push(url)
      const reply = observed(input); return { ...reply, capture: { ...reply.capture!, extent, completeness, limitation } } })
    const original = await f.control.readSource(f.request)
    expect(original.observations[0]!.capture).toMatchObject({ extent, completeness, limitation })
    await f.ctx.root.fiber.dispose()
    const reopened = new ResearchActionStore(f.filename)
    try {
      const retained = reopened.sourceReads.read(f.ownerId, f.request.runId, f.request.readId)
      expect(retained.observations[0]!.capture).toEqual(original.observations[0]!.capture)
    }
    finally { reopened.close() }
  })
  it('does not default missing capture completeness to complete even when the text digest matches', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => { guard(url)
      const reply = observed(input); return { ...reply, capture: { ...reply.capture!, completeness: undefined } } })
    await expect(f.control.readSource(f.request)).rejects.toThrow('source text')
    expect(f.control.readSourceRecord(f.request.runId, f.request.readId).state).toBe('unknown')
  })
  it('rejects the superseded schema8 without silently inventing capture completeness', async () => {
    const f = await setup()
    const filename = join(f.filename + '-old8')
    const db = new DatabaseSync(filename); db.exec('PRAGMA user_version=8'); db.close()
    try { expect(() => new ResearchActionStore(filename)).toThrow('unsupported research database') }
    finally { rmSync(filename, { force: true }) }
  })
  it('retains an authorized redirect while separately checking the original and redirected target', async () => {
    const f = await setup()
    const redirect = 'https://source.invalid/original?version=2'
    f.read.mockImplementation(async (input, _signal, guard) => {
      guard(url); f.visits.push(url); await Promise.resolve(); guard(redirect); f.visits.push(redirect)
      return observed(input, 'completed', redirect)
    })
    const result = await f.control.readSource(f.request)
    expect(result.authorizedUrls).toEqual([url, redirect])
    expect(result.observations[0]!.capture!.finalUrl).toBe(redirect)
    expect(f.visits).toEqual([url, redirect])
  })
  it('keeps the unresolved fence when the selected Reader ID itself changes', async () => {
    const f = await setup()
    f.read.mockRejectedValue(Error('lost original receipt'))
    await expect(f.control.readSource(f.request)).rejects.toThrow('lost original receipt')
    const secondId = 'fake-second-reader' as ResearchSourceReaderId
    const second = vi.fn<ResearchSourceReader['read']>(async input => observed(input))
    f.ctx.researchHandoff.registerSourceReader(f.ctx, { id: secondId, read: second, observe: f.observe })
    const control = f.ctx.researchHandoff.bindHost(f.ctx, f.policy, { ...f.access, readers: [secondId] }).control
    await expect(control.readSource({ ...f.request, readId: 'second' as ResearchSourceReadId, readerId: secondId }))
      .rejects.toThrow('unresolved')
    expect(second).not.toHaveBeenCalled()
    expect(f.visits).toEqual([])
  })
  it('rechecks the revision after Reader preparation and never visits a stale target', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => {
      await Promise.resolve()
      const run = f.control.inspect(f.request.runId)
      const revised = f.control.revise(run.runId, run.revision, run.binding)
      f.control.confirm(run.runId, revised.revision, revised.bindingSha256)
      guard(url); f.visits.push(url); return observed(input)
    })
    await expect(f.control.readSource(f.request)).rejects.toThrow('admission')
    expect(f.visits).toEqual([])
  })
  it('rejects another SQLite instance attempting a new ID while the original Reader is held', async () => {
    const f = await setup()
    const held = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    f.read.mockImplementation(async (input, _signal, guard) => {
      started.resolve(undefined); await held.promise; guard(url); f.visits.push(url); return observed(input)
    })
    const first = f.control.readSource(f.request)
    await started.promise
    const second = new ResearchActionStore(f.filename)
    try { expect(() => second.sourceReads.begin(f.ownerId, { ...f.request, readId: 'second' as ResearchSourceReadId }))
      .toThrow('unresolved') }
    finally { second.close() }
    held.resolve(undefined)
    expect((await first).state).toBe('completed')
    expect(f.visits).toEqual([url])
  })
  it('drains a held Reader and retains late acceptance while closing without claiming cancellation', async () => {
    const f = await setup()
    const held = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    f.read.mockImplementation(async (input, _signal, guard) => {
      guard(url); f.visits.push(url); started.resolve(undefined); await held.promise; return observed(input, 'accepted')
    })
    const first = f.control.readSource(f.request)
    await started.promise
    let closed = false
    const close = f.ctx.root.fiber.dispose().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    held.resolve(undefined)
    expect((await first).state).toBe('accepted')
    await close
    const reopened = new ResearchActionStore(f.filename)
    try { expect(reopened.sourceReads.read(f.ownerId, f.request.runId, f.request.readId).state).toBe('accepted') }
    finally { reopened.close() }
    expect(f.visits).toEqual([url])
  })
  it('commits unknown before a reentrant Reader and retains full UTF-8 bytes without replay', async () => {
    const f = await setup()
    const original = f.read.getMockImplementation()!
    f.read.mockImplementation(async (input, signal, guard) => {
      const observer = new ResearchActionStore(f.filename)
      expect(observer.sourceReads.read(f.ownerId, input.request.runId, input.request.readId).state).toBe('unknown')
      observer.close()
      expect((await f.control.readSource(f.request)).state).toBe('unknown')
      return original(input, signal, guard)
    })
    const result = await f.control.readSource(f.request)
    expect(result.state).toBe('completed')
    expect(result.observations[0]!.capture!.text).toBe('﻿完整原文😀\n末尾\n')
    await f.control.readSource(f.request)
    expect(f.visits).toEqual([url])
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  it('rejects the same identity with conflicting input', async () => {
    const f = await setup()
    await f.control.readSource(f.request)
    await expect(f.control.readSource({ ...f.request, sourceLabel: 'different' })).rejects.toThrow('conflicts')
    expect(f.visits).toHaveLength(1)
  })
  it('fences lost receipts across new IDs, revisions and Reader changes while another URL proceeds', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => {
      guard(input.request.requestedUrl); f.visits.push(input.request.requestedUrl); throw Error('reply lost')
    })
    await expect(f.control.readSource(f.request)).rejects.toThrow('reply lost')
    await expect(f.control.readSource({ ...f.request, readId: 'read-2' as ResearchSourceReadId })).rejects.toThrow('unresolved')
    const run = f.control.inspect(f.request.runId)
    const revised = f.control.revise(run.runId, run.revision, run.binding)
    f.control.confirm(run.runId, revised.revision, revised.bindingSha256)
    const next = { ...f.request, readId: 'read-3' as ResearchSourceReadId, revision: revised.revision,
      bindingSha256: revised.bindingSha256 }
    await expect(f.control.readSource(next)).rejects.toThrow('unresolved')
    await f.disposeReader()
    f.ctx.researchHandoff.registerSourceReader(f.ctx, f.reader)
    await expect(f.control.readSource({ ...next, readId: 'read-4' as ResearchSourceReadId })).rejects.toThrow('unresolved')
    await expect(f.control.readSource({ ...next, readId: 'independent' as ResearchSourceReadId,
      requestedUrl: 'https://source.invalid/other' })).rejects.toThrow('reply lost')
    expect(f.visits).toEqual([url, 'https://source.invalid/other'])
  })
  it('keeps no-resource unknown across reopening and observes without another target visit', async () => {
    const f = await setup()
    f.read.mockRejectedValue(Error('transport unknown'))
    await expect(f.control.readSource(f.request)).rejects.toThrow('transport unknown')
    await f.ctx.root.fiber.dispose()
    const ctx = new Context()
    await ctx.plugin(provider, { filename: f.filename })
    cleanup.push(async () => { await ctx.root.fiber.dispose() })
    ctx.researchHandoff.registerSourceReader(ctx, f.reader)
    const control = ctx.researchHandoff.bindHost(ctx, f.policy, f.access).control
    expect((await control.observeSourceRead(f.request.runId, f.request.readId)).state).toBe('unknown')
    await expect(control.readSource({ ...f.request, readId: 'new' as ResearchSourceReadId })).rejects.toThrow('unresolved')
    expect(f.observe).not.toHaveBeenCalled()
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(f.visits).toEqual([])
  })
  it('refuses access after asynchronous Host revocation with zero actual visits', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => {
      await f.registration.dispose()
      guard(input.request.requestedUrl); f.visits.push(input.request.requestedUrl)
      return observed(input)
    })
    await expect(f.control.readSource(f.request)).rejects.toThrow('revoked')
    expect(f.visits).toEqual([])
    expect(f.rebind().readSourceRecord(f.request.runId, f.request.readId).state).toBe('unknown')
  })
  it('refuses a replacement Reader before the first actual visit', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => {
      await f.disposeReader(); f.ctx.researchHandoff.registerSourceReader(f.ctx, f.reader)
      guard(input.request.requestedUrl); f.visits.push(input.request.requestedUrl)
      return observed(input)
    })
    await expect(f.control.readSource(f.request)).rejects.toThrow()
    expect(f.visits).toEqual([])
  })
  it('checks each redirect before following it and never visits the unauthorized target', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => {
      guard(url); f.visits.push(url)
      await Promise.resolve()
      const redirect = 'https://private.invalid/secret'
      guard(redirect); f.visits.push(redirect)
      return observed(input, 'completed', redirect)
    })
    await expect(f.control.readSource(f.request)).rejects.toThrow('not authorized')
    expect(f.visits).toEqual([url])
    expect(f.control.readSourceRecord(f.request.runId, f.request.readId).state).toBe('unknown')
  })
  it('records a late acceptance after revocation and observes only the correlated original resource', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => {
      guard(url); f.visits.push(url); await f.registration.dispose(); return observed(input, 'accepted')
    })
    expect((await f.control.readSource(f.request)).state).toBe('accepted')
    const current = f.rebind()
    expect((await current.observeSourceRead(f.request.runId, f.request.readId)).state).toBe('completed')
    expect(f.observe.mock.calls[0]![0].resource?.id).toBe('original-doc')
    expect(f.visits).toEqual([url])
  })
  it('distinguishes a before-visit unsupported refusal from uncertainty', async () => {
    const f = await setup()
    f.read.mockImplementation(async input => ({ ...observed(input, 'not-admitted'), evidence: 'unsupported before first visit' }))
    expect((await f.control.readSource(f.request)).state).toBe('not-admitted')
    await f.control.readSource({ ...f.request, readId: 'allowed-new' as ResearchSourceReadId })
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.visits).toEqual([])
  })
  it('refuses not-admitted after an authorized visit check and does not settle unknown', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => { guard(url); return observed(input, 'not-admitted') })
    await expect(f.control.readSource(f.request)).rejects.toThrow('conflicts')
    expect(f.control.readSourceRecord(f.request.runId, f.request.readId).state).toBe('unknown')
  })
  it('rejects an accepted reply with no access guard or a mismatched original request', async () => {
    const f = await setup()
    f.read.mockImplementation(async input => observed(input, 'accepted'))
    await expect(f.control.readSource(f.request)).rejects.toThrow('conflicts')
    f.read.mockImplementation(async (input, _signal, guard) => { guard(input.request.requestedUrl)
      return { ...observed(input), requestSha256: 'wrong' } })
    await expect(f.control.readSource({ ...f.request, readId: 'other' as ResearchSourceReadId,
      requestedUrl: 'https://source.invalid/other' })).rejects.toThrow('request conflicts')
  })
  it('keeps snippet extent separate from action completion and rejects damaged UTF-8 capture digests', async () => {
    const f = await setup()
    f.read.mockImplementation(async (input, _signal, guard) => { guard(url)
      const reply = observed(input); return { ...reply, capture: { ...reply.capture!, extent: 'search-snippet' } } })
    expect((await f.control.readSource(f.request)).observations[0]!.capture!.extent).toBe('search-snippet')
    f.read.mockImplementation(async (input, _signal, guard) => { guard(url)
      const reply = observed(input); return { ...reply, capture: { ...reply.capture!, textSha256: 'damaged' } } })
    await expect(f.control.readSource({ ...f.request, readId: 'new' as ResearchSourceReadId })).rejects.toThrow('capture bytes')
  })
  it('requires the current owner even when a caller knows the source ID and digest', async () => {
    const f = await setup()
    await f.control.readSource(f.request)
    const other = f.ctx.researchHandoff.bindHost(f.ctx, { ...f.policy, ownerId: 'other' as ResearchOwnerId }, f.access).control
    expect(() => other.readSourceRecord(f.request.runId, f.request.readId)).toThrow('another owner')
  })
  it('rejects a damaged durable request and old private schema7 without migration', async () => {
    const f = await setup()
    await f.control.readSource(f.request)
    const db = new DatabaseSync(f.filename)
    db.prepare('UPDATE research_source_reads SET sha256=?').run('corrupted')
    expect(() => f.control.readSourceRecord(f.request.runId, f.request.readId)).toThrow('durable source request')
    db.close()
    const old = join(tmpdir(), 'research-old-schema-' + crypto.randomUUID() + '.sqlite')
    const oldDb = new DatabaseSync(old); oldDb.exec('PRAGMA user_version=7'); oldDb.close()
    try { expect(() => new ResearchActionStore(old)).toThrow('unsupported research database') }
    finally { rmSync(old, { force: true }) }
  })
})
