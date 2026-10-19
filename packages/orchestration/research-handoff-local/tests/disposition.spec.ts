import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResearchDispositionInput, ResearchDispositionId, ResearchCounterTarget, ResearchCitationAssessment,
  ResearchJudgmentId, ResearchCitationAssessmentInput, ResearchCitationId, ResearchClaimId, ResearchDriverId,
  ResearchHostPolicy, ResearchOwnerId, ResearchRunId, ResearchSourceReaderId, ResearchSourceReadId,
  ResearchSourceCapture } from '@deepseek-ai/dsh-research-handoff/api'
import * as provider from '../src/index.ts'
import { ResearchActionStore } from '../src/action-store.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
async function setup(extent: ResearchSourceCapture['extent'] = 'full',
  completeness: ResearchSourceCapture['completeness'] = 'complete') {
  const directory = mkdtempSync(join(tmpdir(), 'research-citation-'))
  const filename = join(directory, 'private.sqlite')
  const ctx = new Context()
  await ctx.plugin(provider, { filename })
  cleanup.push(async () => { await ctx.root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  const ownerId = 'owner' as ResearchOwnerId, driverId = 'unused' as ResearchDriverId
  const readerId = 'fake-source' as ResearchSourceReaderId
  const policy: ResearchHostPolicy = { version: 'policy1', judgmentChannel: 'imported', ownerId, workspace: 'fixture',
    sourceConfigurationSha256s: ['public'], destinations: [], drivers: [{ id: driverId, platform: 'gemini',
      selection: { model: 'fake', mode: 'fake', effort: { kind: 'not-requested' }, tools: [] } }], inputMaxBytes: 10000 }
  const host = ctx.researchHandoff.bindHost(ctx, policy, { readers: [readerId],
    authorizeSourceUrl: () => ({ allowed: true, evidence: 'fake public access' }) })
  const control = host.control
  const run = control.create('run' as ResearchRunId, { questionSha256: hash('original question'), sourcesSha256: 'public',
    modeSha256: control.modeFingerprint(driverId), destinationSha256: 'unused', plan: null })
  control.confirm(run.runId, run.revision, run.bindingSha256)
  const claimId = 'claim1' as ResearchClaimId
  const claimText = '待核验关键事实'
  const inventoryInput = { expectedVersion: 0, questionSha256: run.binding.questionSha256, materials: [],
    claims: [{ id: claimId, text: claimText, critical: true, origins: [{ kind: 'question', artifactId: null,
      sha256: run.binding.questionSha256 }] }], changes: [] }
  const inventory = control.appendClaimInventory(run.runId, inventoryInput)
  const sourceText = '﻿前言\n证据😀正文\n末尾�\n'
  const sourceId = 'original-read' as ResearchSourceReadId
  ctx.researchHandoff.registerSourceReader(ctx, { id: readerId, async read(input, _signal, guard) {
    guard(input.request.requestedUrl)
    return { requestSha256: input.requestSha256, state: 'completed', resource: { id: 'original-doc', evidence: 'fake original source' },
      observedAt: new Date().toISOString(), evidence: 'fake Reader output only', capture: { finalUrl: input.request.requestedUrl,
        title: null, author: null, publishedAt: null, version: null, extent, completeness,
        limitation: completeness === 'complete' ? null : 'fake capture limitation', text: sourceText, textSha256: hash(sourceText) } }
  }, async observe() { throw Error('completed original requires no observation') } })
  const source = await control.readSource({ runId: run.runId, readId: sourceId, readerId, revision: run.revision,
    bindingSha256: run.bindingSha256, requestedUrl: 'https://source.invalid/original', sourceLabel: 'fake source', inventoryVersion: 1 })
  const quoteText = '证据😀正文'
  const byteStart = Buffer.from(sourceText).indexOf(Buffer.from(quoteText))
  const input: ResearchCitationAssessmentInput = { citationId: 'citation1' as ResearchCitationId,
    inventoryVersion: inventory.version, inventorySha256: inventory.sha256, claimId, claimTextSha256: hash(claimText),
    sourceReadId: sourceId, observationSha256: hash(JSON.stringify(source.observations[0])),
    quote: { byteStart, byteEnd: byteStart + Buffer.byteLength(quoteText), text: quoteText },
    by: 'human', relation: 'supported', rationale: 'Attributed reading of the exact retained passage, not automatic truth', respondsTo: [],
    dependency: { status: 'unknown', family: null, basis: 'No independent source-family determination' },
    authority: { kind: 'unknown', basis: 'No primary-record verification' } }
  return { ctx, filename, ownerId, policy, host, control, run, inventory, inventoryInput, source, sourceText, input }
}

function counterTarget(citation: ResearchCitationAssessment): ResearchCounterTarget {
  return { kind: 'citation', id: citation.input.citationId, inventoryVersion: citation.input.inventoryVersion,
    claimId: citation.input.claimId, claimTextSha256: citation.input.claimTextSha256, recordSha256: hash(JSON.stringify(citation)) }
}
async function readyDisposition() {
  const f = await setup()
  const counter = f.control.appendCitationAssessment(f.run.runId, { ...f.input, relation: 'contradicted' })
  const support = f.control.appendCitationAssessment(f.run.runId, { ...f.input, citationId: 'support', relation: 'supported' })
  const target = counterTarget(counter)
  const input: ResearchDispositionInput = { dispositionId: 'treatment1' as ResearchDispositionId, target,
    expectedPreviousDispositionId: null, outcome: 'retained-unresolved', by: 'human',
    rationale: 'Explicit unresolved counterevidence; fake input only', evidenceCitationIds: [], finalCorrection: null }
  return { ...f, counter, support, target, dispositionInput: input }
}

describe('exact counterevidence disposition ownership and CAS', () => {
  it('retains unresolved treatment and independent actual Host attribution without accepting completion flags', async () => {
    const f = await readyDisposition()
    const result = f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput, complete: true, resolved: true,
      attribution: { channel: 'human', ownerId: 'fabricated', hostPolicyVersion: 'fabricated' } })
    expect(result.input.outcome).toBe('retained-unresolved')
    expect(result.attribution).toEqual({ channel: 'imported', ownerId: f.ownerId, hostPolicyVersion: f.policy.version })
    expect(result).not.toHaveProperty('complete')
    expect(result).not.toHaveProperty('resolved')
    expect(f.control.readCitationAssessment(f.run.runId, f.counter.input.citationId)).toEqual(f.counter)
  })
  it('appends explained and reopened records without replacing the original counterevidence or history', async () => {
    const f = await readyDisposition()
    const first = f.control.appendCounterDisposition(f.run.runId, f.dispositionInput)
    const explained = f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput, dispositionId: 'explained',
      expectedPreviousDispositionId: first.input.dispositionId, outcome: 'explained', evidenceCitationIds: [f.support.input.citationId] })
    const reopened = f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput, dispositionId: 'reopened',
      expectedPreviousDispositionId: explained.input.dispositionId })
    expect(f.control.readCounterDispositions(f.run.runId, f.target).map(x => x.input.outcome))
      .toEqual(['retained-unresolved', 'explained', 'retained-unresolved'])
    expect(reopened.seq).toBeGreaterThan(explained.seq)
    expect(f.control.readCounterDisposition(f.run.runId, first.input.dispositionId)).toEqual(first)
    expect(f.control.readCitationAssessment(f.run.runId, f.counter.input.citationId).input.relation).toBe('contradicted')
  })
  it('does not resolve a counter by appending another supported citation', async () => {
    const f = await readyDisposition()
    f.control.appendCounterDisposition(f.run.runId, f.dispositionInput)
    f.control.appendCitationAssessment(f.run.runId, { ...f.input, citationId: 'another-support' })
    expect(f.control.readCounterDispositions(f.run.runId, f.target).at(-1)!.input.outcome).toBe('retained-unresolved')
  })
  it('enforces same-target CAS across two real SQLite connections', async () => {
    const f = await readyDisposition()
    const second = new ResearchActionStore(f.filename)
    try {
      const first = f.control.appendCounterDisposition(f.run.runId, f.dispositionInput)
      expect(() => second.dispositions.append(f.ownerId, f.run.runId, { ...f.dispositionInput, dispositionId: 'racing' },
        first.attribution)).toThrow('disposition changed')
      const next = second.dispositions.append(f.ownerId, f.run.runId, { ...f.dispositionInput,
        dispositionId: 'serialized', expectedPreviousDispositionId: first.input.dispositionId }, first.attribution)
      expect(next.seq).toBeGreaterThan(first.seq)
      expect(f.control.readCounterDispositions(f.run.runId, f.target)).toHaveLength(2)
    }
    finally { second.close() }
  })
  it('keeps immutable identity idempotent even after a later treatment and rejects content changes', async () => {
    const f = await readyDisposition()
    const first = f.control.appendCounterDisposition(f.run.runId, f.dispositionInput)
    f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput, dispositionId: 'later',
      expectedPreviousDispositionId: first.input.dispositionId })
    expect(f.control.appendCounterDisposition(f.run.runId, f.dispositionInput)).toEqual(first)
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput, rationale: 'changed' }))
      .toThrow('immutable disposition')
  })
  it.each(['recordSha256', 'claimTextSha256'] as const)('rejects altered original target %s', async (key) => {
    const f = await readyDisposition()
    const altered = { ...f.target, [key]: hash('different') }
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput, target: altered })).toThrow('original counterevidence')
    expect(() => f.control.readCounterDispositions(f.run.runId, altered)).toThrow('original counterevidence')
  })
  it('rejects wrong historical version, claim and a supported record masquerading as a counter', async () => {
    const f = await readyDisposition()
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput,
      target: { ...f.target, inventoryVersion: 2 } })).toThrow()
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput,
      target: { ...f.target, claimId: 'missing' } })).toThrow('original counterevidence')
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput,
      target: counterTarget(f.support) })).toThrow('original counterevidence')
  })
  it.each(['explained', 'corrected-in-final'] as const)('requires explicit actual citation evidence for %s', async (outcome) => {
    const f = await readyDisposition()
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput, outcome })).toThrow('requires explicit evidence')
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput, outcome,
      evidenceCitationIds: ['missing'] })).toThrow('citation not found')
    const stored = f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput, outcome,
      evidenceCitationIds: [f.support.input.citationId] })
    expect(stored.input.outcome).toBe(outcome)
    expect(stored).not.toHaveProperty('verificationComplete')
  })
  it('binds material-only unverifiable judgments to their exact original inventory text and record', async () => {
    const f = await readyDisposition()
    const judgment = f.control.appendClaimJudgment(f.run.runId, { judgmentId: 'uncertain' as ResearchJudgmentId,
      inventoryVersion: 1, claimId: f.input.claimId, by: 'model', status: 'unverifiable', rationale: 'Original material-only unknown',
      materialArtifactIds: [] })
    const target: ResearchCounterTarget = { kind: 'claim-judgment', id: judgment.judgmentId, inventoryVersion: 1,
      claimId: judgment.claimId, claimTextSha256: f.input.claimTextSha256, recordSha256: hash(JSON.stringify(judgment)) }
    const stored = f.control.appendCounterDisposition(f.run.runId, { ...f.dispositionInput, target })
    expect(stored.input.target).toEqual(target)
    expect(f.control.readCounterDispositions(f.run.runId, target)).toEqual([stored])
  })
  it('retains counterevidence and explicit treatment after a critical claim is removed with no replacement', async () => {
    const f = await readyDisposition()
    f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: 1, claims: [],
      changes: [{ kind: 'remove', from: [f.input.claimId], to: [], reason: 'Not adopted in final report' }] })
    const stored = f.control.appendCounterDisposition(f.run.runId, f.dispositionInput)
    expect(f.control.readCounterDispositions(f.run.runId, f.target)).toEqual([stored])
    expect(f.control.readCitationAssessment(f.run.runId, f.counter.input.citationId)).toEqual(f.counter)
    expect(stored.input.outcome).toBe('retained-unresolved')
  })
  it('restores exact target history across reopening without new source visits or changing attribution', async () => {
    const f = await readyDisposition()
    const first = f.control.appendCounterDisposition(f.run.runId, f.dispositionInput)
    await f.ctx.root.fiber.dispose()
    const reopened = new ResearchActionStore(f.filename)
    try { expect(reopened.dispositions.readTarget(f.ownerId, f.run.runId, f.target)).toEqual([first]) }
    finally { reopened.close() }
  })
  it('refuses another owner and revoked Host instead of treating imported identity as permission', async () => {
    const f = await readyDisposition()
    const first = f.control.appendCounterDisposition(f.run.runId, f.dispositionInput)
    await f.host.dispose()
    expect(() => f.control.readCounterDisposition(f.run.runId, first.input.dispositionId)).toThrow('revoked')
    const other = f.ctx.researchHandoff.bindHost(f.ctx, { ...f.policy, ownerId: 'other' as ResearchOwnerId }).control
    expect(() => other.appendCounterDisposition(f.run.runId, f.dispositionInput)).toThrow()
    expect(() => other.readCounterDispositions(f.run.runId, f.target)).toThrow()
  })
  it('rejects damaged durable history and private schema10 without silently migrating', async () => {
    const f = await readyDisposition()
    const first = f.control.appendCounterDisposition(f.run.runId, f.dispositionInput)
    const db = new DatabaseSync(f.filename)
    db.prepare('UPDATE research_dispositions SET target_key=?').run('different-target')
    expect(() => f.control.readCounterDisposition(f.run.runId, first.input.dispositionId)).toThrow('digest or identity')
    db.close()
    const oldName = f.filename + '-old10'
    const old = new DatabaseSync(oldName); old.exec('PRAGMA user_version=10'); old.close()
    try { expect(() => new ResearchActionStore(oldName)).toThrow('unsupported research database') }
    finally { rmSync(oldName, { force: true }) }
  })
})
