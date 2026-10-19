/** Same-SQLite immutable delivery observations; action acceptance commits independently first. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ResearchActionError, type ResearchAcceptedResource, type ResearchActionId, type ResearchActionSnapshot,
  type ResearchDeliveryRecord, type ResearchDriverDelivery, type ResearchExternalDeliveryId,
  type ResearchOwnerId, type ResearchRunId } from '@deepseek-ai/dsh-research-handoff'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchActionError('invalid research delivery object', 'FORMAT')
  }
  return value as Record<string, unknown>
}

function text(value: Record<string, unknown>, key: string): string {
  const result = value[key]
  if (typeof result !== 'string' || !result) throw new ResearchActionError('invalid research delivery ' + key, 'FORMAT')
  return result
}

function utf8(value: unknown): string {
  if (typeof value !== 'string' || Buffer.from(value, 'utf8').toString('utf8') !== value) {
    throw new ResearchActionError('research delivery requires lossless UTF-8 text', 'FORMAT')
  }
  return value
}

function observation(value: unknown): ResearchDriverDelivery {
  const raw = object(value), read = object(raw.readBack)
  if (raw.kind !== 'message' && raw.kind !== 'attachment') throw new ResearchActionError('invalid delivery kind', 'FORMAT')
  const observedAt = text(raw, 'observedAt')
  if (!Number.isFinite(Date.parse(observedAt))) throw new ResearchActionError('invalid delivery observation time', 'FORMAT')
  let readBack: ResearchDriverDelivery['readBack']
  if (read.kind === 'unavailable') readBack = { kind: 'unavailable', reason: text(read, 'reason') }
  else if (read.kind === 'complete-text' || read.kind === 'partial-text') {
    readBack = { kind: read.kind, text: utf8(read.text), evidence: text(read, 'evidence') }
  }
  else throw new ResearchActionError('delivery read-back extent is missing', 'FORMAT')
  return { kind: raw.kind, externalId: text(raw, 'externalId') as ResearchExternalDeliveryId,
    observedAt, evidence: text(raw, 'evidence'), readBack }
}

function resource(value: unknown): ResearchAcceptedResource {
  const raw = object(value)
  for (const key of ['conversation', 'report']) {
    if (raw[key] !== null && (typeof raw[key] !== 'string' || !raw[key])) {
      throw new ResearchActionError('invalid delivery resource identity', 'FORMAT')
    }
  }
  return { workspace: text(raw, 'workspace'), page: text(raw, 'page'),
    conversation: raw.conversation as string | null, report: raw.report as string | null, evidence: text(raw, 'evidence') }
}

function normalized(current: ResearchActionSnapshot, value: unknown, savedResource: ResearchAcceptedResource) {
  const original = current.acceptedResource
  if (original === null || !['accepted', 'completed'].includes(current.state)
    || savedResource.workspace !== original.workspace || savedResource.page !== original.page
    || savedResource.conversation !== null && savedResource.conversation !== original.conversation
    || savedResource.report !== null && savedResource.report !== original.report) {
    throw new ResearchActionError('delivery has no matching original accepted resource', 'CONFLICT')
  }
  const observed = observation(value)
  const expected = current.request.kind === 'chatgpt-upload' ? 'attachment'
    : current.request.kind === 'gemini-plan-submit' || current.request.kind === 'chatgpt-submit' ? 'message' : null
  if (observed.kind !== expected) throw new ResearchActionError('delivery kind differs from original action', 'CONFLICT')
  const originalText = utf8(current.request.input)
  const contentStatus = observed.readBack.kind !== 'complete-text' ? 'not-read-back' as const
    : Buffer.from(originalText, 'utf8').equals(Buffer.from(observed.readBack.text, 'utf8')) ? 'matched' as const : 'mismatched' as const
  return { runId: current.request.runId, actionId: current.request.actionId, requestSha256: current.inputSha256,
    resource: savedResource, observation: observed, contentStatus }
}

/** Delivery history within the existing action database; it never submits or changes an action. */
export class ResearchDeliveryRecords {
  /**
   * @param db - Database owned and closed by the research action store.
   * @param action - Owner-authorized original action lookup.
   */
  constructor(private readonly db: DatabaseSync,
    private readonly action: (owner: ResearchOwnerId, run: ResearchRunId, action: ResearchActionId) => ResearchActionSnapshot) {}

  /**
   * Append one actual Driver observation after action acceptance has independently committed.
   * @param owner - Current Host owner.
   * @param run - Original run.
   * @param id - Original action.
   * @param inputSha256 - Original complete request digest from the validated Driver receipt.
   * @param value - Driver delivery fields; parsed independently of the action receipt.
   * @returns Immutable original or appended delivery record.
   */
  record(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchActionId,
    inputSha256: string, value: unknown): ResearchDeliveryRecord {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.action(owner, run, id)
      if (inputSha256 !== current.inputSha256 || current.acceptedResource === null) {
        throw new ResearchActionError('delivery original action differs', 'CONFLICT')
      }
      const packet = normalized(current, value, structuredClone(current.acceptedResource))
      const history = this.read(owner, run, id)
      if (history.some(x => x.observation.kind === packet.observation.kind && x.observation.externalId !== packet.observation.externalId)) {
        throw new ResearchActionError('delivery external identity cannot be replaced', 'CONFLICT')
      }
      const json = JSON.stringify(packet), sha256 = digest(json)
      const original = history.find(x => x.sha256 === sha256)
      if (original !== undefined) { this.db.exec('COMMIT'); return original }
      const recordedAt = new Date().toISOString()
      const result = this.db.prepare('INSERT INTO research_deliveries(run_id,action_id,input_json,sha256,recorded_at) VALUES(?,?,?,?,?)')
        .run(run, id, json, sha256, recordedAt)
      this.db.exec('COMMIT')
      return { seq: Number(result.lastInsertRowid), ...packet, sha256, recordedAt }
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /**
   * Read all original observations, including historical mismatches and unavailable read-backs.
   * @param owner - Current Host owner; digests do not authorize reads.
   * @param run - Original run.
   * @param id - Original action.
   * @returns Full ordered evidence; later identity completion cannot rewrite old resource snapshots.
   */
  read(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchActionId): ResearchDeliveryRecord[] {
    const current = this.action(owner, run, id)
    const records = this.db.prepare('SELECT * FROM research_deliveries WHERE run_id=? AND action_id=? ORDER BY seq').all(run, id).map((row) => {
      const json = text(row, 'input_json'), sha256 = text(row, 'sha256')
      if (digest(json) !== sha256 || typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 1) {
        throw new ResearchActionError('corrupt research delivery record', 'FORMAT')
      }
      const raw = object(JSON.parse(json) as unknown)
      const packet = normalized(current, raw.observation, resource(raw.resource))
      if (raw.runId !== run || raw.actionId !== id || raw.requestSha256 !== current.inputSha256
        || raw.contentStatus !== packet.contentStatus || digest(JSON.stringify(packet)) !== sha256) {
        throw new ResearchActionError('durable delivery association or content status differs', 'FORMAT')
      }
      return { seq: row.seq, ...packet, sha256, recordedAt: text(row, 'recorded_at') }
    })
    if (new Set(records.map(x => x.observation.externalId)).size > 1) {
      throw new ResearchActionError('durable delivery external identity differs across history', 'FORMAT')
    }
    return records
  }
}
