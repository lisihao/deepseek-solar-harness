import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  canonicalCohortKey,
  rankComparablePublicEvidence,
  type PublicEvidenceCandidate,
  type PublicEvidenceRanking,
} from '../src/public-evidence.ts'

interface Scenario {
  readonly name: string
  readonly taskType: string
  readonly candidates: readonly PublicEvidenceCandidate[]
  readonly expected?: PublicEvidenceRanking
  readonly throws?: string
}

interface Golden {
  readonly reference: { readonly module: string; readonly sha256: string }
  readonly scenarios: readonly Scenario[]
}

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const golden = JSON.parse(read('./fixtures/public-evidence/golden.json')) as Golden
const manifest = JSON.parse(read('../../../../distribution/workbench-scheduling-sources.json')) as {
  files: { relativePath: string; sha256: Record<string, string | null> }[]
}

const COHORT = {
  benchmark: 'swe-bench',
  benchmark_version: 'v1',
  billing_identity: 'subscription',
  execution_surface: 'codex-cli',
  harness: 'harness-a',
  metric_kind: 'pass_rate',
  reasoning_effort: 'high',
  score_kind: 'resolved',
  task_type: 'coding',
  unit: 'ratio',
}

/** A valid comparable record for one candidate; overrides replace any field. */
function record(model: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    ...COHORT,
    source: 'dradar-codex',
    provider: 'codex',
    canonical_model_id: model,
    value: 0.8,
    sample_count: 1000,
    lineage_id: `lineage-${model}`,
    correlation_group: 'grp',
    comparability: { status: 'comparable' },
    ...overrides,
  }
  return { ...row, cohort_key: canonicalCohortKey(row) }
}

function candidate(candidateId: string, model: string, publicEvidence?: unknown): PublicEvidenceCandidate {
  return {
    candidateId,
    provider: 'codex',
    model,
    reasoningEffort: 'high',
    executionSurface: 'codex-cli',
    billingIdentity: 'subscription',
    ...publicEvidence === undefined ? {} : { publicEvidence },
  }
}

const rank = (candidates: readonly PublicEvidenceCandidate[]): PublicEvidenceRanking =>
  rankComparablePublicEvidence(candidates, { taskType: 'coding' })

describe('Python reference', () => {
  it('records the sha256 of the reference module listed in the source manifest', () => {
    const entry = manifest.files.find(file => file.relativePath === 'src/codex_workbench/public_evidence_ranking.py')
    expect(entry?.sha256.C).toBe(golden.reference.sha256)
  })

  it.each(golden.scenarios.map(scenario => [scenario.name, scenario] as const))('matches the reference: %s', (_name, scenario) => {
    const run = (): PublicEvidenceRanking => rankComparablePublicEvidence(scenario.candidates, { taskType: scenario.taskType })
    if (scenario.throws === undefined) {
      expect(run()).toEqual(scenario.expected)
    } else {
      expect(run).toThrow(TypeError)
    }
  })

  it('covers every ranking outcome', () => {
    const outcomes = golden.scenarios.flatMap(scenario => scenario.expected === undefined ? ['throws'] : [
      scenario.expected.status,
      ...scenario.expected.conflicts.length > 0 ? ['conflict'] : [],
      ...scenario.expected.incompleteComparisons.length > 0 ? ['incomplete'] : [],
      ...scenario.expected.reason.includes('cycle') ? ['cycle'] : [],
    ])
    for (const outcome of ['used', 'abstained', 'conflict', 'incomplete', 'cycle', 'throws']) expect(outcomes).toContain(outcome)
  })
})

describe('where the port deliberately differs from the Python reference', () => {
  const winner = (value: unknown): PublicEvidenceRanking =>
    rank([candidate('a', 'astra', [record('astra', { value })]), candidate('b', 'sol', [record('sol', { value: 0.5 })])])

  it('rejects a numeric string value that Python float() would accept', () => {
    expect(winner('0.9').candidateSummaries[0]?.abstainedSources).toContainEqual(
      expect.objectContaining({ reason: 'public evidence value is not finite' }),
    )
    expect(winner(0.9).status).toBe('used')
  })

  it('rejects NaN and Infinity values', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(winner(value).status).toBe('abstained')
    }
  })

  it('rejects boolean and non-integer sample counts', () => {
    const counts = (sampleCount: unknown): PublicEvidenceRanking =>
      rank([candidate('a', 'astra', [record('astra', { value: 0.9, sample_count: sampleCount })]), candidate('b', 'sol', [record('sol', { value: 0.5 })])])
    expect(counts(true).candidateSummaries[0]?.measurements[0]?.sampleCount).toBeNull()
    expect(counts(1.5).candidateSummaries[0]?.measurements[0]?.sampleCount).toBeNull()
    expect(counts(0).candidateSummaries[0]?.measurements[0]?.sampleCount).toBeNull()
    expect(counts(1000).candidateSummaries[0]?.measurements[0]?.sampleCount).toBe(1000)
  })

  it('rejects duplicate candidate ids, which the reference silently merges', () => {
    expect(() => rank([candidate('a', 'astra'), candidate('a', 'sol')])).toThrow(/distinct candidateId/)
  })
})

describe('canonicalCohortKey', () => {
  it('lists the ten conditions in sorted key order without spaces', () => {
    expect(canonicalCohortKey(COHORT)).toBe(JSON.stringify(COHORT))
    expect(canonicalCohortKey({ ...COHORT, harness: '  harness-a ' })).toBe(JSON.stringify(COHORT))
  })

  it('is null unless every condition is an explicit non-blank string', () => {
    expect(canonicalCohortKey({ ...COHORT, unit: ' ' })).toBeNull()
    expect(canonicalCohortKey({ ...COHORT, unit: 3 })).toBeNull()
    const { harness: _harness, ...missing } = COHORT
    expect(canonicalCohortKey(missing)).toBeNull()
  })
})

describe('input handling', () => {
  it('treats absent and null evidence as none and a non-array as an abstention', () => {
    expect(rank([candidate('a', 'astra')]).candidateSummaries[0]?.reason).toBe('no public evidence supplied')
    expect(rank([{ ...candidate('a', 'astra'), publicEvidence: null }]).candidateSummaries[0]?.reason).toBe('no public evidence supplied')
    const bad = rank([{ ...candidate('a', 'astra'), publicEvidence: 'x' }])
    expect(bad.candidateSummaries[0]?.abstainedSources).toEqual([
      { source: 'unknown', cohortKey: '', reason: 'public_evidence is not a sequence' },
    ])
  })

  it('treats a blank task type as matching no record', () => {
    const ranking = rankComparablePublicEvidence(
      [candidate('a', 'astra', [record('astra')]), candidate('b', 'sol', [record('sol')])],
      { taskType: '   ' },
    )
    expect(ranking.status).toBe('abstained')
  })

  it('does not mutate its inputs', () => {
    const candidates = [candidate('b', 'sol', [record('sol', { value: 0.5 })]), candidate('a', 'astra', [record('astra', { value: 0.9 })])]
    const before = JSON.stringify(candidates)
    rank(candidates)
    expect(JSON.stringify(candidates)).toBe(before)
  })

  it('gives the same receipt for the same input regardless of candidate order', () => {
    const a = candidate('a', 'astra', [record('astra', { value: 0.9 })])
    const b = candidate('b', 'sol', [record('sol', { value: 0.5 })])
    expect(rank([a, b])).toEqual(rank([b, a]))
  })
})
