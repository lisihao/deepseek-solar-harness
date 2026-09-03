/** Owner-local persistent Debate Provider over an injected turn executor. */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { withFileLock, writeFileAtomicSync } from '@deepseek-ai/dsh-atomic-write'
import DebateService, {
  DebateError,
  validateDebateControlRequest,
  validateDebateEventReadRequest,
  validateDebatePolicy,
  validateDebateStartRequest,
} from '@deepseek-ai/dsh-debate'
import type {
  DebateAgentProgressKindV1,
  DebateAgentProgressUsageV1,
  DebateAgentTurnV1,
  DebateClaimLedgerV1,
  DebateClaimSeverity,
  DebateClaimStatus,
  DebateClaimV1,
  DebateControlRequestV1,
  DebateDissentV1,
  DebateEventPageV1,
  DebateEventReadRequestV1,
  DebateEventType,
  DebateEventV1,
  DebateEvidenceRefV1,
  DebateJsonValue,
  DebateLifecycle,
  DebateRoleId,
  DebateRoleSpecV1,
  DebateRoundSnapshotV1,
  DebateRunSnapshotV1,
  DebateRunSummaryV1,
  DebateStartRequestV1,
  DebateTopicV1,
  DebateTurnRoutingV1,
  DebateUnresolvedV1,
  DebateUsageV1,
} from '@deepseek-ai/dsh-debate'
import type {
  Config,
  Config as ProviderConfig,
  DebateRoundExecutor,
  DebateRoundExecutionResultV1,
  DebateRoundAgentProgressV1,
  DebateTurnPhase,
  DebateTurnRequestV1,
  DebateTurnResultV1,
  LocalDebateConfig,
  LocalDebateProviderOptions,
} from './types.ts'

export type * from './types.ts'
export * from './quality-eval.ts'

export const name = 'debate-local'

/** Provider package version recorded in provenance when no override is supplied. */
export const VERSION = '0.1.0-rc.5'

const STATE_VERSION = 1
const DEFAULT_EVENT_LIMIT = 100
const MAX_PREVIEW_LENGTH = 4_000
const MAX_OUTPUT_REF_LENGTH = 2_000
const MAX_FOLLOW_UP_JUDGE_CLAIMS = 4
const MAX_PROGRESS_SOURCE_ID_LENGTH = 512
const MAX_PROGRESS_TEXT_LENGTH = 1_600
const MAX_PROGRESS_NAME_LENGTH = 160
const DEBATE_ROLE_ORDER: readonly DebateRoleId[] = [
  'constructive-proposer',
  'skeptical-falsifier',
  'evidence-auditor',
  'decision-judge',
]
const ROLE_INDEX = new Map<string, number>(DEBATE_ROLE_ORDER.map((role, index) => [role, index]))
const CLAIM_STATUSES = new Set<DebateClaimStatus>(['open', 'supported', 'refuted', 'settled', 'unresolved'])
const CLAIM_SEVERITIES = new Set<DebateClaimSeverity>(['low', 'medium', 'high', 'critical'])
const EVIDENCE_KINDS = new Set<DebateEvidenceRefV1['kind']>(['source', 'artifact', 'observation', 'quote'])
const PROGRESS_KINDS = new Set<DebateAgentProgressKindV1>([
  'phase',
  'public-output',
  'tool-started',
  'tool-completed',
  'approval-required',
  'usage-updated',
])

/** Runtime record kept beside the inspect projection so a resumed run can re-enter the executor. */
interface StoredRun {
  readonly runId: string
  readonly request: DebateStartRequestV1
  snapshot: DebateRunSnapshotV1
  events: DebateEventV1[]
  controlIntent?: {
    readonly action: 'pause' | 'stop'
    readonly reason: string
    readonly commandId: string
  }
}

/** Durable idempotency receipt for one accepted start or control command. */
interface StoredCommand {
  readonly commandId: string
  readonly method: 'start' | 'control'
  readonly requestSha256: string
  readonly runId: string
  state: 'accepted' | 'running' | 'settled' | 'indeterminate'
  response?: DebateRunSnapshotV1
}

/** Versioned owner-local document written with atomic replacement. */
interface StoreDocument {
  readonly version: 1
  generation: number
  runs: StoredRun[]
  commands: StoredCommand[]
}

interface ActiveRun {
  readonly commandId: string
  readonly controller: AbortController
  intent?: 'pause' | 'stop'
  readonly promise: Promise<DebateRunSnapshotV1>
}

interface NormalizedTurnResult {
  readonly confidence: number
  readonly outputRef?: string
  readonly outputPreview?: string
  readonly claims: readonly DebateClaimV1[]
  readonly dissent: readonly DebateDissentV1[]
  readonly unresolved: readonly DebateUnresolvedV1[]
  readonly evidenceRefs: readonly DebateEvidenceRefV1[]
  readonly usage?: DebateUsageV1
}

interface TurnContribution {
  readonly slot: DebateRoleSpecV1
  readonly result: NormalizedTurnResult
}

interface ConvergenceResult {
  readonly version: 1
  readonly status: 'converged' | 'continue' | 'budget_limited' | 'max_rounds'
  readonly score: number
  readonly threshold: number
  readonly disagreement: number
  readonly coverage: number
  readonly unresolvedHighSeverity: number
  readonly settledAgents: number
  readonly reason: string
}

function invalid(message: string): never {
  throw new DebateError(message, 'DEBATE_INVALID')
}

function unavailable(message: string, options?: ErrorOptions): never {
  throw new DebateError(message, 'DEBATE_PROVIDER_UNAVAILABLE', options)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, path: string, max = 16_000): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    invalid(`${path} must be a non-blank string of at most ${String(max)} characters`)
  }
  return value
}

function optionalText(value: unknown, path: string, max: number): string | undefined {
  return value === undefined ? undefined : text(value, path, max)
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(`${path} must be a non-negative safe integer`)
  return value
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`${path} must be a non-negative finite number`)
  return value
}

function boundedConfidence(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid(`${path} must be from 0 through 1`)
  return value
}

function enumValue<T extends string>(value: unknown, path: string, values: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !values.has(value as T)) invalid(`${path} has an unsupported value`)
  return value as T
}

function arrayOfText(value: unknown, path: string, maxItems = 128, maxText = 256): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid(`${path} must be an array with at most ${String(maxItems)} entries`)
  return value.map((entry, index) => text(entry, `${path}[${String(index)}]`, maxText))
}

function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'number' && !Number.isFinite(value)) invalid('canonical value must contain finite numbers')
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const objectValue = value as Record<string, unknown>
    return `{${Object.keys(objectValue).sort((left, right) => left.localeCompare(right))
      .map(key => `${JSON.stringify(key)}:${canonical(objectValue[key])}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function roundNumber(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function roleOrder(role: string): number {
  return ROLE_INDEX.get(role) ?? Number.MAX_SAFE_INTEGER
}

function orderedRoster(roster: readonly DebateRoleSpecV1[]): DebateRoleSpecV1[] {
  return [...roster].sort((left, right) => roleOrder(left.role) - roleOrder(right.role) || left.role.localeCompare(right.role))
}

function claimKey(claim: DebateClaimV1): string {
  return claim.claimId
}

function evidenceKey(ref: DebateEvidenceRefV1): string {
  return `${ref.kind}:${ref.ref}:${ref.digest ?? ''}`
}

function severityRank(severity: DebateClaimSeverity): number {
  switch (severity) {
    case 'critical': return 4
    case 'high': return 3
    case 'medium': return 2
    case 'low': return 1
  }
}

function sourceEvidence(ref: NonNullable<DebateStartRequestV1['sourceRefs']>[number]): DebateEvidenceRefV1 {
  const kind: DebateEvidenceRefV1['kind'] = ref.kind === 'artifact'
    ? 'artifact'
    : ref.kind === 'evidence' || ref.kind === 'document' || ref.kind === 'url'
      ? 'source'
      : 'observation'
  return {
    version: 1,
    ref: ref.ref,
    kind,
    ...(ref.digest === undefined ? {} : { digest: ref.digest }),
  }
}

function emptyLedger(): DebateClaimLedgerV1 {
  const base = { version: 1 as const, claims: [] as readonly DebateClaimV1[], coverage: 0 }
  return { ...base, digest: `sha256:${sha256(base)}` }
}

function emptyCost(): DebateRunSnapshotV1['cost'] {
  return {
    version: 1,
    usageStatus: 'known',
    costStatus: 'known',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    costUsd: 0,
    unknownUsageTurns: 0,
    unknownCostTurns: 0,
    bySlot: [],
  }
}

function normalizeEvidence(value: unknown, path: string): DebateEvidenceRefV1 {
  const evidence = record(value, path)
  if (evidence.version !== 1) invalid(`${path}.version must be 1`)
  const kind = enumValue(evidence.kind, `${path}.kind`, EVIDENCE_KINDS)
  const digest = optionalText(evidence.digest, `${path}.digest`, 256)
  return {
    version: 1,
    ref: text(evidence.ref, `${path}.ref`, 2_000),
    kind,
    ...(digest === undefined ? {} : { digest }),
  }
}

function normalizeClaim(value: unknown, slotId: string, path: string): DebateClaimV1 {
  const claim = record(value, path)
  if (claim.version !== 1) invalid(`${path}.version must be 1`)
  const supporting = arrayOfText(claim.supportingSlotIds, `${path}.supportingSlotIds`)
  const opposing = arrayOfText(claim.opposingSlotIds, `${path}.opposingSlotIds`)
  const supportSlots = supporting.length === 0 && opposing.length === 0 ? [slotId] : supporting
  const evidenceValue = claim.evidenceRefs
  if (!Array.isArray(evidenceValue) || evidenceValue.length > 128) invalid(`${path}.evidenceRefs must be an array with at most 128 entries`)
  const evidenceRefs = evidenceValue.map((entry, index) => normalizeEvidence(entry, `${path}.evidenceRefs[${String(index)}]`))
  const rationale = optionalText(claim.rationale, `${path}.rationale`, 16_000)
  return {
    version: 1,
    claimId: text(claim.claimId, `${path}.claimId`, 256),
    statement: text(claim.statement, `${path}.statement`, 20_000),
    status: enumValue(claim.status, `${path}.status`, CLAIM_STATUSES),
    severity: enumValue(claim.severity, `${path}.severity`, CLAIM_SEVERITIES),
    confidence: boundedConfidence(claim.confidence, `${path}.confidence`),
    supportingSlotIds: sortedUnique(supportSlots),
    opposingSlotIds: sortedUnique(opposing),
    evidenceRefs: [...new Map(evidenceRefs.map(ref => [evidenceKey(ref), ref])).values()]
      .sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right))),
    ...(rationale === undefined ? {} : { rationale }),
  }
}

