/**
 * The verify-cordis-config metadata contract: `disabled` is the one entry
 * metadata field whose `!!js` expression the Loader interpolates; every other
 * metadata field must stay static, and a disabled expression must parse.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { metadataExpressionErrors, rootProjectReferences } from './verify-cordis-config.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function projectFixture(configs: Record<string, readonly string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-project-references-'))
  roots.push(root)
  for (const [path, references] of Object.entries(configs)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ references: references.map(path => ({ path })) }))
  }
  return root
}

describe('verify-cordis-config project references', () => {
  it('counts both explicit compiler faces and follows their nested references', () => {
    const root = projectFixture({
      'tsconfig.json': ['./tsconfig.host.json', './tsconfig.client.json'],
      'tsconfig.host.json': ['./packages/ui-gouzi/tsconfig.host.json'],
      'tsconfig.client.json': ['./packages/ui-gouzi/tsconfig.client.json'],
      'packages/ui-gouzi/tsconfig.host.json': ['../shared/tsconfig.host.json'],
      'packages/ui-gouzi/tsconfig.client.json': ['../shared-client/tsconfig.client.json'],
      'packages/shared/tsconfig.host.json': [],
      'packages/shared-client/tsconfig.client.json': [],
    })
    const references = rootProjectReferences(root)
    expect(references.has(join(root, 'packages/ui-gouzi'))).toBe(true)
    expect(references.has(join(root, 'packages/shared'))).toBe(true)
    expect(references.has(join(root, 'packages/shared-client'))).toBe(true)
    expect([...references].filter(path => path === join(root, 'packages/ui-gouzi'))).toHaveLength(1)
  })

  it('preserves directory references and does not count an unreferenced package', () => {
    const root = projectFixture({
      'tsconfig.json': ['./packages/included'],
      'packages/included/tsconfig.json': [],
      'packages/missing/tsconfig.host.json': [],
      'packages/missing/tsconfig.client.json': [],
    })
    const references = rootProjectReferences(root)
    expect(references.has(join(root, 'packages/included'))).toBe(true)
    expect(references.has(join(root, 'packages/missing'))).toBe(false)
  })

  it('rejects a nonexistent explicit config, including a nested reference', () => {
    const root = projectFixture({
      'tsconfig.json': ['./packages/ui-gouzi/tsconfig.host.json'],
      'packages/ui-gouzi/tsconfig.host.json': ['./missing.json'],
    })
    expect(() => rootProjectReferences(root)).toThrow('missing.json')
  })

  it('rejects a malformed explicit config', () => {
    const root = projectFixture({
      'tsconfig.json': ['./packages/ui-gouzi/tsconfig.host.json'],
      'packages/ui-gouzi/tsconfig.host.json': [],
    })
    writeFileSync(join(root, 'packages/ui-gouzi/tsconfig.host.json'), '{')
    expect(() => rootProjectReferences(root)).toThrow()
  })
})

describe('verify-cordis-config metadata expressions', () => {
  it('accepts a disabled !!js expression', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
      '[0]',
    )
    expect(problems).toEqual([])
  })

  it('rejects an expression in a static metadata field', () => {
    const problems = metadataExpressionErrors({ id: { __jsExpr: 'process.platform' }, name: 'pkg' }, '[0]')
    expect(problems).toContain('[0].id: !!js is not interpolated here')
  })

  it('rejects an expression nested below disabled (only the field itself interpolates)', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: 'pkg', disabled: { when: { __jsExpr: 'process.platform' } } },
      '[0]',
    )
    expect(problems).toContain('[0].disabled.when: !!js is not interpolated here')
  })

  it('rejects a disabled expression that does not parse (the loader would fail the boot)', () => {
    const problems = metadataExpressionErrors(
      { id: 'tool-bash', name: 'pkg', disabled: { __jsExpr: 'process.platform ===' } },
      '[0]',
    )
    expect(problems.some(problem => problem.includes('[0].disabled: disabled expression does not parse'))).toBe(true)
  })
})
