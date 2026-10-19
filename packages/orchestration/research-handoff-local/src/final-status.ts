/** Recompute research process completeness from one owner-authorized SQLite snapshot. */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import type {
  ResearchActionRun, ResearchPreparedPrompt, ResearchArtifactSnapshot, ResearchClaimInventory,
  ResearchCitationAssessment, ResearchClaimJudgment, ResearchDisposition, ResearchCounterTarget,
  ResearchSourceReadId, ResearchSourceReadSnapshot, ResearchFinalMap, ResearchFinalStatus,
  ResearchFinalEvidence, ResearchFinalIssue, ResearchClaimId, ResearchRunId,
} from '@deepseek-ai/dsh-research-handoff/api'

const sha = (raw: string): string => createHash('sha256').update(raw).digest('hex')

/** Already owner-checked records read within the caller's single SQLite transaction. */
export interface ResearchFinalInputs {
  readonly run: ResearchActionRun
  readonly question: ResearchPreparedPrompt | null
  readonly gemini: ResearchArtifactSnapshot | null
  readonly chatgpt: ResearchArtifactSnapshot | null
  readonly inventories: readonly ResearchClaimInventory[]
  readonly map: ResearchFinalMap | null
  readonly citations: readonly ResearchCitationAssessment[]
  readonly judgments: readonly ResearchClaimJudgment[]
  source(id: ResearchSourceReadId): ResearchSourceReadSnapshot
  dispositions(target: ResearchCounterTarget): readonly ResearchDisposition[]
  citation(id: ResearchCitationAssessment['input']['citationId']): ResearchCitationAssessment
}

/**
 * Calculate attributed verification-process completeness without performing any external operation.
 * @param runId - Exact owned run identity.
 * @param input - Validated records from one database snapshot.
 * @returns Current state and complete retained basis, without claiming semantic truth or exhaustive search.
 */
