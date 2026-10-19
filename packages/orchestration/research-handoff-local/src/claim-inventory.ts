/** Versioned critical-claim candidates and attributed judgments, separate from source-read proof. */
import type {
  ResearchArtifactId, ResearchClaimId, ResearchJudgmentId, ResearchClaimOrigin, ResearchClaim, ResearchClaimChange,
  ResearchInventoryMaterial, ResearchClaimInventoryInput, ResearchClaimJudgmentInput, ResearchJudgmentAttribution,
} from '@deepseek-ai/dsh-research-handoff/api'

/** Malformed candidate data or missing derivation for a changed inventory. */
export class ResearchClaimError extends Error {
  constructor(message: string) { super(message); this.name = 'ResearchClaimError' }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ResearchClaimError('invalid claim record')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ResearchClaimError('claim text or identity is empty')
  return value
}

function hash(value: unknown): string {
  const result = text(value)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new ResearchClaimError('invalid claim material digest')
  return result
}

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ResearchClaimError('invalid claim identity list')
  const result = value.map(text)
  if (new Set(result).size !== result.length) throw new ResearchClaimError('duplicate claim identity')
  return result
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ResearchClaimError('invalid claim list')
  return value
}

/**
 * Parse imported candidate JSON into data only, excluding any supplied confirmation fields.
 * @param value - Untrusted model, file, or durable JSON.
 * @returns Valid normalized candidates and material associations; semantic source support is not inferred.
 */
export function parseResearchClaimInventory(value: unknown): ResearchClaimInventoryInput {
  const root = record(value)
  if (!Number.isSafeInteger(root.expectedVersion) || (root.expectedVersion as number) < 0) {
    throw new ResearchClaimError('invalid expected inventory version')
  }
  const materials = array(root.materials).map((item): ResearchInventoryMaterial => {
    const entry = record(item)
    return { artifactId: text(entry.artifactId) as ResearchArtifactId, sha256: hash(entry.sha256) }
  })
  if (new Set(materials.map(x => x.artifactId)).size !== materials.length) throw new ResearchClaimError('duplicate inventory material')
  const claims = array(root.claims).map((item): ResearchClaim => {
    const entry = record(item)
    if (typeof entry.critical !== 'boolean') throw new ResearchClaimError('invalid claim criticality')
    const origins = array(entry.origins).map((item): ResearchClaimOrigin => {
      const origin = record(item)
      if (!['question', 'gemini-report', 'chatgpt-addition'].includes(text(origin.kind))) throw new ResearchClaimError('invalid claim origin')
      const kind = origin.kind as ResearchClaimOrigin['kind']
      const artifactId = origin.artifactId === null ? null : text(origin.artifactId) as ResearchArtifactId
      if ((kind === 'question') !== (artifactId === null)) throw new ResearchClaimError('claim origin material identity does not match its kind')
      return { kind, artifactId, sha256: hash(origin.sha256) }
    })
    if (origins.length < 1) throw new ResearchClaimError('claim has no original material')
    return { id: text(entry.id) as ResearchClaimId, text: text(entry.text), critical: entry.critical, origins }
  })
  if (new Set(claims.map(x => x.id)).size !== claims.length) throw new ResearchClaimError('duplicate claim identity')
  const changes = array(root.changes).map((item): ResearchClaimChange => {
    const entry = record(item)
    if (!['add', 'remove', 'revise', 'split', 'merge', 'downgrade'].includes(text(entry.kind))) throw new ResearchClaimError('invalid claim change')
    return {
      kind: entry.kind as ResearchClaimChange['kind'], from: ids(entry.from) as ResearchClaimId[],
      to: ids(entry.to) as ResearchClaimId[], reason: text(entry.reason),
    }
  })
  return { expectedVersion: root.expectedVersion as number, questionSha256: hash(root.questionSha256), materials, claims, changes }
}

/**
 * Require explicit parent/child identities and reasons for every changed, retired, or new candidate.
 * @param previous - Previous retained inventory, or null for initial candidates.
 * @param next - Parsed candidate input.
 */
export function validateResearchClaimChanges(previous: ResearchClaimInventoryInput | null, next: ResearchClaimInventoryInput): void {
  const before = new Map(previous?.claims.map(x => [x.id, x]))
  const after = new Map(next.claims.map(x => [x.id, x]))
  for (const change of next.changes) {
    if (change.from.some(id => !before.has(id)) || change.to.some(id => !after.has(id))) {
      throw new ResearchClaimError('claim derivation refers to an unknown parent or child')
    }
    const a = change.from.length
    const b = change.to.length
    const valid = change.kind === 'add' ? a === 0 && b > 0
      : change.kind === 'remove' ? a > 0 && b === 0
        : change.kind === 'split' ? a === 1 && b > 1
          : change.kind === 'merge' ? a > 1 && b === 1
            : a === 1 && b === 1
    if (!valid) throw new ResearchClaimError('claim derivation cardinality does not match its operation')
    if (change.kind === 'downgrade') {
      const from = change.from.at(0)
      const to = change.to.at(0)
      if (from === undefined || to === undefined || !before.get(from)?.critical || after.get(to)?.critical !== false) {
        throw new ResearchClaimError('claim downgrade must retain an explicitly critical parent')
      }
    }
  }
  if (previous === null) return
  for (const claim of previous.claims) {
    const replacement = after.get(claim.id)
    if (JSON.stringify(replacement) !== JSON.stringify(claim)
      && !next.changes.some(change => change.from.includes(claim.id))) {
      throw new ResearchClaimError('changed or removed claim has no derivation')
    }
  }
  for (const claim of next.claims) {
    if (JSON.stringify(before.get(claim.id)) !== JSON.stringify(claim)
      && !next.changes.some(change => change.to.includes(claim.id))) {
      throw new ResearchClaimError('new or revised claim has no derivation')
    }
  }
}

/**
 * Parse an attributed interpretation without promoting it to source-read or control-plane evidence.
 * @param value - Untrusted model, human-entry, or durable JSON.
 * @returns Normalized judgment; supplied completion or coverage claims are excluded.
 */
export function parseResearchClaimJudgment(value: unknown): ResearchClaimJudgmentInput {
  const root = record(value)
  if (!Number.isSafeInteger(root.inventoryVersion) || (root.inventoryVersion as number) < 1
    || !['model', 'human'].includes(text(root.by))
    || !['supported', 'contradicted', 'unverifiable'].includes(text(root.status))) throw new ResearchClaimError('invalid claim judgment')
  return {
    judgmentId: text(root.judgmentId) as ResearchJudgmentId, inventoryVersion: root.inventoryVersion as number,
    claimId: text(root.claimId) as ResearchClaimId, by: root.by as ResearchClaimJudgmentInput['by'],
    status: root.status as ResearchClaimJudgmentInput['status'], rationale: text(root.rationale),
    materialArtifactIds: ids(root.materialArtifactIds) as ResearchArtifactId[],
  }
}

/**
 * Parse Host-supplied or durable channel attribution independently of judgment JSON.
 * @param value - Explicit Host metadata or stored JSON.
 * @returns Retained Host assertion, not independent human-presence proof.
 */
export function parseResearchJudgmentAttribution(value: unknown): ResearchJudgmentAttribution {
  const root = record(value)
  if (!['imported', 'model', 'human'].includes(text(root.channel))) throw new ResearchClaimError('invalid judgment channel')
  return { channel: root.channel as ResearchJudgmentAttribution['channel'],
    ownerId: text(root.ownerId) as ResearchJudgmentAttribution['ownerId'], hostPolicyVersion: text(root.hostPolicyVersion) }
}
