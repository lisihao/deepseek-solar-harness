import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { evaluateRlmQualitySuite, type RlmQualitySuiteV1 } from '../src/index.ts'

describe('RLM recorded-output quality evaluation', () => {
  it('runs keyless and reports quality lift, token cost, and critical regressions', async () => {
    const suite = JSON.parse(await readFile(
      new URL('./fixtures/quality-suite.v1.json', import.meta.url),
      'utf8',
    )) as RlmQualitySuiteV1
    const report = evaluateRlmQualitySuite(suite)
    expect(report).toMatchObject({
      passed: true,
      averageDirectScore: 0,
      averageRlmScore: 1,
      criticalRegressions: [],
    })
    expect(report.aggregateTokenRatio).toBeLessThanOrEqual(suite.maximumTokenRatio)
  })

  it('fails closed when an RLM output loses a critical fact', () => {
    const report = evaluateRlmQualitySuite({
      version: 1,
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
})
