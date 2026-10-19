import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { ResearchFinalMapInput, ResearchFinalMapId, ResearchFinalItem, ResearchRetiredFinalItem, ResearchArtifactId,
  ResearchActionId, ResearchStepId, ResearchCitationAssessmentInput, ResearchCitationId, ResearchClaimId, ResearchDriverId,
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


async function readyMap() {
  const f = await setup()
  const store = new ResearchActionStore(f.filename)
  cleanup.push(async () => { store.close() })
  const finalText = '﻿最终：待核验关键事实😀\n修订：撤回旧结论\n尾部\n'
  const reports = []
  for (const platform of ['gemini', 'chatgpt'] as const) {
    const actionId = (platform + '-action') as ResearchActionId
    await store.execute(f.ownerId, { runId: f.run.runId, actionId, stepId: (platform + '-step') as ResearchStepId,
      revision: f.run.revision, bindingSha256: f.run.bindingSha256, binding: f.run.binding,
      driverId: 'unused' as ResearchDriverId, selection: f.policy.drivers[0]!.selection,
      kind: platform === 'gemini' ? 'gemini-research-start' : 'chatgpt-submit', preparedPromptId: null,
      input: 'Full fake question and material; no website submission',
      target: { workspace: 'fixture', page: platform, conversation: platform + '-conversation' } }, async () => ({
      state: 'completed', receipt: 'fake transport only', acceptedResource: { workspace: 'fixture', page: platform,
        conversation: platform + '-conversation', report: null, evidence: 'explicit fake acceptance' } }))
    reports.push(store.captureArtifact(f.ownerId, f.run.runId, { artifactId: (platform + '-v1') as ResearchArtifactId,
      actionId, role: platform === 'gemini' ? 'gemini-report' : 'chatgpt-report', expectedVersion: 0,
      source: { page: platform, conversation: platform + '-conversation', method: 'manual-import',
        capturedAt: '2026-10-17T20:00:00Z', extent: 'complete', endEvidence: 'fake capture end' },
      bytes: Buffer.from(platform === 'chatgpt' ? finalText : 'original fake first-stage report') }))
  }
  const [gemini, chatgpt] = reports
  const inventoryInput = { ...f.inventoryInput, expectedVersion: 1,
    materials: reports.map(x => ({ artifactId: x.artifactId, sha256: x.sha256 })) }
  const inventory = f.control.appendClaimInventory(f.run.runId, inventoryInput)
  const citation = f.control.appendCitationAssessment(f.run.runId, { ...f.input, inventoryVersion: inventory.version,
    inventorySha256: inventory.sha256 })
  const location = { byteStart: 0, byteEnd: Buffer.byteLength(finalText), text: finalText }
  const item: ResearchFinalItem = { claimId: f.input.claimId, claimTextSha256: f.input.claimTextSha256,
    kind: 'adopted-fact', location, citationIds: [citation.input.citationId], dependencies: [], limitations: ['fake evidence only'],
    applicability: 'fixture scope only', sourceAssessment: 'attributed single fake source; no independence determination', hypothesis: null,
    counterCheck: { scope: 'listed fake original material only', questions: ['Could original material contradict this candidate?'],
      citationIds: [citation.input.citationId], unfinished: ['Actual targeted website search not performed'] } }
  const input: ResearchFinalMapInput = { finalMapId: 'map1' as ResearchFinalMapId, expectedPreviousFinalMapId: null,
    revision: f.run.revision, questionSha256: f.run.binding.questionSha256, inventoryVersion: inventory.version,
    inventorySha256: inventory.sha256, geminiReport: { artifactId: gemini!.artifactId, version: gemini!.version, sha256: gemini!.sha256 },
    chatgptReport: { artifactId: chatgpt!.artifactId, version: chatgpt!.version, sha256: chatgpt!.sha256 },
    finalText, items: [item], retired: [], zeroCriticalFactsReason: null, by: 'human' }
  return { ...f, store, inventoryInput, inventory, gemini: gemini!, chatgpt: chatgpt!, input, item, location, finalText }
}
function confirmInventory(f: Awaited<ReturnType<typeof readyMap>>): void {
  f.control.confirmClaimInventory(f.run.runId, f.inventory.version, f.inventory.sha256)
}

describe('complete final report mapping and current Host confirmation', () => {
  it('retains full UTF8 reports and actual Host attribution without trusting imported completion flags', async () => {
    const f = await readyMap()
    const map = f.control.appendFinalMap(f.run.runId, { ...f.input, confirmed: true, complete: true, coverage: 100,
      attribution: { channel: 'human', ownerId: 'fabricated', hostPolicyVersion: 'fabricated' } })
    expect(map.input.finalText).toBe(f.finalText)
    expect(map.input.finalText.endsWith('尾部\n')).toBe(true)
    expect(map.attribution).toEqual({ channel: 'imported', ownerId: f.ownerId, hostPolicyVersion: f.policy.version })
    expect(map.recordedConfirmation).toBe(false)
    expect(map.confirmed).toBe(false)
    expect(map.input).not.toHaveProperty('confirmed')
    expect(map).not.toHaveProperty('complete')
  })
  it('requires separate exact map and denominator confirmation while retaining unfinished research limits', async () => {
    const f = await readyMap(), map = f.control.appendFinalMap(f.run.runId, f.input)
    expect(() => f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)).toThrow('confirmed denominator')
    confirmInventory(f)
    expect(() => f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, hash('wrong'))).toThrow('exact current map')
    const confirmed = f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
    expect(confirmed.confirmed).toBe(true)
    expect(confirmed.input.items[0]!.counterCheck.unfinished).toHaveLength(1)
    expect(confirmed).not.toHaveProperty('verificationComplete')
  })
  it('requires explicit applicability reasoning when there are no final critical adopted facts', async () => {
    const f = await readyMap()
    confirmInventory(f)
    const first = f.control.appendFinalMap(f.run.runId, { ...f.input,
      items: [{ ...f.item, kind: 'hypothesis', hypothesis: 'If the assumed source premise holds' }] })
    expect(() => f.control.confirmFinalMap(f.run.runId, first.input.finalMapId, first.sha256)).toThrow('zero critical facts')
    const next = f.control.appendFinalMap(f.run.runId, { ...first.input, finalMapId: 'map2', expectedPreviousFinalMapId: first.input.finalMapId,
      zeroCriticalFactsReason: 'This report states only a conditional hypothesis, not a verified factual assertion' })
    expect(f.control.confirmFinalMap(f.run.runId, next.input.finalMapId, next.sha256).confirmed).toBe(true)
  })
  it.each(['missing', 'duplicate', 'unknown'] as const)('rejects %s current candidate mappings', async (variant) => {
    const f = await readyMap()
    const items = variant === 'missing' ? [] : variant === 'duplicate' ? [f.item, f.item] : [{ ...f.item, claimId: 'unknown' }]
    expect(() => f.control.appendFinalMap(f.run.runId, { ...f.input, items }))
      .toThrow(variant === 'unknown' ? 'claim text conflicts' : 'candidate')
  })
  it.each(['text', 'range', 'digest', 'surrogate'] as const)('rejects altered final UTF8 association %s', async (variant) => {
    const f = await readyMap()
    const altered = variant === 'text' ? { ...f.input, finalText: f.finalText + 'extra' }
      : variant === 'digest' ? { ...f.input, items: [{ ...f.item, claimTextSha256: hash('another') }] }
        : variant === 'surrogate' ? { ...f.input, items: [{ ...f.item, location: { ...f.location, text: '\ud800' } }] }
          : { ...f.input, items: [{ ...f.item, location: { byteStart: 1, byteEnd: 2, text: '�' } }] }
    expect(() => f.control.appendFinalMap(f.run.runId, altered)).toThrow()
  })
  it('rejects missing and cyclic dependency mappings for recommendations as well as inferences', async () => {
    const f = await readyMap()
    expect(() => f.control.appendFinalMap(f.run.runId, { ...f.input,
      items: [{ ...f.item, kind: 'recommendation', dependencies: ['missing'] }] })).toThrow('no mapped candidate')
    expect(() => f.control.appendFinalMap(f.run.runId, { ...f.input,
      items: [{ ...f.item, kind: 'recommendation', dependencies: [f.item.claimId] }] })).toThrow('cycle')
  })
  it('invalidates current confirmation after any newer report, preserving the old exact mapping', async () => {
    const f = await readyMap(); confirmInventory(f)
    const map = f.control.appendFinalMap(f.run.runId, f.input)
    f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
    f.store.captureArtifact(f.ownerId, f.run.runId, { artifactId: 'chatgpt-v2' as ResearchArtifactId, actionId: f.chatgpt.actionId,
      role: 'chatgpt-report', expectedVersion: 1, source: { ...f.chatgpt.source, extent: 'partial', endEvidence: null },
      bytes: Buffer.from('new incomplete report') })
    const old = f.control.readFinalMap(f.run.runId, map.input.finalMapId)
    expect(old.recordedConfirmation).toBe(true)
    expect(old.isCurrent).toBe(false)
    expect(old.confirmed).toBe(false)
    expect(old.input.finalText).toBe(f.finalText)
    expect(() => f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)).toThrow('exact current')
    expect(() => f.control.appendFinalMap(f.run.runId, { ...f.input, finalMapId: 'stale',
      expectedPreviousFinalMapId: map.input.finalMapId })).toThrow('latest two-stage')
  })
  it('invalidates old confirmations on run revisions and inventory changes', async () => {
    const f = await readyMap(); confirmInventory(f)
    const map = f.control.appendFinalMap(f.run.runId, f.input)
    f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
    f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: f.inventory.version })
    expect(f.control.readFinalMap(f.run.runId, map.input.finalMapId).confirmed).toBe(false)
    f.control.revise(f.run.runId, f.run.revision, f.run.binding)
    expect(f.control.readFinalMap(f.run.runId, map.input.finalMapId).isCurrent).toBe(false)
  })
  it('serializes map CAS and preserves old idempotent requests across two SQLite connections', async () => {
    const f = await readyMap(); confirmInventory(f)
    const map = f.control.appendFinalMap(f.run.runId, f.input)
    f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
    const second = new ResearchActionStore(f.filename)
    try {
      expect(() => second.finalMaps.append(f.ownerId, f.run.runId, { ...f.input, finalMapId: 'race' }, map.attribution)).toThrow('map changed')
      second.finalMaps.append(f.ownerId, f.run.runId, { ...f.input, finalMapId: 'map2',
        expectedPreviousFinalMapId: map.input.finalMapId }, map.attribution)
      const old = f.control.appendFinalMap(f.run.runId, f.input)
      expect(old.seq).toBe(map.seq)
      expect(old.recordedConfirmation).toBe(true)
      expect(old.confirmed).toBe(false)
      expect(() => f.control.appendFinalMap(f.run.runId, { ...f.input, finalText: 'changed' })).toThrow()
    }
    finally { second.close() }
  })
  it('refuses wrong report identity and unavailable source assessments', async () => {
    const f = await readyMap()
    expect(() => f.control.appendFinalMap(f.run.runId, { ...f.input, geminiReport: f.input.chatgptReport })).toThrow('report identity')
    expect(() => f.control.appendFinalMap(f.run.runId, { ...f.input,
      items: [{ ...f.item, citationIds: ['missing'] }] })).toThrow('citation not found')
    expect(() => f.control.appendFinalMap(f.run.runId, { ...f.input,
      items: [{ ...f.item, counterCheck: { ...f.item.counterCheck, citationIds: ['missing'] } }] })).toThrow('citation not found')
  })
  it('rejects owner/run substitution and revoked current Host access', async () => {
    const f = await readyMap(), map = f.control.appendFinalMap(f.run.runId, f.input)
    const anotherRun = f.control.create('another-run' as ResearchRunId, f.run.binding)
    expect(() => f.control.readFinalMap(anotherRun.runId, map.input.finalMapId)).toThrow('not found')
    expect(() => f.control.appendFinalMap(anotherRun.runId, f.input)).toThrow('not found')
    expect(() => f.store.finalMaps.read('other' as ResearchOwnerId, f.run.runId, map.input.finalMapId)).toThrow('another owner')
    await f.host.dispose()
    expect(() => f.control.readFinalMap(f.run.runId, map.input.finalMapId)).toThrow('revoked')
    expect(() => f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)).toThrow('revoked')
  })
  it('preserves confirmed original bytes and identities on reopening the database', async () => {
    const f = await readyMap(); confirmInventory(f)
    const map = f.control.appendFinalMap(f.run.runId, f.input)
    const confirmed = f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
    const second = new ResearchActionStore(f.filename)
    try { expect(second.finalMaps.read(f.ownerId, f.run.runId, map.input.finalMapId)).toEqual(confirmed) }
    finally { second.close() }
  })
  it.each(['input', 'attribution', 'confirmation'] as const)('refuses durable %s corruption', async (column) => {
    const f = await readyMap(); confirmInventory(f)
    const map = f.control.appendFinalMap(f.run.runId, f.input)
    f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
    const db = new DatabaseSync(f.filename)
    try { db.prepare('UPDATE research_final_maps SET ' + column + '_json=?').run('{}') }
    finally { db.close() }
    expect(() => f.control.readFinalMap(f.run.runId, map.input.finalMapId)).toThrow('damaged')
  })
  it('refuses the previous private format instead of silently migrating', async () => {
    const f = await readyMap(), db = new DatabaseSync(f.filename)
    try { db.exec('PRAGMA user_version=12') } finally { db.close() }
    expect(() => new ResearchActionStore(f.filename)).toThrow('unsupported research database')
  })
  it('retains removed critical ancestors with exact final revision locations and no fabricated replacement support', async () => {
    const f = await readyMap()
    const counter = f.control.appendCitationAssessment(f.run.runId, { ...f.control.readCitationAssessment(f.run.runId,
      f.item.citationIds[0]!).input, citationId: 'counter', relation: 'unverifiable' })
    const target = { kind: 'citation' as const, id: counter.input.citationId, inventoryVersion: counter.input.inventoryVersion,
      claimId: counter.input.claimId, claimTextSha256: counter.input.claimTextSha256, recordSha256: hash(JSON.stringify(counter)) }
    const disposition = f.control.appendCounterDisposition(f.run.runId, { dispositionId: 'unresolved', target,
      expectedPreviousDispositionId: null, outcome: 'retained-unresolved', by: 'human', rationale: 'Removed uncertain original claim',
      evidenceCitationIds: [], finalCorrection: null })
    const current = f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: f.inventory.version,
      claims: [], changes: [{ kind: 'remove', from: [f.item.claimId], to: [], reason: 'Not adopted in the final report' }] })
    const retired: ResearchRetiredFinalItem = { inventoryVersion: f.inventory.version, claimId: f.item.claimId,
      claimTextSha256: f.item.claimTextSha256, changeVersion: current.version, kind: 'removed', replacementIds: [],
      reason: 'The old proposition is withdrawn, not proved true', location: f.location, dispositionIds: [disposition.input.dispositionId] }
    const input = { ...f.input, inventoryVersion: current.version, inventorySha256: current.sha256, items: [], retired: [retired],
      zeroCriticalFactsReason: 'Only the withdrawal is reported; no factual adoption' }
    expect(() => f.control.appendFinalMap(f.run.runId, { ...input, retired: [] })).toThrow('historical critical')
    expect(() => f.control.appendFinalMap(f.run.runId, { ...input, retired: [{ ...retired, location: null }] }))
      .toThrow('critical candidate needs a final revision location')
    expect(() => f.control.appendFinalMap(f.run.runId, { ...input, retired: [{ ...retired, replacementIds: ['fabricated'] }] }))
      .toThrow('replacements differ')
    const map = f.control.appendFinalMap(f.run.runId, input)
    expect(map.input.retired[0]!.replacementIds).toEqual([])
    expect(map.input.retired[0]!.dispositionIds).toEqual([disposition.input.dispositionId])
    expect(map).not.toHaveProperty('complete')
    expect(f.control.readCounterDisposition(f.run.runId, disposition.input.dispositionId).input.outcome).toBe('retained-unresolved')
  })
  it('maps corrected historical text through actual lineage without reusing support for the old text', async () => {
    const f = await readyMap()
    const correctedClaim = { ...f.inventoryInput.claims[0]!, text: '修正后的候选' }
    const current = f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: f.inventory.version,
      claims: [correctedClaim], changes: [{ kind: 'revise', from: [f.item.claimId], to: [f.item.claimId], reason: 'Correct old wording' }] })
    const retired: ResearchRetiredFinalItem = { inventoryVersion: f.inventory.version, claimId: f.item.claimId,
      claimTextSha256: f.item.claimTextSha256, changeVersion: current.version, kind: 'corrected', replacementIds: [f.item.claimId],
      reason: 'Withdraw and replace original wording', location: f.location, dispositionIds: [] }
    const item = { ...f.item, claimTextSha256: hash(correctedClaim.text) }
    const input = { ...f.input, inventoryVersion: current.version, inventorySha256: current.sha256, items: [item], retired: [retired] }
    expect(() => f.control.appendFinalMap(f.run.runId, input)).toThrow('current exact claim')
    const stored = f.control.appendFinalMap(f.run.runId, { ...input, items: [{ ...item, citationIds: [] }] })
    expect(stored.input.retired[0]!.kind).toBe('corrected')
    expect(stored.confirmed).toBe(false)
  })
})

