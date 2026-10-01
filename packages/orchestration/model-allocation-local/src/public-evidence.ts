/**
 * Deterministic, non-calibrating comparison of public model evidence.
 *
 * Public benchmark records are not DSH outcomes. This module turns exact,
 * same-cohort records into an explainable secondary preference among
 * candidates the allocator has already admitted. It returns a partial order,
 * never a pairwise sort comparator: incompatible records, source conflicts,
 * missing sample counts, overlapping uncertainty, and preference cycles all
 * abstain instead of producing an unstable ranking. No source value leaves the
 * function; the only ranking output is a topological preference tier.
 *
 * This is a TypeScript port of Codex Workbench's `public_evidence_ranking.py`
 * (the unified-scheduling a3 revision recorded in
 * `distribution/workbench-scheduling-sources.json`). The expected outputs in
 * `tests/fixtures/public-evidence` come from that Python code. Known
 * differences are listed in the package README.
 * @module @deepseek-ai/dsh-model-allocation-local/public-evidence
 */

/** The ten conditions that must all be equal for two records to be comparable, in sorted key order. */
const COHORT_FIELDS = [
  'benchmark',
  'benchmark_version',
  'billing_identity',
  'execution_surface',
  'harness',
  'metric_kind',
  'reasoning_effort',
  'score_kind',
  'task_type',
  'unit',
] as const

const HIGHER_IS_BETTER: ReadonlySet<string> = new Set([
  'acceptance_rate', 'accuracy', 'consistency', 'pass_rate', 'resolved_rate', 'success_rate',
])
const RATE_METRICS = HIGHER_IS_BETTER
const LATENCY_METRICS: ReadonlySet<string> = new Set(['latency', 'latency_ms', 'runtime_ms'])
const COST_METRICS: ReadonlySet<string> = new Set(['cost', 'cost_units', 'cost_usd'])
const RATE_UNITS: ReadonlySet<string> = new Set(['percent', 'percentage', 'proportion', 'ratio'])
const LATENCY_UNITS: ReadonlySet<string> = new Set(['milliseconds', 'ms', 's', 'seconds'])
const COST_UNITS: ReadonlySet<string> = new Set(['cost-units', 'credits', 'tokens', 'usd'])
/** Score kinds that rate opinion or intelligence rather than measure a task outcome. */
const NONCOMPARABLE_SCORE_MARKERS = ['community', 'iq', 'preference', 'rating', 'subjective'] as const
const OVERLAP_REASON = 'pass-rate uncertainty intervals overlap'
const INCOMPLETE_REASON = 'incomplete-comparison: no shared valid comparable public measurement cohort'
const EQUAL_VALUE_TOLERANCE = 1e-12
const WILSON_Z = 1.96

/** One source and cohort a decision rests on or abstained from. */
export interface PublicEvidenceReference {
  readonly source: string
  readonly cohortKey: string
}

/** A source and cohort that was set aside, with the reason. */
export interface PublicEvidenceAbstention extends PublicEvidenceReference {
  readonly reason: string
}

/** The facts of one accepted measurement. Its value is deliberately not echoed. */
export interface PublicEvidenceMeasurement {
  readonly source: string
  readonly sourceFamily: string
  readonly cohortKey: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
  readonly executionSurface: string
  readonly billingIdentity: string
  readonly benchmark: string | null
  readonly benchmarkVersion: string | null
  readonly taskType: string
  readonly harness: string | null
  readonly metricKind: string
  readonly scoreKind: string
  readonly unit: string
  readonly sampleCount: number | null
  readonly observedAt: string | null
  readonly freshnessState: string | null
  readonly provenance: string | null
  readonly lineageId: string
}

/** What the evidence says about one candidate. */
export interface PublicEvidenceCandidateSummary {
  readonly candidateId: string
  /** `used` when the candidate won or lost at least one comparison; otherwise `abstained`. */
  readonly status: 'used' | 'abstained'
  readonly reason: string
  /** Topological tier; 0 is preferred and equal tiers are not ordered. */
  readonly preferenceRank: number
  readonly supportingSources: readonly PublicEvidenceReference[]
  readonly conflictingSources: readonly PublicEvidenceReference[]
  readonly abstainedSources: readonly PublicEvidenceAbstention[]
  readonly cohorts: readonly string[]
  readonly measurements: readonly PublicEvidenceMeasurement[]
}

