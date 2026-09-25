import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  evaluateBlindDebateQualitySuite,
  type DebateBlindQualityAssignmentV1,
  type DebateBlindQualitySuiteV1,
} from '../src/index.ts'

async function fixture() {
  const suiteText = await readFile(new URL('./fixtures/quality-suite-blind.v1.json', import.meta.url), 'utf8')
  const assignmentsText = await readFile(new URL('./fixtures/quality-suite-blind.assignments.v1.json', import.meta.url), 'utf8')
  return {
    suiteText,
    suite: JSON.parse(suiteText) as DebateBlindQualitySuiteV1,
    assignments: JSON.parse(assignmentsText) as DebateBlindQualityAssignmentV1[],
  }
}

describe('Debate recorded-output quality evaluation', () => {
  it('compares anonymous Standard and Debate fixtures without making a measured quality claim', async () => {
    const { suiteText, suite, assignments } = await fixture()
    expect(suiteText).not.toMatch(/"(?:standard|debate)(?:ArmId)?"\s*:/iu)
    const report = evaluateBlindDebateQualitySuite(suite, assignments)
    expect(report).toMatchObject({
      passed: true,
      verdict: 'fixture-regression-passed',
      supportsQualityClaim: false,
      qualityDelta: 0.5,
      usageStatus: 'known',
      costStatus: 'known',
      standardTokens: 300,
      debateTokens: 440,
      tokenDelta: 140,
      standardCostUsd: 0.02,
      debateCostUsd: 0.04,
      costDeltaUsd: 0.02,
      averageStandardRounds: 1,
      averageDebateRounds: 1.5,
      debateEarlyStopCases: 1,
      debateEarlyStopRate: 0.5,
    })
    expect(report.tokenRatio).toBeCloseTo(440 / 300)
    expect(report.costRatio).toBe(2)
  })

  it('keeps missing execution cost unknown instead of reporting zero', async () => {
    const { suite, assignments } = await fixture()
    const first = suite.cases[0]
    const firstAssignment = assignments[0]
    if (first === undefined) throw new Error('fixture case is missing')
    if (firstAssignment === undefined) throw new Error('fixture assignment is missing')
    const { maximumCostRatio: _maximumCostRatio, ...suiteWithoutCostGate } = suite
    const report = evaluateBlindDebateQualitySuite({
      ...suiteWithoutCostGate,
      cases: [{
        ...first,
        arms: first.arms.map((arm) => {
          const { usage, ...output } = arm.output
          return {
            ...arm,
            output: {
              ...output,
              ...(usage === undefined ? {} : { usage: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
              } }),
            },
          }
        }),
      }],
    }, [firstAssignment])
    expect(report).toMatchObject({ costStatus: 'unknown' })
    expect(report.standardCostUsd).toBeUndefined()
    expect(report.debateCostUsd).toBeUndefined()
    expect(report.costDeltaUsd).toBeUndefined()
  })

  it('reserves measured-lift evidence for an explicit real-subscription recording', async () => {
    const { suite, assignments } = await fixture()
    const report = evaluateBlindDebateQualitySuite({
      ...suite,
      evidence: { ...suite.evidence, evidenceKind: 'real-subscription', recordingId: 'approved-blind-run' },
    }, assignments)
    expect(report).toMatchObject({
      passed: true,
      verdict: 'measured-lift-passed',
      supportsQualityClaim: true,
      evidence: { evidenceKind: 'real-subscription' },
    })
  })

  it('rejects a reveal key that aliases both methods to one arm', async () => {
    const { suite, assignments } = await fixture()
    const first = assignments[0]
    if (first === undefined) throw new Error('fixture assignment is missing')
    expect(() => evaluateBlindDebateQualitySuite(suite, [
      { ...first, debateArmId: first.standardArmId },
      ...assignments.slice(1),
    ])).toThrow('assignment is invalid')
  })
})
