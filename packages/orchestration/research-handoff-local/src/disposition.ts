/** Exact counterevidence associations and append-only compare-and-swap in the existing research database. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ResearchActionError, type ResearchCounterTarget, type ResearchDispositionInput, type ResearchDisposition,
  type ResearchDispositionId, type ResearchCitationId, type ResearchJudgmentId, type ResearchClaimId,
  type ResearchCitationAssessment, type ResearchClaimJudgment, type ResearchClaimInventory,
  type ResearchOwnerId, type ResearchRunId, type ResearchJudgmentAttribution,
  type ResearchFinalMapId, type ResearchFinalMap } from '@deepseek-ai/dsh-research-handoff/api'
import { parseResearchJudgmentAttribution } from './claim-inventory.ts'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchActionError('invalid disposition object', 'FORMAT')
  return value as Record<string, unknown>
}

/** Dispositions share the action store's database, owner checks and immutable evidence records. */
export class ResearchDispositionRecords {
  constructor(private readonly db: DatabaseSync,
    private readonly inventory: (owner: ResearchOwnerId, run: ResearchRunId, version: number) => ResearchClaimInventory,
    private readonly citation: (owner: ResearchOwnerId, run: ResearchRunId, id: ResearchCitationId) => ResearchCitationAssessment,
    private readonly judgment: (owner: ResearchOwnerId, run: ResearchRunId, id: ResearchJudgmentId) => ResearchClaimJudgment,
    private readonly finalMap: (owner: ResearchOwnerId, run: ResearchRunId, id: ResearchFinalMapId) => ResearchFinalMap) {}

  private validateTarget(owner: ResearchOwnerId, run: ResearchRunId, t: ResearchCounterTarget): void {
    const original = t.kind === 'citation' ? this.citation(owner, run, t.id) : this.judgment(owner, run, t.id)
    const data = 'input' in original ? original.input : original
    const status = 'relation' in data ? data.relation : data.status
    const claim = this.inventory(owner, run, t.inventoryVersion).input.claims.find(c => c.id === t.claimId)
    if (!['contradicted', 'unverifiable'].includes(status) || data.inventoryVersion !== t.inventoryVersion
      || data.claimId !== t.claimId || claim === undefined || sha(claim.text) !== t.claimTextSha256
      || sha(JSON.stringify(original)) !== t.recordSha256) {
      throw new ResearchActionError('disposition target differs from original counterevidence', 'CONFLICT')
    }
  }

  private validate(owner: ResearchOwnerId, run: ResearchRunId, input: ResearchDispositionInput, current = false): void {
    this.validateTarget(owner, run, input.target)
    for (const id of input.evidenceCitationIds) this.citation(owner, run, id)
    if (input.finalCorrection === null) return
    const map = this.finalMap(owner, run, input.finalCorrection.finalMapId), target = input.target
    const retired = map.input.retired.find(x => x.inventoryVersion === target.inventoryVersion
      && x.claimId === target.claimId && x.claimTextSha256 === target.claimTextSha256)
    if (map.sha256 !== input.finalCorrection.mapSha256 || retired === undefined || retired.location === null
      || current && !map.confirmed
      || map.input.items.some(x => x.kind === 'adopted-fact' && x.claimTextSha256 === target.claimTextSha256)) {
      throw new ResearchActionError('final correction needs the exact retired target in a confirmed current mapping', 'CONFLICT')
    }
  }

