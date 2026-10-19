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
  ResearchSourceCapture, ResearchPromptInputId, ResearchFinalDecisionId } from '@deepseek-ai/dsh-research-handoff/api'
import * as provider from '../src/index.ts'
import { ResearchActionStore } from '../src/action-store.ts'
import { readResearchPromptTemplate } from '../src/prompt.ts'

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


async function readyMap(extent: ResearchSourceCapture['extent'] = 'full',
  completeness: ResearchSourceCapture['completeness'] = 'complete') {
  const f = await setup(extent, completeness)
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
      bytes: Buffer.from(platform === 'chatgpt' ? finalText : '﻿第一阶段完整报告😀\n尾部\n') }))
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

function prepareQuestion(f: Awaited<ReturnType<typeof readyMap>>): void {
  const templateId = 'gemini-deep-research' as const
  const slots = [...readResearchPromptTemplate(templateId).text.matchAll(/<([a-z_]+)>/g)].map(match => match[1]!)
  f.control.preparePrompt(f.run.runId, { inputId: 'question-original' as ResearchPromptInputId, revision: f.run.revision,
    templateId, values: Object.fromEntries(slots.map(slot =>
      [slot, [{ kind: 'text', text: slot === 'user_question' ? 'original question' : 'explicit fake ' + slot }]])) })
}
function publish(f: Awaited<ReturnType<typeof readyMap>>, input: ResearchFinalMapInput = f.input) {
  prepareQuestion(f); confirmInventory(f)
  const map = f.control.appendFinalMap(f.run.runId, { ...input,
    items: input.items.map(item => ({ ...item, counterCheck: { ...item.counterCheck, unfinished: [] } })) })
  f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
  return map
}
function counter(f: Awaited<ReturnType<typeof readyMap>>, relation: 'contradicted' | 'unverifiable') {
  const original = f.control.readCitationAssessment(f.run.runId, 'citation1' as ResearchCitationId)
  const record = f.control.appendCitationAssessment(f.run.runId, { ...original.input, citationId: relation, relation })
  return { kind: 'citation' as const, id: record.input.citationId, inventoryVersion: record.input.inventoryVersion,
    claimId: record.input.claimId, claimTextSha256: record.input.claimTextSha256, recordSha256: hash(JSON.stringify(record)) }
}
describe('current process status and immutable historical decisions', () => {
  it('distinguishes missing original question from full reports with a missing or unconfirmed map', async () => {
    const f = await readyMap()
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('needs-input')
    prepareQuestion(f)
    const partial = f.control.readFinalStatus(f.run.runId)
    expect(partial.state).toBe('partial')
    expect(partial.issues).toContain('final-map-confirmation')
    const map = f.control.appendFinalMap(f.run.runId, f.input)
    expect(map.confirmed).toBe(false)
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
  })
  it('retains complete question, exact source observations and actual Host attribution in a computed decision', async () => {
    const f = await readyMap(); publish(f)
    const status = f.control.readFinalStatus(f.run.runId)
    expect(status.state).toBe('verified-and-synthesized')
    expect(status.basis.requiredFacts).toBe(1)
    expect(status.basis.supportedFacts).toBe(1)
    expect(status.basis.evidence.find(x => x.kind === 'prepared-question')!.json).toContain('original question')
    expect(status.basis.evidence.find(x => x.kind === 'source')!.json).toContain('证据😀正文')
    const decision = f.control.recordFinalDecision(f.run.runId, 'decision1' as ResearchFinalDecisionId)
    expect(decision.status).toEqual(status)
    expect(decision.attribution.channel).toBe('imported')
    expect(decision.isCurrent).toBe(true)
    expect(f.control.readFinalDecision(f.run.runId, decision.decisionId)).toEqual(decision)
    expect(decision.status).not.toHaveProperty('accuracy')
    expect(decision.status).not.toHaveProperty('coverage')
  })
  it.each(['contradicted', 'unverifiable'] as const)('invalidates completion after new %s without allowing later support to hide it', async (relation) => {
    const f = await readyMap(); publish(f)
    const decision = f.control.recordFinalDecision(f.run.runId, 'before-counter' as ResearchFinalDecisionId)
    const target = counter(f, relation)
    expect(f.control.readFinalStatus(f.run.runId).issues).toContain('counter-disposition')
    const original = f.control.readCitationAssessment(f.run.runId, 'citation1' as ResearchCitationId)
    f.control.appendCitationAssessment(f.run.runId, { ...original.input, citationId: 'later-support', respondsTo: [target.id] })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
    const history = f.control.readFinalDecision(f.run.runId, decision.decisionId)
    expect(history.status).toEqual(decision.status)
    expect(history.isCurrent).toBe(false)
    expect(f.control.recordFinalDecision(f.run.runId, decision.decisionId).status).toEqual(decision.status)
    const resolved = f.control.appendCounterDisposition(f.run.runId, { dispositionId: 'resolution', target,
      expectedPreviousDispositionId: null, outcome: 'explained', by: 'human', rationale: 'Attributed interpretation of exact retained evidence',
      evidenceCitationIds: [original.input.citationId], finalCorrection: null })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('verified-and-synthesized')
    f.control.appendCounterDisposition(f.run.runId, { ...resolved.input, dispositionId: 'reopened',
      expectedPreviousDispositionId: resolved.input.dispositionId, outcome: 'retained-unresolved', evidenceCitationIds: [] })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
  })
  it('retains material-only uncertainty independently of supported source citations', async () => {
    const f = await readyMap(); publish(f)
    f.control.appendClaimJudgment(f.run.runId, { judgmentId: 'material-unknown', inventoryVersion: f.inventory.version,
      claimId: f.item.claimId, by: 'model', status: 'unverifiable', rationale: 'Remaining material-only uncertainty',
      materialArtifactIds: [f.gemini.artifactId] })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
  })
  it.each(['partial', 'unknown'] as const)('refuses supported labels backed only by %s source capture', async (completeness) => {
    const f = await readyMap('relevant-passage', completeness); publish(f)
    expect(f.control.readFinalStatus(f.run.runId).issues).toContain('fact-support')
  })
  it('refuses a completed search snippet as factual support', async () => {
    await expect(readyMap('search-snippet')).rejects.toThrow('actual retained source passage')
  })
  it('keeps unfinished critical counterchecks separate from source support', async () => {
    const f = await readyMap(); prepareQuestion(f); confirmInventory(f)
    const map = f.control.appendFinalMap(f.run.runId, f.input)
    f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
    const status = f.control.readFinalStatus(f.run.runId)
    expect(status.basis.supportedFacts).toBe(1)
    expect(status.issues).toContain('counter-check')
    expect(status.limitations).toContain('Actual targeted website search not performed')
  })
  it.each(['adopted-fact', 'inference', 'recommendation', 'hypothesis'] as const)(
    'checks noncritical adopted facts in the full dependency closure of critical %s', async (kind) => {
      const f = await readyMap(); prepareQuestion(f)
      const factId = 'dependent-fact' as ResearchClaimId
      const inventory = f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: f.inventory.version,
        claims: [...f.inventoryInput.claims, { id: factId, text: 'Unverified dependent premise', critical: false,
          origins: [{ kind: 'question', artifactId: null, sha256: f.run.binding.questionSha256 }] }],
        changes: [{ kind: 'add', from: [], to: [factId], reason: 'Explicitly expose the adopted premise' }] })
      f.control.confirmClaimInventory(f.run.runId, inventory.version, inventory.sha256)
      const base = f.control.readCitationAssessment(f.run.runId, 'citation1' as ResearchCitationId)
      const citation = f.control.appendCitationAssessment(f.run.runId, { ...base.input, citationId: 'current-support',
        inventoryVersion: inventory.version, inventorySha256: inventory.sha256 })
      const check = { ...f.item.counterCheck, unfinished: [] }
      const map = f.control.appendFinalMap(f.run.runId, { ...f.input, inventoryVersion: inventory.version,
        inventorySha256: inventory.sha256, zeroCriticalFactsReason: 'Explicit conditional or derived conclusion in fake fixture',
        items: [{ ...f.item, kind, hypothesis: kind === 'hypothesis' ? 'If the adopted premise holds' : null,
          dependencies: [factId], citationIds: [citation.input.citationId], counterCheck: check },
        { ...f.item, claimId: factId, claimTextSha256: hash('Unverified dependent premise'), dependencies: [],
          citationIds: [], counterCheck: check }] })
      f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
      const status = f.control.readFinalStatus(f.run.runId)
      expect(status.basis.criticalClosure).toContain(factId)
      expect(status.issues).toContain('fact-support')
      expect(status.state).toBe('partial')
    })
  it('allows an explicitly conditional hypothesis without reporting zero facts as a percentage', async () => {
    const f = await readyMap()
    publish(f, { ...f.input, zeroCriticalFactsReason: 'Only an explicitly conditional hypothesis is adopted',
      items: [{ ...f.item, kind: 'hypothesis', hypothesis: 'If the stated premise holds' }] })
    const status = f.control.readFinalStatus(f.run.runId)
    expect(status.state).toBe('verified-and-synthesized')
    expect(status.basis.requiredFacts).toBe(0)
    expect(status).not.toHaveProperty('percentage')
  })
  it('invalidates a prior completion after a new map, report, inventory or run revision', async () => {
    const f = await readyMap(); const map = publish(f)
    const decision = f.control.recordFinalDecision(f.run.runId, 'original-decision' as ResearchFinalDecisionId)
    f.control.appendFinalMap(f.run.runId, { ...map.input, finalMapId: 'map2', expectedPreviousFinalMapId: map.input.finalMapId })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
    f.store.captureArtifact(f.ownerId, f.run.runId, { artifactId: 'new-chatgpt' as ResearchArtifactId,
      actionId: f.chatgpt.actionId, role: 'chatgpt-report', expectedVersion: 1,
      source: { ...f.chatgpt.source }, bytes: Buffer.from(f.finalText + 'new complete revision') })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
    f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: f.inventory.version })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
    f.control.revise(f.run.runId, f.run.revision, { ...f.run.binding, sourcesSha256: 'changed-source-selection' })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
    expect(f.control.readFinalDecision(f.run.runId, decision.decisionId).status).toEqual(decision.status)
  })
  it('refuses another owner and a revoked Host for current or historical reads', async () => {
    const f = await readyMap(); publish(f)
    const decision = f.control.recordFinalDecision(f.run.runId, 'private-decision' as ResearchFinalDecisionId)
    const other = f.ctx.researchHandoff.bindHost(f.ctx.extend(), { ...f.policy, ownerId: 'other' as ResearchOwnerId }).control
    expect(() => other.readFinalStatus(f.run.runId)).toThrow()
    expect(() => other.readFinalDecision(f.run.runId, decision.decisionId)).toThrow()
    await f.host.dispose()
    expect(() => f.control.readFinalStatus(f.run.runId)).toThrow()
  })
  it('persists history across reopen and refuses damaged snapshots and the prior schema', async () => {
    const f = await readyMap(); publish(f)
    const decision = f.control.recordFinalDecision(f.run.runId, 'durable-decision' as ResearchFinalDecisionId)
    const reopened = new ResearchActionStore(f.filename)
    expect(reopened.finalDecisions.read(f.ownerId, f.run.runId, decision.decisionId).status).toEqual(decision.status)
    reopened.close()
    const db = new DatabaseSync(f.filename)
    db.prepare('UPDATE research_final_decisions SET status_json=?').run('{}')
    expect(() => f.control.readFinalDecision(f.run.runId, decision.decisionId)).toThrow('damaged')
    db.exec('PRAGMA user_version=13'); db.close()
    expect(() => new ResearchActionStore(f.filename)).toThrow('unsupported')
  })
})