async function readyRetiredCorrection() {
  const f = await readyMap()
  const judgment = f.control.appendClaimJudgment(f.run.runId, { judgmentId: 'old-unknown', inventoryVersion: f.inventory.version,
    claimId: f.item.claimId, by: 'model', status: 'unverifiable', rationale: 'Material-only uncertainty, not source verification',
    materialArtifactIds: [f.gemini.artifactId] })
  const target = { kind: 'claim-judgment' as const, id: judgment.judgmentId, inventoryVersion: judgment.inventoryVersion,
    claimId: judgment.claimId, claimTextSha256: f.item.claimTextSha256, recordSha256: hash(JSON.stringify(judgment)) }
  const inventory = f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: f.inventory.version,
    claims: [], changes: [{ kind: 'remove', from: [f.item.claimId], to: [], reason: 'Withdraw the uncertain proposition' }] })
  f.control.confirmClaimInventory(f.run.runId, inventory.version, inventory.sha256)
  const retired: ResearchRetiredFinalItem = { inventoryVersion: f.inventory.version, claimId: f.item.claimId,
    claimTextSha256: f.item.claimTextSha256, changeVersion: inventory.version, kind: 'removed', replacementIds: [],
    reason: 'Explicitly withdrawn rather than adopted as true', location: f.location, dispositionIds: [] }
  const mapInput = { ...f.input, inventoryVersion: inventory.version, inventorySha256: inventory.sha256, items: [], retired: [retired],
    zeroCriticalFactsReason: 'Only a withdrawal is reported in this fixture; no factual adoption' }
  const map = f.control.appendFinalMap(f.run.runId, mapInput)
  const input = { dispositionId: 'withdrawal', target, expectedPreviousDispositionId: null, outcome: 'corrected-in-final',
    by: 'human', rationale: 'Precise final report withdraws this original material-only assertion', evidenceCitationIds: [],
    finalCorrection: { finalMapId: map.input.finalMapId, mapSha256: map.sha256 } }
  return { ...f, retiredInventory: inventory, retired, map, mapInput, judgment, target, correctionInput: input }
}

