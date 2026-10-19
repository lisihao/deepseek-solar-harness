/** Citation JSON validation and exact retained-source checks; semantic support stays attributed. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ResearchActionError, type ResearchCitationAssessmentInput, type ResearchCitationAssessment,
  type ResearchCitationId, type ResearchClaimId, type ResearchClaimInventory, type ResearchSourceReadId,
  type ResearchSourceReadSnapshot, type ResearchOwnerId, type ResearchRunId,
  type ResearchJudgmentAttribution } from '@deepseek-ai/dsh-research-handoff/api'
import { parseResearchJudgmentAttribution } from './claim-inventory.ts'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchActionError('invalid citation object', 'FORMAT')
  return value as Record<string, unknown>
}

/** Citation records share the existing research database, owner authorization and resource observations. */
export class ResearchCitationRecords {
  constructor(private readonly db: DatabaseSync,
    private readonly inventory: (owner: ResearchOwnerId, run: ResearchRunId, version: number) => ResearchClaimInventory,
    private readonly source: (owner: ResearchOwnerId, run: ResearchRunId, read: ResearchSourceReadId) => ResearchSourceReadSnapshot) {}

  private validate(owner: ResearchOwnerId, run: ResearchRunId, input: ResearchCitationAssessmentInput,
    requireCurrent: boolean): void {
    const inventory = this.inventory(owner, run, input.inventoryVersion)
    const claim = inventory.input.claims.find(x => x.id === input.claimId)
    if (requireCurrent && !inventory.isCurrent || inventory.sha256 !== input.inventorySha256
      || claim === undefined || sha(claim.text) !== input.claimTextSha256) {
      throw new ResearchActionError('citation claim or inventory conflicts', 'CONFLICT')
    }
    const source = this.source(owner, run, input.sourceReadId)
    const observation = source.observations.find(x => sha(JSON.stringify(x)) === input.observationSha256)
    const capture = observation?.capture
    if (observation === undefined || observation.resource === null || capture === undefined || capture === null
      || !['full', 'relevant-passage'].includes(capture.extent)) {
      throw new ResearchActionError('citation requires actual retained source passage', 'CONFLICT')
    }
    const bytes = Buffer.from(capture.text, 'utf8')
    const quoted = bytes.subarray(input.quote.byteStart, input.quote.byteEnd)
    if (input.quote.byteEnd > bytes.length || !quoted.equals(Buffer.from(input.quote.text, 'utf8'))
      || Buffer.from(quoted.toString('utf8'), 'utf8').compare(quoted) !== 0) {
      throw new ResearchActionError('citation quote differs from exact UTF8 source bytes', 'CONFLICT')
    }
    for (const id of input.respondsTo) {
      const row = this.db.prepare('SELECT input_json,sha256 FROM research_citations WHERE run_id=? AND citation_id=?').get(run, id)
      if (id === input.citationId || row === undefined || typeof row.input_json !== 'string') {
        throw new ResearchActionError('citation response has no original assessment', 'CONFLICT')
      }
      const previous = parseResearchCitation(JSON.parse(row.input_json))
      if (sha(row.input_json) !== row.sha256 || previous.claimId !== input.claimId) {
        throw new ResearchActionError('citation response targets another claim or damaged record', 'CONFLICT')
      }
    }
  }

