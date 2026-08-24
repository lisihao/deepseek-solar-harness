import { describe, expect, it } from 'vitest'
import { foldOrchestrationPreferences, orchestrationGuidance } from '../src/index.ts'

describe('orchestration model guidance', () => {
  it('exposes every Resident operator and preserves explicit user selection', () => {
    expect(orchestrationGuidance).toContain('Codex')
    expect(orchestrationGuidance).toContain('Claude Code')
    expect(orchestrationGuidance).toContain('RLM')
    expect(orchestrationGuidance).toContain('Continuous Harness')
    expect(orchestrationGuidance).not.toContain('Prime Agent')
    expect(orchestrationGuidance).toContain('intelligent routing')
    expect(orchestrationGuidance).toContain('fail rather than silently switch products')
    expect(orchestrationGuidance).toContain('clean-task Context Capsule')
    expect(orchestrationGuidance).toContain('without a phase barrier')
  })

  it('defaults to Auto and preserves explicit RLM or Standard choices for comparison', () => {
    expect(foldOrchestrationPreferences([])).toEqual({
      rlm: 'auto', continualHarness: 'auto', optimization: 'balanced',
    })
    expect(foldOrchestrationPreferences([{
      type: 'orchestration/preferences',
      data: { rlm: 'enabled', continualHarness: 'session', optimization: 'quality' },
    }])).toEqual({ rlm: 'enabled', continualHarness: 'session', optimization: 'quality' })
    expect(foldOrchestrationPreferences([{
      type: 'orchestration/preferences',
      data: { rlm: 'disabled', continualHarness: 'off', optimization: 'balanced' },
    }])).toEqual({ rlm: 'disabled', continualHarness: 'off', optimization: 'balanced' })
  })
})
