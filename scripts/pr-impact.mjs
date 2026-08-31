/** Classify pull-request paths into the two credential-free release pack lanes. */

import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseArgs, TextDecoder } from 'node:util'

export const FORMAT_VERSION = 1
export const CLASSIFIER_VERSION = 1

const MAX_GIT_OUTPUT = 64 * 1024 * 1024
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const DOC_ONLY_ROOT_PATHS = new Set([
  'BENCHMARK.md',
  'CONTRIBUTING.i18n.yaml',
  'CONTRIBUTING.md',
  'CONTRIBUTING.zh.md',
  'README.i18n.yaml',
  'README.md',
  'README.zh.md',
  'THIRD_PARTY_NOTICES.md',
])
const DOC_ONLY_PREFIXES = ['.agents/notes/', 'docs/', 'website/']
const DSH_PREFIXES = ['apps/', 'native/landlock-run/', 'packages/']

/**
 * Normalize and validate Git paths before they enter the classifier.
 * @param {readonly unknown[]} paths - repository-relative paths from Git.
 * @returns {string[]} sorted, unique repository-relative paths.
 */
export function normalizePaths(paths) {
  if (!Array.isArray(paths)) throw new TypeError('paths must be an array')
  const normalized = []
  for (const value of paths) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
      throw new Error('Git returned an invalid path')
    }
    // Git path separators are forward slashes. A backslash is a literal
    // filename character and must not be rewritten into an allowlisted path.
    normalized.push(value)
  }
  return [...new Set(normalized)].sort()
}

/**
 * Classify one complete committed path set. Empty and unknown input is full by
 * design: release lanes are skipped only for the explicit docs-only allowlist.
 * @param {readonly unknown[]} paths - changed repository-relative paths.
 * @returns {ImpactDecision} the deterministic release decision.
 */
export function classifyPaths(paths) {
  const normalized = normalizePaths(paths)
  if (normalized.length === 0) {
    return decision('full', true, true, normalized, 'empty diff; run both release lanes')
  }

  const docsOnly = normalized.every(isDocsOnlyPath)
  if (docsOnly) {
    return decision('docs-only', false, false, normalized, 'all paths match the docs-only allowlist')
  }

  const nonDocs = normalized.filter(path => !isDocsOnlyPath(path))
  const hasVendor = nonDocs.some(path => path.startsWith('vendor/'))
  const hasDsh = nonDocs.some(path => DSH_PREFIXES.some(prefix => path.startsWith(prefix)))
  const hasUnknown = nonDocs.some(path => (
    !path.startsWith('vendor/')
    && !DSH_PREFIXES.some(prefix => path.startsWith(prefix))
  ))

  if (hasUnknown) {
    return decision('full', true, true, normalized, 'path is outside the release impact allowlist')
  }
  if (hasVendor) {
    return decision('dsh-and-vendor', true, true, normalized, 'vendor path requires both release lanes')
  }
  if (hasDsh) {
    return decision('dsh-only', true, false, normalized, 'dsh package path requires the dsh lane')
  }

  // This is unreachable while the prefix tables are non-empty, but retaining
  // a conservative branch keeps future table edits fail-closed.
  return decision('full', true, true, normalized, 'unclassified path; run both release lanes')
}

/**
 * Build a decision object with stable field order and values.
 * @param {string} classification - classification label.
 * @param {boolean} runDsh - whether the dsh lane must run.
 * @param {boolean} runVendor - whether the vendor lane must run.
 * @param {string[]} paths - normalized changed paths.
 * @param {string} reason - stable human-readable reason.
 * @param {boolean} [fallback=false] - whether classification fell back after an error.
 * @returns {ImpactDecision} decision.
 */
function decision(classification, runDsh, runVendor, paths, reason, fallback = false) {
  return {
    formatVersion: FORMAT_VERSION,
    classifierVersion: CLASSIFIER_VERSION,
    classification,
    runDsh,
    runVendor,
    paths,
    reason,
    fallback,
  }
}

/** @param {string} path - repository-relative path. */
function isDocsOnlyPath(path) {
  return DOC_ONLY_ROOT_PATHS.has(path) || DOC_ONLY_PREFIXES.some(prefix => path.startsWith(prefix))
}

/**
 * Run Git without a shell and return raw bytes. The byte form preserves paths
 * until each NUL-delimited record is decoded strictly.
 * @param {string} cwd - repository directory.
 * @param {string[]} args - Git arguments.
 * @param {string} context - operation label for diagnostics.
 * @returns {Buffer} stdout bytes.
 */
