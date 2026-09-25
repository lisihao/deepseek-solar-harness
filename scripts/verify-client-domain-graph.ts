/**
 * Enforce intra-package domain layering inside `packages/client/*\/src/client/`.
 * verify-module-graph covers package-level edges; this gate covers the
 * directory level: domain directories may import `contract/` and never each
 * other, and only the assembly point (`apply.ts` / `index.ts`) may import
 * across domains.
 *
 * Layer model (lower may not import higher):
 *   0  contract/            shared contract API (types + slot declarations)
 *   1  <domain>/ + service  domain implementations (skeleton/, chat/, ...)
 *   2  apply.ts, index.ts   assembly point and re-export shell
 *
 * Run directly:
 *   pnpm exec tsx scripts/verify-client-domain-graph.ts
 */

import { globSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const BASELINE_PATH = join(root, 'scripts/fixtures/client-domain-graph-baseline.json')
const BASELINE_SOURCE_COMMIT = '29c05e6297c24bd7dd8f7cdb9ad9db6c46002901'

/** Directory names treated as the shared contract layer (importable by all). */
const CONTRACT_DIRS = new Set(['contract'])
/** Top-level client files allowed to import across domains (assembly layer). */
const ASSEMBLY_FILES = new Set(['apply.ts', 'index.ts', 'index.tsx'])

export interface Violation { file: string; imported: string; reason: string }

export interface ClientDomainGraphBaseline {
  readonly version: 1
  readonly sourceCommit: string
  readonly violations: readonly Violation[]
}

export interface ClientDomainGraphComparison {
  readonly actual: readonly Violation[]
  readonly baseline: readonly Violation[]
  /** Actual entries that are not covered by the baseline, preserving multiplicity. */
  readonly added: readonly Violation[]
  /** Baseline entries absent from the actual result, preserving multiplicity. */
  readonly removed: readonly Violation[]
}

/** Recursively list .ts/.tsx files under dir (relative paths). */
function listSources(dir: string): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: dir })
    .map(rel => rel.split(sep).join('/'))
    .filter(rel => !/\.legacy\./.test(rel.slice(rel.lastIndexOf('/') + 1)))
    .sort()
}

/** First path segment of a client-relative file, or '' for top-level files. */
function domainOf(rel: string): string {
  const ix = rel.indexOf('/')
  return ix === -1 ? '' : rel.slice(0, ix)
}

function checkPackage(pkgName: string, clientDir: string): Violation[] {
  const violations: Violation[] = []
  const files = listSources(clientDir)
  for (const rel of files) {
    const fromDomain = domainOf(rel)
    const isAssembly = fromDomain === '' && ASSEMBLY_FILES.has(rel)
    if (isAssembly) continue
    const source = readFileSync(join(clientDir, rel), 'utf8')
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const spec = match[1]
      if (spec === undefined) continue
      // Resolve the relative specifier against the importing file's directory
      // to a client-dir-relative path.
      const fromDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
      const parts = (fromDir ? fromDir.split('/') : [])
      for (const seg of spec.split('/')) {
        if (seg === '.') continue
        if (seg === '..') parts.pop()
        else parts.push(seg)
      }
      const target = parts.join('/')
      if (target.startsWith('..')) continue // out of client dir (package root) — package-level rules govern
      const toDomain = domainOf(target)
      if (toDomain === '' || CONTRACT_DIRS.has(toDomain)) continue // top-level shared file or contract layer
      if (fromDomain === toDomain) continue // inside one domain
      violations.push({
        file: `${pkgName}/src/client/${rel}`,
        imported: spec,
        reason: fromDomain === ''
          ? `top-level non-assembly file imports domain "${toDomain}" (only apply/index may assemble)`
          : `domain "${fromDomain}" imports sibling domain "${toDomain}" (route shared API through contract/)`,
      })
    }
  }
  return violations
}

/** Collect every client-domain layering violation, in deterministic order. */
export function collectClientDomainViolations(scanRoot: string = root): Violation[] {
  const clientDirRoot = join(scanRoot, 'packages/client')
  const violations: Violation[] = []
  for (const pkg of readdirSync(clientDirRoot).sort()) {
    const clientDir = join(clientDirRoot, pkg, 'src/client')
    try {
      if (!statSync(clientDir).isDirectory()) continue
    } catch {
      // No client half in this package — nothing to layer-check.
      continue
    }
    violations.push(...checkPackage(pkg, clientDir))
  }
  return violations
}