function normalizeDissent(value: unknown, slotId: string, path: string): DebateDissentV1 {
  const dissent = record(value, path)
  if (dissent.version !== 1) invalid(`${path}.version must be 1`)
  const reportedSlotId = dissent.slotId
  if (reportedSlotId !== undefined && reportedSlotId !== slotId) invalid(`${path}.slotId must match the executing slot`)
  const evidenceValue = dissent.evidenceRefs
  if (!Array.isArray(evidenceValue) || evidenceValue.length > 128) invalid(`${path}.evidenceRefs must be an array with at most 128 entries`)
  const evidenceRefs = evidenceValue.map((entry, index) => normalizeEvidence(entry, `${path}.evidenceRefs[${String(index)}]`))
  return {
    version: 1,
    slotId,
    claimId: text(dissent.claimId, `${path}.claimId`, 256),
    position: text(dissent.position, `${path}.position`, 16_000),
    reason: text(dissent.reason, `${path}.reason`, 16_000),
    confidence: boundedConfidence(dissent.confidence, `${path}.confidence`),
    evidenceRefs,
  }
}

function normalizeUnresolved(value: unknown, path: string): DebateUnresolvedV1 {
  const unresolved = record(value, path)
  if (unresolved.version !== 1) invalid(`${path}.version must be 1`)
  if (typeof unresolved.blocking !== 'boolean') invalid(`${path}.blocking must be a boolean`)
  const evidenceValue = unresolved.requiredEvidenceRefs
  if (!Array.isArray(evidenceValue) || evidenceValue.length > 128) invalid(`${path}.requiredEvidenceRefs must be an array with at most 128 entries`)
  return {
    version: 1,
    claimId: text(unresolved.claimId, `${path}.claimId`, 256),
    description: text(unresolved.description, `${path}.description`, 16_000),
    severity: enumValue(unresolved.severity, `${path}.severity`, CLAIM_SEVERITIES),
    blocking: unresolved.blocking,
    reason: text(unresolved.reason, `${path}.reason`, 16_000),
    requiredEvidenceRefs: evidenceValue.map((entry, index) => normalizeEvidence(entry, `${path}.requiredEvidenceRefs[${String(index)}]`)),
  }
}

function normalizeUsage(value: unknown, path: string): DebateUsageV1 {
  const usage = record(value, path)
  const cacheRead = usage.cacheReadInputTokens
  const cacheWrite = usage.cacheWriteInputTokens
  const cost = usage.costUsd
  return {
    inputTokens: nonNegativeInteger(usage.inputTokens, `${path}.inputTokens`),
    outputTokens: nonNegativeInteger(usage.outputTokens, `${path}.outputTokens`),
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: nonNegativeInteger(cacheRead, `${path}.cacheReadInputTokens`) }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: nonNegativeInteger(cacheWrite, `${path}.cacheWriteInputTokens`) }),
    ...(cost === undefined ? {} : { costUsd: nonNegativeNumber(cost, `${path}.costUsd`) }),
  }
}

function normalizeProgressText(value: unknown, path: string, max: number): string {
  const normalized = text(value, path, max).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, max)
  if (normalized.trim().length === 0) invalid(`${path} must contain visible text`)
  return normalized
}

function normalizeProgressUsage(value: unknown, path: string): DebateAgentProgressUsageV1 {
  const raw = record(value, path)
  const usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheWriteInputTokens?: number
    costUsd?: number
  } = {}
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens'] as const) {
    if (raw[field] !== undefined) usage[field] = nonNegativeInteger(raw[field], `${path}.${field}`)
  }
  if (raw.costUsd !== undefined) usage.costUsd = nonNegativeNumber(raw.costUsd, `${path}.costUsd`)
  if (Object.keys(usage).length === 0) invalid(`${path} must include at least one counter`)
  return usage
}

function normalizeProgressRouting(value: unknown, path: string): DebateTurnRoutingV1 {
  const routing = record(value, path)
  if (routing.version !== 1) invalid(`${path}.version must be 1`)
  const requestedOperatorId = normalizeProgressText(routing.requestedOperatorId, `${path}.requestedOperatorId`, MAX_PROGRESS_NAME_LENGTH)
  const requestedModel = normalizeProgressText(routing.requestedModel, `${path}.requestedModel`, MAX_PROGRESS_NAME_LENGTH)
  const actualOperatorId = routing.actualOperatorId === undefined
    ? undefined
    : normalizeProgressText(routing.actualOperatorId, `${path}.actualOperatorId`, MAX_PROGRESS_NAME_LENGTH)
  const actualModel = routing.actualModel === undefined
    ? undefined
    : normalizeProgressText(routing.actualModel, `${path}.actualModel`, MAX_PROGRESS_NAME_LENGTH)
  const fallbackReasonCode = routing.fallbackReasonCode === undefined
    ? undefined
    : normalizeProgressText(routing.fallbackReasonCode, `${path}.fallbackReasonCode`, MAX_PROGRESS_NAME_LENGTH)
  return {
    version: 1,
    requestedOperatorId,
    requestedModel,
    ...(actualOperatorId === undefined ? {} : { actualOperatorId }),
    ...(actualModel === undefined ? {} : { actualModel }),
    ...(fallbackReasonCode === undefined ? {} : { fallbackReasonCode }),
  }
}

function progressUsageData(usage: DebateAgentProgressUsageV1): Readonly<Record<string, DebateJsonValue>> {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: usage.cacheReadInputTokens }),
    ...(usage.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
  }
}

function progressRoutingData(routing: DebateTurnRoutingV1): Readonly<Record<string, DebateJsonValue>> {
  const result: Record<string, DebateJsonValue> = {
    version: 1,
    requestedOperatorId: routing.requestedOperatorId,
    requestedModel: routing.requestedModel,
  }
  if (routing.actualOperatorId !== undefined) result.actualOperatorId = routing.actualOperatorId
  if (routing.actualModel !== undefined) result.actualModel = routing.actualModel
  if (routing.fallbackReasonCode !== undefined) result.fallbackReasonCode = routing.fallbackReasonCode
  return result
}

function normalizeRoundAgentProgress(
  value: DebateRoundAgentProgressV1,
  expected: { readonly runId: string; readonly round: number; readonly slotId: string; readonly role: DebateRoleId },
): DebateRoundAgentProgressV1 {
  const candidate = record(value, 'round progress')
  if (candidate.version !== 1) invalid('round progress.version must be 1')
  if (candidate.runId !== expected.runId || candidate.round !== expected.round
    || candidate.slotId !== expected.slotId || candidate.role !== expected.role) {
    invalid('round progress does not belong to the admitted Debate slot')
  }
  const progress = record(candidate.progress, 'round progress.progress')
  if (progress.version !== 1) invalid('round progress.progress.version must be 1')
  const kind = enumValue(progress.kind, 'round progress.progress.kind', PROGRESS_KINDS)
  const source = record(progress.source, 'round progress.progress.source')
  const orchestrationRunId = normalizeProgressText(
    source.orchestrationRunId,
    'round progress.progress.source.orchestrationRunId',
    MAX_PROGRESS_SOURCE_ID_LENGTH,
  )
  const sequence = nonNegativeInteger(source.sequence, 'round progress.progress.source.sequence')
  if (sequence < 1) invalid('round progress.progress.source.sequence must be positive')
  const time = normalizeProgressText(source.time, 'round progress.progress.source.time', MAX_PROGRESS_NAME_LENGTH)
  if (!Number.isFinite(Date.parse(time))) invalid('round progress.progress.source.time must be an ISO timestamp')
  const phase = progress.phase === undefined ? undefined : normalizeProgressText(progress.phase, 'round progress.progress.phase', MAX_PROGRESS_NAME_LENGTH)
  const publicOutputPreview = progress.publicOutputPreview === undefined
    ? undefined
    : normalizeProgressText(progress.publicOutputPreview, 'round progress.progress.publicOutputPreview', MAX_PROGRESS_TEXT_LENGTH)
  const toolName = progress.toolName === undefined
    ? undefined
    : normalizeProgressText(progress.toolName, 'round progress.progress.toolName', MAX_PROGRESS_NAME_LENGTH)
  const approvalKind = progress.approvalKind === undefined
    ? undefined
    : normalizeProgressText(progress.approvalKind, 'round progress.progress.approvalKind', MAX_PROGRESS_NAME_LENGTH)
  const approvalPreview = progress.approvalPreview === undefined
    ? undefined
    : normalizeProgressText(progress.approvalPreview, 'round progress.progress.approvalPreview', MAX_PROGRESS_TEXT_LENGTH)
  const usage = progress.usage === undefined ? undefined : normalizeProgressUsage(progress.usage, 'round progress.progress.usage')
  const routing = progress.routing === undefined ? undefined : normalizeProgressRouting(progress.routing, 'round progress.progress.routing')
  switch (kind) {
    case 'phase': if (phase === undefined) invalid('phase progress must include phase'); break
    case 'public-output': if (publicOutputPreview === undefined) invalid('public-output progress must include publicOutputPreview'); break
    case 'tool-started':
    case 'tool-completed': if (toolName === undefined) invalid('tool progress must include toolName'); break
    case 'approval-required': if (approvalKind === undefined) invalid('approval progress must include approvalKind'); break
    case 'usage-updated': if (usage === undefined) invalid('usage progress must include usage'); break
  }
  return {
    version: 1,
    runId: expected.runId,
    round: expected.round,
    slotId: expected.slotId,
    role: expected.role,
    progress: {
      version: 1,
      kind,
      source: { orchestrationRunId, sequence, time: new Date(time).toISOString() },
      ...(phase === undefined ? {} : { phase }),
      ...(publicOutputPreview === undefined ? {} : { publicOutputPreview }),
      ...(toolName === undefined ? {} : { toolName }),
      ...(approvalKind === undefined ? {} : { approvalKind }),
      ...(approvalPreview === undefined ? {} : { approvalPreview }),
      ...(usage === undefined ? {} : { usage }),
      ...(routing === undefined ? {} : { routing }),
    },
  }
}

