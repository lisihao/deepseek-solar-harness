import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  classifyPaths,
  collectChangedPaths,
  emitOutputs,
  FORMAT_VERSION,
  CLASSIFIER_VERSION,
} from './pr-impact.mjs'

const scriptPath = resolve(import.meta.dirname, 'pr-impact.mjs')

test('only the explicit documentation allowlist skips both release lanes', () => {
  assert.deepEqual(classifyPaths(['.agents/notes/change.md', 'README.md', 'docs/guide.md', 'website/guide.md']), {
    formatVersion: FORMAT_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    classification: 'docs-only',
    runDsh: false,
    runVendor: false,
    paths: ['.agents/notes/change.md', 'README.md', 'docs/guide.md', 'website/guide.md'],
    reason: 'all paths match the docs-only allowlist',
    fallback: false,
  })
})

test('a package README remains a dsh release impact', () => {
  const result = classifyPaths(['packages/client/example/README.md'])
  assert.equal(result.classification, 'dsh-only')
  assert.equal(result.runDsh, true)
  assert.equal(result.runVendor, false)
})

test('the Landlock release input affects only the dsh lane', () => {
  const result = classifyPaths(['native/landlock-run/packages/entry/package.json'])
  assert.equal(result.classification, 'dsh-only')
  assert.equal(result.runDsh, true)
  assert.equal(result.runVendor, false)
})

test('vendor changes require both release lanes', () => {
  const result = classifyPaths(['vendor/cordis/README.md', 'vendor/cordis/src/index.ts'])
  assert.equal(result.classification, 'dsh-and-vendor')
  assert.equal(result.runDsh, true)
  assert.equal(result.runVendor, true)
})

test('mixed and unknown paths fail closed to both release lanes', () => {
  assert.equal(classifyPaths(['packages/client/example/index.ts', 'docs/guide.md']).runVendor, false)
  assert.equal(classifyPaths(['packages/client/example/index.ts', 'unknown.txt']).runVendor, true)
  assert.equal(classifyPaths([]).classification, 'full')
  assert.equal(classifyPaths([]).runDsh, true)
  assert.equal(classifyPaths([]).runVendor, true)
  assert.equal(classifyPaths(['docs\\guide.md']).classification, 'full')
})

test('path normalization is deterministic and rejects malformed records', () => {
  assert.deepEqual(classifyPaths(['packages/z/index.ts', 'packages/a/index.ts', 'packages/z/index.ts']).paths, [
    'packages/a/index.ts',
    'packages/z/index.ts',
  ])
  assert.throws(() => classifyPaths(['']), /invalid path/u)
  assert.throws(() => classifyPaths(['bad\0path']), /invalid path/u)
})

test('committed paths are read from the unique merge-base to head', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pr-impact-'))
  try {
    git(root, ['init', '--quiet', '--initial-branch=main'])
    git(root, ['config', 'user.email', 'pr-impact@example.com'])
    git(root, ['config', 'user.name', 'PR impact'])
    writeFileSync(join(root, 'README.md'), 'base\n')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '--quiet', '-m', 'base'])
    const base = git(root, ['rev-parse', 'HEAD']).trim()
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs', 'new.md'), 'docs\n', { flag: 'w' })
    git(root, ['add', 'docs/new.md'])
    git(root, ['commit', '--quiet', '-m', 'docs'])
    const head = git(root, ['rev-parse', 'HEAD']).trim()
    assert.deepEqual(collectChangedPaths(root, base, head), ['docs/new.md'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ref and Git parsing failures emit a conservative full decision', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pr-impact-error-'))
  const outputPath = join(root, 'github-output')
  try {
    git(root, ['init', '--quiet', '--initial-branch=main'])
    git(root, ['config', 'user.email', 'pr-impact@example.com'])
    git(root, ['config', 'user.name', 'PR impact'])
    writeFileSync(join(root, 'README.md'), 'base\n')
    git(root, ['add', 'README.md'])
    git(root, ['commit', '--quiet', '-m', 'base'])
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--root', root,
      '--base', 'definitely-missing',
      '--head', 'HEAD',
    ], { env: { ...process.env, GITHUB_OUTPUT: outputPath }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const outputs = parseOutputs(readFileSync(outputPath, 'utf8'))
    assert.deepEqual(outputs, {
      format_version: '1',
      classifier_version: '1',
      classification: 'full',
      run_ci: 'true',
      run_dsh: 'true',
      run_vendor: 'true',
      path_count: '0',
      fallback: 'true',
      reason: outputs.reason,
    })
    assert.match(outputs.reason, /^classifier error; run both release lanes \(/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('non-PR invocations emit full outputs before any package install', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pr-impact-output-'))
  const outputPath = join(root, 'github-output')
  try {
    emitOutputs(classifyPaths([]), outputPath)
    const outputs = parseOutputs(readFileSync(outputPath, 'utf8'))
    assert.equal(outputs.format_version, '1')
    assert.equal(outputs.classifier_version, '1')
    assert.equal(outputs.run_ci, 'true')
    assert.equal(outputs.run_dsh, 'true')
    assert.equal(outputs.run_vendor, 'true')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('documentation-only classification exposes an ordinary CI bypass', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pr-impact-ci-output-'))
  const outputPath = join(root, 'github-output')
  try {
    emitOutputs(classifyPaths(['docs/guide.md']), outputPath)
    const outputs = parseOutputs(readFileSync(outputPath, 'utf8'))
    assert.equal(outputs.classification, 'docs-only')
    assert.equal(outputs.run_ci, 'false')
    assert.equal(outputs.run_dsh, 'false')
    assert.equal(outputs.run_vendor, 'false')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('release workflows classify before install and keep the pack jobs green on skip', () => {
  for (const [workflow, family] of [
    ['.github/workflows/release.yml', 'run_dsh'],
    ['.github/workflows/release-vendor.yml', 'run_vendor'],
  ]) {
    const source = readFileSync(resolve(import.meta.dirname, '..', workflow), 'utf8')
    const classifyAt = source.indexOf('run: node scripts/pr-impact.mjs')
    const installAt = source.indexOf('run: pnpm install --frozen-lockfile')
    assert.ok(classifyAt >= 0, `${workflow} must invoke the direct Node classifier`)
    assert.ok(installAt > classifyAt, `${workflow} must classify before pnpm install`)
    assert.match(source, new RegExp(`if: always\\(\\) && steps\\.impact\\.outputs\\.${family} != 'false'`, 'u'))
    assert.match(source, /name: Skip unaffected release pack/u)
    assert.match(source, /name: Pack npm tarballs/u)
  }
})

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

function parseOutputs(text) {
  return Object.fromEntries(text.trimEnd().split('\n').map(line => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
}