  /**
   * Append an owner-authorized exact quote and attributed interpretation, retaining all earlier counterevidence.
   * @param owner - Current Host owner, never supplied by imported assessment JSON.
   * @param run - Owned run.
   * @param value - Model/human-entry JSON.
   * @param attribution - Separate actual Host channel.
   * @returns Immutable assessment, without completing verification or resolving earlier contradictions.
   */
  append(owner: ResearchOwnerId, run: ResearchRunId, value: unknown,
    attribution: ResearchJudgmentAttribution): ResearchCitationAssessment {
    const input = parseResearchCitation(value), channel = parseResearchJudgmentAttribution(attribution)
    if (channel.ownerId !== owner) throw new ResearchActionError('citation attribution owner conflicts', 'OWNER')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.validate(owner, run, input, true)
      const raw = JSON.stringify(input), channelRaw = JSON.stringify(channel)
      const existing = this.db.prepare('SELECT * FROM research_citations WHERE run_id=? AND citation_id=?').get(run, input.citationId)
      if (existing !== undefined) {
        if (existing.input_json !== raw || existing.attribution_json !== channelRaw) {
          throw new ResearchActionError('immutable citation conflicts', 'CONFLICT')
        }
      }
      else this.db.prepare(
        'INSERT INTO research_citations(run_id,citation_id,inventory_version,input_json,sha256,attribution_json,attribution_sha256,recorded_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(run, input.citationId, input.inventoryVersion, raw, sha(raw), channelRaw, sha(channelRaw), new Date().toISOString())
      const result = this.read(owner, run, input.citationId)
      this.db.exec('COMMIT')
      return result
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /**
   * Read the historical quote and evidence associations for its owner without reusing current confirmation.
   * @param owner - Current Host owner.
   * @param run - Original run.
   * @param id - Retained citation.
   * @returns Original interpretation and actual Host channel, never inferred truth or complete state.
   */
  read(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchCitationId): ResearchCitationAssessment {
    const row = this.db.prepare('SELECT * FROM research_citations WHERE run_id=? AND citation_id=?').get(run, id)
    if (row === undefined) throw new ResearchActionError('citation not found', 'NOT_FOUND')
    if (typeof row.input_json !== 'string' || typeof row.attribution_json !== 'string' || typeof row.recorded_at !== 'string') {
      throw new ResearchActionError('invalid durable citation fields', 'FORMAT')
    }
    const input = parseResearchCitation(JSON.parse(row.input_json))
    const attribution = parseResearchJudgmentAttribution(JSON.parse(row.attribution_json))
    if (sha(row.input_json) !== row.sha256 || sha(row.attribution_json) !== row.attribution_sha256
      || input.citationId !== id || input.inventoryVersion !== row.inventory_version || attribution.ownerId !== owner
      || !Number.isFinite(Date.parse(row.recorded_at)) || new Date(row.recorded_at).toISOString() !== row.recorded_at
      || typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 1) {
      throw new ResearchActionError('durable citation digest or identity conflicts', 'FORMAT')
    }
    this.validate(owner, run, input, false)
    return { seq: row.seq, input, attribution, recordedAt: row.recorded_at, sha256: sha(row.input_json) }
  }

  /**
   * Read every retained assessment for one historical inventory in stable sequence order.
   * @param owner - Current Host owner.
   * @param run - Original run.
   * @param version - Historical inventory.
   * @returns All assessments, including responses and unresolved contradictory judgments.
   */
  readInventory(owner: ResearchOwnerId, run: ResearchRunId, version: number): ResearchCitationAssessment[] {
    this.inventory(owner, run, version)
    return this.db.prepare('SELECT citation_id FROM research_citations WHERE run_id=? AND inventory_version=? ORDER BY seq')
      .all(run, version).map(row => this.read(owner, run, text(row.citation_id) as ResearchCitationId))
  }
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ResearchActionError('empty citation text', 'FORMAT')
  return value
}
function digest(value: unknown): string {
  const raw = text(value)
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new ResearchActionError('invalid citation digest', 'FORMAT')
  return raw
}
function position(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ResearchActionError('invalid citation position', 'FORMAT')
  return value as number
}

/**
 * Parse model/file/durable interpretation fields, excluding imported authority and completion flags.
 * @param value - Untrusted JSON.
 * @returns Normalized assessment data; support is not independently certified.
 */
export function parseResearchCitation(value: unknown): ResearchCitationAssessmentInput {
  const r = object(value), quote = object(r.quote), dependency = object(r.dependency), authority = object(r.authority)
  if (!['model', 'human'].includes(text(r.by))
    || !['supported', 'partial', 'contradicted', 'unrelated', 'unverifiable'].includes(text(r.relation))
    || !['independent', 'dependent', 'unknown'].includes(text(dependency.status))
    || !['primary-record', 'ordinary', 'unknown'].includes(text(authority.kind))
    || !Array.isArray(r.respondsTo)) throw new ResearchActionError('invalid citation interpretation', 'FORMAT')
  const respondsTo = r.respondsTo.map(x => text(x) as ResearchCitationId)
  const inventoryVersion = position(r.inventoryVersion)
  const byteStart = position(quote.byteStart), byteEnd = position(quote.byteEnd)
  if (inventoryVersion < 1 || byteStart >= byteEnd || new Set(respondsTo).size !== respondsTo.length) {
    throw new ResearchActionError('invalid citation version or quotation', 'FORMAT')
  }
  if (typeof quote.text !== 'string' || Buffer.from(quote.text, 'utf8').toString('utf8') !== quote.text) {
    throw new ResearchActionError('citation quote must be lossless UTF8', 'FORMAT')
  }
  const family = dependency.family === null ? null : text(dependency.family)
  if (dependency.status === 'dependent' && family === null) throw new ResearchActionError('dependent source requires family', 'FORMAT')
  return { citationId: text(r.citationId) as ResearchCitationId, inventoryVersion, inventorySha256: digest(r.inventorySha256),
    claimId: text(r.claimId) as ResearchClaimId, claimTextSha256: digest(r.claimTextSha256),
    sourceReadId: text(r.sourceReadId) as ResearchSourceReadId, observationSha256: digest(r.observationSha256),
    quote: { byteStart, byteEnd, text: text(quote.text) }, by: r.by as ResearchCitationAssessmentInput['by'],
    relation: r.relation as ResearchCitationAssessmentInput['relation'], rationale: text(r.rationale), respondsTo,
    dependency: { status: dependency.status as ResearchCitationAssessmentInput['dependency']['status'], family, basis: text(dependency.basis) },
    authority: { kind: authority.kind as ResearchCitationAssessmentInput['authority']['kind'], basis: text(authority.basis) } }
}