type EncodedReportFixture = { artifactId: ResearchArtifactId; bytes: { encoding: string; data: string } }
type MutableDecisionFixture = { sha256: string; basis: { evidence: Array<{ kind: string; json: string; sha256: string }> } }
describe('complete report bytes in immutable decision evidence', () => {
  it('reconstructs both original reports from a partial decision with no final mapping', async () => {
    const f = await readyMap(); prepareQuestion(f)
    const decision = f.control.recordFinalDecision(f.run.runId, 'partial-reports' as ResearchFinalDecisionId)
    expect(decision.status.state).toBe('partial')
    const reports = decision.status.basis.evidence.filter(x => x.kind === 'report').map(x => JSON.parse(x.json) as EncodedReportFixture)
    expect(reports).toHaveLength(2)
    for (const original of [f.gemini, f.chatgpt]) {
      const retained = reports.find(x => x.artifactId === original.artifactId)
      if (retained === undefined) throw new Error('original report missing from retained decision')
      expect(retained.bytes.encoding).toBe('base64')
      const bytes = Buffer.from(retained.bytes.data, 'base64')
      expect(bytes).toEqual(Buffer.from(original.bytes))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(original.sha256)
      expect(bytes.toString('utf8').startsWith('﻿')).toBe(true)
      expect(bytes.toString('utf8').endsWith('\n')).toBe(true)
      expect(bytes.toString('utf8')).toContain('😀')
    }
  })
  it('retains old full report bytes after a newer report invalidates historical applicability', async () => {
    const f = await readyMap(); prepareQuestion(f)
    const before = f.control.recordFinalDecision(f.run.runId, 'original-reports' as ResearchFinalDecisionId)
    f.store.captureArtifact(f.ownerId, f.run.runId, { artifactId: 'new-gemini' as ResearchArtifactId,
      actionId: f.gemini.actionId, role: 'gemini-report', expectedVersion: 1, source: { ...f.gemini.source },
      bytes: Buffer.from('﻿新版报告😀\n') })
    const after = f.control.readFinalDecision(f.run.runId, before.decisionId)
    expect(after.status).toEqual(before.status)
    expect(after.isCurrent).toBe(false)
    const old = JSON.parse(after.status.basis.evidence.find(x => x.kind === 'report')!.json) as EncodedReportFixture
    expect(Buffer.from(old.bytes.data, 'base64')).toEqual(Buffer.from(f.gemini.bytes))
  })
  it.each(['different-bytes', 'invalid-encoding', 'noncanonical-base64'] as const)(
    'rejects report %s despite internally consistent outer snapshot hashes', async (variant) => {
      const f = await readyMap(); prepareQuestion(f)
      const decision = f.control.recordFinalDecision(f.run.runId, 'damaged-report' as ResearchFinalDecisionId)
      const db = new DatabaseSync(f.filename)
      const row = db.prepare('SELECT status_json FROM research_final_decisions WHERE decision_id=?').get(decision.decisionId)!
      const status = JSON.parse(row.status_json as string) as MutableDecisionFixture
      const evidence = status.basis.evidence.find(x => x.kind === 'report')!
      const report = JSON.parse(evidence.json) as EncodedReportFixture
      if (variant === 'different-bytes') report.bytes.data = Buffer.from('altered bytes').toString('base64')
      else if (variant === 'invalid-encoding') report.bytes.encoding = 'unknown'
      else report.bytes.data += '\n'
      evidence.json = JSON.stringify(report)
      evidence.sha256 = hash(evidence.json)
      const { sha256: _sha256, ...unsigned } = status
      status.sha256 = hash(JSON.stringify(unsigned))
      const raw = JSON.stringify(status)
      db.prepare('UPDATE research_final_decisions SET status_json=?,sha256=? WHERE decision_id=?').run(raw, hash(raw), decision.decisionId)
      db.close()
      expect(() => f.control.readFinalDecision(f.run.runId, decision.decisionId)).toThrow('damaged final decision')
    })
})

