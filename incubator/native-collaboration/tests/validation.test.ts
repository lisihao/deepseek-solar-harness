import { describe, expect, it } from 'vitest'
import { normalizeCollaborationInput, renderHandoff } from '../src/validation.js'

describe('native collaboration input boundary', () => {
  it('normalizes scope and renders a deterministic self-contained handoff', () => {
    const input = normalizeCollaborationInput({
      executor: 'codex',
      mode: 'single',
      task: '  inspect the parser  ',
      cwd: './prepared-worktree',
      scope: { read: ['src/index.ts', 'src/index.ts'], write: ['tests/parser.test.ts'] },
      expected_result: 'a written diagnosis',
      verification: 'run the focused parser test',
    })
    expect(input).toEqual({
      executor: 'codex',
      mode: 'single',
      task: 'inspect the parser',
      cwd: './prepared-worktree',
      scope: { read: ['src/index.ts'], write: ['tests/parser.test.ts'] },
      expectedResult: 'a written diagnosis',
      verification: 'run the focused parser test',
    })
    expect(renderHandoff(input)).toBe([
      'Solar native collaboration handoff',
      'executor: codex',
      'mode: single',
      'working directory: ./prepared-worktree',
      'read scope:',
      '- src/index.ts',
      'write scope:',
      '- tests/parser.test.ts',
      'task:',
      'inspect the parser',
      'expected result:',
      'a written diagnosis',
      'verification requested:',
      'run the focused parser test',
      'constraints:',
      '- This is a fresh, self-contained native task; do not treat it as a continuation of the parent conversation.',
      '- Keep the selected executor, account, main model, and reasoning settings unchanged.',
      '- Report refusal, cancellation, failure, and partial work honestly; do not claim verification that was not run.',
    ].join('\n'))
  })

  it('rejects unsupported overrides, absolute scope paths, and resident cwd omission', () => {
    expect(() => normalizeCollaborationInput({
      executor: 'codex',
      mode: 'single',
      task: 'task',
      expected_result: 'result',
      verification: 'check',
      model: 'unsupported',
    })).toThrow('does not support override')

    expect(() => normalizeCollaborationInput({
      executor: 'codex',
      mode: 'single',
      task: 'task',
      scope: { write: ['/outside'] },
      expected_result: 'result',
      verification: 'check',
    })).toThrow('must be a relative path')

    expect(() => normalizeCollaborationInput({
      executor: 'claude-code',
      mode: 'resident',
      task: 'task',
      expected_result: 'result',
      verification: 'check',
    })).toThrow('requires an explicit cwd')
  })

  it('accepts resident-only session/profile/tool bridge fields and rejects them for single mode', () => {
    const resident = normalizeCollaborationInput({
      executor: 'codex',
      mode: 'resident',
      task: 'run the resident task',
      cwd: '/tmp/worktree',
      expected_result: 'result',
      verification: 'check',
      session_key: 'stable-session',
      profile: { model: 'gpt-review', reasoning_effort: 'medium' },
      dsh_tools: ['bash', 'bash'],
    })
    expect(resident).toMatchObject({
      sessionKey: 'stable-session',
      profile: { model: 'gpt-review', reasoningEffort: 'medium' },
      dshTools: ['bash'],
    })
    expect(() => normalizeCollaborationInput({
      executor: 'codex',
      mode: 'single',
      task: 'task',
      expected_result: 'result',
      verification: 'check',
      profile: { model: 'unsupported' },
    })).toThrow('supported only in resident mode')
  })
})
