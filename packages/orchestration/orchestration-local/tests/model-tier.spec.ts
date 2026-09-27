import { describe, expect, it } from 'vitest'
import type { PhysicalOperatorResidentModel } from '@deepseek-ai/dsh-physical-operator'
import { modelTier } from '../src/daemon.ts'

function model(id: string, displayName: string, description = ''): PhysicalOperatorResidentModel {
  return { model: id, displayName, description, supportedEfforts: [], isDefault: false, supportsAdaptiveThinking: false }
}

describe('modelTier', () => {
  it.each([
    [model('gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.'), 'high'],
    [model('gpt-7-nova', 'GPT-7-Nova', 'Frontier intelligence for the most demanding work.'), 'high'],
    [model('gpt-6-sol', 'GPT-6-Sol', 'Workhorse model for coding and everyday work.'), 'high'],
    [model('claude-opus-5', 'Claude Opus 5'), 'high'],
    [model('gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.'), 'low'],
    [model('gpt-7-mini', 'GPT-7-Mini', 'Fast and affordable model for easier tasks.'), 'low'],
    [model('haiku', 'Haiku', 'Fastest for quick answers'), 'low'],
    [model('gpt-5.6-terra', 'GPT-5.6-Terra', 'Older balanced model for straightforward work.'), 'medium'],
    [model('sonnet', 'Sonnet', 'Efficient for routine tasks'), 'medium'],
  ] as const)('rates %o as %s', (entry, tier) => {
    expect(modelTier(entry)).toBe(tier)
  })

  it('falls back to the name when a Resident catalog entry omits its description', () => {
    const { description: _description, ...withoutDescription } = model('gpt-6-astra', 'GPT-6-Astra')
    expect(modelTier(withoutDescription as PhysicalOperatorResidentModel)).toBe('high')
  })
})
