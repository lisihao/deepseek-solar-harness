import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResearchCitationAssessmentInput, ResearchCitationId, ResearchClaimId, ResearchDriverId,
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

describe('owned source-linked citation assessments', () => {
  it('refuses a lone surrogate that would otherwise encode as a legitimate replacement character', async () => {
    const f = await setup()
    const offset = Buffer.from(f.sourceText).indexOf(Buffer.from('�'))
    expect(offset).toBeGreaterThan(0)
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input,
      quote: { byteStart: offset, byteEnd: offset + 3, text: '\uD800' } })).toThrow('lossless UTF8')
    const valid = f.control.appendCitationAssessment(f.run.runId, { ...f.input,
      quote: { byteStart: offset, byteEnd: offset + 3, text: '�' } })
    expect(valid.input.quote.text).toBe('�')
  })
  it('rejects a response bound to a different claim even when both quote the same original passage', async () => {
    const f = await setup()
    const old = f.control.appendCitationAssessment(f.run.runId, f.input)
    const otherId = 'claim2' as ResearchClaimId
    const otherText = '另一待核验事实'
    const next = f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: 1,
      claims: [...f.inventoryInput.claims, { ...f.inventoryInput.claims[0]!, id: otherId, text: otherText }],
      changes: [{ kind: 'add', from: [], to: [otherId], reason: 'new external fact' }] })
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, citationId: 'other-claim-response',
      inventoryVersion: next.version, inventorySha256: next.sha256, claimId: otherId, claimTextSha256: hash(otherText),
      respondsTo: [old.input.citationId] })).toThrow('another claim')
  })
  it('does not rewrite an imported assessment as a trusted human-channel record after rebinding', async () => {
    const f = await setup()
    const original = f.control.appendCitationAssessment(f.run.runId, f.input)
    const human = f.ctx.researchHandoff.bindHost(f.ctx, { ...f.policy, judgmentChannel: 'human', version: 'policy2' }).control
    expect(() => human.appendCitationAssessment(f.run.runId, f.input)).toThrow('immutable citation')
    expect(human.readCitationAssessment(f.run.runId, f.input.citationId)).toEqual(original)
    const separate = human.appendCitationAssessment(f.run.runId, { ...f.input, citationId: 'new-human-input' })
    expect(separate.attribution).toMatchObject({ channel: 'human', hostPolicyVersion: 'policy2' })
  })
  it('retains byte-exact UTF8 quotation and separate actual Host channel across reopening', async () => {
    const f = await setup()
    const stored = f.control.appendCitationAssessment(f.run.runId, { ...f.input, confirmed: true, complete: true,
      attribution: { channel: 'human', ownerId: 'fabricated', hostPolicyVersion: 'fabricated' } })
    expect(stored.input).toEqual(f.input)
    expect(stored.attribution).toEqual({ channel: 'imported', ownerId: f.ownerId, hostPolicyVersion: f.policy.version })
    expect(stored).not.toHaveProperty('complete')
    await f.ctx.root.fiber.dispose()
    const reopened = new ResearchActionStore(f.filename)
    try { expect(reopened.citations.read(f.ownerId, f.run.runId, f.input.citationId)).toEqual(stored) }
    finally { reopened.close() }
  })
  it.each(['inventorySha256', 'claimTextSha256', 'observationSha256'] as const)('rejects mismatched %s', async (key) => {
    const f = await setup()
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, [key]: hash('other') })).toThrow()
    expect(f.control.readCitationAssessments(f.run.runId, 1)).toEqual([])
  })
  it('rejects unknown claims, missing original reads and a URL substituted for actual source identity', async () => {
    const f = await setup()
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, claimId: 'missing' })).toThrow('claim')
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, sourceReadId: 'https://source.invalid/original' }))
      .toThrow('source read not found')
  })
  it('rejects an altered short quote and byte offsets inside a multibyte codepoint', async () => {
    const f = await setup()
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, quote: { ...f.input.quote, text: 'different' } }))
      .toThrow('exact UTF8')
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input,
      quote: { ...f.input.quote, byteStart: f.input.quote.byteStart + 1 } })).toThrow('exact UTF8')
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input,
      quote: { ...f.input.quote, byteEnd: 9999 } })).toThrow('exact UTF8')
  })
  it.each(['search-snippet', 'title-only', 'unavailable', 'not_observed'] as const)('does not promote %s to actual passage evidence', async (extent) => {
    const f = await setup(extent)
    expect(() => f.control.appendCitationAssessment(f.run.runId, f.input)).toThrow('actual retained source passage')
  })
  it('retains a partial-capture interpretation without claiming complete verification', async () => {
    const f = await setup('relevant-passage', 'partial')
    const citation = f.control.appendCitationAssessment(f.run.runId, { ...f.input, relation: 'partial' })
    expect(citation.input.relation).toBe('partial')
    expect(f.control.readSourceRecord(f.run.runId, f.input.sourceReadId).observations[0]!.capture!.completeness).toBe('partial')
    expect(citation).not.toHaveProperty('verified')
  })
  it('appends supported responses without hiding a prior contradicted judgment', async () => {
    const f = await setup()
    const counter = f.control.appendCitationAssessment(f.run.runId, { ...f.input, relation: 'contradicted' })
    const response = f.control.appendCitationAssessment(f.run.runId, { ...f.input, citationId: 'response',
      respondsTo: [counter.input.citationId], rationale: 'A new attributed view does not erase the counterevidence' })
    expect(f.control.readCitationAssessments(f.run.runId, 1).map(x => x.input.relation)).toEqual(['contradicted', 'supported'])
    expect(response.seq).toBeGreaterThan(counter.seq)
    expect(response).not.toHaveProperty('resolved')
  })
  it('rejects self-responses and references to an absent assessment', async () => {
    const f = await setup()
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, respondsTo: [f.input.citationId] })).toThrow('original assessment')
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, respondsTo: ['absent'] })).toThrow('original assessment')
  })
  it('keeps immutable identity and does not repeat an unchanged assessment', async () => {
    const f = await setup()
    const first = f.control.appendCitationAssessment(f.run.runId, f.input)
    expect(f.control.appendCitationAssessment(f.run.runId, f.input)).toEqual(first)
    expect(f.control.readCitationAssessments(f.run.runId, 1)).toHaveLength(1)
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, rationale: 'changed' })).toThrow('immutable citation')
  })
  it('does not inherit old support when the inventory text changes and retains historical reads', async () => {
    const f = await setup()
    const first = f.control.appendCitationAssessment(f.run.runId, f.input)
    const updated = f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: 1,
      claims: [{ ...f.inventoryInput.claims[0]!, text: '修订后的新事实' }],
      changes: [{ kind: 'revise', from: [f.input.claimId], to: [f.input.claimId], reason: 'actual text revised' }] })
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, citationId: 'stale' })).toThrow('inventory conflicts')
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, citationId: 'wrong-text', inventoryVersion: updated.version,
      inventorySha256: updated.sha256 })).toThrow('inventory conflicts')
    expect(f.control.readCitationAssessments(f.run.runId, updated.version)).toEqual([])
    expect(f.control.readCitationAssessment(f.run.runId, f.input.citationId)).toEqual(first)
  })
  it('does not count another URL as independent support and requires a dependent family label', async () => {
    const f = await setup()
    const stored = f.control.appendCitationAssessment(f.run.runId, { ...f.input,
      dependency: { status: 'dependent', family: 'same-original-record', basis: 'Attributed copy lineage' },
      authority: { kind: 'primary-record', basis: 'Attributed unique primary record designation' } })
    expect(stored.input.dependency.status).toBe('dependent')
    expect(stored.input.authority.kind).toBe('primary-record')
    expect(stored).not.toHaveProperty('independentSupportCount')
    expect(() => f.control.appendCitationAssessment(f.run.runId, { ...f.input, citationId: 'missing-family',
      dependency: { status: 'dependent', family: null, basis: 'missing family' } })).toThrow('requires family')
  })
  it('requires the current Host and correct owner rather than imported owner or hash knowledge', async () => {
    const f = await setup()
    f.control.appendCitationAssessment(f.run.runId, f.input)
    await f.host.dispose()
    expect(() => f.control.readCitationAssessment(f.run.runId, f.input.citationId)).toThrow('revoked')
    const other = f.ctx.researchHandoff.bindHost(f.ctx, { ...f.policy, ownerId: 'other' as ResearchOwnerId }).control
    expect(() => other.appendCitationAssessment(f.run.runId, f.input)).toThrow('another owner')
    expect(() => other.readCitationAssessment(f.run.runId, f.input.citationId)).toThrow()
  })
  it('refuses a damaged durable citation and old private schema9 instead of adding defaults', async () => {
    const f = await setup()
    f.control.appendCitationAssessment(f.run.runId, f.input)
    const db = new DatabaseSync(f.filename)
    db.prepare('UPDATE research_citations SET input_json=?').run('{}')
    expect(() => f.control.readCitationAssessment(f.run.runId, f.input.citationId)).toThrow()
    db.close()
    const oldName = f.filename + '-old9'
    const old = new DatabaseSync(oldName); old.exec('PRAGMA user_version=9'); old.close()
    try { expect(() => new ResearchActionStore(oldName)).toThrow('unsupported research database') }
    finally { rmSync(oldName, { force: true }) }
  })
})
