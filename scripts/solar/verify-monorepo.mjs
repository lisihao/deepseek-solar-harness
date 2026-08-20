/** Validate the Solar product boundary, imported-source provenance, and release identity. */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

export const DESKTOP_TAG_PATTERN = '^DSH-desktop-v[0-9]+\\.[0-9]+\\.[0-9]+$'
export const MANAGED_IDS = [
  'agent-teams',
  'governance',
  'luna-vision-bridge',
  'memory-evolve',
  'web-billing',
  'web-ui',
]

const SHA_PATTERN = /^[0-9a-f]{40}$/u

/** Return every violated monorepo invariant without hiding later failures. */
export function validateMonorepo({
  product,
  registry,
  upstreams,
  desktopVersion,
  governanceManifest,
  governanceProfile,
  governanceWorkflow,
  vitestConfig,
  pathExists,
  subtreeImports,
  gitlinks,
}) {
  const errors = []
  if (product?.product !== 'DeepSeek-Solar-Harness') errors.push('product identity must be DeepSeek-Solar-Harness')
  if (product?.abbreviation !== 'DSH') errors.push('product abbreviation must be DSH')
  if (product?.integrationBranch !== 'solar') errors.push('integration branch must be solar')
  if (product?.desktop?.stableTagPattern !== DESKTOP_TAG_PATTERN) {
    errors.push(`Desktop stableTagPattern must be ${DESKTOP_TAG_PATTERN}`)
  }
  if (product?.desktop?.currentVersion !== desktopVersion) {
    errors.push('Desktop product manifest version must equal products/desktop/package.json')
  }
  if (product?.desktop?.sourcePath !== 'products/desktop') errors.push('Desktop sourcePath must be products/desktop')
  if (JSON.stringify(product?.supportedPlatforms) !== JSON.stringify(['darwin'])) {
    errors.push('P0-P2 product support must remain darwin-only')
  }

  const managed = Array.isArray(registry?.managed) ? registry.managed : []
  const ids = managed.map(entry => entry?.id).sort()
  if (JSON.stringify(ids) !== JSON.stringify(MANAGED_IDS)) {
    errors.push(`managed component ids must be exactly ${MANAGED_IDS.join(', ')}`)
  }
  for (const entry of managed) {
    const label = `managed component ${entry?.id ?? '<missing-id>'}`
    if (typeof entry?.path !== 'string' || !entry.path.startsWith('plugins/managed/')) {
      errors.push(`${label} path must remain under plugins/managed`)
    } else if (!pathExists(entry.path)) {
      errors.push(`${label} path is missing: ${entry.path}`)
    }
    if (typeof entry?.source !== 'string' || !entry.source.startsWith('https://github.com/')) {
      errors.push(`${label} source must be an HTTPS GitHub URL`)
    }
    if (!SHA_PATTERN.test(entry?.accepted_sha ?? '')) errors.push(`${label} accepted_sha must be 40 lowercase hex digits`)
    if (!entry?.license || !entry?.license_status) errors.push(`${label} license metadata is incomplete`)
    if (typeof entry?.license_evidence !== 'string' || !pathExists(entry.license_evidence)) {
      errors.push(`${label} license evidence is missing`)
    }
    if (!Array.isArray(entry?.tests) || entry.tests.length === 0 || entry.tests.some(test => typeof test !== 'string')) {
      errors.push(`${label} must declare native test commands`)
    }
    if (entry?.path && entry?.accepted_sha && !subtreeImports.has(`${entry.path}\0${entry.accepted_sha}`)) {
      errors.push(`${label} accepted SHA is not bound to a subtree import commit`)
    }
  }

  const governance = managed.find(entry => entry?.id === 'governance')
  if (governanceManifest?.source_repository !== 'agent-development-governance') {
    errors.push('governance bundle must identify agent-development-governance')
  }
  if (governanceManifest?.source_commit !== governance?.accepted_sha) {
    errors.push('governance bundle source commit must equal the accepted governance SHA')
  }
  const governanceGates = new Map(governanceProfile?.gates?.map(gate => [gate?.id, gate]) ?? [])
  if (governanceProfile?.max_concurrency !== 2) {
    errors.push('Solar governance max_concurrency must reserve one of the three macOS runner CPUs for child pools')
  }
  const sourceBuild = governanceGates.get('source-build')
  if (JSON.stringify(sourceBuild?.command) !== JSON.stringify(['pnpm', 'run', 'build:lib'])) {
    errors.push('Solar governance must own one shared source library build')
  }
  for (const [id, script] of [
    ['typecheck', 'typecheck:contracts-ready'],
    ['lint', 'lint:contracts-ready'],
    ['doc-sync', 'doc-sync:contracts-ready'],
  ]) {
    const gate = governanceGates.get(id)
    if (JSON.stringify(gate?.command) !== JSON.stringify(['pnpm', 'run', script])
      || JSON.stringify(gate?.needs) !== JSON.stringify(['source-build'])) {
      errors.push(`${id} must consume the prepared source build`)
    }
  }
  const relatedTests = governanceGates.get('related-tests')
  if (JSON.stringify(relatedTests?.command) !== JSON.stringify(['pnpm', 'exec', 'vitest', 'run', '--changed=origin/solar'])) {
    errors.push('related-tests must use the bounded Vitest project worker budgets')
  }
  const threadSafeWorkers = /name: 'thread-safe',[\s\S]{0,200}maxWorkers: 3,/u.test(vitestConfig ?? '')
  const processBoundWorkers = /name: 'process-bound',[\s\S]{0,200}maxWorkers: 1,/u.test(vitestConfig ?? '')
  if (!threadSafeWorkers || !processBoundWorkers) {
    errors.push('Vitest must keep thread-safe work bounded and process-bound work serial')
  }
  if (!governanceWorkflow?.includes('filter: blob:none')) {
    errors.push('Solar governance checkout must use partial history blobs')
  }
  if (!governanceWorkflow?.includes('cache: pnpm')) {
    errors.push('Solar governance must restore the pnpm cache')
  }
  if (governanceWorkflow?.includes('- run: corepack pnpm run build:lib')) {
    errors.push('Solar governance workflow must not rebuild source outside the attested DAG')
  }
  for (const required of [
    '.agents/skills/dsh-code-as-harness/SKILL.md',
    'plugins/managed/governance/skill/agent-development-governance/SKILL.md',
    'plugins/managed/governance/skill/agent-development-governance/references/governance-contract.md',
  ]) {
    if (!pathExists(required)) errors.push(`required Code-as-Harness source is missing: ${required}`)
  }
  if (gitlinks.length > 0) errors.push(`nested gitlinks are forbidden under product source: ${gitlinks.join(', ')}`)

  if (upstreams?.desktop?.path !== 'products/desktop') errors.push('Desktop upstream record must target products/desktop')
  if (!SHA_PATTERN.test(upstreams?.desktop?.accepted_sha ?? '')) errors.push('Desktop accepted upstream SHA is invalid')
  if (!subtreeImports.has(`products/desktop\0${upstreams?.desktop?.accepted_sha}`)) {
    errors.push('Desktop accepted SHA is not bound to its subtree import commit')
  }
  return errors
}

