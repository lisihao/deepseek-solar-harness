/** Atomic final decisions retain computed records; historical results never override current recomputation. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  ResearchActionError, type ResearchOwnerId, type ResearchRunId, type ResearchFinalDecisionId,
  type ResearchFinalDecision, type ResearchFinalStatus, type ResearchFinalIssue, type ResearchFinalEvidence,
  type ResearchClaimId, type ResearchJudgmentAttribution,
} from '@deepseek-ai/dsh-research-handoff/api'
import { parseResearchJudgmentAttribution } from './claim-inventory.ts'
import { computeResearchFinalStatus, type ResearchFinalInputs } from './final-status.ts'

const sha = (raw: string): string => createHash('sha256').update(raw).digest('hex')
const issueNames = ['original-question', 'gemini-report', 'chatgpt-report', 'run-confirmation', 'inventory-confirmation',
  'final-map-confirmation', 'fact-support', 'counter-check', 'counter-disposition', 'zero-critical-facts']
const evidenceNames = ['run', 'prepared-question', 'report', 'inventory', 'final-map', 'citation', 'source', 'judgment', 'disposition']
function fail(): never { throw new ResearchActionError('damaged final decision record', 'FORMAT') }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim()) fail(); return value }
function count(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) fail(); return value as number }
function strings(value: unknown): string[] { if (!Array.isArray(value)) fail(); return value.map(text) }
function digest(value: unknown): string { const result = text(value); if (!/^[a-f0-9]{64}$/.test(result)) fail(); return result }
function validateReport(value: Record<string, unknown>): void {
  const bytes = object(value.bytes)
  if (bytes.encoding !== 'base64' || typeof bytes.data !== 'string') fail()
  const decoded = Buffer.from(bytes.data, 'base64')
  if (decoded.toString('base64') !== bytes.data || createHash('sha256').update(decoded).digest('hex') !== digest(value.sha256)
    || !['gemini-report', 'chatgpt-report'].includes(text(value.role)) || count(value.version) < 1) fail()
  text(value.artifactId)
}
function parseStatus(value: unknown, run: ResearchRunId): ResearchFinalStatus {
  const r = object(value), basis = object(r.basis)
  const issues = strings(r.issues), limitations = strings(r.limitations), closure = strings(basis.criticalClosure)
  if (issues.some(x => !issueNames.includes(x)) || new Set(issues).size !== issues.length
    || new Set(closure).size !== closure.length || basis.runId !== run || count(basis.revision) < 1
    || count(basis.supportedFacts) > count(basis.requiredFacts) || !Array.isArray(basis.evidence)) fail()
  const missingCore = issues.some(x => ['original-question', 'gemini-report', 'chatgpt-report'].includes(x))
  const state: ResearchFinalStatus['state'] = missingCore ? 'needs-input' : issues.length > 0 ? 'partial' : 'verified-and-synthesized'
  if (r.state !== state) fail()
  const evidence = basis.evidence.map((value): ResearchFinalEvidence => {
    const record = object(value), json = text(record.json)
    if (!evidenceNames.includes(text(record.kind)) || sha(json) !== digest(record.sha256)) fail()
    const retained = object(JSON.parse(json))
    if (record.kind === 'report') validateReport(retained)
    return { kind: record.kind as ResearchFinalEvidence['kind'], json, sha256: digest(record.sha256) }
  })
  const normalized = { state, issues: issues as ResearchFinalIssue[], limitations,
    basis: { runId: run, revision: count(basis.revision), questionSha256: digest(basis.questionSha256),
      criticalClosure: closure as ResearchClaimId[], requiredFacts: count(basis.requiredFacts),
      supportedFacts: count(basis.supportedFacts), evidence } }
  if (sha(JSON.stringify(normalized)) !== digest(r.sha256)) fail()
  return { ...normalized, sha256: digest(r.sha256) }
}

/** SQLite snapshot owner for current calculation and immutable Host-stamped decisions. */
export class ResearchFinalDecisions {
  constructor(private readonly db: DatabaseSync,
    private readonly inputs: (owner: ResearchOwnerId, run: ResearchRunId) => ResearchFinalInputs) {}

