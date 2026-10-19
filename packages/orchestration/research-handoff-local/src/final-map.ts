/** Owner-bound final mappings in the existing research database. */
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { ResearchActionError, type ResearchFinalMapInput, type ResearchFinalMap, type ResearchFinalMapId,
  type ResearchFinalLocation, type ResearchFinalReportRef, type ResearchClaimInventory, type ResearchActionRun,
  type ResearchArtifactSnapshot, type ResearchArtifactId, type ResearchCitationAssessment, type ResearchCitationId,
  type ResearchDisposition, type ResearchDispositionId, type ResearchOwnerId, type ResearchRunId,
  type ResearchJudgmentAttribution, type ResearchClaimId } from '@deepseek-ai/dsh-research-handoff/api'
import { parseResearchJudgmentAttribution } from './claim-inventory.ts'
import { parseResearchFinalMap } from './final-map-input.ts'

const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
function fail(message: string): never { throw new ResearchActionError(message, 'CONFLICT') }
function checkLocation(bytes: Buffer, location: ResearchFinalLocation): void {
  if (location.byteEnd > bytes.length || !bytes.subarray(location.byteStart, location.byteEnd).equals(Buffer.from(location.text, 'utf8'))) {
    fail('final location differs from exact UTF8 report bytes')
  }
}
function equalIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(id => right.includes(id))
}
type Records = {
  run(owner: ResearchOwnerId, run: ResearchRunId): ResearchActionRun
  inventory(owner: ResearchOwnerId, run: ResearchRunId, version: number): ResearchClaimInventory
  artifact(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchArtifactId): ResearchArtifactSnapshot
  latestArtifact(owner: ResearchOwnerId, run: ResearchRunId, role: 'gemini-report' | 'chatgpt-report'): ResearchArtifactSnapshot | null
  citation(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchCitationId): ResearchCitationAssessment
  disposition(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchDispositionId): ResearchDisposition
}

/** Immutable report mappings share run ownership, SQLite transactions and existing evidence records. */
export class ResearchFinalMaps {
  constructor(private readonly db: DatabaseSync, private readonly records: Records) {}

  private report(owner: ResearchOwnerId, run: ResearchRunId, ref: ResearchFinalReportRef,
    role: 'gemini-report' | 'chatgpt-report'): ResearchArtifactSnapshot {
    const report = this.records.artifact(owner, run, ref.artifactId)
    if (report.role !== role || report.version !== ref.version || report.sha256 !== ref.sha256 || report.source.extent !== 'complete') {
      fail('final map report identity or complete capture conflicts')
    }
    return report
  }

  private validate(owner: ResearchOwnerId, run: ResearchRunId, input: ResearchFinalMapInput): ResearchClaimInventory {
    const inventory = this.records.inventory(owner, run, input.inventoryVersion)
    if (inventory.sha256 !== input.inventorySha256 || inventory.runRevision !== input.revision
      || inventory.input.questionSha256 !== input.questionSha256) fail('final map inventory or original question conflicts')
    const gemini = this.report(owner, run, input.geminiReport, 'gemini-report')
    const chatgpt = this.report(owner, run, input.chatgptReport, 'chatgpt-report')
    if (!inventory.input.materials.some(x => x.artifactId === gemini.artifactId && x.sha256 === gemini.sha256)
      || !inventory.input.materials.some(x => x.artifactId === chatgpt.artifactId && x.sha256 === chatgpt.sha256)) {
      fail('final map reports are not the inventory materials')
    }
    const bytes = Buffer.from(input.finalText, 'utf8')
    if (!bytes.equals(Buffer.from(chatgpt.bytes))) fail('final map text differs from complete ChatGPT report')
    const mapped = new Map(input.items.map(x => [x.claimId, x]))
    if (mapped.size !== input.items.length || mapped.size !== inventory.input.claims.length) fail('final map candidate coverage conflicts')
    for (const item of input.items) {
      const claim = inventory.input.claims.find(x => x.id === item.claimId)
      if (claim === undefined || sha(claim.text) !== item.claimTextSha256) fail('final map claim text conflicts')
      checkLocation(bytes, item.location)
      for (const id of item.dependencies) if (!mapped.has(id)) fail('final dependency has no mapped candidate')
      for (const id of item.citationIds) {
        const citation = this.records.citation(owner, run, id).input
        if (citation.inventoryVersion !== input.inventoryVersion || citation.inventorySha256 !== inventory.sha256
          || citation.claimId !== item.claimId || citation.claimTextSha256 !== item.claimTextSha256) {
          fail('final citation does not assess the current exact claim')
        }
      }
      for (const id of item.counterCheck.citationIds) this.records.citation(owner, run, id)
    }
    const visiting = new Set<ResearchClaimId>(), done = new Set<ResearchClaimId>()
    const visit = (id: ResearchClaimId): void => {
      if (visiting.has(id)) fail('final dependency graph has a cycle')
      if (done.has(id)) return
      visiting.add(id)
      const item = mapped.get(id)
      assert(item !== undefined)
      for (const dependency of item.dependencies) visit(dependency)
      visiting.delete(id); done.add(id)
    }
    for (const id of mapped.keys()) visit(id)
    this.validateRetired(owner, run, input, inventory, bytes)
    return inventory
  }

