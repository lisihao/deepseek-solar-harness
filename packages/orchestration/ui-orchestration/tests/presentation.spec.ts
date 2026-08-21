import { describe, expect, it } from 'vitest'
import { isDiagnosticOrchestrationWorkspace, projectOrchestrationRuns } from '../src/index.ts'

describe('orchestration dashboard presentation', () => {
  it('identifies local acceptance workspaces without hiding user projects', () => {
    expect(isDiagnosticOrchestrationWorkspace('/private/tmp/dsh-orchestration-2.5.2-explicit-no-fallback')).toBe(true)
    expect(isDiagnosticOrchestrationWorkspace('/tmp/dsh-orchestration-acceptance')).toBe(true)
    expect(isDiagnosticOrchestrationWorkspace('/Users/me/Projects/DeepSeek-Solar-Harness')).toBe(false)
  })

  it('keeps acceptance evidence visible and labelled unless the caller hides it', () => {
    const source = [
      { runId: 'acceptance', workspace: '/private/tmp/dsh-orchestration-acceptance' },
      { runId: 'user', workspace: '/Users/me/Projects/app' },
    ]

    expect(projectOrchestrationRuns(source, true)).toEqual({
      runs: [
        { ...source[0], diagnostic: true },
        { ...source[1], diagnostic: false },
      ],
      diagnosticRunCount: 1,
    })
    expect(projectOrchestrationRuns(source, false)).toEqual({
      runs: [{ ...source[1], diagnostic: false }],
      diagnosticRunCount: 1,
    })
  })
})
