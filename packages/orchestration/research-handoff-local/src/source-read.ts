/** Source-read JSON validation and records sharing the research Provider's SQLite owner. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ResearchActionError, type ResearchActionRun, type ResearchOwnerId, type ResearchRunId,
  type ResearchSourceReadId, type ResearchSourceReadRequest, type ResearchSourceReadSnapshot,
  type ResearchSourceObservation } from '@deepseek-ai/dsh-research-handoff/api'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchActionError('invalid source object', 'FORMAT')
  return value as Record<string, unknown>
}

/** Source records use the enclosing action store's database and owner checks, with no independent close or run. */
export class ResearchSourceRecords {
  constructor(private readonly db: DatabaseSync,
    private readonly inspect: (owner: ResearchOwnerId, run: ResearchRunId) => ResearchActionRun) {}

  /**
   * Atomically retain unknown before any external invocation and fence the exact URL across revisions/Readers.
   * @param owner - Current trusted owner.
   * @param request - Complete request.
   * @returns Immutable snapshot and whether this call alone created the intent.
   */
  begin(owner: ResearchOwnerId, request: ResearchSourceReadRequest): { snapshot: ResearchSourceReadSnapshot; created: boolean } {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.inspect(owner, request.runId)
      const parsed = parseResearchSourceRequest(request)
      const raw = JSON.stringify(parsed)
      const existing = this.db.prepare('SELECT request_json FROM research_source_reads WHERE run_id=? AND read_id=?')
        .get(request.runId, request.readId)
      let created = false
      if (existing !== undefined) {
        if (existing.request_json !== raw) throw new ResearchActionError('immutable source request conflicts', 'CONFLICT')
      }
      else {
        if (run.revision !== parsed.revision || run.bindingSha256 !== parsed.bindingSha256 || !run.confirmed) {
          throw new ResearchActionError('source confirmation changed', 'CONFIRMATION')
        }
        const pending = this.db.prepare('SELECT read_id FROM research_source_reads WHERE run_id=? AND requested_url=?')
          .all(parsed.runId, parsed.requestedUrl)
          .some(row => ['unknown', 'accepted'].includes(this.read(owner, parsed.runId, text(row.read_id) as ResearchSourceReadId).state))
        if (pending) throw new ResearchActionError('source URL has unresolved original read', 'CONFLICT')
        this.db.prepare('INSERT INTO research_source_reads VALUES(?,?,?,?,?)')
          .run(parsed.runId, parsed.readId, parsed.requestedUrl, raw, sha(raw))
        created = true
      }
      const snapshot = this.read(owner, request.runId, request.readId)
      this.db.exec('COMMIT')
      return { snapshot, created }
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /**
   * Read retained source observations after owner authorization, checking all durable digests and association.
   * @param owner - Current owner.
   * @param runId - Original run.
   * @param readId - Original read.
   * @returns Original request and append-only source observations.
   */
  read(owner: ResearchOwnerId, runId: ResearchRunId, readId: ResearchSourceReadId): ResearchSourceReadSnapshot {
    this.inspect(owner, runId)
    const row = this.db.prepare('SELECT * FROM research_source_reads WHERE run_id=? AND read_id=?').get(runId, readId)
    if (row === undefined) throw new ResearchActionError('source read not found', 'NOT_FOUND')
    const raw = text(row.request_json)
    const request = parseResearchSourceRequest(JSON.parse(raw))
    if (sha(raw) !== row.sha256 || request.runId !== runId || request.readId !== readId || request.requestedUrl !== row.requested_url) {
      throw new ResearchActionError('durable source request conflicts', 'FORMAT')
    }
    const observations: ResearchSourceObservation[] = []
    let state: ResearchSourceObservation['state'] = 'unknown'
    let resource: ResearchSourceObservation['resource'] = null
    const visits = this.db.prepare('SELECT * FROM research_source_visits WHERE run_id=? AND read_id=? ORDER BY seq').all(runId, readId)
    for (const visit of visits) {
      const vraw = text(visit.visit_json)
      const v = object(JSON.parse(vraw))
      if (sha(vraw) !== visit.sha256 || v.requestSha256 !== row.sha256 || !text(v.evidence) || !text(v.checkedAt)) {
        throw new ResearchActionError('durable source authorization conflicts', 'FORMAT')
      }
      researchSourceUrl(v.url)
    }
    const rows = this.db.prepare('SELECT * FROM research_source_observations WHERE run_id=? AND read_id=? ORDER BY seq').all(runId, readId)
    for (const item of rows) {
      const value = text(item.observation_json)
      const observation = parseResearchSourceObservation(JSON.parse(value))
      if (sha(value) !== item.sha256 || observation.requestSha256 !== row.sha256
        || resource !== null && observation.resource?.id !== resource.id
        || ['completed', 'not-admitted'].includes(state) && JSON.stringify(observations.at(-1)) !== value
        || observation.state === 'not-admitted' && visits.length > 0
        || ['accepted', 'completed'].includes(observation.state) && visits.length === 0
        || observation.capture !== null
          && !visits.some(v => object(JSON.parse(text(v.visit_json))).url === observation.capture?.finalUrl)) {
        throw new ResearchActionError('durable source observation conflicts', 'FORMAT')
      }
      observations.push(observation)
      state = observation.state
      resource = observation.resource
    }
    return { request, requestSha256: sha(raw), state, resource, observations,
      authorizedUrls: [...new Set(visits.map(v => researchSourceUrl(object(JSON.parse(text(v.visit_json))).url)))] }
  }

  /**
   * Persist a successful guard check; this does not assert the Reader actually visited the target.
   * @param owner - Current owner.
   * @param snapshot - Original request.
   * @param url - Exact authorized target.
   * @param evidence - Current Host authorization evidence.
   */
  guard(owner: ResearchOwnerId, snapshot: ResearchSourceReadSnapshot, url: string, evidence: string): void {
    const current = this.read(owner, snapshot.request.runId, snapshot.request.readId)
    if (current.requestSha256 !== snapshot.requestSha256 || current.state !== 'unknown') {
      throw new ResearchActionError('source no longer permits initial access', 'CONFLICT')
    }
    const value = JSON.stringify({ requestSha256: snapshot.requestSha256, url: researchSourceUrl(url),
      evidence: text(evidence), checkedAt: new Date().toISOString() })
    this.db.prepare('INSERT INTO research_source_visits(run_id,read_id,visit_json,sha256) VALUES(?,?,?,?)')
      .run(current.request.runId, current.request.readId, value, sha(value))
  }

  /**
   * Append a correlated actual reply, including late acceptance; exceptions never settle unknown.
   * @param owner - Original owner.
   * @param snapshot - Exact originally dispatched request.
   * @param value - Actual Reader transport JSON.
   * @returns Retained observations.
   */
  record(owner: ResearchOwnerId, snapshot: ResearchSourceReadSnapshot, value: unknown): ResearchSourceReadSnapshot {
    const observation = parseResearchSourceObservation(value)
    if (observation.requestSha256 !== snapshot.requestSha256) throw new ResearchActionError('source reply request conflicts', 'FORMAT')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.read(owner, snapshot.request.runId, snapshot.request.readId)
      const raw = JSON.stringify(observation)
      this.db.prepare('INSERT INTO research_source_observations(run_id,read_id,observation_json,sha256) VALUES(?,?,?,?)')
        .run(snapshot.request.runId, snapshot.request.readId, raw, sha(raw))
      const result = this.read(owner, snapshot.request.runId, snapshot.request.readId)
      this.db.exec('COMMIT')
      return result
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new ResearchActionError('invalid source text', 'FORMAT')
  return value
}
function nullable(value: unknown): string | null { return value === null ? null : text(value) }

/**
 * Validate a URL without changing the exact durable requested URL or removing query parameters.
 * @param value - Actual or requested URL at the JSON/adapter boundary.
 * @returns Original HTTP(S) string.
 */
export function researchSourceUrl(value: unknown): string {
  const raw = text(value)
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol)) throw new ResearchActionError('source requires HTTP(S)', 'FORMAT')
  return raw
}

