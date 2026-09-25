import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  evaluateBlindRlmQualitySuite,
  evaluateRlmQualitySuite,
  type RlmBlindQualityAssignmentV1,
  type RlmBlindQualitySuiteV1,
  type RlmQualitySuiteV1,
} from '../src/index.ts'

describe('RLM recorded-output quality evaluation', () => {
  it('runs keyless and reports quality lift, token cost, and critical regressions', async () => {
    const suite = JSON.parse(await readFile(
      new URL('./fixtures/quality-suite.v1.json', import.meta.url),
      'utf8',
    )) as RlmQualitySuiteV1
    const report = evaluateRlmQualitySuite(suite)
    expect(report).toMatchObject({
      passed: true,
      verdict: 'fixture-regression-passed',
      supportsQualityClaim: false,
      averageDirectScore: 0,
      averageRlmScore: 1,
      criticalRegressions: [],
    })
    expect(report.aggregateTokenRatio).toBeLessThanOrEqual(suite.maximumTokenRatio)
  })

  it('fails closed when an RLM output loses a critical fact', () => {
    const report = evaluateRlmQualitySuite({
      version: 1,
      evidence: fixtureEvidence(),
      minimumQualityLift: 0,
      maximumTokenRatio: 2,
      cases: [{
        id: 'critical', task: 'fixture',
        criteria: [{ id: 'fact', weight: 1, critical: true, requiredFacts: ['receipt'] }],
        direct: { text: 'receipt', turns: 1, estimatedTokens: 10 },
        rlm: { text: 'missing', turns: 1, estimatedTokens: 10 },
      }],
    })
    expect(report).toMatchObject({ passed: false, criticalRegressions: ['critical:fact'] })
  })

  it('keeps method identities outside the reusable blind fixture', async () => {
    const fixtureText = await readFile(
      new URL('./fixtures/quality-suite-blind.v1.json', import.meta.url),
      'utf8',
    )
    const suite = JSON.parse(fixtureText) as RlmBlindQualitySuiteV1
    const assignments = JSON.parse(await readFile(
      new URL('./fixtures/quality-suite-blind.assignments.v1.json', import.meta.url),
      'utf8',
    )) as RlmBlindQualityAssignmentV1[]
    expect(fixtureText).not.toMatch(/"(?:direct|rlm)"\s*:/iu)
    expect(evaluateBlindRlmQualitySuite(suite, assignments)).toMatchObject({
      passed: true,
      verdict: 'fixture-regression-passed',
      supportsQualityClaim: false,
      averageDirectScore: 0,
      averageRlmScore: 1,
      criticalRegressions: [],
    })
  })

  it('rejects a reveal key that aliases both methods to one arm', () => {
    expect(() => evaluateBlindRlmQualitySuite({
      version: 1,
      evidence: fixtureEvidence(),
      minimumQualityLift: 0,
      maximumTokenRatio: 2,
      cases: [{
        id: 'aliased', task: 'fixture',
        criteria: [{ id: 'fact', weight: 1, requiredFacts: ['receipt'] }],
        arms: [
          { armId: 'A', output: { text: 'receipt', turns: 1, estimatedTokens: 10 } },
          { armId: 'B', output: { text: 'missing', turns: 1, estimatedTokens: 10 } },
        ],
      }],
    }, [{ caseId: 'aliased', directArmId: 'A', rlmArmId: 'A' }])).toThrow('assignment is invalid')
  })

  it('reserves measured quality claims for a passing real-subscription recording', () => {
    const report = evaluateRlmQualitySuite({
      version: 1,
      evidence: { ...fixtureEvidence(), kind: 'real-subscription' },
      minimumQualityLift: 0.2,
      maximumTokenRatio: 2,
      cases: [{
        id: 'measured', task: 'fixture',
        criteria: [{ id: 'fact', weight: 1, requiredFacts: ['receipt'] }],
        direct: { text: 'missing', turns: 1, estimatedTokens: 10 },
        rlm: { text: 'receipt', turns: 2, estimatedTokens: 20 },
      }],
    })
    expect(report).toMatchObject({
      passed: true,
      verdict: 'measured-lift-passed',
      supportsQualityClaim: true,
    })
  })
})

function fixtureEvidence() {
  return {
    kind: 'synthetic-fixture' as const,
    recordingId: 'quality-eval-spec',
    recordedAt: '2026-08-24T00:00:00.000Z',
    sourceCommit: 'fixture-source',
    productVersion: 'fixture-version',
  }
}