function parseSubtreeImports(log) {
  const imports = new Set()
  for (const body of log.split('\x1e')) {
    const path = /^git-subtree-dir: (.+)$/mu.exec(body)?.[1]
    const sha = /^git-subtree-split: ([0-9a-f]{40})$/mu.exec(body)?.[1]
    if (path && sha) imports.add(`${path}\0${sha}`)
  }
  return imports
}

export function verifyRepository(root) {
  const readJson = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'))
  const readYaml = path => yaml.load(readFileSync(resolve(root, path), 'utf8'))
  const log = execFileSync('git', ['log', '--all', '--format=%B%x1e', '--grep=git-subtree-dir:'], {
    cwd: root,
    encoding: 'utf8',
  })
  const indexed = execFileSync('git', ['ls-files', '-s', '--', 'products/desktop', 'plugins/managed'], {
    cwd: root,
    encoding: 'utf8',
  })
  const gitlinks = indexed.split('\n')
    .filter(line => line.startsWith('160000 '))
    .map(line => line.split('\t')[1])
    .filter(Boolean)
  return validateMonorepo({
    product: readJson('distribution/product.json'),
    registry: readYaml('plugins/registry.yaml'),
    upstreams: readYaml('distribution/upstreams.yaml'),
    desktopVersion: readJson('products/desktop/package.json').version,
    governanceManifest: readJson('tools/agent-development-governance/manifest.json'),
    governanceProfile: readJson('.agent-governance/profile.json'),
    governanceWorkflow: readFileSync(resolve(root, '.github/workflows/solar-governance.yml'), 'utf8'),
    vitestConfig: readFileSync(resolve(root, 'vitest.config.ts'), 'utf8'),
    pathExists: path => existsSync(resolve(root, path)),
    subtreeImports: parseSubtreeImports(log),
    gitlinks,
  })
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const errors = verifyRepository(root)
  if (errors.length > 0) {
    process.stderr.write(`verify-monorepo: ${errors.length} violation(s):\n${errors.map(error => `- ${error}`).join('\n')}\n`)
    process.exit(1)
  }
  process.stdout.write('verify-monorepo: product identity, provenance, licenses, Code-as-Harness, and Desktop tag contract are consistent\n')
}
