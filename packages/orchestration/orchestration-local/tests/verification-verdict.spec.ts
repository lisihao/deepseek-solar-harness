/** Explicit verification outcomes and JSON graph acceptance validation. */
import { describe, expect, it } from 'vitest'
import type { LogicalTaskGraphV1, OrchestrationNodeSpecV1 } from '@deepseek-ai/dsh-orchestration'
import { validateGraph } from '../src/graph.ts'
import { verificationVerdictFailure } from '../src/verification-verdict.ts'

const node: OrchestrationNodeSpecV1 = {
  id: 'verify', title: 'Verify files', task: 'Read the resulting files.', role: 'verification', phase: 'verification',
  dependsOn: [], requiredForCompletion: true, capabilityRequirements: [], capabilityBudget: [],
  contextPolicy: { maxTokens: 4096, allowedSourceKinds: ['intent'], unavailableSource: 'block' },
  effectBudget: { read: ['**'], write: [], execute: [], network: [], cost: [], risk: [] },
  readScopes: ['**'], writeScopes: [], approvedSecretRefs: [],
  acceptance: [{ id: 'verified', description: 'Explicit independent result.', kind: 'model-verdict' }],
  retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
}

function failure(text: string, requirement = node) {
  return verificationVerdictFailure(requirement, { output: [{ type: 'text', text }], stopReason: 'completed' })
}

describe('explicit model verification verdict', () => {
  it.each([
    'Work is complete.', 'null', '[]', '{}',
    JSON.stringify({ accepted: 'true', reason: 'Checked files.', evidence: ['work.txt'] }),
    JSON.stringify({ accepted: true, reason: ' ', evidence: ['work.txt'] }),
    JSON.stringify({ accepted: true, reason: 'Checked files.', evidence: [17] }),
    JSON.stringify({ accepted: true, reason: 'Checked files.', evidence: [' '] }),
    JSON.stringify({ accepted: true, reason: 'Checked files.', evidence: ['work.txt'], extra: true }),
  ])('rejects malformed or incomplete output %s', (text) => {
    expect(failure(text)).toBeDefined()
  })

  it('uses a negative verdict reason even when the physical operator completed', () => {
    expect(failure(JSON.stringify({ accepted: false, reason: 'work.txt contains the wrong bytes.', evidence: ['Read work.txt.'] })))
      .toBe('work.txt contains the wrong bytes.')
  })

  it('rejects affirmative acceptance without file evidence', () => {
    expect(failure(JSON.stringify({ accepted: true, reason: 'Completed.', evidence: [] }))).toBeDefined()
  })

  it('accepts an affirmative result with actual evidence', () => {
    expect(failure(JSON.stringify({ accepted: true, reason: 'Requested bytes match.', evidence: ['Read work.txt: requested bytes.'] })))
      .toBeUndefined()
  })

  it('does not parse ordinary operator-completed output as a verdict', () => {
    expect(failure('Implemented the requested edit.', { ...node,
      acceptance: [{ id: 'done', description: 'Operator completes.', kind: 'operator-completed' }] })).toBeUndefined()
  })

  it('validates model-verdict and rejects an unknown acceptance kind at the JSON graph entry', () => {
    const graph: LogicalTaskGraphV1 = { version: 1, title: 'Verify graph', workspace: '/fixture', risk: 'low', maxParallel: 1,
      nodes: [node] }
    expect(validateGraph(graph)).toEqual(['verify'])
    const invalid: unknown = { ...graph, nodes: [{ ...node,
      acceptance: [{ id: 'verified', description: 'Unsupported acceptance.', kind: 'model-verdict-typo' }] }] }
    expect(() => validateGraph(invalid)).toThrow(/acceptance/u)
  })
})