export function computeResearchFinalStatus(runId: ResearchRunId, input: ResearchFinalInputs): ResearchFinalStatus {
  const evidence: ResearchFinalEvidence[] = [], seen = new Set<string>(), issues = new Set<ResearchFinalIssue>()
  const retain = (kind: ResearchFinalEvidence['kind'], value: unknown): void => {
    const json = JSON.stringify(value), digest = sha(json), key = kind + ':' + digest
    if (!seen.has(key)) { seen.add(key); evidence.push({ kind, json, sha256: digest }) }
  }
  retain('run', input.run)
  if (input.question === null) issues.add('original-question')
  else retain('prepared-question', input.question)
  for (const [role, report] of [['gemini-report', input.gemini], ['chatgpt-report', input.chatgpt]] as const) {
    if (report === null || report.source.extent !== 'complete') issues.add(role)
    if (report !== null) {
      const { bytes, ...metadata } = report
      retain('report', { ...metadata, bytes: { encoding: 'base64', data: Buffer.from(bytes).toString('base64') } })
    }
  }
  if (!input.run.confirmed) issues.add('run-confirmation')
  const inventories = input.inventories.filter(x => x.input.questionSha256 === input.run.binding.questionSha256)
  for (const inventory of inventories) retain('inventory', inventory)
  const current = inventories.find(x => x.isCurrent)
  if (current === undefined || !current.denominatorConfirmed) issues.add('inventory-confirmation')
  const map = input.map
  if (map !== null) retain('final-map', map)
  if (map === null || !map.confirmed) issues.add('final-map-confirmation')
  const limitations = new Set<string>([
    'Support, source quality, independence and treatment remain attributed judgments; no factual accuracy score.',
    'Listed questions and source records do not prove targeted or exhaustive real-world search.',
  ])
  const closure = new Set<ResearchClaimId>()
  let requiredFacts = 0, supportedFacts = 0
  const sources = new Map<ResearchSourceReadId, ResearchSourceReadSnapshot>()
  const source = (id: ResearchSourceReadId): ResearchSourceReadSnapshot => {
    let record = sources.get(id)
    if (record === undefined) { record = input.source(id); sources.set(id, record); retain('source', record) }
    return record
  }
  const retainCitation = (record: ResearchCitationAssessment): void => {
    retain('citation', record); source(record.input.sourceReadId)
  }
  for (const record of input.citations) retainCitation(record)
  for (const record of input.judgments) retain('judgment', record)
  if (map !== null && map.isCurrent && current !== undefined) {
    const items = new Map(map.input.items.map(item => [item.claimId, item]))
    const visit = (id: ResearchClaimId): void => {
      if (closure.has(id)) return
      closure.add(id)
      const item = items.get(id)
      assert(item !== undefined)
      for (const dependency of item.dependencies) visit(dependency)
    }
    for (const claim of current.input.claims) if (claim.critical) visit(claim.id)
    for (const item of map.input.items) {
      for (const limitation of item.limitations) limitations.add(limitation)
      for (const unfinished of item.counterCheck.unfinished) limitations.add(unfinished)
      for (const id of item.counterCheck.citationIds) retainCitation(input.citation(id))
      const required = closure.has(item.claimId)
      if (required && (item.counterCheck.unfinished.length > 0 || item.counterCheck.questions.length === 0
        || item.counterCheck.citationIds.length === 0)) issues.add('counter-check')
      if (item.kind !== 'adopted-fact') continue
      if (required) requiredFacts++
      const supported = item.citationIds.some((id) => {
        const citation = input.citation(id)
        retainCitation(citation)
        const observation = source(citation.input.sourceReadId).observations
          .find(x => sha(JSON.stringify(x)) === citation.input.observationSha256)
        return citation.input.relation === 'supported' && observation?.capture?.completeness === 'complete'
          && (observation.capture.extent === 'full' || observation.capture.extent === 'relevant-passage')
      })
      if (required) {
        if (supported) supportedFacts++
        else issues.add('fact-support')
      }
      else if (!supported) limitations.add('Unverified noncritical adopted fact: ' + item.claimId)
    }
    if (requiredFacts === 0 && map.input.zeroCriticalFactsReason === null) issues.add('zero-critical-facts')
    if (map.input.zeroCriticalFactsReason !== null) limitations.add(map.input.zeroCriticalFactsReason)
  }
  const relevant = new Set(closure)
  // Retain historical critical ancestors even when removal has no replacement in the current graph.
  for (let index = inventories.length - 1; index >= 0; index--) {
    const inventory = inventories[index]
    assert(inventory !== undefined)
    for (const claim of inventory.input.claims) if (claim.critical) relevant.add(claim.id)
    for (const change of inventory.input.changes) {
      if (change.to.some(id => relevant.has(id))) for (const id of change.from) relevant.add(id)
    }
  }
  const inspectCounter = (record: ResearchCitationAssessment | ResearchClaimJudgment): void => {
    const data = 'input' in record ? record.input : record
    const relation = 'relation' in data ? data.relation : data.status
    if (!relevant.has(data.claimId) || relation !== 'contradicted' && relation !== 'unverifiable') return
    const inventory = inventories.find(x => x.version === data.inventoryVersion)
    const claim = inventory?.input.claims.find(x => x.id === data.claimId)
    assert(claim !== undefined)
    const common = { inventoryVersion: data.inventoryVersion, claimId: data.claimId,
      claimTextSha256: sha(claim.text), recordSha256: sha(JSON.stringify(record)) }
    const target: ResearchCounterTarget = 'input' in record
      ? { ...common, kind: 'citation', id: record.input.citationId }
      : { ...common, kind: 'claim-judgment', id: record.judgmentId }
    const stillCurrent = current?.input.claims.some(x => x.id === data.claimId && sha(x.text) === common.claimTextSha256
      && (!claim.critical || x.critical)) === true
    if (!stillCurrent && (map === null || !map.input.retired.some(x => x.inventoryVersion === data.inventoryVersion
      && x.claimId === data.claimId && x.claimTextSha256 === common.claimTextSha256 && x.location !== null))) {
      issues.add('counter-disposition')
    }
    const history = input.dispositions(target)
    for (const disposition of history) {
      retain('disposition', disposition)
      for (const id of disposition.input.evidenceCitationIds) retainCitation(input.citation(id))
    }
    const latest = history.at(-1)
    if (latest === undefined || latest.input.outcome === 'retained-unresolved') { issues.add('counter-disposition'); return }
    const correction = latest.input.finalCorrection
    if (correction !== null && (map === null || !map.confirmed || correction.finalMapId !== map.input.finalMapId
      || correction.mapSha256 !== map.sha256)) issues.add('counter-disposition')
  }
  for (const record of input.citations) inspectCounter(record)
  for (const record of input.judgments) inspectCounter(record)
  const missingCore = issues.has('original-question') || issues.has('gemini-report') || issues.has('chatgpt-report')
  const result = {
    state: missingCore ? 'needs-input' as const : issues.size > 0 ? 'partial' as const : 'verified-and-synthesized' as const,
    issues: [...issues], limitations: [...limitations],
    basis: { runId, revision: input.run.revision, questionSha256: input.run.binding.questionSha256,
      criticalClosure: [...closure], requiredFacts, supportedFacts, evidence },
  }
  return { ...result, sha256: sha(JSON.stringify(result)) }
}