function violationKey(violation: Violation): string {
  return JSON.stringify([violation.file, violation.imported, violation.reason])
}

function compareViolations(left: Violation, right: Violation): number {
  const leftKey = violationKey(left)
  const rightKey = violationKey(right)
  return leftKey === rightKey ? 0 : leftKey < rightKey ? -1 : 1
}

function subtractViolationMultiset(
  left: readonly Violation[],
  right: readonly Violation[],
): Violation[] {
  const remaining = new Map<string, number>()
  for (const violation of right) {
    const key = violationKey(violation)
    remaining.set(key, (remaining.get(key) ?? 0) + 1)
  }
  const result: Violation[] = []
  for (const violation of left) {
    const key = violationKey(violation)
    const count = remaining.get(key) ?? 0
    if (count > 0) remaining.set(key, count - 1)
    else result.push(violation)
  }
  return result
}

/**
 * Compare sorted violation records as multisets. Keeping counts is important:
 * two source imports with the same triple are two debts, not one.
 */
export function compareClientDomainViolations(
  actual: readonly Violation[],
  baseline: readonly Violation[],
): ClientDomainGraphComparison {
  const sort = (values: readonly Violation[]) => [...values].sort(compareViolations)
  const sortedActual = sort(actual)
  const sortedBaseline = sort(baseline)
  return {
    actual: sortedActual,
    baseline: sortedBaseline,
    added: subtractViolationMultiset(sortedActual, sortedBaseline),
    removed: subtractViolationMultiset(sortedBaseline, sortedActual),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseViolation(value: unknown, index: number): Violation {
  if (!isRecord(value)
    || typeof value.file !== 'string'
    || typeof value.imported !== 'string'
    || typeof value.reason !== 'string') {
    throw new Error(`baseline violation ${String(index)} must contain string file, imported and reason`)
  }
  return { file: value.file, imported: value.imported, reason: value.reason }
}

export function readClientDomainBaseline(path: string = BASELINE_PATH): ClientDomainGraphBaseline {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRecord(parsed)
    || parsed.version !== 1
    || typeof parsed.sourceCommit !== 'string'
    || !Array.isArray(parsed.violations)) {
    throw new Error('client-domain-graph baseline must have version 1, sourceCommit and violations[]')
  }
  return {
    version: 1,
    sourceCommit: parsed.sourceCommit,
    violations: parsed.violations.map(parseViolation),
  }
}

function printViolations(label: string, violations: readonly Violation[]): void {
  console.error(`${label} (${String(violations.length)}):`)
  for (const violation of violations) {
    console.error(`  ${violation.file} -> ${violation.imported}\n    ${violation.reason}`)
  }
}

function run(): void {
  const actual = collectClientDomainViolations()
  const baseline = readClientDomainBaseline()
  if (baseline.sourceCommit !== BASELINE_SOURCE_COMMIT) {
    throw new Error(`client-domain-graph baseline sourceCommit must be ${BASELINE_SOURCE_COMMIT}, got ${baseline.sourceCommit}`)
  }
  const comparison = compareClientDomainViolations(actual, baseline.violations)

  if (comparison.added.length > 0 || comparison.removed.length > 0) {
    console.error('verify-client-domain-graph: baseline mismatch.')
    if (comparison.added.length > 0) printViolations('new client-domain violations', comparison.added)
    if (comparison.removed.length > 0) {
      printViolations('resolved violations still present in baseline; shrink the baseline explicitly', comparison.removed)
    }
    process.exitCode = 1
    return
  }

  if (comparison.actual.length > 0) {
    console.log(`verify-client-domain-graph: known baseline debt (${String(comparison.actual.length)} violation(s), source ${baseline.sourceCommit}).`)
    for (const violation of comparison.actual) {
      console.log(`  ${violation.file} -> ${violation.imported}\n    ${violation.reason}`)
    }
  } else {
    console.log('verify-client-domain-graph: client domain layering clean.')
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) run()
