import { describe, expect, it } from 'vitest'
import type { ResidentModelOption } from '@deepseek-ai/dsh-resident-operator'
import { resolveResidentExecutionProfile } from '../src/profile.ts'

const codexModels: ResidentModelOption[] = [
  {
    model: 'gpt-5.6-sol', displayName: 'Sol', description: 'Latest frontier model',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low',
    isDefault: true, supportsAdaptiveThinking: false,
  },
  {
    model: 'gpt-5.6-terra', displayName: 'Terra', description: 'Balanced everyday model',
    supportedEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium',
    isDefault: false, supportsAdaptiveThinking: false,
  },
  {
    model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Fast and affordable model',
    supportedEfforts: ['low', 'medium'], defaultEffort: 'medium',
    isDefault: false, supportsAdaptiveThinking: false,
  },
]

const claudeModels: ResidentModelOption[] = [
  {
    model: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default',
    description: 'Opus recommended for complex tasks', supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high', isDefault: true, supportsAdaptiveThinking: true,
  },
  {
    model: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet',
    description: 'Efficient for routine tasks', supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'high', isDefault: false, supportsAdaptiveThinking: true,
  },
  {
    model: 'haiku', displayName: 'Haiku', description: 'Fastest for quick answers',
    supportedEfforts: [], isDefault: false, supportsAdaptiveThinking: false,
  },
  {
    model: 'claude-fable-5', displayName: 'Fable', description: 'Most capable for the hardest tasks',
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high',
    isDefault: false, supportsAdaptiveThinking: true,
  },
]

describe('Resident execution profile resolution', () => {
  it('uses live catalogs to select fast, balanced, and frontier Codex profiles', () => {
    expect(resolveResidentExecutionProfile('codex', codexModels, [{ type: 'text', text: '快速做个小改' }]))
      .toMatchObject({ profile: { model: 'gpt-5.6-luna', effort: 'low' }, source: 'smart-auto' })
    expect(resolveResidentExecutionProfile('codex', codexModels, [{ type: 'text', text: '实现常规表单验证和测试' }]))
      .toMatchObject({ profile: { model: 'gpt-5.6-terra', effort: 'medium' }, source: 'smart-auto' })
    expect(resolveResidentExecutionProfile('codex', codexModels, [{ type: 'text', text: '深度重构复杂架构并系统性验证' }]))
      .toMatchObject({ profile: { model: 'gpt-5.6-sol', effort: 'xhigh' }, source: 'smart-auto' })
  })

  it('selects Claude models by task class and honors partial manual preferences', () => {
    expect(resolveResidentExecutionProfile('claude-code', claudeModels, [{ type: 'text', text: '一句话快速检查' }]))
      .toMatchObject({ profile: { model: 'haiku' }, source: 'smart-auto' })
    expect(resolveResidentExecutionProfile(
      'claude-code', claudeModels, [{ type: 'text', text: '全面红队这个超长任务' }], { model: 'sonnet' },
    )).toMatchObject({ profile: { model: 'sonnet', effort: 'high' }, source: 'mixed' })
    expect(resolveResidentExecutionProfile(
      'claude-code', claudeModels, [{ type: 'text', text: '分析' }], { model: 'claude-opus-5', effort: 'max' },
    )).toMatchObject({ profile: { model: 'default', effort: 'max' }, source: 'manual' })
  })

  it('fails loud for a model or effort absent from the native catalog', () => {
    expect(() => resolveResidentExecutionProfile(
      'claude-code', claudeModels, [{ type: 'text', text: 'task' }], { model: 'unknown' },
    )).toThrow(expect.objectContaining({ code: 'EXECUTION_PROFILE_UNSUPPORTED' }))
    expect(() => resolveResidentExecutionProfile(
      'claude-code', claudeModels, [{ type: 'text', text: 'task' }], { model: 'haiku', effort: 'high' },
    )).toThrow(expect.objectContaining({ code: 'EXECUTION_PROFILE_UNSUPPORTED' }))
  })
})