/** Two candidates whose comparable sources disagree. */
export interface PublicEvidenceConflict {
  readonly candidates: readonly [string, string]
  readonly sources: readonly PublicEvidenceReference[]
  readonly reason: string
}

/** Two candidates that share no valid comparable measurement. */
export interface PublicEvidenceIncompleteComparison {
  readonly candidates: readonly [string, string]
  readonly sources: readonly PublicEvidenceReference[]
  readonly reason: string
}

/** The ranking and the full receipt of what was used, conflicted, and set aside. */
export interface PublicEvidenceRanking {
  readonly status: 'used' | 'abstained'
  readonly reason: string
  readonly preferenceRanks: Readonly<Record<string, number>>
  /** In candidate id order. */
  readonly candidateSummaries: readonly PublicEvidenceCandidateSummary[]
  readonly conflicts: readonly PublicEvidenceConflict[]
  readonly cohorts: readonly string[]
  readonly incompleteComparisons: readonly PublicEvidenceIncompleteComparison[]
}

/**
 * One candidate already admitted by the hard gates and inside the quality band.
 * `publicEvidence` holds records exactly as the collectors emit them
 * (snake_case keys) and is validated here, since it is parsed external data.
 */
export interface PublicEvidenceCandidate {
  readonly candidateId: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string | undefined
  readonly executionSurface: string
  readonly billingIdentity: string
  readonly publicEvidence?: unknown
}

type Dict = Readonly<Record<string, unknown>>

/** An accepted record: the receipt facts plus the two fields that never leave this module. */
interface ParsedRecord extends PublicEvidenceMeasurement {
  readonly direction: 'higher' | 'lower'
  readonly value: number
}

interface CandidateState {
  readonly candidateId: string
  /** Keyed by source family and cohort. */
  readonly records: ReadonlyMap<string, ParsedRecord>
  readonly abstentions: readonly PublicEvidenceAbstention[]
}

interface MutableSummary {
  candidateId: string
  status: 'used' | 'abstained'
  reason: string
  preferenceRank: number
  supportingSources: PublicEvidenceReference[]
  conflictingSources: PublicEvidenceReference[]
  abstainedSources: PublicEvidenceAbstention[]
  cohorts: string[]
  measurements: PublicEvidenceMeasurement[]
}

/** Winner and loser of one unanimous comparison, keyed by the pair. */
type Edges = ReadonlyMap<string, { winner: string; loser: string }>

/** What a record must match about the candidate it belongs to. */
interface CandidateContext {
  readonly provider: string
  readonly model: string
  readonly effort: string | null
  readonly taskType: string
  readonly executionSurface: string
  readonly billingIdentity: string
}

type ParseResult = { readonly parsed: ParsedRecord } | { readonly abstained: PublicEvidenceAbstention }

interface Comparison {
  readonly direction: -1 | 0 | 1
  readonly reason: string | null
}

interface Vote extends PublicEvidenceReference {
  readonly winner: string
  readonly loser: string
}

