/** Deterministic blind evaluator for frozen Standard and Debate outputs. */

/** Evidence class for a frozen evaluation recording. */
export type DebateQualityEvidenceKindV1 = 'synthetic-fixture' | 'recorded-keyless' | 'real-subscription'

/** Provenance retained with every evaluation verdict. */
export interface DebateQualityEvidenceV1 {
  readonly evidenceKind: DebateQualityEvidenceKindV1
  readonly recordingId: string
  readonly recordedAt: string
  readonly sourceCommit: string
  readonly productVersion: string
}

/** Deterministic fact criterion applied identically to both anonymous arms. */
export interface DebateQualityCriterionV1 {
  readonly id: string
  readonly weight: number
  readonly critical?: boolean
  readonly requiredFacts: readonly string[]
  readonly forbiddenFacts?: readonly string[]
}

/** Recorded resource usage. Cost must come from execution Evidence, never an estimate. */
export interface DebateQualityUsageV1 {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd?: number
}

/** Frozen output and execution envelope for one method-anonymous arm. */
export interface DebateBlindOutputV1 {
  readonly text: string
  readonly rounds: number
  readonly earlyStopped: boolean
  readonly usage?: DebateQualityUsageV1
}

/** One anonymous arm; its method identity lives only in the reveal key. */
export interface DebateBlindArmV1 {
  readonly armId: string
  readonly output: DebateBlindOutputV1
}

/** One blind Standard-versus-Debate case. */
export interface DebateBlindQualityCaseV1 {
  readonly id: string
  readonly task: string
  readonly criteria: readonly DebateQualityCriterionV1[]
  readonly arms: readonly DebateBlindArmV1[]
}

/** Reusable offline suite. It never invokes a model. */
export interface DebateBlindQualitySuiteV1 {
  readonly version: 1
  readonly evidence: DebateQualityEvidenceV1
  readonly minimumQualityDelta: number
  readonly maximumTokenRatio: number
  readonly maximumCostRatio?: number
  readonly cases: readonly DebateBlindQualityCaseV1[]
}

/** Separated method assignment applied only after both arms are frozen. */
export interface DebateBlindQualityAssignmentV1 {
  readonly caseId: string
  readonly standardArmId: string
  readonly debateArmId: string
}

/** Completeness of recorded token or account-cost Evidence. */
export type DebateQualityAccountingStatus = 'known' | 'partial' | 'unknown'

/** Quality, usage, and stopping comparison for one revealed case. */
export interface DebateQualityCaseResultV1 {
  readonly id: string
  readonly standardScore: number
  readonly debateScore: number
  readonly qualityDelta: number
  readonly usageStatus: DebateQualityAccountingStatus
  readonly costStatus: DebateQualityAccountingStatus
  readonly standardTokens?: number
  readonly debateTokens?: number
  readonly tokenDelta?: number
  readonly tokenRatio?: number
  readonly standardCostUsd?: number
  readonly debateCostUsd?: number
  readonly costDeltaUsd?: number
  readonly costRatio?: number
  readonly standardRounds: number
  readonly debateRounds: number
  readonly debateEarlyStopped: boolean
  readonly criticalRegressions: readonly string[]
}

/** Aggregate blind-evaluation report. */
export interface DebateQualityReportV1 {
  readonly version: 1
  readonly evidence: DebateQualityEvidenceV1
  readonly passed: boolean
  readonly verdict: 'fixture-regression-passed' | 'measured-lift-passed' | 'failed'
  readonly supportsQualityClaim: boolean
  readonly averageStandardScore: number
  readonly averageDebateScore: number
  readonly qualityDelta: number
  readonly usageStatus: DebateQualityAccountingStatus
  readonly costStatus: DebateQualityAccountingStatus
  readonly standardTokens?: number
  readonly debateTokens?: number
  readonly tokenDelta?: number
  readonly tokenRatio?: number
  readonly standardCostUsd?: number
  readonly debateCostUsd?: number
  readonly costDeltaUsd?: number
  readonly costRatio?: number
  readonly averageStandardRounds: number
  readonly averageDebateRounds: number
  readonly debateEarlyStopCases: number
  readonly debateEarlyStopRate: number
  readonly criticalRegressions: readonly string[]
  readonly cases: readonly DebateQualityCaseResultV1[]
}

