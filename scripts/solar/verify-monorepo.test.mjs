import assert from 'node:assert/strict'
import test from 'node:test'
import { DESKTOP_TAG_PATTERN, MANAGED_IDS, validateMonorepo } from './verify-monorepo.mjs'

function validInput() {
  const managed = MANAGED_IDS.map((id, index) => ({
    id,
    path: `plugins/managed/${id}`,
    package: `${id}@1.0.0`,
    source: `https://github.com/example/${id}.git`,
    accepted_sha: `${index + 1}`.repeat(40),
    license: 'MIT',
    license_status: 'license-file',
    license_evidence: `plugins/managed/${id}/LICENSE`,
    tests: ['node --test'],
  }))
  const governance = managed.find(entry => entry.id === 'governance')
  return {
    product: {
      product: 'DeepSeek-Solar-Harness',
      abbreviation: 'DSH',
      integrationBranch: 'solar',
      supportedPlatforms: ['darwin'],
      desktop: {
        sourcePath: 'products/desktop',
        currentVersion: '2.4.2',
        stableTagPattern: DESKTOP_TAG_PATTERN,
      },
    },
    registry: { managed },
    upstreams: { desktop: { path: 'products/desktop', accepted_sha: 'a'.repeat(40) } },
    desktopVersion: '2.4.2',
    governanceManifest: {
      source_repository: 'agent-development-governance',
      source_commit: governance.accepted_sha,
    },
    governanceProfile: {
      max_concurrency: 2,
      gates: [
        { id: 'source-build', command: ['pnpm', 'run', 'build:lib'] },
        { id: 'typecheck', command: ['pnpm', 'run', 'typecheck:contracts-ready'], needs: ['source-build'] },
        { id: 'lint', command: ['pnpm', 'run', 'lint:contracts-ready'], needs: ['source-build'] },
        { id: 'related-tests', command: ['pnpm', 'exec', 'vitest', 'run', '--changed=origin/solar'], exclusive: true },
        { id: 'doc-sync', command: ['pnpm', 'run', 'doc-sync:contracts-ready'], needs: ['source-build'] },
      ],
    },
    vitestConfig: [
      "name: 'thread-safe',",
      'maxWorkers: 2,',
      "name: 'process-bound',",
      'maxWorkers: 1,',
    ].join('\n'),
    governanceWorkflow: [
      'filter: blob:none',
      'cache: pnpm',
      '- run: python3 tools/agent-development-governance/governance.py verify --project .',
    ].join('\n'),
    pathExists: () => true,
    subtreeImports: new Set([
      ...managed.map(entry => `${entry.path}\0${entry.accepted_sha}`),
      `products/desktop\0${'a'.repeat(40)}`,
    ]),
    gitlinks: [],
  }
}

test('accepts the exact Solar monorepo contract', () => {
  assert.deepEqual(validateMonorepo(validInput()), [])
})

test('rejects the old Desktop tag shape', () => {
  const input = validInput()
  input.product.desktop.stableTagPattern = '^desktop-v[0-9]+\\.[0-9]+\\.[0-9]+$'
  assert.match(validateMonorepo(input).join('\n'), /stableTagPattern/u)
})

test('rejects unbound source provenance and nested gitlinks', () => {
  const input = validInput()
  input.registry.managed[0].accepted_sha = 'not-a-sha'
  input.gitlinks = ['products/desktop/deepseek-harness']
  assert.match(validateMonorepo(input).join('\n'), /accepted_sha/u)
  assert.match(validateMonorepo(input).join('\n'), /nested gitlinks/u)
})

test('rejects an unbounded or unsplit related-test worker contract', () => {
  const input = validInput()
  input.vitestConfig = "name: 'thread-safe',\nmaxWorkers: 2,"
  assert.match(validateMonorepo(input).join('\n'), /process-bound/u)
})

test('rejects a related-test gate that can overlap other resource-heavy gates', () => {
  const input = validInput()
  delete input.governanceProfile.gates.find(gate => gate.id === 'related-tests').exclusive
  assert.match(validateMonorepo(input).join('\n'), /exclusive gate/u)
})

test('rejects repeated source preparation inside governance consumers', () => {
  const input = validInput()
  input.governanceProfile.gates.find(gate => gate.id === 'lint').command = ['pnpm', 'run', 'lint']
  assert.match(validateMonorepo(input).join('\n'), /prepared source build/u)
})

test('rejects uncached or full-history-blob Solar governance checkout', () => {
  const input = validInput()
  input.governanceWorkflow = '- run: python3 tools/agent-development-governance/governance.py verify --project .'
  assert.match(validateMonorepo(input).join('\n'), /partial history|pnpm cache/u)
})
