import { describe, expect, it } from 'vitest'
import { orchestrationGuidance } from '../src/index.ts'

describe('orchestration model guidance', () => {
  it('exposes both Resident operators and preserves explicit user selection', () => {
    expect(orchestrationGuidance).toContain('Codex')
    expect(orchestrationGuidance).toContain('Claude Code')
    expect(orchestrationGuidance).toContain('intelligent per-node routing')
    expect(orchestrationGuidance).toContain('fail rather than silently switch products')
  })
})
