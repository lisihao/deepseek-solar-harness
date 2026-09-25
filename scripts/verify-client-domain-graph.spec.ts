import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  collectClientDomainViolations,
  compareClientDomainViolations,
  readClientDomainBaseline,
  type Violation,
} from './verify-client-domain-graph.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_COMMIT = '29c05e6297c24bd7dd8f7cdb9ad9db6c46002901'

function violation(file: string, imported = './module.ts', reason = 'known'): Violation {
  return { file, imported, reason }
}

describe('client domain graph baseline ratchet', () => {
  it('matches the checked-in baseline at the frozen source commit', () => {
    const baseline = readClientDomainBaseline()
    const comparison = compareClientDomainViolations(
      collectClientDomainViolations(ROOT),
      baseline.violations,
    )

    expect(baseline.sourceCommit).toBe(SOURCE_COMMIT)
    expect(comparison.added).toEqual([])
    expect(comparison.removed).toEqual([])
    expect(comparison.actual).toHaveLength(27)
  })

  it('compares triples as a sorted multiset and preserves duplicate debt', () => {
    const duplicate = violation('pkg/src/client/a.ts')
    const other = violation('pkg/src/client/b.ts')
    const comparison = compareClientDomainViolations(
      [other, duplicate, duplicate],
      [duplicate, other],
    )

    expect(comparison.added).toEqual([duplicate])
    expect(comparison.removed).toEqual([])
  })

  it('reports a stale baseline when a debt has been resolved', () => {
    const resolved = violation('pkg/src/client/a.ts')
    const comparison = compareClientDomainViolations([], [resolved])

    expect(comparison.added).toEqual([])
    expect(comparison.removed).toEqual([resolved])
  })

  it('detects both newly introduced and resolved triples independently', () => {
    const oldDebt = violation('pkg/src/client/old.ts')
    const newDebt = violation('pkg/src/client/new.ts')
    const comparison = compareClientDomainViolations([newDebt], [oldDebt])

    expect(comparison.added).toEqual([newDebt])
    expect(comparison.removed).toEqual([oldDebt])
  })
})
