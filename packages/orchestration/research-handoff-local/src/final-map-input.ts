/** Durable/model JSON parsing for final report mappings. */
import { ResearchActionError, type ResearchFinalMapInput, type ResearchFinalMapId, type ResearchFinalLocation,
  type ResearchFinalReportRef, type ResearchFinalItem, type ResearchRetiredFinalItem, type ResearchClaimId,
  type ResearchCitationId, type ResearchDispositionId, type ResearchArtifactId } from '@deepseek-ai/dsh-research-handoff/api'

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchActionError('invalid final map object', 'FORMAT')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0
    || Buffer.from(value, 'utf8').toString('utf8') !== value) throw new ResearchActionError('invalid final map text', 'FORMAT')
  return value
}
function number(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new ResearchActionError('invalid final map number', 'FORMAT')
  }
  return value
}
function digest(value: unknown): string {
  const result = text(value)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new ResearchActionError('invalid final map digest', 'FORMAT')
  return result
}
function list<T>(value: unknown, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new ResearchActionError('invalid final map list', 'FORMAT')
  return value.map(parse)
}
function ids<T extends string>(value: unknown): T[] {
  const result = list(value, text) as T[]
  if (new Set(result).size !== result.length) throw new ResearchActionError('duplicate final map identity', 'FORMAT')
  return result
}
function location(value: unknown): ResearchFinalLocation {
  const data = object(value), start = number(data.byteStart, 0), end = number(data.byteEnd)
  if (end <= start) throw new ResearchActionError('empty final report range', 'FORMAT')
  return { byteStart: start, byteEnd: end, text: text(data.text) }
}
function report(value: unknown): ResearchFinalReportRef {
  const data = object(value)
  return { artifactId: text(data.artifactId) as ResearchArtifactId, version: number(data.version), sha256: digest(data.sha256) }
}
function item(value: unknown): ResearchFinalItem {
  const data = object(value), kind = data.kind, check = object(data.counterCheck)
  if (kind !== 'adopted-fact' && kind !== 'inference' && kind !== 'recommendation' && kind !== 'hypothesis') {
    throw new ResearchActionError('invalid final item classification', 'FORMAT')
  }
  const hypothesis = data.hypothesis === null ? null : text(data.hypothesis)
  if ((kind === 'hypothesis') !== (hypothesis !== null)) {
    throw new ResearchActionError('final hypothesis needs an explicit condition', 'FORMAT')
  }
  return { claimId: text(data.claimId) as ResearchClaimId, claimTextSha256: digest(data.claimTextSha256), kind,
    location: location(data.location), citationIds: ids<ResearchCitationId>(data.citationIds),
    dependencies: ids<ResearchClaimId>(data.dependencies), limitations: list(data.limitations, text),
    applicability: text(data.applicability), sourceAssessment: text(data.sourceAssessment), hypothesis,
    counterCheck: { scope: text(check.scope), questions: list(check.questions, text),
      citationIds: ids<ResearchCitationId>(check.citationIds),
      unfinished: list(check.unfinished, text) } }
}
function retired(value: unknown): ResearchRetiredFinalItem {
  const data = object(value), kind = data.kind
  if (kind !== 'corrected' && kind !== 'removed') throw new ResearchActionError('invalid retired mapping classification', 'FORMAT')
  return { inventoryVersion: number(data.inventoryVersion), claimId: text(data.claimId) as ResearchClaimId,
    claimTextSha256: digest(data.claimTextSha256), changeVersion: number(data.changeVersion), kind,
    replacementIds: ids<ResearchClaimId>(data.replacementIds), reason: text(data.reason),
    location: data.location === null ? null : location(data.location), dispositionIds: ids<ResearchDispositionId>(data.dispositionIds) }
}

/**
 * Parse complete immutable mapping fields, excluding imported confirmation and completion flags.
 * @param value - Untrusted model, file or durable JSON.
 * @returns Normalized mapping; source and report associations still require the owner store.
 */
export function parseResearchFinalMap(value: unknown): ResearchFinalMapInput {
  const data = object(value), by = data.by
  if (by !== 'model' && by !== 'human') throw new ResearchActionError('invalid final map author', 'FORMAT')
  return { finalMapId: text(data.finalMapId) as ResearchFinalMapId,
    expectedPreviousFinalMapId: data.expectedPreviousFinalMapId === null
      ? null : text(data.expectedPreviousFinalMapId) as ResearchFinalMapId,
    revision: number(data.revision), questionSha256: digest(data.questionSha256), inventoryVersion: number(data.inventoryVersion),
    inventorySha256: digest(data.inventorySha256), geminiReport: report(data.geminiReport), chatgptReport: report(data.chatgptReport),
    finalText: text(data.finalText), items: list(data.items, item), retired: list(data.retired, retired),
    zeroCriticalFactsReason: data.zeroCriticalFactsReason === null ? null : text(data.zeroCriticalFactsReason), by }
}