function normalizeTurnResult(value: DebateTurnResultV1, slotId: string): NormalizedTurnResult {
  const result = record(value, 'turn result')
  const confidence = boundedConfidence(result.confidence, 'turn result.confidence')
  const outputRef = optionalText(result.outputRef, 'turn result.outputRef', MAX_OUTPUT_REF_LENGTH)
  const outputPreview = optionalText(result.outputPreview, 'turn result.outputPreview', MAX_PREVIEW_LENGTH)
  if (outputRef === undefined && outputPreview === undefined) {
    invalid('turn result must include outputRef or outputPreview')
  }
  const claims: DebateClaimV1[] = []
  const claimValues = result.claims
  if (claimValues !== undefined) {
    if (!Array.isArray(claimValues) || claimValues.length > 128) invalid('turn result.claims must contain at most 128 entries')
    claims.push(...claimValues.map((claim, index) => normalizeClaim(claim, slotId, `turn result.claims[${String(index)}]`)))
  }
  const claimLedger = result.claimLedger
  if (claimLedger !== undefined) {
    const ledger = record(claimLedger, 'turn result.claimLedger')
    if (!Array.isArray(ledger.claims) || ledger.claims.length > 128) invalid('turn result.claimLedger.claims must contain at most 128 entries')
    claims.push(...ledger.claims.map((claim, index) => normalizeClaim(claim, slotId, `turn result.claimLedger.claims[${String(index)}]`)))
  }
  const dissentValue = result.dissent
  if (dissentValue !== undefined && (!Array.isArray(dissentValue) || dissentValue.length > 128)) invalid('turn result.dissent must contain at most 128 entries')
  const unresolvedValue = result.unresolved
  if (unresolvedValue !== undefined && (!Array.isArray(unresolvedValue) || unresolvedValue.length > 128)) invalid('turn result.unresolved must contain at most 128 entries')
  const evidenceValue = result.evidenceRefs
  if (evidenceValue !== undefined && (!Array.isArray(evidenceValue) || evidenceValue.length > 128)) invalid('turn result.evidenceRefs must contain at most 128 entries')
  return {
    confidence,
    ...(outputRef === undefined ? {} : { outputRef }),
    ...(outputPreview === undefined ? {} : { outputPreview }),
    claims,
    dissent: dissentValue === undefined ? [] : dissentValue.map((entry, index) => normalizeDissent(entry, slotId, `turn result.dissent[${String(index)}]`)),
    unresolved: unresolvedValue === undefined ? [] : unresolvedValue.map((entry, index) => normalizeUnresolved(entry, `turn result.unresolved[${String(index)}]`)),
    evidenceRefs: evidenceValue === undefined ? [] : evidenceValue.map((entry, index) => normalizeEvidence(entry, `turn result.evidenceRefs[${String(index)}]`)),
    ...(result.usage === undefined ? {} : { usage: normalizeUsage(result.usage, 'turn result.usage') }),
  }
}

function mergeClaimStatus(left: DebateClaimStatus, right: DebateClaimStatus): DebateClaimStatus {
  if (right === 'unresolved') return 'unresolved'
  if (left === 'unresolved') return right === 'open' ? 'unresolved' : right
  if (left === right) return left
  if (left === 'open') return right
  if (right === 'open') return left
  return 'open'
}

function mergeClaim(left: DebateClaimV1, right: DebateClaimV1): DebateClaimV1 {
  const status = mergeClaimStatus(left.status, right.status)
  const evidence = [...left.evidenceRefs, ...right.evidenceRefs]
  return {
    ...left,
    status,
    severity: severityRank(left.severity) >= severityRank(right.severity) ? left.severity : right.severity,
    confidence: roundNumber((left.confidence + right.confidence) / 2),
    supportingSlotIds: sortedUnique([...left.supportingSlotIds, ...right.supportingSlotIds]),
    opposingSlotIds: sortedUnique([...left.opposingSlotIds, ...right.opposingSlotIds]),
    evidenceRefs: [...new Map(evidence.map(ref => [evidenceKey(ref), ref])).values()]
      .sort((a, b) => evidenceKey(a).localeCompare(evidenceKey(b))),
  }
}

function mergeLedger(
  previous: DebateClaimLedgerV1,
  contributions: readonly TurnContribution[],
): DebateClaimLedgerV1 {
  const claims = new Map<string, DebateClaimV1>(previous.claims.map(claim => [claimKey(claim), clone(claim)]))
  for (const contribution of contributions) {
    for (const claim of contribution.result.claims) {
      const current = claims.get(claimKey(claim))
      claims.set(claimKey(claim), current === undefined ? claim : mergeClaim(current, claim))
    }
    for (const unresolved of contribution.result.unresolved) {
      const current = claims.get(unresolved.claimId)
      if (current === undefined) {
        claims.set(unresolved.claimId, {
          version: 1,
          claimId: unresolved.claimId,
          statement: unresolved.description,
          status: 'unresolved',
          severity: unresolved.severity,
          confidence: 0,
          supportingSlotIds: [],
          opposingSlotIds: [],
          evidenceRefs: unresolved.requiredEvidenceRefs,
          rationale: unresolved.reason,
        })
      } else if (unresolved.blocking || unresolved.severity === 'critical' || unresolved.severity === 'high') {
        claims.set(unresolved.claimId, { ...current, status: 'unresolved' })
      }
    }
  }
  const ordered = [...claims.values()].sort((left, right) => left.claimId.localeCompare(right.claimId))
  const coverage = ordered.length === 0 ? 0 : roundNumber(ordered.filter(claim => claim.evidenceRefs.length > 0).length / ordered.length)
  const base = { version: 1 as const, claims: ordered, coverage }
  return { ...base, digest: `sha256:${sha256(base)}` }
}

function mergeDissent(previous: readonly DebateDissentV1[], contributions: readonly TurnContribution[]): DebateDissentV1[] {
  const values = [...previous]
  for (const contribution of contributions) values.push(...contribution.result.dissent)
  const unique = new Map<string, DebateDissentV1>()
  for (const dissent of values) {
    const key = `${dissent.slotId}:${dissent.claimId}:${dissent.position}:${dissent.reason}`
    unique.set(key, dissent)
  }
  return [...unique.values()].sort((left, right) => left.slotId.localeCompare(right.slotId)
    || left.claimId.localeCompare(right.claimId) || left.position.localeCompare(right.position))
}

function mergeUnresolved(
  previous: readonly DebateUnresolvedV1[],
  contributions: readonly TurnContribution[],
  ledger: DebateClaimLedgerV1,
): DebateUnresolvedV1[] {
  const values = [...previous]
  for (const contribution of contributions) values.push(...contribution.result.unresolved)
  const settledClaims = new Set(ledger.claims
    .filter(claim => claim.status === 'supported' || claim.status === 'refuted' || claim.status === 'settled')
    .map(claim => claim.claimId))
  const unique = new Map<string, DebateUnresolvedV1>()
  for (const unresolved of values) {
    if (settledClaims.has(unresolved.claimId)) continue
    const key = `${unresolved.claimId}:${unresolved.description}:${unresolved.reason}`
    unique.set(key, unresolved)
  }
  return [...unique.values()].sort((left, right) => severityRank(right.severity) - severityRank(left.severity)
    || left.claimId.localeCompare(right.claimId) || left.description.localeCompare(right.description))
}

function collectEvidence(
  sourceRefs: DebateStartRequestV1['sourceRefs'],
  ledger: DebateClaimLedgerV1,
  dissent: readonly DebateDissentV1[],
  unresolved: readonly DebateUnresolvedV1[],
): DebateRunSnapshotV1['evidence'] {
  const refs: DebateEvidenceRefV1[] = (sourceRefs ?? []).map(sourceEvidence)
  refs.push(...ledger.claims.flatMap(claim => claim.evidenceRefs))
  refs.push(...dissent.flatMap(entry => entry.evidenceRefs))
  const known = new Set(refs.map(evidenceKey))
  refs.push(...unresolved.flatMap(entry => entry.requiredEvidenceRefs))
  const unique = [...new Map(refs.map(ref => [evidenceKey(ref), ref])).values()]
    .sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)))
  const missingRefs = sortedUnique(unresolved.flatMap(entry => entry.requiredEvidenceRefs
    .filter(ref => !known.has(evidenceKey(ref))).map(ref => ref.ref)))
  return {
    version: 1,
    refs: unique,
    coverage: ledger.coverage,
    missingRefs,
    lineage: sortedUnique((sourceRefs ?? []).map(ref => ref.ref)),
  }
}

function addUsage(
  cost: DebateRunSnapshotV1['cost'],
  slot: DebateRoleSpecV1,
  usage: DebateUsageV1 | undefined,
): DebateRunSnapshotV1['cost'] {
  if (usage === undefined) {
    const unknownUsageTurns = cost.unknownUsageTurns + 1
    const unknownCostTurns = cost.unknownCostTurns + 1
    const hasKnownUsage = cost.bySlot.length > 0
    const hasKnownCost = cost.bySlot.some(entry => entry.usage.costUsd !== undefined)
    const {
      inputTokens: _inputTokens,
      outputTokens: _outputTokens,
      cacheReadInputTokens: _cacheReadInputTokens,
      cacheWriteInputTokens: _cacheWriteInputTokens,
      costUsd: _costUsd,
      ...identity
    } = cost
    return {
      ...identity,
      usageStatus: hasKnownUsage ? 'partial' : 'unknown',
      costStatus: hasKnownCost ? 'partial' : 'unknown',
      ...(hasKnownUsage ? {
        inputTokens: cost.inputTokens,
        outputTokens: cost.outputTokens,
      } : {}),
      ...(cost.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: cost.cacheReadInputTokens }),
      ...(cost.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: cost.cacheWriteInputTokens }),
      ...(hasKnownCost ? { costUsd: cost.costUsd } : {}),
      unknownUsageTurns,
      unknownCostTurns,
    }
  }
  const existing = cost.bySlot.find(entry => entry.slotId === slot.role)
  const combinedCacheRead = existing === undefined
    || (existing.usage.cacheReadInputTokens === undefined && usage.cacheReadInputTokens === undefined)
    ? usage.cacheReadInputTokens
    : (existing.usage.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0)
  const combinedCacheWrite = existing === undefined
    || (existing.usage.cacheWriteInputTokens === undefined && usage.cacheWriteInputTokens === undefined)
    ? usage.cacheWriteInputTokens
    : (existing.usage.cacheWriteInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0)
  const combinedCost = existing === undefined || (existing.usage.costUsd === undefined && usage.costUsd === undefined)
    ? usage.costUsd
    : (existing.usage.costUsd ?? 0) + (usage.costUsd ?? 0)
  const bySlot = existing === undefined
    ? [...cost.bySlot, { version: 1 as const, slotId: slot.role, model: slot.model, usage }]
    : cost.bySlot.map(entry => entry.slotId === slot.role
      ? {
        ...entry,
        usage: {
          inputTokens: entry.usage.inputTokens + usage.inputTokens,
          outputTokens: entry.usage.outputTokens + usage.outputTokens,
          ...(combinedCacheRead === undefined ? {} : { cacheReadInputTokens: combinedCacheRead }),
          ...(combinedCacheWrite === undefined ? {} : { cacheWriteInputTokens: combinedCacheWrite }),
          ...(combinedCost === undefined ? {} : { costUsd: combinedCost }),
        },
      }
      : entry)
  const inputTokens = bySlot.reduce((sum, entry) => sum + entry.usage.inputTokens, 0)
  const outputTokens = bySlot.reduce((sum, entry) => sum + entry.usage.outputTokens, 0)
  const cacheReadEntries = bySlot.filter(entry => entry.usage.cacheReadInputTokens !== undefined)
  const cacheWriteEntries = bySlot.filter(entry => entry.usage.cacheWriteInputTokens !== undefined)
  const costEntries = bySlot.filter(entry => entry.usage.costUsd !== undefined)
  const unknownCostTurns = cost.unknownCostTurns + (usage.costUsd === undefined ? 1 : 0)
  return {
    version: 1,
    usageStatus: cost.unknownUsageTurns > 0 ? 'partial' : 'known',
    costStatus: costEntries.length === 0 ? 'unknown' : unknownCostTurns > 0 ? 'partial' : 'known',
    inputTokens,
    outputTokens,
    ...(cacheReadEntries.length === 0 ? {} : {
      cacheReadInputTokens: cacheReadEntries.reduce((sum, entry) => sum + (entry.usage.cacheReadInputTokens ?? 0), 0),
    }),
    ...(cacheWriteEntries.length === 0 ? {} : {
      cacheWriteInputTokens: cacheWriteEntries.reduce((sum, entry) => sum + (entry.usage.cacheWriteInputTokens ?? 0), 0),
    }),
    ...(costEntries.length === 0 ? {} : {
      costUsd: costEntries.reduce((sum, entry) => sum + (entry.usage.costUsd ?? 0), 0),
    }),
    unknownUsageTurns: cost.unknownUsageTurns,
    unknownCostTurns,
    bySlot: bySlot.sort((left, right) => left.slotId.localeCompare(right.slotId)),
  }
}