  private compute(owner: ResearchOwnerId, run: ResearchRunId): ResearchFinalStatus {
    return computeResearchFinalStatus(run, this.inputs(owner, run))
  }

  /**
   * Recompute the final status inside the caller-owned SQLite transaction.
   * @param owner - Current owner.
   * @param run - Owned run.
   * @returns Original final calculation within the caller-owned SQLite snapshot; no nested BEGIN.
   */
  readStatusInTransaction(owner: ResearchOwnerId, run: ResearchRunId): ResearchFinalStatus {
    return this.compute(owner, run)
  }

  /**
   * Recompute current process state in one read transaction without using historical completion.
   * @param owner - Current authorized Host owner.
   * @param run - Owned run.
   * @returns Current result and complete used records.
   */
  readStatus(owner: ResearchOwnerId, run: ResearchRunId): ResearchFinalStatus {
    this.db.exec('BEGIN')
    try { const result = this.compute(owner, run); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private readStored(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchFinalDecisionId,
    current: ResearchFinalStatus): ResearchFinalDecision {
    const row = this.db.prepare('SELECT * FROM research_final_decisions WHERE run_id=? AND decision_id=?').get(run, id)
    if (row === undefined) throw new ResearchActionError('final decision not found', 'NOT_FOUND')
    const raw = text(row.status_json), channel = text(row.attribution_json), at = text(row.recorded_at)
    if (sha(raw) !== row.sha256 || sha(channel) !== row.attribution_sha256 || count(row.seq) < 1
      || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) fail()
    const status = parseStatus(JSON.parse(raw), run)
    const attribution = parseResearchJudgmentAttribution(JSON.parse(channel))
    if (attribution.ownerId !== owner || JSON.stringify(status) !== raw) fail()
    return { decisionId: id, seq: count(row.seq), recordedAt: at, attribution, status, isCurrent: status.sha256 === current.sha256 }
  }

  /**
   * Record the computed result atomically; a repeated identity returns its immutable original result.
   * @param owner - Current authorized Host owner.
   * @param run - Owned run.
   * @param id - New immutable decision identity, without caller state flags.
   * @param attribution - Actual Host input channel.
   * @returns Original decision with independently recomputed current applicability.
   */
  record(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchFinalDecisionId,
    attribution: ResearchJudgmentAttribution): ResearchFinalDecision {
    const channel = parseResearchJudgmentAttribution(attribution), channelRaw = JSON.stringify(channel)
    if (channel.ownerId !== owner) throw new ResearchActionError('decision owner conflicts', 'OWNER')
    text(id)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.compute(owner, run)
      const existing = this.db.prepare('SELECT attribution_json FROM research_final_decisions WHERE run_id=? AND decision_id=?').get(run, id)
      if (existing !== undefined && existing.attribution_json !== channelRaw) {
        throw new ResearchActionError('immutable decision attribution conflicts', 'CONFLICT')
      }
      if (existing === undefined) {
        const raw = JSON.stringify(current)
        this.db.prepare(
          'INSERT INTO research_final_decisions(run_id,decision_id,status_json,sha256,attribution_json,attribution_sha256,recorded_at) VALUES(?,?,?,?,?,?,?)')
          .run(run, id, raw, sha(raw), channelRaw, sha(channelRaw), new Date().toISOString())
      }
      const result = this.readStored(owner, run, id, current)
      this.db.exec('COMMIT'); return result
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /**
   * Read the complete original decision and separately recompute whether its basis still applies.
   * @param owner - Current authorized Host owner.
   * @param run - Original owned run.
   * @param id - Original decision identity.
   * @returns Historical result; isCurrent never changes its stored state or evidence.
   */
  read(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchFinalDecisionId): ResearchFinalDecision {
    this.db.exec('BEGIN')
    try {
      const current = this.compute(owner, run), result = this.readStored(owner, run, id, current)
      this.db.exec('COMMIT'); return result
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