function isDict(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Trimmed non-empty string, or null: an exact contract identifier without case folding. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareReferences(left: PublicEvidenceReference, right: PublicEvidenceReference): number {
  return compareText(left.source, right.source) || compareText(left.cohortKey, right.cohortKey)
}

function pairKey(first: string, second: string): string {
  return JSON.stringify([first, second])
}

function uniqueReferences(references: Iterable<PublicEvidenceReference>): PublicEvidenceReference[] {
  const unique = new Map<string, PublicEvidenceReference>()
  for (const reference of references) {
    unique.set(pairKey(reference.source, reference.cohortKey), { source: reference.source, cohortKey: reference.cohortKey })
  }
  return [...unique.values()].sort(compareReferences)
}

function uniqueAbstentions(abstentions: Iterable<PublicEvidenceAbstention>): PublicEvidenceAbstention[] {
  const unique = new Map<string, PublicEvidenceAbstention>()
  for (const item of abstentions) {
    unique.set(JSON.stringify([item.source, item.cohortKey, item.reason]), {
      source: item.source,
      cohortKey: item.cohortKey,
      reason: item.reason,
    })
  }
  return [...unique.values()].sort((left, right) => compareReferences(left, right) || compareText(left.reason, right.reason))
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Build the canonical cohort key of an evidence record.
 * @param record - one evidence record with snake_case keys.
 * @returns the key, a compact JSON object of the ten cohort conditions in sorted key order, or null
 * unless every condition is an explicit non-blank string.
 */
export function canonicalCohortKey(record: Dict): string | null {
  const cohort: Record<string, string> = {}
  for (const field of COHORT_FIELDS) {
    const value = text(record[field])
    if (value === null) return null
    cohort[field] = value
  }
  return JSON.stringify(cohort)
}

function sourceFamily(raw: Dict, source: string | null): string {
  const explicit = text(raw.upstream_dataset)
  const joined = [explicit, source, text(raw.source_id), text(raw.lineage_id), text(raw.correlation_group)]
    .filter((value): value is string => value !== null)
    .join(' ')
    .toLowerCase()
    .replaceAll('_', '-')
  if (['dradar', 'codex-radar', 'codexradar'].some(alias => joined.includes(alias))) return 'dradar'
  return explicit ?? source ?? 'unknown'
}

function abstention(raw: unknown, reason: string, source?: string): PublicEvidenceAbstention {
  const mapping = isDict(raw) ? raw : {}
  return {
    source: source ?? text(mapping.source) ?? 'unknown',
    cohortKey: text(mapping.cohort_key) ?? '',
    reason,
  }
}

function metricDirection(metricKind: string, unit: string): 'higher' | 'lower' | null {
  if (HIGHER_IS_BETTER.has(metricKind) && RATE_UNITS.has(unit)) return 'higher'
  if (LATENCY_METRICS.has(metricKind) && LATENCY_UNITS.has(unit)) return 'lower'
  if (COST_METRICS.has(metricKind) && COST_UNITS.has(unit)) return 'lower'
  return null
}

function normalizeRate(value: number, unit: string): number | null {
  const normalized = unit === 'percent' || unit === 'percentage' ? value / 100 : value
  return normalized >= 0 && normalized <= 1 ? normalized : null
}

function wilsonInterval(rate: number, sampleCount: number): readonly [number, number] {
  const denominator = 1 + WILSON_Z * WILSON_Z / sampleCount
  const center = (rate + WILSON_Z * WILSON_Z / (2 * sampleCount)) / denominator
  const spread = WILSON_Z * Math.sqrt(
    rate * (1 - rate) / sampleCount + WILSON_Z * WILSON_Z / (4 * sampleCount * sampleCount),
  ) / denominator
  return [Math.max(0, center - spread), Math.min(1, center + spread)]
}

/** The expected `[parsed, abstention]` result of reading one record. */
function parseRecord(raw: unknown, candidate: CandidateContext): ParseResult {
  const abstain = (reason: string, source?: string): ParseResult => ({ abstained: abstention(raw, reason, source) })
  if (!isDict(raw)) return abstain('public evidence record is not an object')
  const source = text(raw.source)
  const family = sourceFamily(raw, source)
  const { effort } = candidate
  if (effort === null) return abstain('candidate reasoning effort is missing')
  const cohortKey = text(raw.cohort_key)
  if (source === null) return abstain('missing public evidence source')
  const comparability = raw.comparability
  if (!isDict(comparability)) return abstain('missing public evidence comparability')
  if (text(comparability.status) !== 'comparable') {
    return abstain('public evidence is reference_only or lacks declared comparability', source)
  }
  const expectedCohort = canonicalCohortKey(raw)
  if (expectedCohort === null || cohortKey !== expectedCohort) {
    return abstain('public evidence cohort_key is incomplete or does not match its conditions', source)
  }
  if (text(raw.provider) !== candidate.provider || text(raw.canonical_model_id) !== candidate.model) {
    return abstain('public evidence does not match the exact execution provider/model', source)
  }
  if (text(raw.reasoning_effort) !== effort || text(raw.task_type) !== candidate.taskType) {
    return abstain('public evidence does not match the exact reasoning effort/task type', source)
  }
  if (text(raw.execution_surface) !== candidate.executionSurface || text(raw.billing_identity) !== candidate.billingIdentity) {
    return abstain('public evidence does not match the exact execution surface/billing identity', source)
  }
  // The cohort key above is null unless these three are explicit, so they are present here.
  const metricKind = text(raw.metric_kind) as string
  const scoreKind = text(raw.score_kind) as string
  const unit = text(raw.unit) as string
  const normalizedScoreKind = scoreKind.toLowerCase().replaceAll('_', '-')
  if (NONCOMPARABLE_SCORE_MARKERS.some(marker => normalizedScoreKind.includes(marker))) {
    return abstain('IQ, subjective, preference, and community-rating scores are reference-only', source)
  }
  const direction = metricDirection(metricKind, unit)
  if (direction === null) return abstain('public evidence metric direction or unit is unknown', source)
  let value = finiteNumber(raw.value)
  if (value === null) return abstain('public evidence value is not finite', source)
  if (RATE_METRICS.has(metricKind)) {
    value = normalizeRate(value, unit)
    if (value === null) return abstain('public pass-rate value is outside its declared unit', source)
  }
  const lineageId = text(raw.lineage_id)
  const correlationGroup = text(raw.correlation_group)
  if (lineageId === null || correlationGroup === null) {
    return abstain('public evidence lineage_id or correlation_group is missing', source)
  }
  return {
    parsed: {
      source,
      sourceFamily: family,
      cohortKey: expectedCohort,
      provider: candidate.provider,
      model: candidate.model,
      reasoningEffort: effort,
      executionSurface: candidate.executionSurface,
      billingIdentity: candidate.billingIdentity,
      benchmark: text(raw.benchmark),
      benchmarkVersion: text(raw.benchmark_version),
      taskType: candidate.taskType,
      harness: text(raw.harness),
      metricKind,
      scoreKind,
      unit,
      direction,
      value,
      sampleCount: positiveInteger(raw.sample_count),
      lineageId,
      observedAt: text(raw.observed_at),
      freshnessState: text(raw.freshness_state),
      provenance: text(raw.provenance),
    },
  }
}

/** Keep one record per source family and cohort, or abstain when the group has no single lineage and value. */
function deduplicate(
  group: readonly ParsedRecord[],
): { readonly selected: ParsedRecord } | { readonly abstained: PublicEvidenceAbstention } {
  const [first] = group as readonly [ParsedRecord, ...ParsedRecord[]]
  const unambiguous = group.every(item => item.lineageId === first.lineageId
    && item.metricKind === first.metricKind
    && item.scoreKind === first.scoreKind
    && item.unit === first.unit
    && item.direction === first.direction
    && item.value === first.value
    && item.sampleCount === first.sampleCount)
  if (unambiguous) return { selected: first }
  return {
    abstained: {
      source: first.source,
      cohortKey: first.cohortKey,
      reason: 'multiple public records share a source/cohort without one unambiguous lineage',
    },
  }
}

function candidateState(candidate: PublicEvidenceCandidate, taskType: string): CandidateState {
  const candidateId = text(candidate.candidateId)
  const provider = text(candidate.provider)
  const model = text(candidate.model)
  const executionSurface = text(candidate.executionSurface)
  const billingIdentity = text(candidate.billingIdentity)
  if (candidateId === null || provider === null || model === null || executionSurface === null || billingIdentity === null) {
    throw new TypeError('public evidence candidate requires candidateId, provider, model, executionSurface, and billingIdentity')
  }
  const abstentions: PublicEvidenceAbstention[] = []
  let rawRecords: readonly unknown[] = []
  if (candidate.publicEvidence !== undefined && candidate.publicEvidence !== null) {
    if (Array.isArray(candidate.publicEvidence)) {
      rawRecords = candidate.publicEvidence as readonly unknown[]
    } else {
      abstentions.push({ source: 'unknown', cohortKey: '', reason: 'public_evidence is not a sequence' })
    }
  }
  const parseContext = { provider, model, effort: text(candidate.reasoningEffort), taskType, executionSurface, billingIdentity }
  const grouped = new Map<string, ParsedRecord[]>()
  for (const raw of rawRecords) {
    const result = parseRecord(raw, parseContext)
    if ('abstained' in result) {
      abstentions.push(result.abstained)
    } else {
      const key = pairKey(result.parsed.sourceFamily, result.parsed.cohortKey)
      grouped.set(key, [...grouped.get(key) ?? [], result.parsed])
    }
  }
  const records = new Map<string, ParsedRecord>()
  for (const [key, group] of grouped) {
    const result = deduplicate(group)
    if ('abstained' in result) abstentions.push(result.abstained)
    else records.set(key, result.selected)
  }
  return { candidateId, records, abstentions }
}

function compareRecords(left: ParsedRecord, right: ParsedRecord): Comparison {
  // Records of one cohort share metric kind, score kind, unit, and therefore direction: the cohort key holds them.
  if (RATE_METRICS.has(left.metricKind)) {
    if (left.sampleCount === null || right.sampleCount === null) {
      return { direction: 0, reason: 'pass-rate denominator is missing; confidence is not fabricated' }
    }
    const [leftLow, leftHigh] = wilsonInterval(left.value, left.sampleCount)
    const [rightLow, rightHigh] = wilsonInterval(right.value, right.sampleCount)
    if (leftLow <= rightHigh && rightLow <= leftHigh) return { direction: 0, reason: OVERLAP_REASON }
  } else if (left.sampleCount === null || right.sampleCount === null) {
    return { direction: 0, reason: 'public measurement sample_count is missing; ranking confidence is not fabricated' }
  }
  if (Math.abs(left.value - right.value) <= EQUAL_VALUE_TOLERANCE) return { direction: 0, reason: null }
  const leftWins = left.direction === 'higher' ? left.value > right.value : left.value < right.value
  return { direction: leftWins ? 1 : -1, reason: null }
}

function hasCycle(candidateIds: readonly string[], edges: Edges): boolean {
  const adjacency = new Map<string, Set<string>>(candidateIds.map(id => [id, new Set<string>()]))
  for (const { winner, loser } of edges.values()) (adjacency.get(winner) as Set<string>).add(loser)
  const state = new Map<string, number>(candidateIds.map(id => [id, 0]))
  const visit = (id: string): boolean => {
    state.set(id, 1)
    for (const neighbor of [...adjacency.get(id) as Set<string>].sort(compareText)) {
      if (state.get(neighbor) === 1) return true
      if (state.get(neighbor) === 0 && visit(neighbor)) return true
    }
    state.set(id, 2)
    return false
  }
  return [...candidateIds].sort(compareText).some(id => state.get(id) === 0 && visit(id))
}

function preferenceRanks(candidateIds: readonly string[], edges: Edges): Map<string, number> {
  const adjacency = new Map<string, Set<string>>(candidateIds.map(id => [id, new Set<string>()]))
  const indegree = new Map<string, number>(candidateIds.map(id => [id, 0]))
  for (const { winner, loser } of edges.values()) {
    // Edges are keyed by winner and loser, so each pair is seen once.
    const losers = adjacency.get(winner) as Set<string>
    losers.add(loser)
    indegree.set(loser, (indegree.get(loser) as number) + 1)
  }
  const queue = candidateIds.filter(id => indegree.get(id) === 0).sort(compareText)
  const ranks = new Map<string, number>(candidateIds.map(id => [id, 0]))
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head] as string
    for (const neighbor of [...adjacency.get(current) as Set<string>].sort(compareText)) {
      ranks.set(neighbor, Math.max(ranks.get(neighbor) as number, (ranks.get(current) as number) + 1))
      const remaining = (indegree.get(neighbor) as number) - 1
      indegree.set(neighbor, remaining)
      if (remaining === 0) queue.push(neighbor)
    }
  }
  return ranks
}