function executorErrorCode(error: unknown): string {
  if (error instanceof DebateError) return error.code
  if (error !== null && typeof error === 'object') {
    const code = (error as { readonly code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'DEBATE_PROVIDER_UNAVAILABLE'
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}

function lifecycleTerminal(state: DebateLifecycle): boolean {
  return state === 'completed' || state === 'stopped' || state === 'failed'
    || state === 'indeterminate' || state === 'budget_limited' || state === 'max_rounds'
}

/** Final lifecycle states cannot be reopened; a paused `stopped` run may resume. */
function lifecycleFinal(state: DebateLifecycle): boolean {
  return state === 'completed' || state === 'failed' || state === 'indeterminate'
    || state === 'budget_limited' || state === 'max_rounds'
}

/**
 * Return whether a persisted terminal run proves the outcome of a pending
 * command receipt. A terminal snapshot without its committing event is not
 * sufficient: recovery must preserve the indeterminate state in that case.
 */
function hasProvenTerminalOutcome(run: StoredRun): boolean {
  switch (run.snapshot.state) {
    case 'completed':
    case 'budget_limited':
    case 'max_rounds':
      return run.events.some((event) => {
        if (event.type !== 'debate.synthesis.settled') return false
        const lifecycleState = (event.data as { readonly lifecycleState?: unknown }).lifecycleState
        return lifecycleState === undefined || lifecycleState === run.snapshot.state
      })
    case 'failed':
      return run.events.some(event => event.type === 'debate.failed')
    case 'stopped':
      return run.events.some(event => event.type === 'debate.stopped')
    case 'indeterminate':
    default:
      return false
  }
}

/** Persistent local implementation of {@link DebateService}. */
export class LocalDebateProvider extends DebateService {
  static Config: z<Config> = z.object({
    root: z.string(),
    executor: z.any(),
    providerId: z.string(),
    providerVersion: z.string(),
  })

  private readonly filename: string
  private readonly executor: DebateRoundExecutor | undefined
  private readonly clock: () => string
  private readonly idFactory: () => string
  private readonly providerId: string
  private readonly providerVersion: string
  private document: StoreDocument
  private writeTail: Promise<void> = Promise.resolve()
  private readonly activeRuns = new Map<string, ActiveRun>()

  /**
   * Create a Provider backed by `<root>/state.json`.
   * @param ctx - Cordis context receiving `ctx.debates`.
   * @param config - owner-private root and optional Provider identity.
   * @param executor - optional programmatic override for the turn executor seam.
   */
  constructor(
    ctx: Context,
    config: LocalDebateConfig,
    executor?: DebateRoundExecutor,
  )
  constructor(ctx: Context, config: LocalDebateConfig, executor?: DebateRoundExecutor) {
    super(ctx)
    const options: ProviderConfig & Pick<LocalDebateProviderOptions, 'clock' | 'idFactory'> = typeof config === 'string'
      ? { root: config, ...(executor === undefined ? {} : { executor }) }
      : { ...config, ...(executor === undefined ? {} : { executor }) }
    if (typeof options.root !== 'string' || options.root.trim().length === 0) {
      throw new DebateError('debate-local root must be a non-blank directory', 'DEBATE_INVALID')
    }
    mkdirSync(options.root, { recursive: true, mode: 0o700 })
    chmodSync(options.root, 0o700)
    this.filename = join(options.root, 'state.json')
    this.executor = options.executor
    this.clock = options.clock ?? (() => new Date().toISOString())
    this.idFactory = options.idFactory ?? randomUUID
    this.providerId = options.providerId ?? name
    this.providerVersion = options.providerVersion ?? VERSION
    this.document = this.load()
    this.recoverInterruptedCommands()
  }

  /** Admit a request, returning an approval-pending or terminal run projection. */
  async start(request: DebateStartRequestV1): Promise<DebateRunSnapshotV1> {
    const normalized = validateDebateStartRequest(request)
    const admission = await this.mutate(() => {
      const requestSha256 = `sha256:${sha256(normalized)}`
      const existing = this.command('start', normalized.commandId, requestSha256)
      if (existing !== undefined) return { existing: clone(existing) } as const
      const runId = this.newRunId()
      const policy = validateDebatePolicy(normalized.policy)
      const roster = orderedRoster(policy.roster)
      const sourceRefs = normalized.sourceRefs ?? []
      const baseSnapshot: DebateRunSnapshotV1 & { readonly topic: DebateTopicV1 } = {
        version: 1,
        runId,
        revision: 0,
        state: 'planned',
        mode: policy.mode,
        promptSha256: `sha256:${sha256(normalized.prompt)}`,
        ...(normalized.objective === undefined ? {} : { objective: normalized.objective }),
        topic: {
          version: 1,
          title: normalized.objective ?? normalized.prompt,
          source: normalized.objective === undefined ? 'user' : 'objective',
        },
        policy,
        roster,
        currentRound: 0,
        rounds: [],
        claimLedger: emptyLedger(),
        dissent: [],
        unresolved: [],
        evidence: collectEvidence(sourceRefs, emptyLedger(), [], []),
        cost: emptyCost(),
        provenance: this.provenance(normalized, requestSha256, policy),
        createdAt: this.now(),
        updatedAt: this.now(),
      }
      const run: StoredRun = { runId, request: clone({ ...normalized, policy }), snapshot: baseSnapshot, events: [] }
      this.document.runs.push(run)
      this.document.commands.push({
        commandId: normalized.commandId,
        method: 'start',
        requestSha256,
        runId,
        state: 'accepted',
      })
      this.appendEvent(run, 'debate.planned', { mode: policy.mode, rosterSize: roster.length }, {
        state: policy.mode === 'disabled' ? 'stopped' : 'awaiting_approval',
      })
      this.appendEvent(run, 'debate.roster.qualified', {
        roles: roster.map(role => role.role),
        maxRounds: policy.budget.maxRounds,
        maxAgentsPerRound: policy.budget.maxAgentsPerRound,
      })
      if (policy.mode === 'disabled') {
        this.appendEvent(run, 'debate.stopped', { action: 'disabled', reason: 'debate policy is disabled' }, { state: 'stopped' })
      }
      /* jscpd:ignore-start -- start and control intentionally retain separate
       * receipt transitions; combining them would blur their distinct durable
       * command methods for a small amount of settlement plumbing. */
      if (policy.mode === 'auto') {
        this.transitionCommand(normalized.commandId, 'running')
        return { runId, execute: true as const }
      }
      const response = clone(run.snapshot)
      this.transitionCommand(normalized.commandId, 'settled', response)
      return { response }
    })
    if ('existing' in admission) return this.replayCommand(admission.existing)
    if ('execute' in admission) {
      if (typeof admission.runId !== 'string') unavailable('accepted Debate start omitted its run identity')
      return this.drive(admission.runId, normalized.commandId, 'auto')
    }
    return admission.response
    /* jscpd:ignore-end */
  }

  /** List all persisted runs in deterministic newest-first order. */
  async list(): Promise<readonly DebateRunSummaryV1[]> {
    await this.writeTail
    return this.document.runs
      .map(run => this.summary(run.snapshot))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.runId.localeCompare(right.runId))
      .map(clone)
  }

  /** Inspect one persisted run without exposing its original prompt text. */
  async inspect(runId: string): Promise<DebateRunSnapshotV1> {
    const id = this.runId(runId)
    await this.writeTail
    const run = this.requireRun(id)
    return clone(run.snapshot)
  }

  /** Read a bounded append-only event page for one run. */
  async readEvents(request: DebateEventReadRequestV1): Promise<DebateEventPageV1> {
    const normalized = validateDebateEventReadRequest(request)
    await this.writeTail
    const run = this.requireRun(normalized.runId)
    const after = normalized.afterSequence ?? 0
    const limit = normalized.limit ?? DEFAULT_EVENT_LIMIT
    const events = run.events.filter(event => event.sequence > after).slice(0, limit).map(clone)
    const nextSequence = events.length === 0
      ? after
      : (events[events.length - 1]?.sequence ?? after)
    return { events, nextSequence }
  }

  /** Apply an approval, pause, resume, stop, or reject with revision fencing. */
  async control(request: DebateControlRequestV1): Promise<DebateRunSnapshotV1> {
    const normalized = validateDebateControlRequest(request)
    const admission = await this.mutate(() => {
      const requestSha256 = `sha256:${sha256(normalized)}`
      const existing = this.command('control', normalized.commandId, requestSha256)
      if (existing !== undefined) return { existing: clone(existing) } as const
      const run = this.requireRun(normalized.runId)
      if (run.snapshot.revision !== normalized.expectedRevision) {
        throw new DebateError(
          `debate revision changed for ${run.runId}: expected ${String(normalized.expectedRevision)}, found ${String(run.snapshot.revision)}`,
          'DEBATE_REVISION_CONFLICT',
        )
      }
      switch (normalized.action) {
        case 'approve':
          if (run.snapshot.state !== 'awaiting_approval') this.stateConflict(run, normalized.action)
          break
        case 'resume':
          if (run.snapshot.state !== 'stopped' || this.lastStopAction(run) !== 'pause') this.stateConflict(run, normalized.action)
          break
        case 'pause':
        case 'stop':
          if (lifecycleTerminal(run.snapshot.state)) this.stateConflict(run, normalized.action)
          break
        case 'reject':
          if (run.snapshot.state !== 'awaiting_approval') this.stateConflict(run, normalized.action)
          break
      }
      this.recordCommand({
        commandId: normalized.commandId,
        method: 'control',
        requestSha256,
        runId: run.runId,
        state: 'accepted',
      })
      switch (normalized.action) {
        case 'approve':
          this.transitionCommand(normalized.commandId, 'running')
          return { runId: run.runId, execute: 'approve' as const }
        case 'resume':
          this.transitionCommand(normalized.commandId, 'running')
          return { runId: run.runId, execute: 'resume' as const }
        case 'pause':
          if (this.activeRuns.has(run.runId)) {
            const active = this.activeRuns.get(run.runId)
            if (active !== undefined) active.intent = 'pause'
            run.controlIntent = { action: 'pause', reason: normalized.reason, commandId: normalized.commandId }
            this.persist()
            return { runId: run.runId, waitForActive: true as const }
          }
          this.appendEvent(run, 'debate.stopped', { action: 'pause', reason: normalized.reason }, { state: 'stopped' })
          break
        case 'stop':
          if (this.activeRuns.has(run.runId)) {
            const active = this.activeRuns.get(run.runId)
            if (active !== undefined) {
              active.intent = 'stop'
              active.controller.abort(normalized.reason)
            }
            run.controlIntent = { action: 'stop', reason: normalized.reason, commandId: normalized.commandId }
            this.persist()
            return { runId: run.runId, waitForActive: true as const }
          }
          this.appendEvent(run, 'debate.stopped', { action: 'stop', reason: normalized.reason }, { state: 'stopped' })
          break
        case 'reject':
          this.appendEvent(run, 'debate.stopped', { action: 'reject', reason: normalized.reason }, { state: 'stopped' })
          break
      }
      const response = clone(run.snapshot)
      this.transitionCommand(normalized.commandId, 'settled', response)
      return { response }
    })
    if ('existing' in admission) return this.replayCommand(admission.existing)
    if ('execute' in admission) {
      if (typeof admission.runId !== 'string') unavailable('accepted Debate control omitted its run identity')
      return this.drive(admission.runId, normalized.commandId, admission.execute)
    }
    if ('waitForActive' in admission) {
      if (typeof admission.runId !== 'string') unavailable('accepted Debate control omitted its active run identity')
      const active = this.activeRuns.get(admission.runId)
      try {
        const response = active === undefined
          ? clone(this.requireRun(admission.runId).snapshot)
          : await active.promise
        await this.mutate(() => {
          this.transitionCommand(normalized.commandId, 'settled', response)
        })
        return clone(response)
      } catch (error) {
        await this.mutate(() => {
          this.transitionCommand(normalized.commandId, 'indeterminate', clone(this.requireRun(admission.runId).snapshot))
        })
        throw error
      }
    }
    return admission.response
  }

  private async runUntilTerminal(
    run: StoredRun,
    action: 'auto' | 'approve' | 'resume',
    signal: AbortSignal,
  ): Promise<void> {
    this.appendEvent(run, 'debate.admitted', { action }, { state: 'admitting' })
    for (;;) {
      const result = await this.runRound(run, signal)
      if (result !== 'continue' || lifecycleTerminal(run.snapshot.state)) return
      const active = this.activeRuns.get(run.runId)
      if (run.controlIntent?.action === 'pause' || active?.intent === 'pause') {
        const reason = run.controlIntent?.reason ?? 'pause requested at the round boundary'
        delete run.controlIntent
        this.appendEvent(run, 'debate.stopped', { action: 'pause', reason }, { state: 'stopped' })
        return
      }
    }
  }

  private async runRound(run: StoredRun, signal: AbortSignal): Promise<'continue' | 'converged' | 'terminal'> {
    // A settled run is immutable from the scheduler's point of view. This
    // guard keeps a late recovery/control path from dispatching another round
    // after a terminal lifecycle event has committed.
    if (lifecycleFinal(run.snapshot.state)) return 'terminal'
    const number = run.snapshot.currentRound + 1
    const { policy } = run.snapshot
    if (number > policy.budget.maxRounds) {
      const lastRound = run.snapshot.rounds.at(-1)
      if (lastRound === undefined) {
        // This is only reachable after an externally edited/legacy state. Do
        // not leave the run in a non-terminal state after reporting the
        // exhausted budget; settle an empty synthesis explicitly instead.
        this.appendEvent(run, 'debate.convergence.evaluated', {
          status: 'max_rounds', round: number - 1, reason: 'maximum rounds already exhausted',
          lifecycleState: 'synthesizing',
        }, { state: 'synthesizing' })
        const synthesis = {
          version: 1 as const,
          state: 'settled' as const,
          unresolvedClaimIds: run.snapshot.unresolved.map(entry => entry.claimId),
          dissentCount: run.snapshot.dissent.length,
        }
        this.appendEvent(run, 'debate.synthesis.started', {
          round: number - 1,
          lifecycleState: 'synthesizing',
        }, {
          state: 'synthesizing',
          synthesis: { ...synthesis, state: 'running' as const },
        })
        this.appendEvent(run, 'debate.synthesis.settled', {
          round: number - 1,
          unresolvedClaimIds: synthesis.unresolvedClaimIds,
          dissentCount: synthesis.dissentCount,
          lifecycleState: 'max_rounds',
        }, { state: 'max_rounds', synthesis })
      } else {
        this.synthesize(run, lastRound, 'max_rounds')
      }
      return 'terminal'
    }
    const slots = this.roundSlots(run.snapshot.roster, policy.budget.maxAgentsPerRound)
    const phase: DebateTurnPhase = number === 1
      ? 'blind-independent'
      : run.snapshot.unresolved.some(entry => entry.severity === 'high' || entry.severity === 'critical')
        ? 'high-severity-unresolved'
        : 'claim-ledger'
    const plannedTurns: DebateAgentTurnV1[] = slots.map(slot => ({
      version: 1,
      round: number,
      slotId: slot.role,
      role: slot.role,
      operatorId: slot.operatorId,
      model: slot.model,
      state: 'planned',
      claimIds: [],
      evidenceRefs: [],
    }))
    const plannedRound: DebateRoundSnapshotV1 = {
      version: 1,
      round: number,
      state: 'running',
      turns: plannedTurns,
      claimLedger: run.snapshot.claimLedger,
      dissent: run.snapshot.dissent,
      unresolved: run.snapshot.unresolved,
    }
    this.appendEvent(run, 'debate.round.started', { round: number, phase, slotIds: slots.map(slot => slot.role) }, {
      state: 'round_running',
      currentRound: number,
      rounds: [...run.snapshot.rounds, plannedRound],
    }, { round: number })

    const priorUnresolved = run.snapshot.unresolved
    const contributions: TurnContribution[] = []
    let budgetReason: string | undefined
    const dispatchedTurns: Array<{ readonly slot: DebateRoleSpecV1; readonly turn: DebateAgentTurnV1 }> = []
    const turnBudgetSlot = slots.find(slot => this.turnCount(run, slot.role, number) >= policy.budget.maxTurnsPerAgent)
    budgetReason = turnBudgetSlot === undefined
      ? this.budgetReason(run.snapshot.cost, policy)
      : `turn budget exhausted for ${turnBudgetSlot.role}`
    if (budgetReason === undefined) {
      for (const slot of slots) {
        const planned = this.round(run, number).turns.find(turn => turn.slotId === slot.role)
        if (planned === undefined) unavailable(`planned turn missing for ${slot.role}`)
        const dispatched: DebateAgentTurnV1 = { ...planned, state: 'dispatched', startedAt: this.now() }
        this.replaceTurn(run, number, dispatched, 'debate.agent.dispatched', {
          round: number, role: slot.role, model: slot.model,
        })
        dispatchedTurns.push({ slot, turn: dispatched })
      }
    }

    let batch: { readonly ok: true; readonly value: DebateRoundExecutionResultV1 }
      | { readonly ok: false; readonly error: unknown }
      | undefined
    if (dispatchedTurns.length > 0) {
      try {
        batch = {
          ok: true,
          value: await this.executeRound(
            run,
            dispatchedTurns.map(entry => entry.slot),
            number,
            phase,
            signal,
          ),
        }
      } catch (error) {
        batch = { ok: false, error }
      }
    }
    let terminalState: 'failed' | 'indeterminate' | undefined
    let interrupted = false
    for (const admitted of dispatchedTurns) {
      const { slot, turn: dispatched } = admitted
      if (batch === undefined || !batch.ok) {
        const error = batch?.error ?? new DebateError('Debate round executor returned no result', 'DEBATE_PROVIDER_UNAVAILABLE')
        const code = executorErrorCode(error)
        if (code === 'DEBATE_INTERRUPTED'
          && (run.controlIntent?.action === 'stop' || this.activeRuns.get(run.runId)?.intent === 'stop')) interrupted = true
        const failedState = code === 'DEBATE_INDETERMINATE' ? 'indeterminate' : 'failed'
        const failedTurn: DebateAgentTurnV1 = {
          ...dispatched,
          state: failedState,
          settledAt: this.now(),
          errorCode: code,
        }
        this.replaceTurn(run, number, failedTurn, failedState === 'indeterminate' ? 'debate.agent.indeterminate' : 'debate.agent.failed', {
          round: number, errorCode: code, error: errorMessage(error),
        })
        if (failedState === 'indeterminate' || terminalState === undefined) terminalState = failedState
        continue
      }
      const failure = batch.value.failuresBySlot?.[slot.role]
      if (failure !== undefined) {
        const failedTurn: DebateAgentTurnV1 = {
          ...dispatched,
          state: failure.state,
          attempt: failure.attempt,
          ...(failure.routing === undefined ? {} : {
            routing: failure.routing,
            operatorId: failure.routing.actualOperatorId ?? dispatched.operatorId,
            model: failure.routing.actualModel ?? dispatched.model,
          }),
          blockers: failure.blockers,
          settledAt: this.now(),
          errorCode: failure.errorCode,
        }
        const eventType = failure.state === 'indeterminate'
          ? 'debate.agent.indeterminate' as const
          : failure.state === 'blocked'
            ? 'debate.agent.blocked' as const
            : 'debate.agent.failed' as const
        this.replaceTurn(run, number, failedTurn, eventType, {
          round: number,
          errorCode: failure.errorCode,
          blockerCodes: failure.blockers.map(blocker => blocker.code).join(', '),
          blockerMessages: failure.blockers.map(blocker => blocker.message).join('\n'),
        })
        if (failure.state === 'indeterminate' || terminalState === undefined) {
          terminalState = failure.state === 'indeterminate' ? 'indeterminate' : 'failed'
        }
        continue
      }
      const rawResult = batch.value.resultsBySlot[slot.role]
      if (rawResult === undefined) {
        const failedTurn: DebateAgentTurnV1 = {
          ...dispatched,
          state: 'failed',
          settledAt: this.now(),
          errorCode: 'DEBATE_INVALID',
        }
        this.replaceTurn(run, number, failedTurn, 'debate.agent.failed', {
          round: number, errorCode: 'DEBATE_INVALID', error: `round result omitted slot ${slot.role}`,
        })
        terminalState ??= 'failed'
        continue
      }
      let result: NormalizedTurnResult
      try {
        result = normalizeTurnResult(rawResult, slot.role)
        if (number > 1) this.assertFollowUpReferences(result, run.snapshot.claimLedger, slot.role)
      } catch (error) {
        const failedTurn: DebateAgentTurnV1 = {
          ...dispatched,
          state: 'failed',
          settledAt: this.now(),
          errorCode: 'DEBATE_INVALID',
        }
        this.replaceTurn(run, number, failedTurn, 'debate.agent.failed', {
          round: number, errorCode: 'DEBATE_INVALID', error: errorMessage(error),
        })
        terminalState ??= 'failed'
        continue
      }
      const settledTurn: DebateAgentTurnV1 = {
        ...dispatched,
        state: 'settled',
        ...(rawResult.attempt === undefined ? {} : { attempt: rawResult.attempt }),
        ...(rawResult.routing === undefined ? {} : {
          routing: rawResult.routing,
          operatorId: rawResult.routing.actualOperatorId ?? dispatched.operatorId,
          model: rawResult.routing.actualModel ?? dispatched.model,
        }),
        claimIds: sortedUnique(result.claims.map(claim => claim.claimId)),
        evidenceRefs: result.evidenceRefs,
        settledAt: this.now(),
        ...(result.outputRef === undefined ? {} : { outputRef: result.outputRef }),
        ...(result.outputPreview === undefined ? {} : { outputPreview: result.outputPreview }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      }
      const nextCost = addUsage(run.snapshot.cost, slot, result.usage)
      this.replaceTurn(run, number, settledTurn, 'debate.agent.settled', {
        round: number, role: slot.role, claimCount: result.claims.length, evidenceCount: result.evidenceRefs.length,
        confidence: result.confidence,
      }, { cost: nextCost })
      contributions.push({ slot, result })
      const afterCostReason = this.budgetReason(run.snapshot.cost, policy)
      if (afterCostReason !== undefined) {
        budgetReason = afterCostReason
      }
    }

    if (interrupted) {
      const reason = run.controlIntent?.reason ?? 'active TaskGraph was interrupted'
      delete run.controlIntent
      this.appendEvent(run, 'debate.stopped', { action: 'stop', reason }, { state: 'stopped' }, { round: number })
      return 'terminal'
    }

    if (terminalState !== undefined) {
      const failedRound: DebateRoundSnapshotV1 = {
        ...this.round(run, number),
        state: terminalState,
      }
      this.replaceRoundProjection(
        run,
        failedRound,
        terminalState === 'indeterminate' ? 'debate.indeterminate' : 'debate.failed',
        { round: number, errorCode: terminalState === 'indeterminate' ? 'DEBATE_INDETERMINATE' : 'DEBATE_TURN_FAILED' },
        { state: terminalState },
      )
      return 'terminal'
    }

    const ledger = mergeLedger(run.snapshot.claimLedger, contributions)
    const dissent = mergeDissent(run.snapshot.dissent, contributions)
    const unresolved = mergeUnresolved(run.snapshot.unresolved, contributions, ledger)
    const evidence = collectEvidence(run.request.sourceRefs, ledger, dissent, unresolved)
    const currentRound = this.round(run, number)
    const reviewingRound: DebateRoundSnapshotV1 = {
      ...currentRound,
      state: 'reviewing',
      claimLedger: ledger,
      dissent,
      unresolved,
    }
    this.replaceRoundProjection(run, reviewingRound, 'debate.claims.compiled', {
      round: number, claimCount: ledger.claims.length, dissentCount: dissent.length, unresolvedCount: unresolved.length,
    }, { claimLedger: ledger, dissent, unresolved, evidence })
    const convergence = this.convergence(run, reviewingRound, priorUnresolved, budgetReason)
    const completedRound: DebateRoundSnapshotV1 = { ...reviewingRound, state: 'completed', convergence }
    this.replaceRoundProjection(run, completedRound, 'debate.convergence.evaluated', {
      round: number,
      status: convergence.status,
      score: convergence.score,
      threshold: convergence.threshold,
      disagreement: convergence.disagreement,
      coverage: convergence.coverage,
      unresolvedHighSeverity: convergence.unresolvedHighSeverity,
      settledAgents: convergence.settledAgents,
      reason: convergence.reason,
      lifecycleState: convergence.status === 'continue' ? 'next_round' : 'synthesizing',
    }, {
      state: convergence.status === 'converged'
        ? 'synthesizing'
        : convergence.status === 'continue'
          ? 'next_round'
          : 'synthesizing',
      claimLedger: ledger,
      dissent,
      unresolved,
      evidence,
    })
    this.appendEvent(run, 'debate.cost.accounted', {
      usageStatus: run.snapshot.cost.usageStatus,
      costStatus: run.snapshot.cost.costStatus,
      ...(run.snapshot.cost.inputTokens === undefined ? {} : { inputTokens: run.snapshot.cost.inputTokens }),
      ...(run.snapshot.cost.outputTokens === undefined ? {} : { outputTokens: run.snapshot.cost.outputTokens }),
      ...(run.snapshot.cost.costUsd === undefined ? {} : { costUsd: run.snapshot.cost.costUsd }),
    }, { cost: run.snapshot.cost }, { round: number })
    if (convergence.status !== 'continue') {
      this.synthesize(
        run,
        completedRound,
        convergence.status === 'converged' ? 'completed' : convergence.status,
      )
      return convergence.status === 'converged' ? 'converged' : 'terminal'
    }
    return 'continue'
  }

  private convergence(
    run: StoredRun,
    round: DebateRoundSnapshotV1,
    priorUnresolved: readonly DebateUnresolvedV1[],
    budgetReason: string | undefined,
  ): ConvergenceResult {
    const policy = run.snapshot.policy.convergence
    const settledAgents = new Set(round.turns.filter(turn => turn.state === 'settled').map(turn => turn.slotId)).size
    const claims = round.claimLedger.claims
    const confidenceSum = claims.reduce((sum, claim) => sum + claim.confidence, 0)
    const confidence = claims.length === 0 ? 0 : confidenceSum / claims.length
    const opposedConfidence = claims
      .filter(claim => claim.opposingSlotIds.length > 0)
      .reduce((sum, claim) => sum + claim.confidence, 0)
    const dissentConfidence = round.dissent.reduce((sum, dissent) => sum + dissent.confidence, 0)
    const disagreement = roundNumber(Math.min(1, (opposedConfidence + dissentConfidence)
      / Math.max(1, confidenceSum + dissentConfidence)))
    const coverage = round.claimLedger.coverage
    const score = roundNumber(confidence * (1 - disagreement))
    const unresolvedHighSeverity = round.unresolved.filter(entry => entry.severity === 'high' || entry.severity === 'critical').length
    const priorUnresolvedIds = new Set(priorUnresolved.map(entry => entry.claimId))
    const newUnresolved = round.unresolved.some(entry => !priorUnresolvedIds.has(entry.claimId))
    const criticalEvidenceMissing = policy.requireEvidenceForCritical
      && claims.some(claim => claim.severity === 'critical' && claim.evidenceRefs.length === 0)
    const eligible = settledAgents >= policy.minSettledAgents
      && score >= policy.scoreThreshold
      && unresolvedHighSeverity <= policy.maxUnresolvedHighSeverity
      && !newUnresolved
      && !criticalEvidenceMissing
    const reason = budgetReason !== undefined
      ? budgetReason
      : eligible
        ? 'settled agents, evidence coverage, confidence, and disagreement satisfy the convergence policy'
        : [
          settledAgents < policy.minSettledAgents ? `settled agents ${String(settledAgents)} below ${String(policy.minSettledAgents)}` : undefined,
          score < policy.scoreThreshold ? `score ${String(score)} below ${String(policy.scoreThreshold)}` : undefined,
          unresolvedHighSeverity > policy.maxUnresolvedHighSeverity ? `unresolved high-severity claims ${String(unresolvedHighSeverity)} exceed ${String(policy.maxUnresolvedHighSeverity)}` : undefined,
          newUnresolved ? 'round introduced an unresolved claim' : undefined,
          criticalEvidenceMissing ? 'critical claim lacks evidence' : undefined,
        ].filter((entry): entry is string => entry !== undefined).join('; ')
    const status = budgetReason !== undefined
      ? 'budget_limited'
      : eligible
        ? 'converged'
        : round.round >= run.snapshot.policy.budget.maxRounds
          ? 'max_rounds'
          : 'continue'
    return {
      version: 1,
      status,
      score,
      threshold: policy.scoreThreshold,
      disagreement,
      coverage,
      unresolvedHighSeverity,
      settledAgents,
      reason,
    }
  }

  private assertFollowUpReferences(
    result: NormalizedTurnResult,
    ledger: DebateClaimLedgerV1,
    role: DebateRoleId,
  ): void {
    const priorClaimIds = new Set(ledger.claims.map(claim => claim.claimId))
    const newClaimIds = new Set(result.claims
      .filter(claim => !priorClaimIds.has(claim.claimId))
      .map(claim => claim.claimId))
    if (role !== 'decision-judge' && newClaimIds.size > 0) {
      invalid(`follow-up claim ${[...newClaimIds].sort()[0]} is not present in the claim ledger`)
    }
    if (newClaimIds.size > MAX_FOLLOW_UP_JUDGE_CLAIMS) {
      invalid(`follow-up decision judge may add at most ${String(MAX_FOLLOW_UP_JUDGE_CLAIMS)} reconciliation claims`)
    }
    const knownClaimIds = new Set([...priorClaimIds, ...newClaimIds])
    for (const dissent of result.dissent) {
      if (!knownClaimIds.has(dissent.claimId)) invalid(`follow-up dissent ${dissent.claimId} is not present in the claim ledger`)
    }
    for (const unresolved of result.unresolved) {
      if (!knownClaimIds.has(unresolved.claimId)) invalid(`follow-up unresolved claim ${unresolved.claimId} is not present in the claim ledger`)
    }
  }

  private synthesize(
    run: StoredRun,
    round: DebateRoundSnapshotV1,
    finalState: 'completed' | 'budget_limited' | 'max_rounds',
  ): void {
    const judge = [...round.turns].reverse().find(turn => turn.role === 'decision-judge' && turn.state === 'settled')
    const running = {
      version: 1 as const,
      state: 'running' as const,
      unresolvedClaimIds: run.snapshot.unresolved.map(entry => entry.claimId),
      dissentCount: run.snapshot.dissent.length,
    }
    this.appendEvent(run, 'debate.synthesis.started', {
      round: round.round,
      lifecycleState: 'synthesizing',
    }, { state: 'synthesizing', synthesis: running }, { round: round.round })
    const settled = {
      version: 1 as const,
      state: 'settled' as const,
      unresolvedClaimIds: run.snapshot.unresolved.map(entry => entry.claimId),
      dissentCount: run.snapshot.dissent.length,
      ...(judge?.outputRef === undefined ? {} : { artifactRef: judge.outputRef }),
      ...(judge?.outputPreview === undefined ? {} : { outputPreview: judge.outputPreview }),
    }
    this.appendEvent(run, 'debate.synthesis.settled', {
      round: round.round,
      unresolvedClaimIds: settled.unresolvedClaimIds,
      dissentCount: settled.dissentCount,
      lifecycleState: finalState,
    }, { state: finalState, synthesis: settled }, { round: round.round })
  }

  private async executeRound(
    run: StoredRun,
    slots: readonly DebateRoleSpecV1[],
    round: number,
    phase: DebateTurnPhase,
    signal: AbortSignal,
  ): Promise<DebateRoundExecutionResultV1> {
    const turns = slots.map((slot): DebateTurnRequestV1 => ({
      version: 1,
      runId: run.runId,
      workspace: run.request.workspace,
      round,
      slotId: slot.role,
      role: slot.role,
      persona: clone(slot.persona),
      operatorId: slot.operatorId,
      ...(slot.fallbackOperatorIds === undefined ? {} : { fallbackOperatorIds: clone(slot.fallbackOperatorIds) }),
      model: slot.model,
      tier: slot.tier,
      source: slot.source,
      phase,
      prompt: run.request.prompt,
      ...(run.request.objective === undefined ? {} : { objective: run.request.objective }),
      sourceRefs: clone(run.request.sourceRefs ?? []),
      ...(run.request.execution === undefined ? {} : { execution: clone(run.request.execution) }),
      ...(run.request.sourceSessionId === undefined ? {} : { sourceSessionId: run.request.sourceSessionId }),
      priorLedger: clone(run.snapshot.claimLedger),
      priorDissent: clone(run.snapshot.dissent),
      priorUnresolved: clone(run.snapshot.unresolved),
      signal,
    }))
    if (this.executor === undefined) unavailable('debate-local has no injected round executor')
    const result = await this.executor.executeRound({
      version: 1,
      runId: run.runId,
      round,
      turns,
      maxParallel: Math.max(1, slots.filter(slot => slot.kind === 'participant').length),
      onProgress: async progress => this.appendRoundAgentProgress(run.runId, progress),
      signal,
    })
    const expected = new Set(slots.map(slot => slot.role))
    const actual = [...Object.keys(result.resultsBySlot), ...Object.keys(result.failuresBySlot ?? {})]
    if (actual.some(slotId => !expected.has(slotId as DebateRoleId))) {
      invalid('round executor returned an unsupported slot result')
    }
    if (new Set(actual).size !== actual.length) invalid('round executor returned both result and failure for one slot')
    if (actual.length !== expected.size) invalid('round executor omitted a slot outcome')
    return result
  }

  /** Persist one whitelisted TaskGraph operator detail before the round settles. */
  private async appendRoundAgentProgress(
    runId: string,
    candidate: DebateRoundAgentProgressV1,
  ): Promise<void> {
    await this.mutate(() => {
      const run = this.requireRun(runId)
      if (lifecycleTerminal(run.snapshot.state)) return
      const round = this.round(run, candidate.round)
      const turn = round.turns.find(value => value.slotId === candidate.slotId)
      if (turn === undefined) invalid(`round progress slot is not admitted: ${candidate.slotId}`)
      const progress = normalizeRoundAgentProgress(candidate, {
        runId,
        round: round.round,
        slotId: turn.slotId,
        role: turn.role,
      })
      if (turn.state !== 'dispatched') return
      const source = progress.progress.source
      const duplicate = run.events.some(event => (
        event.type === 'debate.agent.progress'
        && event.round === progress.round
        && event.slotId === progress.slotId
        && event.data.orchestrationRunId === source.orchestrationRunId
        && event.data.orchestrationSequence === source.sequence
      ))
      if (duplicate) return
      this.appendEvent(run, 'debate.agent.progress', {
        role: progress.role,
        orchestrationRunId: source.orchestrationRunId,
        orchestrationSequence: source.sequence,
        orchestrationTime: source.time,
        kind: progress.progress.kind,
        ...(progress.progress.phase === undefined ? {} : { phase: progress.progress.phase }),
        ...(progress.progress.publicOutputPreview === undefined ? {} : { publicOutputPreview: progress.progress.publicOutputPreview }),
        ...(progress.progress.toolName === undefined ? {} : { toolName: progress.progress.toolName }),
        ...(progress.progress.approvalKind === undefined ? {} : { approvalKind: progress.progress.approvalKind }),
        ...(progress.progress.approvalPreview === undefined ? {} : { approvalPreview: progress.progress.approvalPreview }),
        ...(progress.progress.usage === undefined ? {} : { usage: progressUsageData(progress.progress.usage) }),
        ...(progress.progress.routing === undefined ? {} : { routing: progressRoutingData(progress.progress.routing) }),
      }, {}, { round: progress.round, slotId: progress.slotId })
    })
  }

  private roundSlots(roster: readonly DebateRoleSpecV1[], maxAgents: number): DebateRoleSpecV1[] {
    const ordered = orderedRoster(roster)
    if (ordered.length <= maxAgents) return ordered
    const judge = ordered.find(slot => slot.role === 'decision-judge')
    const selected = ordered.slice(0, maxAgents)
    if (judge !== undefined && !selected.some(slot => slot.role === judge.role)) selected[selected.length - 1] = judge
    return orderedRoster(selected)
  }

  private turnCount(run: StoredRun, slotId: string, beforeRound: number): number {
    return run.snapshot.rounds.flatMap(round => round.turns)
      .filter(turn => turn.slotId === slotId && turn.round < beforeRound).length
  }

  private budgetReason(cost: DebateRunSnapshotV1['cost'], policy: DebateRunSnapshotV1['policy']): string | undefined {
    const budget = policy.budget
    if (cost.unknownUsageTurns > 0) return 'token usage accounting is unavailable'
    if (budget.maxCostUsd !== undefined && cost.unknownCostTurns > 0) return 'cost accounting is unavailable'
    if ((cost.inputTokens ?? 0) >= budget.maxInputTokens) return 'input token budget exhausted'
    if ((cost.outputTokens ?? 0) >= budget.maxOutputTokens) return 'output token budget exhausted'
    if ((cost.inputTokens ?? 0) + (cost.outputTokens ?? 0) >= budget.maxTotalTokens) return 'total token budget exhausted'
    if (budget.maxCostUsd !== undefined && (cost.costUsd ?? 0) >= budget.maxCostUsd) return 'cost budget exhausted'
    return undefined
  }

  private replaceTurn(
    run: StoredRun,
    roundNumber: number,
    turn: DebateAgentTurnV1,
    type: DebateEventType,
    data: Readonly<Record<string, string | number>>,
    patch: Partial<Pick<DebateRunSnapshotV1, 'state' | 'cost'>> = {},
  ): void {
    this.round(run, roundNumber)
    const rounds = run.snapshot.rounds.map(round => round.round === roundNumber
      ? { ...round, turns: round.turns.map(entry => entry.slotId === turn.slotId ? turn : entry) }
      : round)
    this.appendEvent(run, type, data, { ...patch, rounds }, { round: roundNumber, slotId: turn.slotId })
  }

  private replaceRoundProjection(
    run: StoredRun,
    round: DebateRoundSnapshotV1,
    type: DebateEventType,
    data: Readonly<Record<string, unknown>>,
    patch: Partial<Pick<DebateRunSnapshotV1, 'state' | 'claimLedger' | 'dissent' | 'unresolved' | 'evidence'>> = {},
  ): void {
    const rounds = run.snapshot.rounds.map(entry => entry.round === round.round ? round : entry)
    this.appendEvent(
      run,
      type,
      data as Readonly<Record<string, string | number | boolean | readonly string[]>>,
      { ...patch, rounds },
      { round: round.round },
    )
  }

  private appendEvent(
    run: StoredRun,
    type: DebateEventType,
    data: Readonly<Record<string, DebateJsonValue>>,
    patch: Partial<Pick<DebateRunSnapshotV1, 'state' | 'currentRound' | 'rounds' | 'claimLedger' | 'dissent' | 'unresolved' | 'evidence' | 'cost' | 'provenance' | 'synthesis'>> = {},
    context: { readonly round?: number; readonly slotId?: string } = {},
  ): void {
    const nextState = patch.state ?? run.snapshot.state
    if (lifecycleFinal(run.snapshot.state) && nextState !== run.snapshot.state) {
      throw new DebateError(
        `terminal Debate ${run.runId} cannot transition from ${run.snapshot.state} to ${nextState}`,
        'DEBATE_STATE_CONFLICT',
      )
    }
    const createdAt = this.now()
    const revision = run.snapshot.revision + 1
    run.snapshot = { ...run.snapshot, ...patch, revision, updatedAt: createdAt }
    this.document.generation += 1
    const event: DebateEventV1 = {
      version: 1,
      sequence: run.events.length + 1,
      runId: run.runId,
      revision,
      generation: this.document.generation,
      type,
      createdAt,
      data: data as DebateEventV1['data'],
      ...(context.round === undefined ? {} : { round: context.round }),
      ...(context.slotId === undefined ? {} : { slotId: context.slotId }),
    }
    run.events.push(event)
    this.persist()
  }

  private provenance(
    request: DebateStartRequestV1,
    requestSha256: string,
    policy: DebateRunSnapshotV1['policy'],
  ): DebateRunSnapshotV1['provenance'] {
    const execution = request.execution
    return {
      version: 1,
      providerId: this.providerId,
      providerVersion: this.providerVersion,
      requestSha256,
      policySha256: `sha256:${sha256(policy)}`,
      ...(request.sourceSessionId === undefined ? {} : { sourceSessionId: request.sourceSessionId }),
      ...(execution?.runId === undefined ? {} : { parentRunId: execution.runId }),
      ...(execution?.nodeId === undefined ? {} : { parentNodeId: execution.nodeId }),
      ...(execution?.sessionId === undefined ? {} : { parentRlmSessionId: execution.sessionId }),
    }
  }

  private summary(snapshot: DebateRunSnapshotV1): DebateRunSummaryV1 {
    return {
      version: 1,
      runId: snapshot.runId,
      state: snapshot.state,
      mode: snapshot.mode,
      currentRound: snapshot.currentRound,
      revision: snapshot.revision,
      unresolvedCount: snapshot.unresolved.length,
      cost: clone(snapshot.cost),
      updatedAt: snapshot.updatedAt,
    }
  }

  private round(run: StoredRun, roundNumber: number): DebateRoundSnapshotV1 {
    const current = run.snapshot.rounds.find(round => round.round === roundNumber)
    if (current === undefined) unavailable(`debate round not found: ${String(roundNumber)}`)
    return current
  }

  private requireRun(runId: string): StoredRun {
    const run = this.document.runs.find(entry => entry.runId === runId)
    if (run === undefined) throw new DebateError(`debate run not found: ${runId}`, 'DEBATE_NOT_FOUND')
    return run
  }

  private runId(value: string): string {
    return text(value, 'runId', 256)
  }

  private stateConflict(run: StoredRun, action: string): never {
    throw new DebateError(`cannot ${action} debate ${run.runId} while state is ${run.snapshot.state}`, 'DEBATE_STATE_CONFLICT')
  }

  private lastStopAction(run: StoredRun): string | undefined {
    const event = [...run.events].reverse().find(entry => entry.type === 'debate.stopped')
    const action = event?.data.action
    return typeof action === 'string' ? action : undefined
  }

  private command(method: StoredCommand['method'], commandId: string, requestSha256: string): StoredCommand | undefined {
    const existing = this.document.commands.find(command => command.commandId === commandId)
    if (existing === undefined) return undefined
    if (existing.method !== method || existing.requestSha256 !== requestSha256) {
      throw new DebateError(`commandId already belongs to another Debate request: ${commandId}`, 'DEBATE_STATE_CONFLICT')
    }
    return existing
  }

  private recordCommand(command: StoredCommand): void {
    this.document.commands.push(command)
    this.persist()
  }

  private transitionCommand(
    commandId: string,
    state: StoredCommand['state'],
    response?: DebateRunSnapshotV1,
  ): void {
    const command = this.document.commands.find(entry => entry.commandId === commandId)
    if (command === undefined) unavailable(`debate command receipt is missing: ${commandId}`)
    command.state = state
    if (response !== undefined) command.response = clone(response)
    this.persist()
  }

  private replayCommand(command: StoredCommand): Promise<DebateRunSnapshotV1> | DebateRunSnapshotV1 {
    if (command.state === 'settled' && command.response !== undefined) return clone(command.response)
    if (command.state === 'indeterminate') {
      throw new DebateError(`debate command outcome is indeterminate: ${command.commandId}`, 'DEBATE_INDETERMINATE')
    }
    const active = this.activeRuns.get(command.runId)
    if (active !== undefined) return active.promise.then(clone)
    throw new DebateError(`debate command lost its active runner: ${command.commandId}`, 'DEBATE_INDETERMINATE')
  }

  private drive(
    runId: string,
    commandId: string,
    action: 'auto' | 'approve' | 'resume',
  ): Promise<DebateRunSnapshotV1> {
    const current = this.activeRuns.get(runId)
    if (current !== undefined) return current.promise
    const controller = new AbortController()
    const promise = (async (): Promise<DebateRunSnapshotV1> => {
      const run = this.requireRun(runId)
      try {
        await this.runUntilTerminal(run, action, controller.signal)
        if (run.controlIntent !== undefined) {
          delete run.controlIntent
          this.persist()
        }
        const response = clone(run.snapshot)
        await this.mutate(() => {
          this.transitionCommand(commandId, 'settled', response)
        })
        return response
      } catch (error) {
        await this.mutate(() => {
          const latest = this.requireRun(runId)
          if (!lifecycleTerminal(latest.snapshot.state)) {
            this.appendEvent(latest, 'debate.indeterminate', {
              errorCode: executorErrorCode(error),
              error: errorMessage(error),
            }, { state: 'indeterminate' })
          }
          this.transitionCommand(commandId, 'indeterminate', clone(latest.snapshot))
        })
        throw error
      } finally {
        if (this.activeRuns.get(runId)?.commandId === commandId) this.activeRuns.delete(runId)
      }
    })()
    const active: ActiveRun = { commandId, controller, promise }
    this.activeRuns.set(runId, active)
    return promise
  }

  private newRunId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = this.idFactory()
      if (typeof value !== 'string' || value.trim().length === 0) invalid('idFactory must return a non-blank string')
      if (!this.document.runs.some(run => run.runId === value)) return value
    }
    invalid('idFactory returned duplicate run IDs without making progress')
  }

  private now(): string {
    const value = this.clock()
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid('clock must return an ISO timestamp')
    return new Date(value).toISOString()
  }

  private async mutate<T>(operation: () => T | Promise<T>): Promise<T> {
    const task = this.writeTail.then(() => withFileLock(
      this.filename,
      () => Promise.resolve(operation()),
    ))
    this.writeTail = task.then(() => undefined, () => undefined)
    return task
  }

  private recoverInterruptedCommands(): void {
    const interruptedRunIds = new Set(this.document.commands
      .filter(command => command.state === 'accepted' || command.state === 'running')
      .map(command => command.runId))
    for (const run of this.document.runs) {
      if (['admitting', 'round_running', 'reviewing', 'converged', 'next_round', 'synthesizing'].includes(run.snapshot.state)) {
        interruptedRunIds.add(run.runId)
      }
    }
    if (interruptedRunIds.size === 0) return
    for (const runId of interruptedRunIds) {
      const run = this.document.runs.find(entry => entry.runId === runId)
      if (run === undefined || lifecycleTerminal(run.snapshot.state)) continue
      delete run.controlIntent
      const createdAt = this.now()
      const revision = run.snapshot.revision + 1
      run.snapshot = { ...run.snapshot, state: 'indeterminate', revision, updatedAt: createdAt }
      this.document.generation += 1
      run.events.push({
        version: 1,
        sequence: run.events.length + 1,
        runId,
        revision,
        generation: this.document.generation,
        type: 'debate.indeterminate',
        createdAt,
        data: { errorCode: 'DEBATE_INDETERMINATE', error: 'provider restarted before the command outcome was proven' },
      })
    }
    for (const command of this.document.commands) {
      if (command.state !== 'accepted' && command.state !== 'running') continue
      const run = this.document.runs.find(entry => entry.runId === command.runId)
      if (run !== undefined && hasProvenTerminalOutcome(run)) {
        command.state = 'settled'
        command.response = clone(run.snapshot)
        continue
      }
      command.state = 'indeterminate'
      if (run !== undefined) command.response = clone(run.snapshot)
    }
    this.persist()
  }

  private load(): StoreDocument {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filename, 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, generation: 0, runs: [], commands: [] }
      unavailable(`cannot read debate-local state: ${errorMessage(error)}`, { cause: error })
    }
    const document = record(parsed, 'debate-local state')
    const generation = document.generation
    if (document.version !== STATE_VERSION || typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0
      || !Array.isArray(document.runs) || !Array.isArray(document.commands)) {
      unavailable('debate-local state has an unsupported shape')
    }
    const runs: StoredRun[] = []
    for (const value of document.runs as unknown[]) {
      const stored = record(value, 'debate-local stored run')
      if (typeof stored.runId !== 'string' || stored.request === undefined || stored.snapshot === undefined || !Array.isArray(stored.events)) {
        unavailable('debate-local state contains an invalid run')
      }
      const runId = stored.runId
      let request: DebateStartRequestV1
      try {
        request = validateDebateStartRequest(stored.request)
      } catch (error) {
        unavailable(`stored Debate request is invalid: ${errorMessage(error)}`, { cause: error })
      }
      const snapshot = record(stored.snapshot, `debate-local snapshot ${runId}`)
      if (snapshot.runId !== runId || typeof snapshot.revision !== 'number' || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
        unavailable(`stored Debate snapshot is invalid: ${runId}`)
      }
      const events: DebateEventV1[] = []
      for (const eventValue of stored.events) {
        const event = record(eventValue, `debate-local event ${runId}`)
        if (event.runId !== runId || typeof event.sequence !== 'number' || !Number.isSafeInteger(event.sequence) || event.sequence < 1) {
          unavailable(`stored Debate event is invalid: ${runId}`)
        }
        events.push(event as unknown as DebateEventV1)
      }
      let controlIntent: StoredRun['controlIntent']
      if (stored.controlIntent !== undefined) {
        const intent = record(stored.controlIntent, `debate-local control intent ${runId}`)
        if ((intent.action !== 'pause' && intent.action !== 'stop')
          || typeof intent.reason !== 'string' || typeof intent.commandId !== 'string') {
          unavailable(`stored Debate control intent is invalid: ${runId}`)
        }
        controlIntent = {
          action: intent.action,
          reason: intent.reason,
          commandId: intent.commandId,
        }
      }
      runs.push({
        runId,
        request,
        snapshot: snapshot as unknown as DebateRunSnapshotV1,
        events,
        ...(controlIntent === undefined ? {} : { controlIntent }),
      })
    }
    const commands: StoredCommand[] = []
    for (const value of document.commands as unknown[]) {
      const stored = record(value, 'debate-local command receipt')
      if (typeof stored.commandId !== 'string' || (stored.method !== 'start' && stored.method !== 'control')
        || typeof stored.requestSha256 !== 'string') {
        unavailable('debate-local state contains an invalid command receipt')
      }
      const legacyResponse = stored.response === undefined ? undefined : stored.response as DebateRunSnapshotV1
      const runId = typeof stored.runId === 'string'
        ? stored.runId
        : legacyResponse?.runId
      const state = stored.state === undefined && legacyResponse !== undefined ? 'settled' : stored.state
      if (typeof runId !== 'string' || !['accepted', 'running', 'settled', 'indeterminate'].includes(String(state))) {
        unavailable('debate-local state contains an unsupported command receipt')
      }
      if (state === 'settled' && legacyResponse === undefined) {
        unavailable('debate-local settled command receipt omitted its response')
      }
      commands.push({
        commandId: stored.commandId,
        method: stored.method,
        requestSha256: stored.requestSha256,
        runId,
        state: state as StoredCommand['state'],
        ...(legacyResponse === undefined ? {} : { response: legacyResponse }),
      })
    }
    return {
      version: 1,
      generation,
      runs,
      commands,
    }
  }

  private persist(): void {
    writeFileAtomicSync(this.filename, `${JSON.stringify(this.document)}\n`, { mode: 0o600, dirMode: 0o700 })
  }
}

/** Named plugin entry for Loader compositions. */
export function apply(ctx: Context, config: Config): void {
  new LocalDebateProvider(ctx, config)
}

export default LocalDebateProvider