  /**
   * Append exact-target treatment using CAS without deleting its original evidence or earlier treatment.
   * @param owner - Current trusted owner.
   * @param run - Original research run.
   * @param value - Untrusted interpretation data, never a completion control.
   * @param attribution - Separate actual Host channel.
   * @returns Immutable disposition; future final mapping and current completion still have independent checks.
   */
  append(owner: ResearchOwnerId, run: ResearchRunId, value: unknown,
    attribution: ResearchJudgmentAttribution): ResearchDisposition {
    const input = parseResearchDisposition(value), channel = parseResearchJudgmentAttribution(attribution)
    if (channel.ownerId !== owner) throw new ResearchActionError('disposition attribution owner conflicts', 'OWNER')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const raw = JSON.stringify(input), key = targetKey(input.target), channelRaw = JSON.stringify(channel)
      const existing = this.db.prepare('SELECT * FROM research_dispositions WHERE run_id=? AND disposition_id=?')
        .get(run, input.dispositionId)
      this.validate(owner, run, input, existing === undefined)
      if (existing !== undefined) {
        if (existing.input_json !== raw || existing.attribution_json !== channelRaw) {
          throw new ResearchActionError('immutable disposition conflicts', 'CONFLICT')
        }
      }
      else {
        const previous = this.db.prepare('SELECT disposition_id FROM research_dispositions WHERE run_id=? AND target_key=? ORDER BY seq DESC LIMIT 1')
          .get(run, key)
        if ((previous?.disposition_id ?? null) !== input.expectedPreviousDispositionId) {
          throw new ResearchActionError('counterevidence disposition changed', 'REVISION')
        }
        this.db.prepare(
          'INSERT INTO research_dispositions(run_id,disposition_id,target_key,input_json,sha256,attribution_json,attribution_sha256,recorded_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(run, input.dispositionId, key, raw, sha(raw), channelRaw, sha(channelRaw), new Date().toISOString())
      }
      const result = this.read(owner, run, input.dispositionId)
      this.db.exec('COMMIT')
      return result
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /**
   * Read a historical disposition while retaining its original target and evidence associations.
   * @param owner - Current trusted owner.
   * @param run - Original run.
   * @param id - Immutable disposition.
   * @returns Exact historical treatment; it does not automatically apply to newer counterevidence IDs.
   */
  read(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchDispositionId): ResearchDisposition {
    const row = this.db.prepare('SELECT * FROM research_dispositions WHERE run_id=? AND disposition_id=?').get(run, id)
    if (row === undefined) throw new ResearchActionError('disposition not found', 'NOT_FOUND')
    if (typeof row.input_json !== 'string' || typeof row.attribution_json !== 'string' || typeof row.recorded_at !== 'string') {
      throw new ResearchActionError('invalid durable disposition fields', 'FORMAT')
    }
    const input = parseResearchDisposition(JSON.parse(row.input_json))
    const attribution = parseResearchJudgmentAttribution(JSON.parse(row.attribution_json))
    if (sha(row.input_json) !== row.sha256 || sha(row.attribution_json) !== row.attribution_sha256
      || input.dispositionId !== id || targetKey(input.target) !== row.target_key || attribution.ownerId !== owner
      || !Number.isFinite(Date.parse(row.recorded_at)) || new Date(row.recorded_at).toISOString() !== row.recorded_at
      || typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 1) {
      throw new ResearchActionError('durable disposition digest or identity conflicts', 'FORMAT')
    }
    this.validate(owner, run, input)
    const previous = this.db.prepare('SELECT disposition_id FROM research_dispositions WHERE run_id=? AND target_key=? AND seq<? ORDER BY seq DESC LIMIT 1')
      .get(run, row.target_key, row.seq)
    if ((previous?.disposition_id ?? null) !== input.expectedPreviousDispositionId) {
      throw new ResearchActionError('durable disposition history conflicts', 'FORMAT')
    }
    return { seq: row.seq, input, attribution, recordedAt: row.recorded_at, sha256: sha(row.input_json) }
  }

  /**
   * Read all exact-target treatment records, including explicit reopening and unresolved outcomes.
   * @param owner - Current trusted owner.
   * @param run - Original run.
   * @param target - Exact immutable original counterevidence target.
   * @returns Stable ordered history; no latest supported judgment can replace it.
   */
  readTarget(owner: ResearchOwnerId, run: ResearchRunId, target: ResearchCounterTarget): ResearchDisposition[] {
    const rows = this.db.prepare('SELECT disposition_id FROM research_dispositions WHERE run_id=? AND target_key=? ORDER BY seq')
      .all(run, targetKey(target))
    this.validateTarget(owner, run, target)
    return rows.map(row => this.read(owner, run, text(row.disposition_id) as ResearchDispositionId))
  }
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ResearchActionError('empty disposition text', 'FORMAT')
  return value
}
function digest(value: unknown): string {
  const raw = text(value)
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new ResearchActionError('invalid disposition digest', 'FORMAT')
  return raw
}
function targetKey(target: ResearchCounterTarget): string { return JSON.stringify({ kind: target.kind, id: target.id }) }

/**
 * Parse explicit treatment data without accepting imported authority or completion fields.
 * @param value - Model, human-entry, file or durable JSON.
 * @returns Normalized data; the outcome remains an attributed interpretation.
 */
export function parseResearchDisposition(value: unknown): ResearchDispositionInput {
  const r = record(value), t = record(r.target)
  if (!['citation', 'claim-judgment'].includes(text(t.kind))
    || !Number.isSafeInteger(t.inventoryVersion) || (t.inventoryVersion as number) < 1
    || !['explained', 'corrected-in-final', 'retained-unresolved'].includes(text(r.outcome))
    || !['model', 'human'].includes(text(r.by)) || !Array.isArray(r.evidenceCitationIds)) {
    throw new ResearchActionError('invalid disposition fields', 'FORMAT')
  }
  const evidenceCitationIds = r.evidenceCitationIds.map(x => text(x) as ResearchCitationId)
  const correction = r.finalCorrection === null ? null : record(r.finalCorrection)
  const finalCorrection = correction === null ? null : {
    finalMapId: text(correction.finalMapId) as ResearchFinalMapId, mapSha256: digest(correction.mapSha256),
  }
  if (new Set(evidenceCitationIds).size !== evidenceCitationIds.length
    || finalCorrection !== null && r.outcome !== 'corrected-in-final'
    || finalCorrection === null && r.outcome !== 'retained-unresolved' && evidenceCitationIds.length === 0) {
    throw new ResearchActionError('resolved disposition requires explicit evidence citations', 'FORMAT')
  }
  const common = { inventoryVersion: t.inventoryVersion as number, claimId: text(t.claimId) as ResearchClaimId,
    claimTextSha256: digest(t.claimTextSha256), recordSha256: digest(t.recordSha256) }
  const target: ResearchCounterTarget = t.kind === 'citation'
    ? { ...common, kind: 'citation', id: text(t.id) as ResearchCitationId }
    : { ...common, kind: 'claim-judgment', id: text(t.id) as ResearchJudgmentId }
  return { dispositionId: text(r.dispositionId) as ResearchDispositionId, target,
    expectedPreviousDispositionId: r.expectedPreviousDispositionId === null
      ? null : text(r.expectedPreviousDispositionId) as ResearchDispositionId,
    outcome: r.outcome as ResearchDispositionInput['outcome'], by: r.by as ResearchDispositionInput['by'],
    rationale: text(r.rationale), evidenceCitationIds, finalCorrection }
}
