import { describe, expect, it } from 'vitest'

import { defaultWebPreferences } from '../src/preferences.js'
import { insightGeminiReadiness } from '../src/flow-readiness.js'

const completeSemantics = {
  submitSelector: '[data-fixture-submit]',
  promptReceiptSelector: '[data-fixture-prompt-receipt]',
  planReadyMarker: '[data-fixture-plan-ready]',
  researchStartSelector: '[data-fixture-research-start]',
  researchReportReadyMarker: '[data-fixture-report-ready]',
} as const

describe('Insight Gemini readiness', () => {
  it('keeps the requested 4 Argon Deep Research and high-polish defaults ready only for normal page preflight', () => {
    const preferences = defaultWebPreferences()
    const readiness = insightGeminiReadiness(preferences.insight, preferences.geminiSemantics)

    expect(preferences.insight.plan.requested).toMatchObject({ provider: 'gemini', modelLabel: '4 Argon', modeLabel: 'Deep Research' })
    expect(preferences.insight.research.requested).toMatchObject({ provider: 'gemini', modelLabel: '4 Argon', modeLabel: 'Deep Research' })
    expect(preferences.insight.polish.requested).toMatchObject({ provider: 'gemini', modelLabel: '4 Argon', effortLabel: 'high' })
    expect(readiness.configurationComplete).toBe(true)
    expect(readiness.targets).toEqual([
      {
        id: 'gemini-research',
        label: 'Gemini 深度研究',
        missing: [],
        configurationComplete: true,
      },
      {
        id: 'gemini-thinking',
        label: 'Gemini 文字润色',
        missing: [],
        configurationComplete: true,
      },
    ])
    expect(readiness.requirements.map(requirement => [requirement.id, requirement.configured, requirement.source])).toEqual([
      ['submitSelector', true, 'observed-adapter'],
      ['promptReceiptSelector', true, 'observed-adapter'],
      ['planReadyMarker', true, 'observed-adapter'],
      ['researchStartSelector', true, 'observed-adapter'],
      ['researchReportReadyMarker', true, 'observed-adapter'],
      ['thinking', true, 'observed-adapter'],
    ])
  })

  it('retains a user-supplied research-start selector as configuration rather than treating it as a live acceptance', () => {
    const preferences = defaultWebPreferences()
    const readiness = insightGeminiReadiness(preferences.insight, {
      ...completeSemantics,
      researchStartSelector: '[data-fixture-visible-start]',
    })

    expect(readiness.configurationComplete).toBe(true)
    expect(readiness.targets.every(target => target.configurationComplete)).toBe(true)
    expect(readiness.requirements.map(requirement => [requirement.id, requirement.configured, requirement.source])).toEqual([
      ['submitSelector', true, 'preferences'],
      ['promptReceiptSelector', true, 'preferences'],
      ['planReadyMarker', true, 'preferences'],
      ['researchStartSelector', true, 'preferences'],
      ['researchReportReadyMarker', true, 'preferences'],
      ['thinking', true, 'observed-adapter'],
    ])
  })
})