interface Score {
  readonly value: number
  readonly passed: ReadonlySet<string>
}

function score(text: string, criteria: readonly DebateQualityCriterionV1[]): Score {
  const normalized = text.toLocaleLowerCase('en-US')
  const total = criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  const passed = new Set<string>()
  let earned = 0
  for (const criterion of criteria) {
    const required = criterion.requiredFacts.every(fact => normalized.includes(fact.toLocaleLowerCase('en-US')))
    const forbidden = (criterion.forbiddenFacts ?? [])
      .some(fact => normalized.includes(fact.toLocaleLowerCase('en-US')))
    if (!required || forbidden) continue
    passed.add(criterion.id)
    earned += criterion.weight
  }
  return { value: earned / total, passed }
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function ratio(numerator: number, denominator: number): number | undefined {
  if (denominator === 0) return numerator === 0 ? 1 : undefined
  return numerator / denominator
}

function status(known: number, total: number): DebateQualityAccountingStatus {
  return known === total ? 'known' : known === 0 ? 'unknown' : 'partial'
}

function tokenCount(output: DebateBlindOutputV1): number | undefined {
  return output.usage === undefined ? undefined : output.usage.inputTokens + output.usage.outputTokens
}

function caseResult(
  entry: DebateBlindQualityCaseV1,
  assignment: DebateBlindQualityAssignmentV1,
): DebateQualityCaseResultV1 {
  const byArm = new Map(entry.arms.map(arm => [arm.armId, arm.output]))
  const standard = byArm.get(assignment.standardArmId)
  const debate = byArm.get(assignment.debateArmId)
  if (standard === undefined || debate === undefined) throw new Error(`Debate blind assignment references an unknown arm for ${entry.id}`)
  const standardScore = score(standard.text, entry.criteria)
  const debateScore = score(debate.text, entry.criteria)
  const standardTokens = tokenCount(standard)
  const debateTokens = tokenCount(debate)
  const standardCost = standard.usage?.costUsd
  const debateCost = debate.usage?.costUsd
  const tokenRatio = standardTokens === undefined || debateTokens === undefined
    ? undefined
    : ratio(debateTokens, standardTokens)
  const costRatio = standardCost === undefined || debateCost === undefined
    ? undefined
    : ratio(debateCost, standardCost)
  const usageKnown = Number(standardTokens !== undefined) + Number(debateTokens !== undefined)
  const costKnown = Number(standardCost !== undefined) + Number(debateCost !== undefined)
  const criticalRegressions = entry.criteria
    .filter(criterion => criterion.critical === true
      && standardScore.passed.has(criterion.id)
      && !debateScore.passed.has(criterion.id))
    .map(criterion => `${entry.id}:${criterion.id}`)
  return {
    id: entry.id,
    standardScore: standardScore.value,
    debateScore: debateScore.value,
    qualityDelta: debateScore.value - standardScore.value,
    usageStatus: status(usageKnown, 2),
    costStatus: status(costKnown, 2),
    ...(standardTokens === undefined ? {} : { standardTokens }),
    ...(debateTokens === undefined ? {} : { debateTokens }),
    ...(standardTokens === undefined || debateTokens === undefined ? {} : {
      tokenDelta: debateTokens - standardTokens,
      ...(tokenRatio === undefined ? {} : { tokenRatio }),
    }),
    ...(standardCost === undefined ? {} : { standardCostUsd: standardCost }),
    ...(debateCost === undefined ? {} : { debateCostUsd: debateCost }),
    ...(standardCost === undefined || debateCost === undefined ? {} : {
      costDeltaUsd: debateCost - standardCost,
      ...(costRatio === undefined ? {} : { costRatio }),
    }),
    standardRounds: standard.rounds,
    debateRounds: debate.rounds,
    debateEarlyStopped: debate.earlyStopped,
    criticalRegressions,
  }
}

function totalKnown(
  cases: readonly DebateQualityCaseResultV1[],
  select: (entry: DebateQualityCaseResultV1) => number | undefined,
): number {
  let total = 0
  for (const entry of cases) {
    const value = select(entry)
    if (value === undefined) throw new Error('Debate quality accounting status disagrees with its values')
    total += value
  }
  return total
}

/**
 * Compare already-recorded anonymous outputs without invoking any model.
 * Only a passing `real-subscription` recording can support a measured quality
 * claim; synthetic and keyless recordings remain regression evidence.
 * @param suite - frozen anonymous Standard-versus-Debate fixtures and thresholds.
 * @param assignments - separately stored reveal key for the anonymous arms.
 * @returns deterministic quality and resource comparison report.
 */
export function evaluateBlindDebateQualitySuite(
  suite: DebateBlindQualitySuiteV1,
  assignments: readonly DebateBlindQualityAssignmentV1[],
): DebateQualityReportV1 {
  validate(suite, assignments)
  const byCase = new Map(assignments.map(assignment => [assignment.caseId, assignment]))
  const cases = suite.cases.map((entry) => {
    const assignment = byCase.get(entry.id)
    if (assignment === undefined) throw new Error(`Debate blind assignment is missing for ${entry.id}`)
    return caseResult(entry, assignment)
  })
  const averageStandardScore = average(cases.map(entry => entry.standardScore))
  const averageDebateScore = average(cases.map(entry => entry.debateScore))
  const usageKnown = cases.reduce((sum, entry) => sum + (entry.usageStatus === 'known' ? 2 : entry.usageStatus === 'partial' ? 1 : 0), 0)
  const costKnown = cases.reduce((sum, entry) => sum + (entry.costStatus === 'known' ? 2 : entry.costStatus === 'partial' ? 1 : 0), 0)
  const usageStatus = status(usageKnown, cases.length * 2)
  const costStatus = status(costKnown, cases.length * 2)
  const standardTokens = usageStatus === 'known' ? totalKnown(cases, entry => entry.standardTokens) : undefined
  const debateTokens = usageStatus === 'known' ? totalKnown(cases, entry => entry.debateTokens) : undefined
  const standardCostUsd = costStatus === 'known' ? totalKnown(cases, entry => entry.standardCostUsd) : undefined
  const debateCostUsd = costStatus === 'known' ? totalKnown(cases, entry => entry.debateCostUsd) : undefined
  const tokenRatio = standardTokens === undefined || debateTokens === undefined ? undefined : ratio(debateTokens, standardTokens)
  const costRatio = standardCostUsd === undefined || debateCostUsd === undefined ? undefined : ratio(debateCostUsd, standardCostUsd)
  const criticalRegressions = cases.flatMap(entry => entry.criticalRegressions)
  const qualityDelta = averageDebateScore - averageStandardScore
  const passed = qualityDelta >= suite.minimumQualityDelta
    && tokenRatio !== undefined
    && tokenRatio <= suite.maximumTokenRatio
    && (suite.maximumCostRatio === undefined || (costRatio !== undefined && costRatio <= suite.maximumCostRatio))
    && criticalRegressions.length === 0
  const supportsQualityClaim = passed && suite.evidence.evidenceKind === 'real-subscription'
  const debateEarlyStopCases = cases.filter(entry => entry.debateEarlyStopped).length
  return {
    version: 1,
    evidence: suite.evidence,
    passed,
    verdict: passed
      ? supportsQualityClaim ? 'measured-lift-passed' : 'fixture-regression-passed'
      : 'failed',
    supportsQualityClaim,
    averageStandardScore,
    averageDebateScore,
    qualityDelta,
    usageStatus,
    costStatus,
    ...(standardTokens === undefined ? {} : { standardTokens }),
    ...(debateTokens === undefined ? {} : { debateTokens }),
    ...(standardTokens === undefined || debateTokens === undefined ? {} : { tokenDelta: debateTokens - standardTokens }),
    ...(tokenRatio === undefined ? {} : { tokenRatio }),
    ...(standardCostUsd === undefined ? {} : { standardCostUsd }),
    ...(debateCostUsd === undefined ? {} : { debateCostUsd }),
    ...(standardCostUsd === undefined || debateCostUsd === undefined ? {} : { costDeltaUsd: debateCostUsd - standardCostUsd }),
    ...(costRatio === undefined ? {} : { costRatio }),
    averageStandardRounds: average(cases.map(entry => entry.standardRounds)),
    averageDebateRounds: average(cases.map(entry => entry.debateRounds)),
    debateEarlyStopCases,
    debateEarlyStopRate: debateEarlyStopCases / cases.length,
    criticalRegressions,
    cases,
  }
}

function validate(
  suite: DebateBlindQualitySuiteV1,
  assignments: readonly DebateBlindQualityAssignmentV1[],
): void {
  if (suite.cases.length === 0) throw new Error('Debate quality suite must be non-empty')
  if (!['synthetic-fixture', 'recorded-keyless', 'real-subscription'].includes(suite.evidence.evidenceKind)
    || [suite.evidence.recordingId, suite.evidence.recordedAt, suite.evidence.sourceCommit, suite.evidence.productVersion]
      .some(value => value.trim().length === 0)) {
    throw new Error('Debate quality evidence provenance is invalid')
  }
  if (!Number.isFinite(suite.minimumQualityDelta) || suite.minimumQualityDelta < -1 || suite.minimumQualityDelta > 1) {
    throw new Error('Debate minimumQualityDelta must be from -1 through 1')
  }
  if (!Number.isFinite(suite.maximumTokenRatio) || suite.maximumTokenRatio < 1
    || (suite.maximumCostRatio !== undefined && (!Number.isFinite(suite.maximumCostRatio) || suite.maximumCostRatio < 1))) {
    throw new Error('Debate resource ratios must be at least 1')
  }
  const assignmentByCase = new Map<string, DebateBlindQualityAssignmentV1>()
  for (const assignment of assignments) {
    if (assignmentByCase.has(assignment.caseId)) throw new Error(`Debate blind assignment is duplicated for ${assignment.caseId}`)
    assignmentByCase.set(assignment.caseId, assignment)
  }
  const caseIds = new Set<string>()
  for (const entry of suite.cases) {
    if (entry.id.trim().length === 0 || caseIds.has(entry.id)) throw new Error(`Debate quality case id is invalid or duplicated: ${entry.id}`)
    caseIds.add(entry.id)
    const armIds = new Set(entry.arms.map(arm => arm.armId))
    const assignment = assignmentByCase.get(entry.id)
    if (entry.arms.length !== 2 || armIds.size !== 2 || assignment === undefined
      || assignment.standardArmId === assignment.debateArmId
      || !armIds.has(assignment.standardArmId) || !armIds.has(assignment.debateArmId)) {
      throw new Error(`Debate blind assignment is invalid for ${entry.id}`)
    }
    if (entry.criteria.length === 0) throw new Error(`Debate quality case ${entry.id} has no criteria`)
    for (const criterion of entry.criteria) {
      if (criterion.id.trim().length === 0 || !Number.isFinite(criterion.weight) || criterion.weight <= 0
        || criterion.requiredFacts.length === 0) throw new Error(`Debate quality criterion ${entry.id}:${criterion.id} is invalid`)
    }
    for (const arm of entry.arms) {
      if (arm.armId.trim().length === 0 || arm.output.text.trim().length === 0
        || typeof arm.output.earlyStopped !== 'boolean'
        || !Number.isSafeInteger(arm.output.rounds) || arm.output.rounds < 1) {
        throw new Error(`Debate quality output is invalid for ${entry.id}:${arm.armId}`)
      }
      const usage = arm.output.usage
      if (usage !== undefined && (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
        || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0
        || (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)))) {
        throw new Error(`Debate quality usage is invalid for ${entry.id}:${arm.armId}`)
      }
    }
  }
  if (assignmentByCase.size !== suite.cases.length) throw new Error('Debate blind assignment contains unknown cases')
}