describe('retired critical unknowns in current completion', () => {
  async function withdrawn() {
    const f = await readyMap(); prepareQuestion(f)
    const judgment = f.control.appendClaimJudgment(f.run.runId, { judgmentId: 'old-unknown', inventoryVersion: f.inventory.version,
      claimId: f.item.claimId, by: 'model', status: 'unverifiable', rationale: 'Original material uncertainty',
      materialArtifactIds: [f.gemini.artifactId] })
    const target = { kind: 'claim-judgment' as const, id: judgment.judgmentId, inventoryVersion: judgment.inventoryVersion,
      claimId: judgment.claimId, claimTextSha256: f.item.claimTextSha256, recordSha256: hash(JSON.stringify(judgment)) }
    const inventory = f.control.appendClaimInventory(f.run.runId, { ...f.inventoryInput, expectedVersion: f.inventory.version,
      claims: [], changes: [{ kind: 'remove', from: [f.item.claimId], to: [], reason: 'Withdraw rather than adopt the unknown proposition' }] })
    f.control.confirmClaimInventory(f.run.runId, inventory.version, inventory.sha256)
    const retired: ResearchRetiredFinalItem = { inventoryVersion: f.inventory.version, claimId: f.item.claimId,
      claimTextSha256: f.item.claimTextSha256, changeVersion: inventory.version, kind: 'removed', replacementIds: [],
      reason: 'Explicit withdrawal, not factual support', location: f.location, dispositionIds: [] }
    const map = f.control.appendFinalMap(f.run.runId, { ...f.input, inventoryVersion: inventory.version,
      inventorySha256: inventory.sha256, items: [], retired: [retired], zeroCriticalFactsReason: 'Only withdrawal; no factual adoption' })
    f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
    const disposition = { dispositionId: 'withdrawal', target, expectedPreviousDispositionId: null, outcome: 'corrected-in-final',
      by: 'human', rationale: 'Exact current final report withdraws this original unknown', evidenceCitationIds: [],
      finalCorrection: { finalMapId: map.input.finalMapId, mapSha256: map.sha256 } }
    return { ...f, map, disposition }
  }
  it('completes an exact withdrawal with no fabricated citation or support for the retired false proposition', async () => {
    const f = await withdrawn()
    expect(f.control.readFinalStatus(f.run.runId).issues).toContain('counter-disposition')
    f.control.appendCounterDisposition(f.run.runId, f.disposition)
    const status = f.control.readFinalStatus(f.run.runId)
    expect(status.state).toBe('verified-and-synthesized')
    expect(status.basis.requiredFacts).toBe(0)
    expect(status.basis.supportedFacts).toBe(0)
    expect(status.basis.evidence.some(x => x.kind === 'judgment')).toBe(true)
  })
  it('requires the new exact current map rather than borrowing a prior completed withdrawal', async () => {
    const f = await withdrawn()
    const first = f.control.appendCounterDisposition(f.run.runId, f.disposition)
    const old = f.control.recordFinalDecision(f.run.runId, 'withdrawn-decision' as ResearchFinalDecisionId)
    const map = f.control.appendFinalMap(f.run.runId, { ...f.map.input, finalMapId: 'map2',
      expectedPreviousFinalMapId: f.map.input.finalMapId })
    f.control.confirmFinalMap(f.run.runId, map.input.finalMapId, map.sha256)
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
    const next = f.control.appendCounterDisposition(f.run.runId, { ...f.disposition, dispositionId: 'withdrawal2',
      expectedPreviousDispositionId: first.input.dispositionId,
      finalCorrection: { finalMapId: map.input.finalMapId, mapSha256: map.sha256 } })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('verified-and-synthesized')
    expect(f.control.readFinalDecision(f.run.runId, old.decisionId).isCurrent).toBe(false)
    f.control.appendClaimJudgment(f.run.runId, { judgmentId: 'new-retired-counter', inventoryVersion: f.inventory.version,
      claimId: f.item.claimId, by: 'model', status: 'contradicted', rationale: 'New exact counterevidence, not covered by old treatment',
      materialArtifactIds: [f.gemini.artifactId] })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
    expect(next.input.finalCorrection!.finalMapId).toBe(map.input.finalMapId)
  })
  it('does not import another run counter even when the owner, question and candidate ID match', async () => {
    const f = await readyMap(); publish(f)
    const other = f.control.create('other-run' as ResearchRunId, f.run.binding)
    const inventory = f.control.appendClaimInventory(other.runId, { ...f.inventoryInput, expectedVersion: 0, materials: [] })
    f.control.appendClaimJudgment(other.runId, { judgmentId: 'other-counter', inventoryVersion: inventory.version,
      claimId: f.item.claimId, by: 'model', status: 'unverifiable', rationale: 'Belongs only to another original run', materialArtifactIds: [] })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('verified-and-synthesized')
    expect(f.control.readFinalStatus(other.runId).state).toBe('needs-input')
  })
  it('keeps an older-version critical counter blocked when only another historical version has a final revision location', async () => {
    const f = await withdrawn()
    f.control.appendCounterDisposition(f.run.runId, f.disposition)
    const judgment = f.control.appendClaimJudgment(f.run.runId, { judgmentId: 'version1-counter', inventoryVersion: 1,
      claimId: f.item.claimId, by: 'model', status: 'unverifiable', rationale: 'Earlier original material uncertainty', materialArtifactIds: [] })
    const target = { ...f.disposition.target, id: judgment.judgmentId, inventoryVersion: 1, recordSha256: hash(JSON.stringify(judgment)) }
    f.control.appendCounterDisposition(f.run.runId, { ...f.disposition, dispositionId: 'older-explained', target,
      outcome: 'explained', finalCorrection: null, evidenceCitationIds: ['citation1'] })
    expect(f.control.readFinalStatus(f.run.runId).state).toBe('partial')
  })
})