function emptySummary(candidateId: string): MutableSummary {
  return {
    candidateId,
    status: 'abstained',
    reason: 'no public evidence supplied',
    preferenceRank: 0,
    supportingSources: [],
    conflictingSources: [],
    abstainedSources: [],
    cohorts: [],
    measurements: [],
  }
}

function normalizeReceipt(summary: MutableSummary): void {
  summary.supportingSources = uniqueReferences(summary.supportingSources)
  summary.conflictingSources = uniqueReferences(summary.conflictingSources)
  summary.abstainedSources = uniqueAbstentions(summary.abstainedSources)
  summary.cohorts = [...new Set([...summary.supportingSources, ...summary.conflictingSources, ...summary.abstainedSources]
    .map(item => item.cohortKey)
    .filter(cohort => cohort.length > 0))].sort(compareText)
}

function result(
  items: readonly CandidateState[],
  summaries: ReadonlyMap<string, MutableSummary>,
  outcome: { status: 'used' | 'abstained'; reason: string; conflicts: readonly PublicEvidenceConflict[]; incomplete?: readonly PublicEvidenceIncompleteComparison[] },
): PublicEvidenceRanking {
  const ordered = items.map(item => summaries.get(item.candidateId) as MutableSummary)
  return {
    status: outcome.status,
    reason: outcome.reason,
    preferenceRanks: Object.fromEntries(ordered.map(summary => [summary.candidateId, summary.preferenceRank])),
    candidateSummaries: ordered,
    conflicts: outcome.conflicts,
    cohorts: [...new Set(ordered.flatMap(summary => summary.cohorts))].sort(compareText),
    incompleteComparisons: outcome.incomplete ?? [],
  }
}

