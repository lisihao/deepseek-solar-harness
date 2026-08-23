/** Deterministic A/B evaluator for recorded direct and RLM outputs. */

export interface RlmQualityCriterionV1 {
  readonly id: string
  readonly weight: number
  readonly critical?: boolean
  readonly requiredFacts: readonly string[]
  readonly forbiddenFacts?: readonly string[]
}

/** Recorded output and resource envelope for one evaluation arm. */
export interface RlmQualityOutputV1 {
  readonly text: string
  readonly turns: number
  readonly estimatedTokens: number
}

/** One method-anonymous direct-versus-RLM comparison case. */
export interface RlmQualityCaseV1 {
  readonly id: string
  readonly task: string
  readonly criteria: readonly RlmQualityCriterionV1[]
  readonly direct: RlmQualityOutputV1
  readonly rlm: RlmQualityOutputV1
}

/** Versioned offline quality suite and its release thresholds. */
export interface RlmQualitySuiteV1 {
  readonly version: 1
  readonly minimumQualityLift: number
  readonly maximumTokenRatio: number
  readonly cases: readonly RlmQualityCaseV1[]
}

/** Deterministic score and cost comparison for one case. */
export interface RlmQualityCaseResultV1 {
  readonly id: string
  readonly directScore: number
  readonly rlmScore: number
  readonly qualityLift: number
  readonly tokenRatio: number
  readonly criticalRegressions: readonly string[]
}

/** Aggregate quality, budget, and critical-regression verdict. */
export interface RlmQualityReportV1 {
  readonly version: 1
  readonly passed: boolean
  readonly averageDirectScore: number
  readonly averageRlmScore: number
  readonly averageQualityLift: number
  readonly aggregateTokenRatio: number
  readonly criticalRegressions: readonly string[]
  readonly cases: readonly RlmQualityCaseResultV1[]
}

/**
 * Evaluate already-recorded outputs without invoking a model. This keeps daily
 * regression checks keyless; a release candidate can replace one fixture pair
 * with the single approved subscription blind test and feed it through the
 * same scorer.
 * @param suite - recorded direct and RLM outputs plus deterministic criteria.
 * @returns the aggregate release verdict and per-case evidence.
 */
export function evaluateRlmQualitySuite(suite: RlmQualitySuiteV1): RlmQualityReportV1 {
  validateSuite(suite)
  const cases = suite.cases.map((entry): RlmQualityCaseResultV1 => {
    const direct = score(entry.direct.text, entry.criteria)
    const rlm = score(entry.rlm.text, entry.criteria)
    const criticalRegressions = entry.criteria
      .filter(criterion => criterion.critical === true
        && direct.passed.has(criterion.id)
        && !rlm.passed.has(criterion.id))
      .map(criterion => `${entry.id}:${criterion.id}`)
    return {
      id: entry.id,
      directScore: direct.score,
      rlmScore: rlm.score,
      qualityLift: rlm.score - direct.score,
      tokenRatio: entry.direct.estimatedTokens === 0
        ? entry.rlm.estimatedTokens === 0 ? 1 : Number.POSITIVE_INFINITY
        : entry.rlm.estimatedTokens / entry.direct.estimatedTokens,
      criticalRegressions,
    }
  })
  const averageDirectScore = average(cases.map(entry => entry.directScore))
  const averageRlmScore = average(cases.map(entry => entry.rlmScore))
  const directTokens = suite.cases.reduce((sum, entry) => sum + entry.direct.estimatedTokens, 0)
  const rlmTokens = suite.cases.reduce((sum, entry) => sum + entry.rlm.estimatedTokens, 0)
  const aggregateTokenRatio = directTokens === 0
    ? rlmTokens === 0 ? 1 : Number.POSITIVE_INFINITY
    : rlmTokens / directTokens
  const criticalRegressions = cases.flatMap(entry => entry.criticalRegressions)
  const averageQualityLift = averageRlmScore - averageDirectScore
  return {
    version: 1,
    passed: averageQualityLift >= suite.minimumQualityLift
      && aggregateTokenRatio <= suite.maximumTokenRatio
      && criticalRegressions.length === 0,
    averageDirectScore,
    averageRlmScore,
    averageQualityLift,
    aggregateTokenRatio,
    criticalRegressions,
    cases,
  }
}

function score(text: string, criteria: readonly RlmQualityCriterionV1[]): {
  readonly score: number
  readonly passed: ReadonlySet<string>
} {
  const normalized = text.toLocaleLowerCase('en-US')
  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
  const passed = new Set<string>()
  let earned = 0
  for (const criterion of criteria) {
    const includesRequired = criterion.requiredFacts.every(fact => normalized.includes(fact.toLocaleLowerCase('en-US')))
    const includesForbidden = (criterion.forbiddenFacts ?? [])
      .some(fact => normalized.includes(fact.toLocaleLowerCase('en-US')))
    if (!includesRequired || includesForbidden) continue
    passed.add(criterion.id)
    earned += criterion.weight
  }
  return { score: totalWeight === 0 ? 1 : earned / totalWeight, passed }
}

function validateSuite(suite: RlmQualitySuiteV1): void {
  if ((suite as { version: unknown }).version !== 1 || suite.cases.length === 0) {
    throw new Error('RLM quality suite must be a non-empty version-1 suite')
  }
  if (!Number.isFinite(suite.minimumQualityLift) || suite.minimumQualityLift < -1 || suite.minimumQualityLift > 1) {
    throw new Error('RLM minimumQualityLift must be from -1 through 1')
  }
  if (!Number.isFinite(suite.maximumTokenRatio) || suite.maximumTokenRatio < 1) {
    throw new Error('RLM maximumTokenRatio must be at least 1')
  }
  const caseIds = new Set<string>()
  for (const entry of suite.cases) {
    if (entry.id.trim() !== entry.id || entry.id.length === 0 || caseIds.has(entry.id)) {
      throw new Error(`RLM quality case id is invalid or duplicated: ${JSON.stringify(entry.id)}`)
    }
    caseIds.add(entry.id)
    if (entry.criteria.length === 0) throw new Error(`RLM quality case ${entry.id} has no criteria`)
    for (const criterion of entry.criteria) {
      if (criterion.weight <= 0 || !Number.isFinite(criterion.weight) || criterion.requiredFacts.length === 0) {
        throw new Error(`RLM quality criterion ${entry.id}:${criterion.id} is invalid`)
      }
    }
    for (const output of [entry.direct, entry.rlm]) {
      if (!Number.isSafeInteger(output.turns) || output.turns < 1
        || !Number.isSafeInteger(output.estimatedTokens) || output.estimatedTokens < 0) {
        throw new Error(`RLM quality output budget is invalid for ${entry.id}`)
      }
    }
  }
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