  private validateRetired(owner: ResearchOwnerId, run: ResearchRunId, input: ResearchFinalMapInput,
    current: ResearchClaimInventory, bytes: Buffer): void {
    const inventories = new Map<number, ResearchClaimInventory>([[current.version, current]])
    for (let version = 1; version < current.version; version++) {
      inventories.set(version, this.records.inventory(owner, run, version))
    }
    const inventoryAt = (version: number): ResearchClaimInventory => {
      const result = inventories.get(version)
      assert(result !== undefined)
      return result
    }
    const keys = new Set<string>()
    for (const retired of input.retired) {
      const key = String(retired.inventoryVersion) + ':' + retired.claimId
      if (keys.has(key)) fail('duplicate retired final item')
      keys.add(key)
      const original = inventories.get(retired.inventoryVersion)
      const claim = original?.input.claims.find(x => x.id === retired.claimId)
      if (original === undefined || original.input.questionSha256 !== input.questionSha256 || claim === undefined
        || sha(claim.text) !== retired.claimTextSha256 || retired.changeVersion <= original.version
        || retired.changeVersion > current.version) fail('retired final item has no exact original candidate')
      for (let version = original.version + 1; version <= retired.changeVersion; version++) {
        const previous = inventoryAt(version - 1).input.claims.find(x => x.id === retired.claimId)
        if (previous === undefined || previous.text !== claim.text || previous.critical !== claim.critical) {
          fail('retired change skips an earlier candidate revision')
        }
      }
      const change = inventoryAt(retired.changeVersion).input.changes.find(x => x.from.includes(retired.claimId))
      if (change === undefined || (retired.kind === 'removed') !== (change.kind === 'remove')) {
        fail('retired final item has no matching lineage change')
      }
      let descendants = new Set(change.to)
      for (let version = retired.changeVersion + 1; version <= current.version; version++) {
        const before = descendants, after = new Set(before)
        for (const next of inventoryAt(version).input.changes) if (next.from.some(id => before.has(id))) {
          for (const id of next.from) after.delete(id)
          for (const id of next.to) after.add(id)
        }
        descendants = after
      }
      if (!equalIds(retired.replacementIds, [...descendants])
        || retired.replacementIds.some(id => !input.items.some(x => x.claimId === id))) fail('retired replacements differ from lineage')
      if (claim.critical && retired.location === null) fail('retired critical candidate needs a final revision location')
      if (retired.location !== null) checkLocation(bytes, retired.location)
      for (const id of retired.dispositionIds) {
        const target = this.records.disposition(owner, run, id).input.target
        if (target.claimId !== retired.claimId || target.claimTextSha256 !== retired.claimTextSha256) {
          fail('retired disposition targets another original claim')
        }
      }
    }
    for (const inventory of inventories.values()) {
      if (inventory.input.questionSha256 !== input.questionSha256) continue
      for (const claim of inventory.input.claims) {
        if (!claim.critical || current.input.claims.some(x => x.id === claim.id && x.text === claim.text && x.critical)) continue
        if (!input.retired.some(x => x.claimId === claim.id && x.claimTextSha256 === sha(claim.text)
          && inventories.get(x.inventoryVersion)?.input.claims.find(c => c.id === x.claimId)?.critical === true)) {
          fail('historical critical candidate is missing from final revisions')
        }
      }
    }
  }