describe('exact final-report withdrawal evidence for original counterevidence', () => {
  it('records withdrawal after confirming the existing map without inventing a Citation or successor map', async () => {
    const f = await readyRetiredCorrection()
    f.control.confirmFinalMap(f.run.runId, f.map.input.finalMapId, f.map.sha256)
    const corrected = f.control.appendCounterDisposition(f.run.runId, f.correctionInput)
    expect(corrected.input.evidenceCitationIds).toEqual([])
    expect(corrected.input.finalCorrection).toEqual(f.correctionInput.finalCorrection)
    expect(f.control.readFinalMap(f.run.runId, f.map.input.finalMapId).input.retired[0]!.dispositionIds).toEqual([])
    expect(f.control.readCounterDispositions(f.run.runId, f.target).at(-1)).toEqual(corrected)
    expect(corrected).not.toHaveProperty('complete')
  })
  it('refuses unconfirmed, future and incorrectly bound maps without appending a treatment', async () => {
    const f = await readyRetiredCorrection()
    expect(() => f.control.appendCounterDisposition(f.run.runId, f.correctionInput)).toThrow('confirmed current mapping')
    f.control.confirmFinalMap(f.run.runId, f.map.input.finalMapId, f.map.sha256)
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.correctionInput,
      finalCorrection: { ...f.correctionInput.finalCorrection, mapSha256: hash('wrong') } })).toThrow('exact retired target')
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.correctionInput,
      finalCorrection: { ...f.correctionInput.finalCorrection, finalMapId: 'future' } })).toThrow('map not found')
    expect(f.control.readCounterDispositions(f.run.runId, f.target)).toEqual([])
  })
  it('does not let another historical inventory with identical text borrow a retirement explanation', async () => {
    const f = await readyRetiredCorrection()
    f.control.confirmFinalMap(f.run.runId, f.map.input.finalMapId, f.map.sha256)
    const earlier = f.control.appendClaimJudgment(f.run.runId, { ...f.judgment, judgmentId: 'earlier-unknown', inventoryVersion: 1 })
    const target = { ...f.target, id: earlier.judgmentId, inventoryVersion: 1, recordSha256: hash(JSON.stringify(earlier)) }
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.correctionInput, target })).toThrow('exact retired target')
  })
  it.each(['explained', 'retained-unresolved'] as const)('refuses finalCorrection as a substitute basis for %s', async (outcome) => {
    const f = await readyRetiredCorrection()
    f.control.confirmFinalMap(f.run.runId, f.map.input.finalMapId, f.map.sha256)
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.correctionInput, outcome })).toThrow('explicit evidence')
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.correctionInput, finalCorrection: null,
      outcome: 'explained' })).toThrow('explicit evidence')
  })
  it('retains historical correction reads after a successor map and uses a new CAS treatment for its current identity', async () => {
    const f = await readyRetiredCorrection()
    f.control.confirmFinalMap(f.run.runId, f.map.input.finalMapId, f.map.sha256)
    const first = f.control.appendCounterDisposition(f.run.runId, f.correctionInput)
    const next = f.control.appendFinalMap(f.run.runId, { ...f.mapInput, finalMapId: 'map2', expectedPreviousFinalMapId: f.map.input.finalMapId,
      retired: [{ ...f.retired, dispositionIds: [first.input.dispositionId] }] })
    f.control.confirmFinalMap(f.run.runId, next.input.finalMapId, next.sha256)
    expect(f.control.readCounterDisposition(f.run.runId, first.input.dispositionId)).toEqual(first)
    expect(f.control.appendCounterDisposition(f.run.runId, f.correctionInput)).toEqual(first)
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.correctionInput, dispositionId: 'new-stale',
      expectedPreviousDispositionId: first.input.dispositionId })).toThrow('confirmed current mapping')
    const corrected = f.control.appendCounterDisposition(f.run.runId, { ...f.correctionInput, dispositionId: 'new-current',
      expectedPreviousDispositionId: first.input.dispositionId,
      finalCorrection: { finalMapId: next.input.finalMapId, mapSha256: next.sha256 } })
    expect(corrected.input.finalCorrection!.finalMapId).toBe(next.input.finalMapId)
    expect(f.control.readFinalMap(f.run.runId, next.input.finalMapId).input.retired[0]!.dispositionIds)
      .toEqual([first.input.dispositionId])
  })
  it('refuses stale report evidence without falling back to an unrelated Citation', async () => {
    const f = await readyRetiredCorrection()
    f.control.confirmFinalMap(f.run.runId, f.map.input.finalMapId, f.map.sha256)
    const first = f.control.appendCounterDisposition(f.run.runId, f.correctionInput)
    f.store.captureArtifact(f.ownerId, f.run.runId, { artifactId: 'new-report' as ResearchArtifactId, actionId: f.gemini.actionId,
      role: 'gemini-report', expectedVersion: 1, source: f.gemini.source, bytes: Buffer.from('new complete first-stage report') })
    expect(f.control.readCounterDisposition(f.run.runId, first.input.dispositionId)).toEqual(first)
    expect(() => f.control.appendCounterDisposition(f.run.runId, { ...f.correctionInput, dispositionId: 'stale-with-Citation',
      expectedPreviousDispositionId: first.input.dispositionId, evidenceCitationIds: f.item.citationIds })).toThrow('confirmed current mapping')
  })
  it('does not close withdrawal when the same original text remains an adopted fact under another ID', async () => {
    const f = await readyMap()
    const judgment = f.control.appendClaimJudgment(f.run.runId, { judgmentId: 'old-unknown', inventoryVersion: f.inventory.version,
      claimId: f.item.claimId, by: 'human', status: 'unverifiable', rationale: 'Material-only unknown', materialArtifactIds: [] })
    const alias = { ...f.inventoryInput.claims[0]!, id: 'renamed' as ResearchClaimId }
    const inventory = f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: f.inventory.version,
      claims: [alias], changes: [{ kind: 'revise', from: [f.item.claimId], to: [alias.id], reason: 'Rename without changing original text' }] })
    f.control.confirmClaimInventory(f.run.runId, inventory.version, inventory.sha256)
    const map = f.control.appendFinalMap(f.run.runId, { ...f.input, inventoryVersion: inventory.version, inventorySha256: inventory.sha256,
      items: [{ ...f.item, claimId: alias.id, citationIds: [] }], retired: [{ inventoryVersion: f.inventory.version,
        claimId: f.item.claimId, claimTextSha256: f.item.claimTextSha256, changeVersion: inventory.version, kind: 'corrected',
        replacementIds: [alias.id], reason: 'Original renamed', location: f.location, dispositionIds: [] }] })
    f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
    const target = { kind: 'claim-judgment', id: judgment.judgmentId, inventoryVersion: judgment.inventoryVersion,
      claimId: judgment.claimId, claimTextSha256: f.item.claimTextSha256, recordSha256: hash(JSON.stringify(judgment)) }
    expect(() => f.control.appendCounterDisposition(f.run.runId, { dispositionId: 'invalid-withdrawal', target,
      expectedPreviousDispositionId: null, outcome: 'corrected-in-final', by: 'human', rationale: 'Pretend withdrawn',
      evidenceCitationIds: [], finalCorrection: { finalMapId: map.input.finalMapId, mapSha256: map.sha256 } })).toThrow('exact retired target')
  })
})