/**
 * Rank already-admitted candidates by comparable public evidence.
 *
 * Candidates must already pass the hard gates and sit in the same quality
 * band; this function never overrides either. It is a pure function of its
 * arguments.
 * @param candidates - admitted candidates, each with its own public evidence records.
 * @param options - `taskType`, the exact task type every record must name.
 * @returns the preference tiers plus a receipt of every source used, conflicted, and set aside.
 * @throws {TypeError} When a candidate lacks an identity field.
 */
export function rankComparablePublicEvidence(
  candidates: readonly PublicEvidenceCandidate[],
  options: { readonly taskType: string },
): PublicEvidenceRanking {
  const taskType = text(options.taskType) ?? ''
  const items = candidates.map(candidate => candidateState(candidate, taskType))
    .sort((left, right) => compareText(left.candidateId, right.candidateId))
  const ids = items.map(item => item.candidateId)
  if (new Set(ids).size !== ids.length) throw new TypeError('public evidence candidates must have distinct candidateId values')
  const summaries = new Map(items.map(item => [item.candidateId, emptySummary(item.candidateId)]))
  const summaryOf = (id: string): MutableSummary => summaries.get(id) as MutableSummary
  for (const item of items) {
    const summary = summaryOf(item.candidateId)
    summary.abstainedSources.push(...item.abstentions)
    summary.measurements = [...item.records.values()]
      .sort((left, right) => compareText(left.sourceFamily, right.sourceFamily) || compareText(left.cohortKey, right.cohortKey))
      .map(record => ({
        source: record.source,
        sourceFamily: record.sourceFamily,
        cohortKey: record.cohortKey,
        provider: record.provider,
        model: record.model,
        reasoningEffort: record.reasoningEffort,
        executionSurface: record.executionSurface,
        billingIdentity: record.billingIdentity,
        benchmark: record.benchmark,
        benchmarkVersion: record.benchmarkVersion,
        taskType: record.taskType,
        harness: record.harness,
        metricKind: record.metricKind,
        scoreKind: record.scoreKind,
        unit: record.unit,
        sampleCount: record.sampleCount,
        observedAt: record.observedAt,
        freshnessState: record.freshnessState,
        provenance: record.provenance,
        lineageId: record.lineageId,
      }))
  }

  const edges = new Map<string, { winner: string; loser: string; references: PublicEvidenceReference[] }>()
  const conflicts: PublicEvidenceConflict[] = []
  const incomplete: PublicEvidenceIncompleteComparison[] = []
  for (const [index, left] of items.entries()) {
    for (const right of items.slice(index + 1)) {
      const shared = [...left.records.keys()].filter(key => right.records.has(key))
        .map(key => ({ key, record: left.records.get(key) as ParsedRecord }))
        .sort((a, b) => compareText(a.record.sourceFamily, b.record.sourceFamily) || compareText(a.record.cohortKey, b.record.cohortKey))
      if (shared.length === 0) {
        incomplete.push({ candidates: [left.candidateId, right.candidateId], sources: [], reason: INCOMPLETE_REASON })
        continue
      }
      const votes: Vote[] = []
      let sharedValidMeasurement = false
      for (const { key, record } of shared) {
        const comparison = compareRecords(record, right.records.get(key) as ParsedRecord)
        const reference = { source: record.sourceFamily, cohortKey: record.cohortKey }
        if (comparison.direction !== 0 || comparison.reason === null || comparison.reason === OVERLAP_REASON) sharedValidMeasurement = true
        if (comparison.direction === 0) {
          if (comparison.reason !== null) {
            const receipt = { ...reference, reason: comparison.reason }
            summaryOf(left.candidateId).abstainedSources.push(receipt)
            summaryOf(right.candidateId).abstainedSources.push(receipt)
          }
          continue
        }
        votes.push({
          ...reference,
          winner: comparison.direction > 0 ? left.candidateId : right.candidateId,
          loser: comparison.direction > 0 ? right.candidateId : left.candidateId,
        })
      }
      const directions = new Set(votes.map(vote => pairKey(vote.winner, vote.loser)))
      if (directions.size > 1) {
        const sources = uniqueReferences(votes)
        conflicts.push({ candidates: [left.candidateId, right.candidateId], sources, reason: 'comparable public sources disagree; preference abstained' })
        summaryOf(left.candidateId).conflictingSources.push(...sources)
        summaryOf(right.candidateId).conflictingSources.push(...sources)
        continue
      }
      const [first] = votes
      if (first !== undefined) {
        edges.set(pairKey(first.winner, first.loser), { winner: first.winner, loser: first.loser, references: uniqueReferences(votes) })
      }
      if (!sharedValidMeasurement) {
        incomplete.push({
          candidates: [left.candidateId, right.candidateId],
          sources: uniqueReferences(shared.map(({ record }) => ({ source: record.sourceFamily, cohortKey: record.cohortKey }))),
          reason: INCOMPLETE_REASON,
        })
      }
    }
  }

  const supportOf = (id: string): PublicEvidenceReference[] =>
    [...edges.values()].filter(edge => edge.winner === id).flatMap(edge => edge.references)

  if (incomplete.length > 0) {
    for (const [id, summary] of summaries) summary.supportingSources.push(...supportOf(id))
    for (const comparison of incomplete) {
      const references = comparison.sources.length > 0 ? comparison.sources : [{ source: 'unknown', cohortKey: '' }]
      for (const id of comparison.candidates) {
        summaryOf(id).abstainedSources.push(...references.map(reference => ({ ...reference, reason: comparison.reason })))
      }
    }
    const reason = 'incomplete-comparison: not every in-band candidate pair shares a valid comparable public measurement cohort; baseline deterministic ordering retained'
    for (const summary of summaries.values()) {
      summary.status = 'abstained'
      summary.reason = reason
      summary.preferenceRank = 0
      normalizeReceipt(summary)
    }
    return result(items, summaries, { status: 'abstained', reason, conflicts, incomplete })
  }

  if (hasCycle(ids, edges)) {
    const references = uniqueReferences([...edges.values()].flatMap(edge => edge.references))
    const reason = 'public evidence cycle; baseline deterministic ordering retained'
    for (const summary of summaries.values()) {
      summary.abstainedSources.push(...references.map(reference => ({
        ...reference,
        reason: 'public evidence preference cycle; all public preferences abstained',
      })))
      summary.reason = reason
      normalizeReceipt(summary)
    }
    return result(items, summaries, { status: 'abstained', reason, conflicts })
  }

  const ranks = preferenceRanks(ids, edges)
  for (const [id, summary] of summaries) {
    const wins = supportOf(id)
    const lost = [...edges.values()].some(edge => edge.loser === id)
    summary.supportingSources.push(...wins)
    if (wins.length > 0) {
      summary.status = 'used'
      summary.reason = 'same-cohort public evidence supports a secondary cold-start preference'
    } else if (lost) {
      summary.status = 'used'
      summary.reason = 'same-cohort public evidence supports another cold-start candidate'
    } else if (summary.conflictingSources.length > 0) {
      summary.reason = 'conflicting public evidence; baseline deterministic ordering retained'
    } else if (summary.abstainedSources.length > 0) {
      summary.reason = 'no comparable public evidence; baseline deterministic ordering retained'
    } else {
      summary.reason = 'no public evidence supplied'
    }
    summary.preferenceRank = ranks.get(id) as number
    normalizeReceipt(summary)
  }
  const used = edges.size > 0
  return result(items, summaries, {
    status: used ? 'used' : 'abstained',
    reason: used
      ? 'same-cohort public evidence applied as a secondary cold-start preference'
      : 'no unanimous comparable public evidence; baseline deterministic ordering retained',
    conflicts,
  })
}