/**
 * Parse immutable durable source request fields without importing authority.
 * @param value - Durable request JSON.
 * @returns Validated explicit fields.
 */
export function parseResearchSourceRequest(value: unknown): ResearchSourceReadRequest {
  const r = object(value)
  if (!Number.isSafeInteger(r.revision) || (r.revision as number) < 1
    || r.inventoryVersion !== null && (!Number.isSafeInteger(r.inventoryVersion) || (r.inventoryVersion as number) < 1)) {
    throw new ResearchActionError('invalid source request revision', 'FORMAT')
  }
  return { runId: text(r.runId) as ResearchRunId, readId: text(r.readId) as ResearchSourceReadId,
    readerId: text(r.readerId) as ResearchSourceReadRequest['readerId'], revision: r.revision as number,
    bindingSha256: text(r.bindingSha256), requestedUrl: researchSourceUrl(r.requestedUrl),
    sourceLabel: text(r.sourceLabel), inventoryVersion: r.inventoryVersion as number | null }
}

/**
 * Parse actual transport/durable observations, keeping missing metadata distinct from observed values.
 * @param value - Reader transport or durable JSON.
 * @returns Explicit observation with lossless UTF-8 extraction.
 */
export function parseResearchSourceObservation(value: unknown): ResearchSourceObservation {
  const r = object(value)
  if (!['unknown', 'not-admitted', 'accepted', 'completed'].includes(text(r.state))) {
    throw new ResearchActionError('invalid source state', 'FORMAT')
  }
  const observedAt = text(r.observedAt)
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    throw new ResearchActionError('invalid source observation time', 'FORMAT')
  }
  const resource = r.resource === null ? null : object(r.resource)
  const capture = r.capture === null ? null : object(r.capture)
  if (['accepted', 'completed'].includes(r.state as string) !== (resource !== null)) {
    throw new ResearchActionError('source acceptance requires correlated resource', 'FORMAT')
  }
  if (capture !== null) {
    if (resource === null || !['full', 'relevant-passage', 'search-snippet', 'title-only', 'unavailable', 'not_observed']
      .includes(text(capture.extent)) || !['complete', 'partial', 'unknown'].includes(text(capture.completeness))
      || capture.completeness !== 'complete' && (typeof capture.limitation !== 'string' || !capture.limitation)
      || typeof capture.text !== 'string'
      || Buffer.from(capture.text, 'utf8').toString('utf8') !== capture.text || sha(capture.text) !== capture.textSha256) {
      throw new ResearchActionError('invalid source capture bytes or extent', 'FORMAT')
    }
  }
  return { requestSha256: text(r.requestSha256), state: r.state as ResearchSourceObservation['state'],
    observedAt, evidence: text(r.evidence),
    resource: resource === null ? null : { id: text(resource.id), evidence: text(resource.evidence) },
    capture: capture === null ? null : { finalUrl: researchSourceUrl(capture.finalUrl), title: nullable(capture.title),
      author: nullable(capture.author), publishedAt: nullable(capture.publishedAt), version: nullable(capture.version),
      extent: capture.extent as NonNullable<ResearchSourceObservation['capture']>['extent'],
      text: capture.text as string, textSha256: text(capture.textSha256),
      completeness: capture.completeness as NonNullable<ResearchSourceObservation['capture']>['completeness'],
      limitation: nullable(capture.limitation) } }
}