function runGitBytes(cwd, args, context) {
  const result = spawnSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LANG: 'C', LC_ALL: 'C' },
    maxBuffer: MAX_GIT_OUTPUT,
  })
  if (result.error !== undefined) throw new Error(`${context}: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : ''
    throw new Error(`${context}: ${detail || `Git exited with status ${String(result.status)}`}`)
  }
  if (!Buffer.isBuffer(result.stdout)) throw new Error(`${context}: Git did not return byte output`)
  return result.stdout
}

/** @param {Buffer} bytes - strict UTF-8 bytes. @param {string} context - operation label. */
function decodeUtf8(bytes, context) {
  try {
    return UTF8_DECODER.decode(bytes)
  } catch {
    throw new Error(`${context}: Git output is not valid UTF-8`)
  }
}

/** @param {string} cwd - repository directory. @param {string[]} args - Git arguments. @param {string} context - operation label. */
function runGitText(cwd, args, context) {
  return decodeUtf8(runGitBytes(cwd, args, context), context)
}

/**
 * Resolve one ref to exactly one commit.
 * @param {string} cwd - repository directory.
 * @param {'base'|'head'} label - ref label.
 * @param {string} ref - Git ref or object ID.
 * @returns {string} resolved commit ID.
 */
function resolveCommit(cwd, label, ref) {
  const result = runGitText(cwd, [
    '-c',
    'core.warnAmbiguousRefs=true',
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ], `cannot resolve ${label} ref`)
  const commits = result.trim().split(/\r?\n/u).filter(Boolean)
  if (commits.length !== 1) throw new Error(`${label} ref did not resolve to exactly one commit`)
  return commits[0]
}

/**
 * Collect committed PR paths from the unique merge base to the requested head.
 * @param {string} cwd - repository directory.
 * @param {string} base - PR base ref.
 * @param {string} head - PR head ref.
 * @returns {string[]} sorted changed paths.
 */
export function collectChangedPaths(cwd, base, head = 'HEAD') {
  if (typeof base !== 'string' || base.length === 0) throw new Error('missing PR base ref')
  if (typeof head !== 'string' || head.length === 0) throw new Error('missing PR head ref')
  const baseSha = resolveCommit(cwd, 'base', base)
  const headSha = resolveCommit(cwd, 'head', head)
  const mergeBases = runGitText(cwd, ['merge-base', '--all', baseSha, headSha], 'cannot resolve merge base')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
  if (mergeBases.length !== 1) throw new Error(`base and head do not have a unique merge base; found ${String(mergeBases.length)}`)

  const output = runGitBytes(cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    '--ignore-submodules=none',
    '--name-only',
    '-z',
    mergeBases[0],
    headSha,
    '--',
  ], 'cannot inspect committed paths')
  return parseNulPaths(output)
}

/** @param {Buffer} output - NUL-delimited Git path output. @returns {string[]} paths. */
function parseNulPaths(output) {
  const paths = []
  let start = 0
  for (let end = 0; end < output.length; end += 1) {
    if (output[end] !== 0) continue
    if (end === start) throw new Error('Git returned an empty path record')
    paths.push(decodeUtf8(output.subarray(start, end), 'cannot decode changed path'))
    start = end + 1
  }
  if (start !== output.length) throw new Error('Git path output was not NUL terminated')
  return normalizePaths(paths)
}

/**
 * Emit stable step outputs. Without GITHUB_OUTPUT, print a JSON decision for
 * local inspection and tests.
 * @param {ImpactDecision} result - classifier result.
 * @param {string|undefined} outputPath - GitHub output file.
 */
export function emitOutputs(result, outputPath = process.env.GITHUB_OUTPUT) {
  const values = {
    format_version: String(result.formatVersion),
    classifier_version: String(result.classifierVersion),
    classification: result.classification,
    run_dsh: String(result.runDsh),
    run_vendor: String(result.runVendor),
    path_count: String(result.paths.length),
    fallback: String(result.fallback),
    reason: result.reason,
  }
  if (outputPath !== undefined && outputPath !== '') {
    appendFileSync(outputPath, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, 'utf8')
    return
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

/** @param {unknown} error - thrown value. @returns {string} one-line safe diagnostic. */
function errorReason(error) {
  const detail = error instanceof Error ? error.message : String(error)
  return `classifier error; run both release lanes (${detail.replaceAll(/\s+/gu, ' ').slice(0, 400)})`
}

/**
 * Classify a workflow invocation. Missing PR refs mean push/manual mode and
 * intentionally select both release lanes.
 * @param {string[]} args - command-line arguments.
 */
function main(args) {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      root: { type: 'string' },
    },
  })
  const base = values.base ?? process.env.PR_BASE_SHA
  const head = values.head ?? process.env.PR_HEAD_SHA ?? 'HEAD'
  const root = resolve(values.root ?? process.env.GITHUB_WORKSPACE ?? process.cwd())

  let result
  if (base === undefined || base === '') {
    result = decision('full', true, true, [], 'non-PR event; run both release lanes')
  } else {
    try {
      result = classifyPaths(collectChangedPaths(root, base, head))
    } catch (error) {
      result = decision('full', true, true, [], errorReason(error), true)
      console.warn(`pr-impact: ${result.reason}`)
    }
  }
  emitOutputs(result)
  console.log(`pr-impact: ${result.classification}; dsh=${String(result.runDsh)}; vendor=${String(result.runVendor)}; paths=${String(result.paths.length)}`)
}

const entryPath = process.argv[1]
if (entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    // Argument or output-file failures cannot be classified. The workflows
    // guard heavy steps against only an explicit `false`, so missing outputs
    // also take the full path and leave the job failed for operator review.
    console.error(`pr-impact: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

/** @typedef {{formatVersion: number, classifierVersion: number, classification: string, runDsh: boolean, runVendor: boolean, paths: string[], reason: string, fallback: boolean}} ImpactDecision */