  private isCurrent(owner: ResearchOwnerId, run: ResearchRunId, input: ResearchFinalMapInput): boolean {
    const current = this.records.run(owner, run), inventory = this.records.inventory(owner, run, input.inventoryVersion)
    if (current.revision !== input.revision || current.binding.questionSha256 !== input.questionSha256 || !inventory.isCurrent) return false
    for (const [role, ref] of [['gemini-report', input.geminiReport], ['chatgpt-report', input.chatgptReport]] as const) {
      const latest = this.records.latestArtifact(owner, run, role)
      if (latest === null || latest.artifactId !== ref.artifactId || latest.version !== ref.version
        || latest.sha256 !== ref.sha256 || latest.source.extent !== 'complete') return false
    }
    const latest = this.db.prepare('SELECT map_id FROM research_final_maps WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(run)
    return latest?.map_id === input.finalMapId
  }

  /**
   * Append an immutable exact report mapping under the existing owner transaction.
   * @param owner - Current Host owner.
   * @param run - Owned run.
   * @param value - Untrusted mapping JSON, never imported confirmation or completion controls.
   * @param attribution - Actual Host channel, independent of declared by.
   * @returns Retained mapping; factual verification and current completion remain separate.
   */
  append(owner: ResearchOwnerId, run: ResearchRunId, value: unknown, attribution: ResearchJudgmentAttribution): ResearchFinalMap {
    const input = parseResearchFinalMap(value), channel = parseResearchJudgmentAttribution(attribution)
    if (channel.ownerId !== owner) throw new ResearchActionError('final mapping owner conflicts', 'OWNER')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const inventory = this.validate(owner, run, input), raw = JSON.stringify(input), channelRaw = JSON.stringify(channel)
      const existing = this.db.prepare('SELECT * FROM research_final_maps WHERE run_id=? AND map_id=?').get(run, input.finalMapId)
      if (existing !== undefined) {
        if (existing.input_json !== raw || existing.attribution_json !== channelRaw) fail('immutable final map conflicts')
      }
      else {
        const current = this.records.run(owner, run)
        if (!inventory.isCurrent || current.revision !== input.revision) fail('final map requires current inventory and revision')
        for (const [role, ref] of [['gemini-report', input.geminiReport], ['chatgpt-report', input.chatgptReport]] as const) {
          const latest = this.records.latestArtifact(owner, run, role)
          if (latest?.artifactId !== ref.artifactId) fail('final map requires latest two-stage reports')
        }
        const previous = this.db.prepare('SELECT map_id FROM research_final_maps WHERE run_id=? ORDER BY seq DESC LIMIT 1').get(run)
        if ((previous?.map_id ?? null) !== input.expectedPreviousFinalMapId) fail('final map changed')
        this.db.prepare(
          'INSERT INTO research_final_maps(run_id,map_id,input_json,sha256,attribution_json,attribution_sha256,recorded_at) VALUES(?,?,?,?,?,?,?)')
          .run(run, input.finalMapId, raw, sha(raw), channelRaw, sha(channelRaw), new Date().toISOString())
      }
      const result = this.read(owner, run, input.finalMapId)
      this.db.exec('COMMIT'); return result
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  /**
   * Read historical mapping bytes and recompute current confirmation validity.
   * @param owner - Current Host owner.
   * @param run - Owned run.
   * @param id - Original mapping identity.
   * @returns Complete mapping with separate historical and current confirmation flags.
   */
  read(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchFinalMapId): ResearchFinalMap {
    this.records.run(owner, run)
    const row = this.db.prepare('SELECT * FROM research_final_maps WHERE run_id=? AND map_id=?').get(run, id)
    if (row === undefined) throw new ResearchActionError('final map not found', 'NOT_FOUND')
    if (typeof row.input_json !== 'string' || typeof row.attribution_json !== 'string' || typeof row.recorded_at !== 'string'
      || typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 1 || sha(row.input_json) !== row.sha256
      || sha(row.attribution_json) !== row.attribution_sha256
      || !Number.isFinite(Date.parse(row.recorded_at))) throw new ResearchActionError('damaged final mapping record', 'FORMAT')
    const input = parseResearchFinalMap(JSON.parse(row.input_json))
    const attribution = parseResearchJudgmentAttribution(JSON.parse(row.attribution_json))
    if (input.finalMapId !== id || attribution.ownerId !== owner) throw new ResearchActionError('damaged final mapping identity', 'FORMAT')
    const inventory = this.validate(owner, run, input)
    const previous = this.db.prepare('SELECT map_id FROM research_final_maps WHERE run_id=? AND seq<? ORDER BY seq DESC LIMIT 1').get(run, row.seq)
    if ((previous?.map_id ?? null) !== input.expectedPreviousFinalMapId) {
      throw new ResearchActionError('damaged final mapping predecessor', 'FORMAT')
    }
    let recordedConfirmation = false
    if (row.confirmation_json !== null) {
      if (typeof row.confirmation_json !== 'string' || sha(row.confirmation_json) !== row.confirmation_sha256) {
        throw new ResearchActionError('damaged final mapping confirmation', 'FORMAT')
      }
      const confirmation: unknown = JSON.parse(row.confirmation_json)
      if (confirmation === null || typeof confirmation !== 'object' || Array.isArray(confirmation)) {
        throw new ResearchActionError('invalid final mapping confirmation', 'FORMAT')
      }
      const data = confirmation as Record<string, unknown>
      if (data.sha256 !== row.sha256 || typeof data.at !== 'string' || !Number.isFinite(Date.parse(data.at))) {
        throw new ResearchActionError('final mapping confirmation identity changed', 'FORMAT')
      }
      if (parseResearchJudgmentAttribution(data.attribution).ownerId !== owner) {
        throw new ResearchActionError('final mapping confirmation owner changed', 'FORMAT')
      }
      recordedConfirmation = true
    }
    const isCurrent = this.isCurrent(owner, run, input)
    return { seq: row.seq, input, sha256: sha(row.input_json), attribution, recordedAt: row.recorded_at,
      isCurrent, recordedConfirmation, confirmed: isCurrent && recordedConfirmation && inventory.denominatorConfirmed }
  }

  /**
   * Confirm the exact current map through a live Host control, never imported JSON.
   * @param owner - Current Host owner.
   * @param run - Owned run.
   * @param id - Current mapping.
   * @param digest - Exact reviewed mapping digest.
   * @param attribution - Current actual Host channel.
   * @returns Current confirmation without declaring factual verification or final completion.
   */
  confirm(owner: ResearchOwnerId, run: ResearchRunId, id: ResearchFinalMapId, digest: string,
    attribution: ResearchJudgmentAttribution): ResearchFinalMap {
    const channel = parseResearchJudgmentAttribution(attribution)
    if (channel.ownerId !== owner) throw new ResearchActionError('final confirmation owner conflicts', 'OWNER')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const map = this.read(owner, run, id), inventory = this.records.inventory(owner, run, map.input.inventoryVersion)
      if (!map.isCurrent || map.sha256 !== digest || !inventory.denominatorConfirmed) {
        throw new ResearchActionError('final confirmation requires the exact current map and confirmed denominator', 'CONFIRMATION')
      }
      const criticalIds = new Set(inventory.input.claims.filter(x => x.critical).map(x => x.id))
      const criticalFacts = map.input.items.filter(item => item.kind === 'adopted-fact' && criticalIds.has(item.claimId))
      if (criticalFacts.length === 0 && map.input.zeroCriticalFactsReason === null) {
        throw new ResearchActionError('zero critical facts require explicit applicability reasoning', 'CONFIRMATION')
      }
      const raw = JSON.stringify({ sha256: digest, attribution: channel, at: new Date().toISOString() })
      this.db.prepare('UPDATE research_final_maps SET confirmation_json=?,confirmation_sha256=? WHERE run_id=? AND map_id=?')
        .run(raw, sha(raw), run, id)
      const result = this.read(owner, run, id)
      this.db.exec('COMMIT'); return result
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
