#!/opt/homebrew/opt/node@22/bin/node

/**
 * One frozen, deliberately unequal-compute comparison: a bare one-shot model
 * answer (D1) and the existing native Prime RLM at depth one (S14).
 *
 * Importing this module is side-effect free.  The only provider entry point is
 * runPanel(), after the historical-closure, prepared-byte, acceptance, replay,
 * and process-profile gates have all passed.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import dns from 'node:dns'
import net from 'node:net'

import {
  compileCurrentSources,
  createModelDispatcher,
  loadRealProvider,
  prepareSharedRuntime,
  summarizeConditionResources,
} from '../rlm-arc-pilot/run.mjs'
import { createAttachmentRelay } from '../rlm-arc-pilot/attachment-relay.mjs'
import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { serializeDispatcher } from '../rlm-recursion-pilot/control.mjs'
import { executeCondition } from '../rlm-recursion-pilot/run.mjs'
import { installNoReuseProfile } from '../rlm-recursion-pilot/network-profile.mjs'
import { gradeTask, loadTask } from './task.mjs'

const execFile = promisify(execFileCallback)
const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(TOOL_DIRECTORY, '../..')
const DEFAULT_PRIOR_ROOT = '/Users/sihaoli/Projects/DeepSeek-Solar-Harness-V4/artifacts/rlm-recursion-20261021'
const DEFAULT_OUTPUT = join(DEFAULT_PRIOR_ROOT, 'bare-quality-v1')
const DEFAULT_TMP_ROOT = '/private/tmp/bq1'
const DEFAULT_PRIOR_CLOSURE = join(DEFAULT_PRIOR_ROOT, 'revalidation/no-reuse-v2/final-closure.json')
const DEFAULT_PRIOR_CLOSURE_SHA256 = 'c3fd18c63b72a40176867bd311df274d05b2d22a653e3c4dd88b87b230d65593'
const PREPARED_FILE = 'prepared.json'
const RUN_START_FILE = 'real-run-started.json'
const RUN_RECEIPT_FILE = 'run-receipt.json'
const FORMAT_VERSION = 1
const SHA256 = /^[a-f0-9]{64}$/i
const TEMP_BASE = process.platform === 'darwin' ? '/private/tmp' : resolve(tmpdir())

const FIXED_ROUTE = Object.freeze({
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  maxTokens: 16_384,
})

const FIXED_LIMITS = Object.freeze({
  newPhaseRequests: 15,
  perRunRequests: 14,
  directRequests: 1,
  rlmRequests: 14,
  priorCharged: 506,
  priorConfirmed: 495,
  priorUnknown: 11,
  globalCap: 522,
  wallTimeMs: 1_200_000,
  autonomousMaxTurns: 14,
  autonomousMaxTokens: 4_000_000,
})

const EXECUTION_FILES = Object.freeze([
  'tools/rlm-quality-pilot/run.mjs',
  'tools/rlm-quality-pilot/task.mjs',
  'tools/rlm-quality-pilot/official-score.py',
  'tools/rlm-arc-pilot/run.mjs',
  'tools/rlm-arc-pilot/native-worker.mjs',
  'tools/rlm-arc-pilot/sandbox.mjs',
  'tools/rlm-arc-pilot/attachment-relay.mjs',
  'tools/rlm-arc-pilot/ledger.mjs',
  'tools/rlm-recursion-pilot/control.mjs',
  'tools/rlm-recursion-pilot/run.mjs',
  'tools/rlm-recursion-pilot/network-profile.mjs',
  'package.json',
  'pnpm-lock.yaml',
])

const NATIVE_PROOF_FILES = Object.freeze([
  'tools/rlm-arc-pilot/run.mjs',
  'tools/rlm-arc-pilot/native-worker.mjs',
  'tools/rlm-arc-pilot/sandbox.mjs',
  'tools/rlm-recursion-pilot/control.mjs',
  'tools/rlm-recursion-pilot/run.mjs',
])

function failure(code, detail, options = {}) {
  const error = new Error(`${code}: ${detail}`, options.cause === undefined ? undefined : { cause: options.cause })
  error.code = code
  return error
}

function fail(code, detail, options) {
  throw failure(code, detail, options)
}

function errorText(value) {
  return value instanceof Error ? value.message : String(value)
}

function redact(value) {
  return String(value ?? '')
    .replace(/(api[_-]?key|authorization|credential|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 2_000)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(value, key) {
  return isRecord(value) && Object.hasOwn(value, key)
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function canonicalHash(value) {
  return sha256Bytes(stableJson(value))
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path))
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('BQ_PATH', `${label} must be an absolute path`)
  return resolve(value)
}

function isWithin(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function assertDirectory(path, label) {
  const absolute = requireAbsolute(path, label)
  let info
  try { info = await stat(absolute) } catch (error) { fail('BQ_FILE', `${label} is unavailable`, { cause: error }) }
  if (!info.isDirectory()) fail('BQ_FILE', `${label} is not a directory`)
  return absolute
}

async function assertRegularFile(path, label) {
  const absolute = requireAbsolute(path, label)
  let info
  try { info = await stat(absolute) } catch (error) { fail('BQ_FILE', `${label} is unavailable`, { cause: error }) }
  if (!info.isFile()) fail('BQ_FILE', `${label} is not a regular file`)
  return absolute
}

async function readJson(path, label) {
  const file = await assertRegularFile(path, label)
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { fail('BQ_JSON', `${label} is not valid JSON`, { cause: error }) }
}

async function writeExclusiveJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function writeExclusiveText(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(value, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
}

async function gitHead(sourceRoot) {
  try {
    const { stdout } = await execFile('git', ['-C', sourceRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    const head = stdout.trim()
    if (!/^[a-f0-9]{40}$/i.test(head)) fail('BQ_SOURCE_HEAD', 'git did not return a full source HEAD')
    return head
  } catch (error) {
    fail('BQ_SOURCE_HEAD', `cannot read source HEAD: ${redact(errorText(error))}`)
  }
}

async function hashTree(root) {
  const directory = await assertDirectory(root, 'hash tree')
  const values = {}
  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(path, relativePath)
      else if (entry.isFile()) values[relativePath] = await sha256File(path)
      else fail('BQ_SOURCE_FILES', `source tree contains an unsupported node: ${relativePath}`)
    }
  }
  await visit(directory, '')
  if (Object.keys(values).length === 0) fail('BQ_SOURCE_FILES', 'source tree must not be empty')
  return values
}

async function executionHashes(sourceRoot) {
  const source = await assertDirectory(sourceRoot, 'sourceRoot')
  const helpers = {}
  for (const name of EXECUTION_FILES) helpers[name] = await sha256File(await assertRegularFile(join(source, name), name))
  const packageRoot = join(source, 'incubator/rlm')
  return {
    helpers,
    source: await hashTree(join(packageRoot, 'src')),
    package: await sha256File(await assertRegularFile(join(packageRoot, 'package.json'), 'RLM package manifest')),
    lock: await sha256File(await assertRegularFile(join(source, 'pnpm-lock.yaml'), 'pnpm lockfile')),
  }
}

function assertExactHashMap(actual, expected, label) {
  if (!isRecord(actual) || !isRecord(expected) || canonicalHash(actual) !== canonicalHash(expected)) {
    fail('BQ_FINGERPRINT_SOURCE', `${label} differs from its frozen hash map`)
  }
}

function publicPrompt(task) {
  return `${task.context}\n${task.question}`
}

function requireTask(task) {
  if (!isRecord(task) || task.formatVersion !== 1 || task.kind !== 'paper-oolong-task-v1'
    || typeof task.id !== 'string' || task.id.length === 0
    || typeof task.context !== 'string' || task.context.length === 0
    || typeof task.question !== 'string' || task.question.length === 0
    || typeof task.answerType !== 'string' || !isRecord(task.source)
    || !isRecord(task.scorer) || typeof task.scorer.path !== 'string' || !isAbsolute(task.scorer.path)
    || !SHA256.test(task.scorer.sha256 ?? '')) {
    fail('BQ_TASK', 'task loader returned an unsupported task object')
  }
  if (!isRecord(task.inputFiles) || Object.keys(task.inputFiles).length !== 1 || task.inputFiles['inputs/context.txt'] !== task.context) {
    fail('BQ_TASK', 'task public inputs must contain only the exact context at inputs/context.txt')
  }
  return task
}

function nativePrompt(task) {
  return [
    'The original task context is available at inputs/context.txt.',
    task.question,
    'Write the final answer to answer.json as exactly a JSON object with one string field: {"answer":"..."}.',
    'The whole tree is limited to 14 model requests and 20 minutes.',
  ].join('\n\n')
}

function quoteShell(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function publicGateScript() {
  return `#!/usr/bin/env python3
import json
import pathlib
import sys

workspace = pathlib.Path(sys.argv[1])
answer_path = workspace / 'answer.json'
try:
    value = json.loads(answer_path.read_text('utf-8'))
except Exception as exc:
    raise SystemExit('unreadable answer: ' + str(exc))
if type(value) is not dict or set(value) != {'answer'} or type(value.get('answer')) is not str:
    raise SystemExit('answer.json must be exactly {"answer": string}')
`
}

function gateCommand({ python, script, workspace }) {
  return `env -i PATH=${quoteShell(dirname(python))} HOME=${quoteShell(join(workspace, '.home'))} TMPDIR=${quoteShell(join(workspace, '.tmp'))} ${quoteShell(python)} ${quoteShell(script)} ${quoteShell(workspace)}`
}

function conditionSummary(condition) {
  return {
    id: condition.id,
    arm: condition.arm,
    taskId: condition.taskId,
    publicPromptSha256: condition.publicPromptSha256,
    prompt: condition.prompt,
    inputHashes: condition.inputHashes,
    autonomous: condition.autonomous,
    directory: condition.directory ?? null,
    runDirectory: condition.runDirectory ?? null,
    durableDirectory: condition.durableDirectory ?? null,
    workspace: condition.workspace ?? null,
    data: condition.data ?? null,
    markerDirectory: condition.markerDirectory ?? null,
  }
}

function manifestFingerprint(manifest) {
  return canonicalHash({
    kind: manifest.kind,
    output: manifest.output,
    tmpRoot: manifest.tmpRoot,
    parentPrivate: manifest.parentPrivate,
    prior: manifest.prior,
    sourceHead: manifest.sourceHead,
    runner: manifest.runner,
    execution: manifest.execution,
    package: manifest.package,
    shared: {
      compiled: manifest.shared.compiled,
      runtime: manifest.shared.runtime,
      worker: manifest.shared.worker,
      gate: manifest.shared.gate,
    },
    task: manifest.task,
    scorer: manifest.scorer,
    protectedRoots: manifest.protectedRoots,
    ledger: manifest.ledger,
    limits: manifest.limits,
    route: manifest.route,
    conditions: manifest.conditions.map(conditionSummary),
  })
}

function requireSha256(value, label, code = 'BQ_HASH') {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code, `${label} must be a SHA-256 digest`)
  return value.toLowerCase()
}

async function validatePriorPhase({
  priorRoot = DEFAULT_PRIOR_ROOT,
  closurePath = join(priorRoot, 'revalidation/no-reuse-v2/final-closure.json'),
  expectedClosureSha256 = DEFAULT_PRIOR_CLOSURE_SHA256,
} = {}) {
  const root = await assertDirectory(priorRoot, 'prior root')
  const closureFile = await assertRegularFile(closurePath, 'prior final closure')
  const closureSha256 = await sha256File(closureFile)
  if (closureSha256 !== requireSha256(expectedClosureSha256, 'expected prior closure SHA-256')) {
    fail('BQ_PRIOR_CLOSURE_HASH', 'prior final closure differs from the immutable accepted closure')
  }
  const closure = await readJson(closureFile, 'prior final closure')
  if (!isRecord(closure) || closure.formatVersion !== 1 || closure.kind !== 'native-recursion-final-closure-v1'
    || closure.ownedProcessesAbsent !== true || closure.endpointsClosed !== true || closure.providerClosed !== true
    || closure.relayClosed !== true || closure.networkProfileDisposed !== true) {
    fail('BQ_PRIOR_CLOSURE', 'prior final closure does not prove its previous effects were closed')
  }
  const accounting = closure.accounting
  if (!isRecord(accounting) || accounting.newAdmitted !== 25 || accounting.physicalAdmitted !== 25
    || accounting.cumulativeAdmitted !== FIXED_LIMITS.priorCharged
    || accounting.cumulativeConfirmed !== FIXED_LIMITS.priorConfirmed
    || accounting.cumulativeUnknown !== FIXED_LIMITS.priorUnknown || accounting.stopped !== false) {
    fail('BQ_PRIOR_ACCOUNTING', 'prior closure does not retain the fixed 506 = 495 + 11 prefix')
  }
  const closureDirectory = dirname(closureFile)
  const referenced = [
    ['manifest', 'prepared.json'],
    ['receipt', 'run-receipt.json'],
    ['ledger', 'provider-ledger.jsonl'],
    ['errorAnalysis', 'answer-error-analysis.json'],
  ]
  const artifacts = {}
  for (const [field, name] of referenced) {
    const record = closure[field]
    if (!isRecord(record) || !SHA256.test(record.sha256 ?? '')) fail('BQ_PRIOR_REFERENCE', `prior closure has no valid ${field} hash`)
    const path = await assertRegularFile(join(closureDirectory, name), `prior ${field}`)
    const sha256 = await sha256File(path)
    if (sha256 !== record.sha256.toLowerCase()) fail('BQ_PRIOR_REFERENCE', `prior ${field} hash differs from final closure`)
    artifacts[field] = { path, sha256 }
  }
  const prepared = await readJson(artifacts.manifest.path, 'prior prepared manifest')
  const receipt = await readJson(artifacts.receipt.path, 'prior run receipt')
  if (!isRecord(prepared) || prepared.kind !== 'native-recursion-no-reuse-revalidation-v2'
    || prepared.fingerprint !== closure.fingerprint
    || !isRecord(receipt) || receipt.kind !== 'native-recursion-no-reuse-revalidation-receipt-v2'
    || receipt.fingerprint !== closure.fingerprint || receipt.closes?.provider !== 'closed'
    || receipt.closes?.relay !== 'closed' || receipt.closes?.networkProfile !== 'disposed') {
    fail('BQ_PRIOR_REFERENCE', 'prior manifest or receipt is not bound to the final closure')
  }
  const receiptAccounting = receipt.accounting
  if (!isRecord(receiptAccounting) || receiptAccounting.newAdmitted !== 25 || receiptAccounting.physicalAdmitted !== 25
    || receiptAccounting.cumulativeAdmitted !== FIXED_LIMITS.priorCharged
    || receiptAccounting.cumulativeConfirmed !== FIXED_LIMITS.priorConfirmed
    || receiptAccounting.cumulativeUnknown !== FIXED_LIMITS.priorUnknown || receiptAccounting.stopped !== false) {
    fail('BQ_PRIOR_REFERENCE', 'prior run receipt has inconsistent cumulative accounting')
  }
  const ledger = await Ledger.open(artifacts.ledger.path, { total: 28, perRun: 14 })
  const ledgerReceipt = await ledger.receipt()
  if (ledgerReceipt.newAdmitted !== 25 || ledgerReceipt.settled !== 25 || ledgerReceipt.unknown !== 0
    || ledgerReceipt.physicalAdmitted !== 25 || ledgerReceipt.stopped !== false) {
    fail('BQ_PRIOR_LEDGER', 'prior phase ledger is not the accepted 25 settled requests')
  }
  return { root, closure: { path: closureFile, sha256: closureSha256, value: closure }, artifacts }
}

async function assertOutputScope({ output, priorRoot }) {
  const root = await assertDirectory(priorRoot, 'prior root')
  const expected = join(root, 'bare-quality-v1')
  if (requireAbsolute(output, 'output') !== expected) fail('BQ_OUTPUT_SCOPE', `output must be the one-shot namespace ${expected}`)
  if (await exists(expected)) fail('BQ_OUTPUT_REPLAY', 'the one-shot output namespace already exists; never replay this comparison')
  return expected
}

async function createFreshTmpRoot(tmpRoot, { priorRoot }) {
  const root = requireAbsolute(tmpRoot, 'tmpRoot')
  const production = resolve(priorRoot) === resolve(DEFAULT_PRIOR_ROOT)
  if (production && root !== DEFAULT_TMP_ROOT) fail('BQ_TMP_SCOPE', `production tmpRoot must be ${DEFAULT_TMP_ROOT}`)
  if (!production && (!isWithin(TEMP_BASE, root) || root === TEMP_BASE)) fail('BQ_TMP_SCOPE', `test tmpRoot must be a descendant of ${TEMP_BASE}`)
  if (await exists(root)) fail('BQ_TMP_REPLAY', 'native temporary root already exists; do not reuse a native namespace')
  const socketPath = join(root, 'runs', 'S14', 'tmp', 'prime-agent-000000000000-000000000000.sock')
  if (Buffer.byteLength(socketPath) >= 100) fail('BQ_SOCKET_PATH', 'native temporary root is too long for the Unix socket boundary')
  await mkdir(root, { recursive: true, mode: 0o700 })
  return root
}

async function writeContext(workspace, context) {
  const path = join(workspace, 'inputs', 'context.txt')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, context, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return { path, sha256: await sha256File(path) }
}

async function createConditions({ output, tmpRoot, sharedRuntimeRoot, runtime, gatePath, task }) {
  const directDirectory = join(output, 'runs', 'D1')
  const directMarkers = join(directDirectory, 'markers')
  const runDirectory = join(tmpRoot, 'runs', 'S14')
  const durableDirectory = join(output, 'runs', 'S14')
  const workspace = join(runDirectory, 'workspace')
  const markerDirectory = join(durableDirectory, 'markers')
  await Promise.all([
    mkdir(directDirectory, { recursive: true, mode: 0o700 }),
    mkdir(directMarkers, { recursive: true, mode: 0o700 }),
    mkdir(workspace, { recursive: true, mode: 0o700 }),
    mkdir(join(runDirectory, 'home'), { recursive: true, mode: 0o700 }),
    mkdir(join(runDirectory, 'tmp'), { recursive: true, mode: 0o700 }),
    mkdir(join(runDirectory, 'data'), { recursive: true, mode: 0o700 }),
    mkdir(join(runDirectory, 'client-state'), { recursive: true, mode: 0o700 }),
    mkdir(join(durableDirectory, 'parent-intents'), { recursive: true, mode: 0o700 }),
    mkdir(join(durableDirectory, 'parent-chunks'), { recursive: true, mode: 0o700 }),
    mkdir(markerDirectory, { recursive: true, mode: 0o700 }),
  ])
  await symlink(sharedRuntimeRoot, join(runDirectory, 'data', 'runtimes'), 'dir')
  const context = await writeContext(workspace, task.context)
  const direct = {
    id: 'D1', arm: 'D', taskId: task.id, directory: directDirectory, durableDirectory: directDirectory,
    markerDirectory: directMarkers, gameId: task.id,
    publicPrompt: publicPrompt(task), publicPromptSha256: sha256Bytes(publicPrompt(task)),
    prompt: null, inputHashes: {}, autonomous: null,
  }
  const rlmTask = nativePrompt(task)
  const rlm = {
    id: 'S14', arm: 'S', taskId: task.id, gameId: task.id,
    runDirectory, durableDirectory, workspace, data: join(runDirectory, 'data'), markerDirectory,
    publicPromptSha256: sha256Bytes(publicPrompt(task)),
    prompt: { task: rlmTask, sha256: sha256Bytes(rlmTask) },
    inputHashes: { 'inputs/context.txt': context.sha256 },
    autonomous: {
      maxTurns: FIXED_LIMITS.autonomousMaxTurns,
      maxTokens: FIXED_LIMITS.autonomousMaxTokens,
      gate: gateCommand({ python: runtime.paths.python, script: gatePath, workspace }),
    },
  }
  await writeExclusiveJson(join(directMarkers, 'condition.json'), { formatVersion: FORMAT_VERSION, ...conditionSummary(direct) })
  await writeExclusiveJson(join(markerDirectory, 'condition.json'), { formatVersion: FORMAT_VERSION, ...conditionSummary(rlm) })
  return [direct, rlm]
}

/**
 * Make the 15-request Ledger show the accepted 506-call prefix without
 * inventing 506 synthetic durable request records.  D1 is separately limited
 * to one logical/physical request; S14 retains the native tree limit of 14.
 */
function qualityBudgetView(base, conditions) {
  const limits = new Map(conditions.map(condition => [condition.id, condition.id === 'D1' ? FIXED_LIMITS.directRequests : FIXED_LIMITS.rlmRequests]))
  const assertRun = runId => {
    if (!limits.has(runId)) fail('BQ_ARM_SCOPE', `unexpected run ${String(runId)}`)
    return limits.get(runId)
  }
  const countLogical = runId => [...base.calls.values()].filter(call => call.run === runId).length
  return {
    async admit(runId, request) {
      const limit = assertRun(runId)
      if (countLogical(runId) >= limit) fail('BQ_ARM_LIMIT', `${runId} would exceed its ${String(limit)} request limit`)
      return base.admit(runId, request)
    },
    admitPhysical({ runId, ...rest }) {
      const limit = assertRun(runId)
      if ((base.physicalByRun.get(runId) ?? 0) >= limit) fail('BQ_ARM_LIMIT', `${runId} would exceed its ${String(limit)} physical-request limit`)
      return base.admitPhysical({ runId, ...rest })
    },
    settle(...args) { return base.settle(...args) },
    appendSync(...args) { return base.appendSync(...args) },
    get stopped() { return base.stopped },
    get calls() { return base.calls },
    async receipt() {
      const receipt = await base.receipt()
      return {
        ...receipt,
        cumulativeAdmitted: FIXED_LIMITS.priorCharged + receipt.newAdmitted,
        cumulativeConfirmed: FIXED_LIMITS.priorConfirmed + receipt.settled,
        cumulativeUnknown: FIXED_LIMITS.priorUnknown + receipt.unknown,
        budgets: { D1: FIXED_LIMITS.directRequests, S14: FIXED_LIMITS.rlmRequests },
      }
    },
  }
}

/** Create the immutable no-provider preparation. */
export async function preparePanel({
  output = DEFAULT_OUTPUT,
  tmpRoot = DEFAULT_TMP_ROOT,
  taskPath,
  priorRoot = DEFAULT_PRIOR_ROOT,
  priorClosureSha256 = DEFAULT_PRIOR_CLOSURE_SHA256,
  sourceRoot = REPOSITORY_ROOT,
  packageRoot,
  taskLoader = loadTask,
  compiler = compileCurrentSources,
  runtimePreparer = prepareSharedRuntime,
} = {}) {
  const source = await assertDirectory(sourceRoot, 'sourceRoot')
  const prior = await validatePriorPhase({ priorRoot, expectedClosureSha256: priorClosureSha256 })
  const targetOutput = await assertOutputScope({ output, priorRoot: prior.root })
  const taskFile = await assertRegularFile(taskPath, 'private task artifact')
  if (isWithin(targetOutput, taskFile)) fail('BQ_TASK_SCOPE', 'private task artifact must not be inside the worker output namespace')
  const task = requireTask(await taskLoader(taskFile))
  if (task.artifactSha256 !== undefined && task.artifactSha256 !== await sha256File(taskFile)) fail('BQ_TASK_HASH', 'task loader artifact hash differs from task bytes')
  const scorerPath = await assertRegularFile(task.scorer.path, 'official scorer')
  const scorerSha256 = await sha256File(scorerPath)
  if (scorerSha256 !== task.scorer.sha256.toLowerCase()) fail('BQ_SCORER_HASH', 'official scorer bytes differ from the task pin')
  const packageDirectory = await assertDirectory(packageRoot ?? join(source, 'incubator/rlm'), 'packageRoot')
  const temporaryRoot = await createFreshTmpRoot(tmpRoot, { priorRoot: prior.root })
  await mkdir(targetOutput, { recursive: false, mode: 0o700 })
  const parentPrivate = join(targetOutput, 'parent-private')
  const shared = join(temporaryRoot, 'shared')
  await Promise.all([mkdir(parentPrivate, { recursive: true, mode: 0o700 }), mkdir(shared, { recursive: true, mode: 0o700 })])

  const sharedCompile = await compiler({ sourceRoot: source, packageRoot: packageDirectory, shared })
  if (!isRecord(sharedCompile) || typeof sharedCompile.compiled !== 'string' || !isRecord(sharedCompile.outputs) || !SHA256.test(sharedCompile.hash ?? '')) {
    fail('BQ_COMPILE', 'compiler returned an invalid compiled artifact manifest')
  }
  const runtime = await runtimePreparer({ compiled: sharedCompile.compiled, packageRoot: packageDirectory, shared })
  if (!isRecord(runtime) || !isRecord(runtime.paths) || typeof runtime.paths.python !== 'string' || !isRecord(runtime.manifest)
    || typeof runtime.runtimes !== 'string' || !SHA256.test(runtime.manifest.sha256 ?? '')) {
    fail('BQ_RUNTIME', 'runtime preparer returned an invalid runtime manifest')
  }
  await assertDirectory(runtime.runtimes, 'shared runtime directory')
  const workerSource = await assertRegularFile(join(source, 'tools/rlm-arc-pilot/native-worker.mjs'), 'native worker source')
  const workerPath = join(shared, 'worker.mjs')
  await copyFile(workerSource, workerPath, fsConstants.COPYFILE_EXCL)
  const gatePath = join(shared, 'check-answer.py')
  await writeFile(gatePath, publicGateScript(), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const conditions = await createConditions({ output: targetOutput, tmpRoot: temporaryRoot, sharedRuntimeRoot: runtime.runtimes, runtime, gatePath, task })
  const ledgerPath = join(targetOutput, 'provider-ledger.jsonl')
  const ledger = await Ledger.open(ledgerPath, { total: FIXED_LIMITS.newPhaseRequests, perRun: FIXED_LIMITS.perRunRequests })
  const freshLedger = await ledger.receipt()
  if (freshLedger.newAdmitted !== 0 || freshLedger.priorAdmitted !== 0 || freshLedger.stopped) fail('BQ_LEDGER_FRESH', 'new quality ledger must start with no admissions')

  const runnerPath = fileURLToPath(import.meta.url)
  const taskModulePath = join(source, 'tools/rlm-quality-pilot/task.mjs')
  const manifest = {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-bare-quality-prepared-v1',
    preparedAt: new Date().toISOString(),
    output: targetOutput,
    tmpRoot: temporaryRoot,
    parentPrivate,
    prior: {
      root: prior.root,
      closure: { path: prior.closure.path, sha256: prior.closure.sha256 },
      artifacts: prior.artifacts,
      charged: FIXED_LIMITS.priorCharged,
      confirmed: FIXED_LIMITS.priorConfirmed,
      unknown: FIXED_LIMITS.priorUnknown,
    },
    sourceHead: await gitHead(source),
    runner: { path: runnerPath, sha256: await sha256File(runnerPath), sourceRoot: source },
    execution: await executionHashes(source),
    package: {
      root: packageDirectory,
      runtimeManifest: { path: runtime.manifest.path, sha256: runtime.manifest.sha256 },
    },
    shared: {
      path: shared,
      compiled: { path: sharedCompile.compiled, outputs: sharedCompile.outputs, hash: sharedCompile.hash },
      runtime,
      worker: { path: workerPath, sha256: await sha256File(workerPath) },
      gate: { path: gatePath, sha256: await sha256File(gatePath) },
    },
    task: {
      path: taskFile,
      sha256: await sha256File(taskFile),
      id: task.id,
      answerType: task.answerType,
      sourceSha256: canonicalHash(task.source),
      contextSha256: sha256Bytes(task.context),
      questionSha256: sha256Bytes(task.question),
      publicPromptSha256: sha256Bytes(publicPrompt(task)),
    },
    scorer: {
      adapterPath: taskModulePath,
      adapterSha256: await sha256File(await assertRegularFile(taskModulePath, 'task/scorer adapter')),
      path: scorerPath,
      sha256: scorerSha256,
      commit: task.scorer.commit ?? null,
    },
    protectedRoots: [...new Set([parentPrivate, dirname(taskFile), dirname(scorerPath)])],
    ledger: { path: ledgerPath, total: FIXED_LIMITS.newPhaseRequests, perRun: FIXED_LIMITS.perRunRequests },
    route: { ...FIXED_ROUTE },
    limits: { ...FIXED_LIMITS },
    conditions,
    sideEffects: { providerLoaded: false, credentialRead: false, modelCalls: 0, network: false },
  }
  manifest.fingerprint = manifestFingerprint(manifest)
  await writeExclusiveJson(join(targetOutput, PREPARED_FILE), manifest)
  return manifest
}

async function readPreparedManifest(output = DEFAULT_OUTPUT) {
  const root = await assertDirectory(output, 'output')
  const path = await assertRegularFile(join(root, PREPARED_FILE), 'prepared manifest')
  const manifest = await readJson(path, 'prepared manifest')
  if (!isRecord(manifest) || manifest.formatVersion !== FORMAT_VERSION || manifest.kind !== 'prime-rlm-bare-quality-prepared-v1' || manifest.output !== root) {
    fail('BQ_PREPARED_FORMAT', 'prepared manifest has an unsupported format or scope')
  }
  return { root, path, manifest }
}

async function assertCompiledOutputs(manifest) {
  if (!isRecord(manifest.shared?.compiled?.outputs)) fail('BQ_FINGERPRINT_COMPILED', 'compiled output map is missing')
  const outputs = {}
  for (const [name, expected] of Object.entries(manifest.shared.compiled.outputs)) {
    if (!isRecord(expected) || !SHA256.test(expected.sha256 ?? '') || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) {
      fail('BQ_FINGERPRINT_COMPILED', `invalid compiled output metadata for ${name}`)
    }
    const path = resolve(manifest.shared.compiled.path, name)
    if (!isWithin(manifest.shared.compiled.path, path)) fail('BQ_FINGERPRINT_COMPILED', `compiled output escapes its directory: ${name}`)
    const info = await stat(path)
    const sha256 = await sha256File(path)
    if (sha256 !== expected.sha256 || info.size !== expected.bytes) fail('BQ_FINGERPRINT_COMPILED', `compiled output changed: ${name}`)
    outputs[name] = { sha256, bytes: info.size }
  }
  if (canonicalHash(outputs) !== manifest.shared.compiled.hash) fail('BQ_FINGERPRINT_COMPILED', 'compiled aggregate hash changed')
}

function taskMatchesManifest(task, manifest) {
  return task.id === manifest.task.id
    && task.answerType === manifest.task.answerType
    && canonicalHash(task.source) === manifest.task.sourceSha256
    && sha256Bytes(task.context) === manifest.task.contextSha256
    && sha256Bytes(task.question) === manifest.task.questionSha256
    && sha256Bytes(publicPrompt(task)) === manifest.task.publicPromptSha256
    && task.scorer.path === manifest.scorer.path
    && task.scorer.sha256 === manifest.scorer.sha256
}

/** Recheck every byte that can affect a paid D1 or S14 request. */
export async function assertPreparedFingerprint(manifest, { taskLoader = loadTask } = {}) {
  if (!isRecord(manifest)) fail('BQ_PREPARED_FORMAT', 'prepared manifest must be an object')
  const source = await assertDirectory(manifest.runner?.sourceRoot, 'prepared source root')
  const expectedOutput = join(await assertDirectory(manifest.prior?.root, 'prepared prior root'), 'bare-quality-v1')
  if (manifest.output !== expectedOutput) fail('BQ_OUTPUT_SCOPE', 'prepared output is not the fixed one-shot namespace')
  const prior = await validatePriorPhase({
    priorRoot: manifest.prior.root,
    closurePath: manifest.prior?.closure?.path,
    expectedClosureSha256: manifest.prior?.closure?.sha256,
  })
  if (canonicalHash(prior.artifacts) !== canonicalHash(manifest.prior.artifacts)) fail('BQ_PRIOR_REFERENCE', 'prior closure references changed since preparation')
  if (manifest.sourceHead !== await gitHead(source)) fail('BQ_FINGERPRINT_SOURCE_HEAD', 'source HEAD changed since preparation')
  if (await sha256File(manifest.runner.path) !== manifest.runner.sha256) fail('BQ_FINGERPRINT_RUNNER', 'runner bytes changed since preparation')
  assertExactHashMap(await executionHashes(source), manifest.execution, 'execution sources')
  if (await sha256File(manifest.package.runtimeManifest.path) !== manifest.package.runtimeManifest.sha256
    || manifest.package.runtimeManifest.sha256 !== manifest.shared.runtime.manifest.sha256) {
    fail('BQ_FINGERPRINT_RUNTIME', 'runtime manifest changed since preparation')
  }
  await assertCompiledOutputs(manifest)
  if (await sha256File(manifest.shared.worker.path) !== manifest.shared.worker.sha256) fail('BQ_FINGERPRINT_WORKER', 'copied native worker changed since preparation')
  if (await sha256File(manifest.shared.gate.path) !== manifest.shared.gate.sha256) fail('BQ_FINGERPRINT_GATE', 'public output gate changed since preparation')
  const taskFile = await assertRegularFile(manifest.task.path, 'private task artifact')
  if (await sha256File(taskFile) !== manifest.task.sha256) fail('BQ_FINGERPRINT_TASK', 'private task bytes changed since preparation')
  if (await sha256File(manifest.scorer.adapterPath) !== manifest.scorer.adapterSha256
    || await sha256File(manifest.scorer.path) !== manifest.scorer.sha256) {
    fail('BQ_FINGERPRINT_SCORER', 'task adapter or official scorer bytes changed since preparation')
  }
  const task = requireTask(await taskLoader(taskFile))
  if (!taskMatchesManifest(task, manifest)) fail('BQ_FINGERPRINT_TASK', 'loaded task public fields or scorer pin changed since preparation')
  const rlm = manifest.conditions?.find(condition => condition?.id === 'S14')
  const direct = manifest.conditions?.find(condition => condition?.id === 'D1')
  if (!rlm || !direct || manifest.conditions.length !== 2 || rlm.arm !== 'S' || direct.arm !== 'D') fail('BQ_FINGERPRINT_CONDITIONS', 'prepared panel must contain only D1 and S14')
  if (direct.publicPromptSha256 !== manifest.task.publicPromptSha256 || rlm.publicPromptSha256 !== manifest.task.publicPromptSha256
    || direct.publicPrompt !== publicPrompt(task) || rlm.prompt?.task !== nativePrompt(task)) {
    fail('BQ_FINGERPRINT_PROMPT', 'public task or native wrapper changed since preparation')
  }
  const contextPath = resolve(rlm.workspace, 'inputs/context.txt')
  if (!isWithin(rlm.workspace, contextPath) || await sha256File(contextPath) !== rlm.inputHashes?.['inputs/context.txt']) {
    fail('BQ_FINGERPRINT_INPUTS', 'native public context bytes changed since preparation')
  }
  if (manifestFingerprint(manifest) !== manifest.fingerprint) fail('BQ_FINGERPRINT_MANIFEST', 'prepared manifest is not self-consistent')
  return { source, task, prior }
}

export async function assertPanelNotStarted(output = DEFAULT_OUTPUT) {
  const root = await assertDirectory(output, 'output')
  if (await exists(join(root, RUN_START_FILE))) fail('BQ_RUN_ALREADY_STARTED', 'real panel has a durable start marker; never replay it')
}

function assertRunArguments({ providerModule, providerSha256, providerPackage, credentialFile, acceptanceArtifact, acceptanceSha256, nativeProof } = {}) {
  if (typeof providerModule !== 'string' || !isAbsolute(providerModule)
    || typeof credentialFile !== 'string' || !isAbsolute(credentialFile)
    || typeof providerPackage !== 'string' || providerPackage.trim().length === 0
    || !SHA256.test(providerSha256 ?? '') || typeof acceptanceArtifact !== 'string' || !isAbsolute(acceptanceArtifact)
    || !SHA256.test(acceptanceSha256 ?? '') || typeof nativeProof !== 'string' || !isAbsolute(nativeProof)) {
    fail('BQ_RUN_ARGS', '--run requires provider module/hash/package, credential file, acceptance artifact/hash, and native proof')
  }
}

function assertRealRunRuntime() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node.split('.')[0] !== '22'
    || process.env.NO_PROXY !== 'chatgpt.com' || dns.getDefaultResultOrder() !== 'ipv4first'
    || net.getDefaultAutoSelectFamily() !== false) {
    fail('BQ_NETWORK_PROFILE', 'real run requires Node 22/macOS arm64, NO_PROXY=chatgpt.com, ipv4first, and autoSelectFamily=false')
  }
}

async function assertNativeProof({ nativeProof, expectedSha256, sourceRoot, manifest }) {
  const path = await assertRegularFile(nativeProof, 'native proof')
  const actualSha256 = await sha256File(path)
  if (actualSha256 !== requireSha256(expectedSha256, 'native proof SHA-256', 'BQ_ACCEPTANCE_NATIVE')) {
    fail('BQ_ACCEPTANCE_NATIVE', 'native proof SHA-256 differs from acceptance')
  }
  const proof = await readJson(path, 'native proof')
  if (!isRecord(proof) || proof.accepted !== true || proof.realModelRequests !== 0 || !isRecord(proof.sourceHashes)) {
    fail('BQ_ACCEPTANCE_NATIVE', 'native proof does not show an accepted zero-model mechanism check')
  }
  if (proof.compiledHash !== manifest.shared.compiled.hash
    || proof.runtimeManifestSha256 !== manifest.shared.runtime.manifest.sha256) {
    fail('BQ_ACCEPTANCE_NATIVE', 'native proof is not bound to this compiled runtime')
  }
  for (const name of NATIVE_PROOF_FILES) {
    const expected = proof.sourceHashes[name]
    const actual = await sha256File(await assertRegularFile(join(sourceRoot, name), name))
    if (expected !== actual) fail('BQ_ACCEPTANCE_NATIVE', `native proof source hash differs from current ${name}`)
  }
  return { path, sha256: actualSha256, proof }
}

/** All acceptance gates run before a provider module or credential file is inspected. */
export async function assertRunPreflight({
  output = DEFAULT_OUTPUT,
  acceptanceArtifact,
  acceptanceSha256,
  nativeProof,
  taskLoader = loadTask,
} = {}) {
  const { root, path, manifest } = await readPreparedManifest(output)
  const prepared = await assertPreparedFingerprint(manifest, { taskLoader })
  await assertPanelNotStarted(root)
  const acceptancePath = await assertRegularFile(acceptanceArtifact, 'acceptance artifact')
  const actualAcceptanceSha256 = await sha256File(acceptancePath)
  if (actualAcceptanceSha256 !== requireSha256(acceptanceSha256, '--acceptance-sha256', 'BQ_ACCEPTANCE_HASH')) {
    fail('BQ_ACCEPTANCE_HASH', 'acceptance artifact SHA-256 differs')
  }
  const acceptance = await readJson(acceptancePath, 'acceptance artifact')
  if (!isRecord(acceptance) || acceptance.formatVersion !== 1 || acceptance.kind !== 'bare-quality-acceptance-v1'
    || acceptance.accepted !== true || acceptance.manifestFingerprint !== manifest.fingerprint
    || acceptance.runnerSha256 !== manifest.runner.sha256 || !SHA256.test(acceptance.nativeProofSha256 ?? '')) {
    fail('BQ_ACCEPTANCE_GATE', 'acceptance artifact does not bind this prepared quality panel')
  }
  const proof = await assertNativeProof({ nativeProof, expectedSha256: acceptance.nativeProofSha256, sourceRoot: prepared.source, manifest })
  return { root, preparedPath: path, manifest, task: prepared.task, acceptance: { path: acceptancePath, sha256: actualAcceptanceSha256, value: acceptance, nativeProof: proof } }
}

function parseAnswerText(text) {
  try {
    const value = JSON.parse(text)
    if (!isRecord(value) || Object.keys(value).length !== 1 || !own(value, 'answer') || typeof value.answer !== 'string') {
      return { ok: false, error: 'answer.json must be exactly {answer:string}' }
    }
    return { ok: true, answer: value.answer }
  } catch (error) {
    return { ok: false, error: `answer.json is not valid JSON: ${redact(errorText(error))}` }
  }
}

function schemaOnlyGrade(_task, text) {
  const parsed = parseAnswerText(text)
  return { score: null, exact: null, schemaValid: parsed.ok, errors: parsed.ok ? [] : [parsed.error] }
}

function safeGradeSummary(grade) {
  if (!isRecord(grade)) return { score: null, exact: null, error: 'official scorer returned an invalid result' }
  return {
    score: typeof grade.score === 'number' && Number.isFinite(grade.score) ? grade.score : null,
    primaryScore: typeof grade.primaryScore === 'number' && Number.isFinite(grade.primaryScore) ? grade.primaryScore : null,
    exact: typeof grade.exact === 'boolean' ? grade.exact : null,
    attemptedParse: typeof grade.attemptedParse === 'string' ? grade.attemptedParse : null,
    parseConfidence: (typeof grade.parseConfidence === 'number' && Number.isFinite(grade.parseConfidence)) || typeof grade.parseConfidence === 'string'
      ? grade.parseConfidence : null,
    scorerSha256: typeof grade.scorerSha256 === 'string' ? grade.scorerSha256 : null,
  }
}

async function gradeAnswer(task, rawText, taskGrader) {
  const parsed = parseAnswerText(rawText)
  if (!parsed.ok) return { score: null, primaryScore: null, exact: null, schemaValid: false, errors: [parsed.error] }
  try {
    return { ...safeGradeSummary(await taskGrader(task, parsed.answer)), schemaValid: true, errors: [] }
  } catch (error) {
    return { score: null, primaryScore: null, exact: null, schemaValid: true, errors: [`official scorer failed: ${redact(errorText(error))}`] }
  }
}

async function gradeDirectAnswer(task, rawText, taskGrader) {
  if (typeof rawText !== 'string') return { score: null, primaryScore: null, exact: null, schemaValid: false, errors: ['bare assistant text is unavailable'] }
  try {
    return { ...safeGradeSummary(await taskGrader(task, rawText)), schemaValid: true, errors: [] }
  } catch (error) {
    return { score: null, primaryScore: null, exact: null, schemaValid: false, errors: [`official scorer failed: ${redact(errorText(error))}`] }
  }
}

async function* capturedStream(chunks) {
  yield* chunks
}

async function loadCompiledModelWire(compiled) {
  const path = await assertRegularFile(join(compiled, 'model-wire.mjs'), 'compiled model wire')
  const wire = await import(pathToFileURL(path).href)
  if (typeof wire.encodeChatStream !== 'function') fail('BQ_MODEL_WIRE', 'compiled model wire lacks encodeChatStream')
  return wire
}

/** Bare D1: one user message, no system prompt, no tools, and full stream EOF. */
export async function executeDirectCondition({
  manifest,
  condition,
  provider,
  relay,
  ledger,
  modelWireLoader = loadCompiledModelWire,
} = {}) {
  if (!isRecord(manifest) || condition?.id !== 'D1' || !provider || !relay || !ledger) fail('BQ_D_ARGS', 'D1 requires prepared manifest, provider, relay, and ledger')
  const startedAt = Date.now()
  const base = createModelDispatcher({ condition, provider, relay, ledger })
  const dispatcher = serializeDispatcher(base)
  const options = {
    ...FIXED_ROUTE,
    messages: [{ role: 'user', content: condition.publicPrompt }],
  }
  const chunks = []
  let answerText = null
  let runError = null
  let deadlineExpired = false
  const deadline = setTimeout(() => {
    deadlineExpired = true
    void dispatcher.abortAll('parent wall-time deadline').catch(() => undefined)
  }, FIXED_LIMITS.wallTimeMs)
  deadline.unref()
  try {
    for await (const chunk of dispatcher.call('D1-root', options)) chunks.push(chunk)
    // The provider stream is now at EOF.  Only then may the compiled wire
    // assembler derive the authoritative final assistant message.
    const wire = await modelWireLoader(manifest.shared.compiled.path)
    let finished
    for await (const _line of wire.encodeChatStream(capturedStream(chunks), {
      id: 'bare-quality-D1',
      model: FIXED_ROUTE.model,
      onFinish: value => {
        if (finished !== undefined) fail('BQ_D_FINISH', 'bare stream produced more than one finish')
        finished = value
      },
    })) { /* Encoding verifies the captured terminal stream; it executes no tool. */ }
    if (!isRecord(finished?.message)) fail('BQ_D_FINISH', 'bare stream has no authoritative assistant message')
    if (Array.isArray(finished.message.tool_calls) && finished.message.tool_calls.length > 0) {
      fail('BQ_D_TOOLS', 'bare condition returned tool calls; tools are never executed in D1')
    }
    if (typeof finished.message.content !== 'string') fail('BQ_D_OUTPUT', 'bare assistant finish has no text answer')
    answerText = finished.message.content
  } catch (error) {
    runError = redact(errorText(error))
  } finally {
    clearTimeout(deadline)
  }
  const receipt = await ledger.receipt()
  const resources = summarizeConditionResources(receipt, condition.id, Date.now() - startedAt)
  return {
    condition: { id: condition.id, arm: condition.arm, taskId: condition.taskId },
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    answer: { present: typeof answerText === 'string', sha256: typeof answerText === 'string' ? sha256Bytes(answerText) : null, error: runError },
    answerText,
    resources,
    observed: { childModelRequestCount: 0, rootModelRequestCount: resources.modelRequests, recursionObserved: false, noToolsExecuted: true, streamChunks: chunks.length },
    executionCompleted: runError === null && !deadlineExpired && typeof answerText === 'string',
    cleanupComplete: runError === null && !deadlineExpired,
  }
}

function publicNativeTask(task) {
  return { id: task.id, inputFiles: { 'inputs/context.txt': task.context }, instruction: task.question }
}

async function attachOfficialGrade(outcome, task, taskGrader, answerText) {
  const raw = typeof answerText === 'string' ? answerText : null
  outcome.grading = raw === null
    ? { score: null, primaryScore: null, exact: null, schemaValid: false, errors: ['answer output is unavailable'] }
    : await gradeAnswer(task, raw, taskGrader)
  return outcome
}

function conditionResult(condition, outcome) {
  const completed = outcome.executionCompleted === true && outcome.cleanupComplete === true && outcome.grading?.schemaValid === true
  return {
    formatVersion: FORMAT_VERSION,
    condition: { id: condition.id, arm: condition.arm, taskId: condition.taskId },
    status: completed ? 'completed' : 'incomplete',
    ...outcome,
    executionCompleted: outcome.executionCompleted === true,
    cleanupComplete: outcome.cleanupComplete === true,
  }
}

function parentFailure(condition, error, ledger) {
  return (async () => {
    let resources
    try { resources = summarizeConditionResources(await ledger.receipt(), condition.id, null) } catch (receiptError) {
      resources = { modelRequests: null, physicalModelRequests: null, confirmedModelRequests: null, unknownModelRequests: null, knownUsageTotals: { inputTokens: null, outputTokens: null, totalTokens: null }, accountingError: redact(errorText(receiptError)) }
    }
    return {
      condition: { id: condition.id, arm: condition.arm, taskId: condition.taskId },
      completedAt: new Date().toISOString(),
      answer: { present: false, sha256: null, error: redact(errorText(error)) },
      resources,
      observed: { childModelRequestCount: 0, rootModelRequestCount: null, recursionObserved: false },
      executionCompleted: false,
      cleanupComplete: false,
    }
  })()
}

/** The sole real-provider entry point.  It has no retry or fallback path. */
export async function runPanel({
  output = DEFAULT_OUTPUT,
  providerModule,
  providerSha256,
  providerPackage,
  credentialFile,
  acceptanceArtifact,
  acceptanceSha256,
  nativeProof,
  taskLoader = loadTask,
  taskGrader = gradeTask,
  providerLoader = loadRealProvider,
  relayFactory = createAttachmentRelay,
  directExecutor = executeDirectCondition,
  nativeExecutor = executeCondition,
  modelWireLoader = loadCompiledModelWire,
  networkProfileInstaller = installNoReuseProfile,
  runtimeAssert = assertRealRunRuntime,
} = {}) {
  const preflight = await assertRunPreflight({ output, acceptanceArtifact, acceptanceSha256, nativeProof, taskLoader })
  assertRunArguments({ providerModule, providerSha256, providerPackage, credentialFile, acceptanceArtifact, acceptanceSha256, nativeProof })
  runtimeAssert()
  const { root, manifest, task, acceptance } = preflight
  await writeExclusiveJson(join(root, RUN_START_FILE), {
    formatVersion: FORMAT_VERSION,
    startedAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    acceptance: { path: acceptance.path, sha256: acceptance.sha256, nativeProof: { path: acceptance.nativeProof.path, sha256: acceptance.nativeProof.sha256 } },
    provider: { moduleSha256: providerSha256.toLowerCase(), package: providerPackage },
  })

  let baseLedger
  let ledger
  let provider
  let relay
  let networkProfile
  let panelError = null
  const results = []
  const closes = {}
  const originalFetch = globalThis.fetch
  try {
    baseLedger = await Ledger.open(manifest.ledger.path, { total: FIXED_LIMITS.newPhaseRequests, perRun: FIXED_LIMITS.perRunRequests })
    const initial = await baseLedger.receipt()
    if (initial.newAdmitted !== 0 || initial.priorAdmitted !== 0 || initial.stopped) fail('BQ_LEDGER_STARTED', 'prepared quality ledger is not fresh')
    ledger = qualityBudgetView(baseLedger, manifest.conditions)
    networkProfile = networkProfileInstaller({
      baseFetch: originalFetch,
      onDiagnostic: event => baseLedger.appendSync({ type: 'network-diagnostic', event }),
    })
    globalThis.fetch = networkProfile.fetch
    relay = await relayFactory({ sourceRoot: manifest.runner.sourceRoot, dataRoot: join(root, 'attachments') })
    provider = await providerLoader({
      providerModule,
      providerSha256,
      providerPackage,
      credentialFile,
      dataRoot: join(root, 'provider-private'),
      sourceRoot: manifest.runner.sourceRoot,
      maxModelRequests: FIXED_LIMITS.newPhaseRequests,
      attachments: relay.store,
      onPhysical: () => fail('BQ_PHYSICAL_SCOPE', 'provider physical request occurred outside D1 or S14 dispatcher'),
      onTransportEvent: event => baseLedger.appendSync({ type: 'transport-event', event }),
    })
    for (const condition of manifest.conditions) {
      if (ledger.stopped) break
      const markerPath = join(condition.markerDirectory, 'real-condition-started.json')
      const resultPath = join(condition.markerDirectory, 'result.json')
      if (await exists(markerPath) || await exists(resultPath)) fail('BQ_CONDITION_REPLAY', `condition ${condition.id} already has a durable marker`)
      await writeExclusiveJson(markerPath, { formatVersion: FORMAT_VERSION, fingerprint: manifest.fingerprint, id: condition.id, arm: condition.arm, startedAt: new Date().toISOString() })
      let outcome
      try {
        if (condition.id === 'D1') {
          outcome = await directExecutor({ manifest, condition, provider, relay, ledger, modelWireLoader })
          if (typeof outcome.answerText === 'string') {
            const rawPath = join(manifest.parentPrivate, 'D1-answer.txt')
            await writeExclusiveText(rawPath, outcome.answerText)
            outcome.answer.parentPrivatePath = rawPath
          }
          outcome.grading = await gradeDirectAnswer(task, outcome.answerText, taskGrader)
          delete outcome.answerText
        } else {
          outcome = await nativeExecutor({
            manifest,
            condition,
            provider,
            ledger,
            relay,
            task: publicNativeTask(task),
            grade: schemaOnlyGrade,
            protectedRoots: [...manifest.protectedRoots, dirname(requireAbsolute(credentialFile, 'credentialFile'))],
          })
          let raw = null
          try { raw = await readFile(join(condition.workspace, 'answer.json'), 'utf8') } catch { /* outcome has the independent missing-output evidence. */ }
          await attachOfficialGrade(outcome, task, taskGrader, raw)
        }
      } catch (error) {
        outcome = await parentFailure(condition, error, ledger)
        await attachOfficialGrade(outcome, task, taskGrader, null)
      }
      const recorded = conditionResult(condition, outcome)
      await writeExclusiveJson(resultPath, recorded)
      results.push(recorded)
      if (!recorded.cleanupComplete || ledger.stopped) break
    }
  } catch (error) {
    panelError = redact(errorText(error))
  } finally {
    try { await provider?.close?.(); closes.provider = provider ? 'closed' : 'not-loaded' } catch (error) { closes.provider = redact(errorText(error)); panelError ??= `provider close: ${closes.provider}` }
    try { await relay?.close?.(); closes.relay = relay ? 'closed' : 'not-created' } catch (error) { closes.relay = redact(errorText(error)); panelError ??= `relay close: ${closes.relay}` }
    try { networkProfile?.dispose?.(); closes.networkProfile = networkProfile ? 'disposed' : 'not-installed' } catch (error) { closes.networkProfile = redact(errorText(error)); panelError ??= `network profile dispose: ${closes.networkProfile}` }
    globalThis.fetch = originalFetch
  }
  const accounting = ledger ? await ledger.receipt() : baseLedger ? await baseLedger.receipt() : null
  const receipt = {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-bare-quality-run-v1',
    completedAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    providerLoaded: provider !== undefined,
    results: results.map(result => ({ condition: result.condition, status: result.status, grading: result.grading, resources: result.resources, observed: result.observed, executionCompleted: result.executionCompleted, cleanupComplete: result.cleanupComplete })),
    accounting: accounting ? {
      newAdmitted: accounting.newAdmitted,
      settled: accounting.settled,
      unknown: accounting.unknown,
      physicalAdmitted: accounting.physicalAdmitted,
      cumulativeAdmitted: accounting.cumulativeAdmitted ?? FIXED_LIMITS.priorCharged + accounting.newAdmitted,
      cumulativeConfirmed: accounting.cumulativeConfirmed ?? FIXED_LIMITS.priorConfirmed + accounting.settled,
      cumulativeUnknown: accounting.cumulativeUnknown ?? FIXED_LIMITS.priorUnknown + accounting.unknown,
      stopped: accounting.stopped,
      budgets: { D1: FIXED_LIMITS.directRequests, S14: FIXED_LIMITS.rlmRequests },
    } : null,
    closes,
    error: panelError,
  }
  await writeExclusiveJson(join(root, RUN_RECEIPT_FILE), receipt)
  if (panelError) throw failure('BQ_RUN_STOPPED', panelError)
  return receipt
}

async function readConditionResult(condition) {
  const path = join(condition.markerDirectory, 'result.json')
  if (!await exists(path)) return { condition: { id: condition.id, arm: condition.arm, taskId: condition.taskId }, status: 'not-run', grading: { score: null, exact: null }, resources: null, observed: { childModelRequestCount: 0 }, executionCompleted: false, cleanupComplete: false }
  try {
    const result = await readJson(path, `result for ${condition.id}`)
    return { ...result, status: result.status === 'completed' ? 'completed' : 'incomplete' }
  } catch (error) {
    return { condition: { id: condition.id, arm: condition.arm, taskId: condition.taskId }, status: 'incomplete', grading: { score: null, exact: null, errors: [redact(errorText(error))] }, resources: null, observed: { childModelRequestCount: 0 }, executionCompleted: false, cleanupComplete: false }
  }
}

function totalResources(cells) {
  const keys = ['modelRequests', 'physicalModelRequests', 'confirmedModelRequests', 'unknownModelRequests']
  const total = {}
  for (const key of keys) total[key] = cells.reduce((sum, cell) => sum + (Number.isSafeInteger(cell.resources?.[key]) ? cell.resources[key] : 0), 0)
  const token = field => {
    const values = cells.map(cell => cell.resources?.knownUsageTotals?.[field]).filter(value => typeof value === 'number' && Number.isFinite(value))
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null
  }
  return { ...total, knownUsageTotals: { inputTokens: token('inputTokens'), outputTokens: token('outputTokens'), totalTokens: token('totalTokens') } }
}

/** Produce a derived report only; it never loads a provider or raw private gold. */
export async function analyzePanel({ output = DEFAULT_OUTPUT } = {}) {
  const { root, manifest } = await readPreparedManifest(output)
  const cells = []
  for (const condition of manifest.conditions) cells.push(await readConditionResult(condition))
  let accounting
  try {
    const base = await Ledger.open(manifest.ledger.path, { total: FIXED_LIMITS.newPhaseRequests, perRun: FIXED_LIMITS.perRunRequests })
    const receipt = await qualityBudgetView(base, manifest.conditions).receipt()
    accounting = {
      historical: { charged: FIXED_LIMITS.priorCharged, confirmed: FIXED_LIMITS.priorConfirmed, unknown: FIXED_LIMITS.priorUnknown },
      new: { admitted: receipt.newAdmitted, confirmed: receipt.settled, unknown: receipt.unknown, physicalAdmitted: receipt.physicalAdmitted },
      cumulative: { charged: receipt.cumulativeAdmitted, confirmed: receipt.cumulativeConfirmed, unknown: receipt.cumulativeUnknown, cap: FIXED_LIMITS.globalCap, withinCap: receipt.cumulativeAdmitted <= FIXED_LIMITS.globalCap },
      stopped: receipt.stopped,
    }
  } catch (error) { accounting = { error: redact(errorText(error)) } }
  const direct = cells.find(cell => cell.condition?.id === 'D1')
  const rlm = cells.find(cell => cell.condition?.id === 'S14')
  const directScore = typeof direct?.grading?.score === 'number' ? direct.grading.score : null
  const rlmScore = typeof rlm?.grading?.score === 'number' ? rlm.grading.score : null
  const analysis = {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-bare-quality-analysis-v1',
    createdAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    denominator: { plannedConditions: 2, recordedConditions: cells.filter(cell => cell.status !== 'not-run').length, completedConditions: cells.filter(cell => cell.status === 'completed').length, failedOrIncompleteConditions: cells.filter(cell => cell.status === 'incomplete').length, notRunConditions: cells.filter(cell => cell.status === 'not-run').length },
    requestBudgets: { D1: FIXED_LIMITS.directRequests, S14: FIXED_LIMITS.rlmRequests },
    cells,
    fullTreeUsage: totalResources(cells),
    observedComparison: { directScore, rlmScore, rlmMinusDirect: directScore !== null && rlmScore !== null ? rlmScore - directScore : null, actualChildren: { D1: direct?.observed?.childModelRequestCount ?? 0, S14: rlm?.observed?.childModelRequestCount ?? 0 } },
    accounting,
    limitations: [
      'This report retains one D1/S14 task comparison and its full-tree resource records; fixture evidence alone makes no efficacy claim.',
      'D1 and S14 intentionally have unequal compute budgets (1 versus 14 model requests), as authorized for this quality-focused test.',
      'A numeric difference on one task is an observed result, not a general proof that Prime RLM improves model reasoning.',
    ],
  }
  await writeFile(join(root, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' })
  const rows = cells.map(cell => `| ${cell.condition.id} | ${cell.status} | ${cell.grading?.score ?? 'unknown'} | ${cell.grading?.exact ?? 'unknown'} | ${cell.observed?.childModelRequestCount ?? 0} | ${cell.resources?.modelRequests ?? 0} | ${cell.resources?.unknownModelRequests ?? 0} |`).join('\n')
  const markdown = [
    '# Bare model versus Prime RLM quality comparison',
    '',
    `Prepared fingerprint: \`${manifest.fingerprint}\``,
    '',
    `Denominator: 2 planned conditions; ${analysis.denominator.recordedConditions} recorded, ${analysis.denominator.completedConditions} complete, ${analysis.denominator.failedOrIncompleteConditions} incomplete, ${analysis.denominator.notRunConditions} not run.`,
    '',
    '| Arm | Status | Official score | Exact | Actual child requests | Full-tree model requests | Unknown requests |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: |',
    rows,
    '',
    `Request budgets: D1=${FIXED_LIMITS.directRequests}, S14=${FIXED_LIMITS.rlmRequests}. Observed S14 − D1 score: ${analysis.observedComparison.rlmMinusDirect ?? 'not comparable'}.`,
    '',
    accounting?.cumulative
      ? `Historical prefix: ${accounting.historical.charged} charged (${accounting.historical.confirmed} confirmed, ${accounting.historical.unknown} unknown). New admitted: ${accounting.new.admitted}; cumulative charged: ${accounting.cumulative.charged}/${accounting.cumulative.cap}; cumulative unknown: ${accounting.cumulative.unknown}.`
      : `Accounting unavailable: ${accounting?.error ?? 'unknown error'}.`,
    '',
    'This fixture/runner report makes no general efficacy claim. It preserves the one-task observed score, missing arm, failure, and full-tree usage facts.',
    '',
  ].join('\n')
  await writeFile(join(root, 'analysis.md'), markdown, { encoding: 'utf8', mode: 0o600, flag: 'w' })
  return analysis
}

export function parseArgs(argv) {
  const result = {
    mode: undefined,
    output: DEFAULT_OUTPUT,
    tmpRoot: DEFAULT_TMP_ROOT,
    taskPath: undefined,
    providerModule: undefined,
    providerSha256: undefined,
    providerPackage: undefined,
    credentialFile: undefined,
    acceptanceArtifact: undefined,
    acceptanceSha256: undefined,
    nativeProof: undefined,
  }
  const options = new Map([
    ['--output', 'output'], ['--tmp-root', 'tmpRoot'], ['--task', 'taskPath'],
    ['--provider-module', 'providerModule'], ['--provider-sha256', 'providerSha256'], ['--provider-package', 'providerPackage'], ['--credential-file', 'credentialFile'],
    ['--acceptance-artifact', 'acceptanceArtifact'], ['--acceptance-sha256', 'acceptanceSha256'], ['--native-proof', 'nativeProof'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--prepare' || value === '--run' || value === '--analyze') {
      if (result.mode !== undefined) fail('BQ_ARGS', 'choose exactly one of --prepare, --run, or --analyze')
      result.mode = value.slice(2)
      continue
    }
    const property = options.get(value)
    if (!property || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail('BQ_ARGS', `unknown or incomplete argument: ${String(value)}`)
    if (result[property] !== undefined && !['output', 'tmpRoot'].includes(property)) fail('BQ_ARGS', `duplicate argument: ${value}`)
    result[property] = argv[index + 1]
    index += 1
  }
  if (result.mode === undefined) fail('BQ_ARGS', 'choose exactly one of --prepare, --run, or --analyze')
  const runOnly = ['providerModule', 'providerSha256', 'providerPackage', 'credentialFile', 'acceptanceArtifact', 'acceptanceSha256', 'nativeProof']
  if (result.mode !== 'run' && runOnly.some(name => result[name] !== undefined)) fail('BQ_ARGS', 'provider, credential, and acceptance flags are only valid with --run')
  if (result.mode !== 'prepare' && (result.taskPath !== undefined || result.tmpRoot !== DEFAULT_TMP_ROOT)) fail('BQ_ARGS', '--task and --tmp-root are only valid with --prepare')
  if (result.mode === 'prepare' && result.taskPath === undefined) fail('BQ_ARGS', '--prepare requires --task <private-task-artifact>')
  return result
}

function usage() {
  return [
    'Usage:',
    '  /opt/homebrew/opt/node@22/bin/node tools/rlm-quality-pilot/run.mjs --prepare --task <private-task-artifact> [--output <fixed-bare-quality-v1>] [--tmp-root /private/tmp/bq1]',
    '  /opt/homebrew/opt/node@22/bin/node tools/rlm-quality-pilot/run.mjs --run --output <fixed-bare-quality-v1> --provider-module <private-module> --provider-sha256 <sha256> --provider-package <name> --credential-file <private-file> --acceptance-artifact <accepted-json> --acceptance-sha256 <sha256> --native-proof <accepted-native-json>',
    '  node tools/rlm-quality-pilot/run.mjs --analyze [--output <fixed-bare-quality-v1>]',
  ].join('\n')
}

function isDirectEntrypoint() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'prepare') {
    const manifest = await preparePanel(args)
    process.stdout.write(`${JSON.stringify({ mode: 'prepare', fingerprint: manifest.fingerprint, output: manifest.output })}\n`)
    return
  }
  if (args.mode === 'run') {
    const receipt = await runPanel(args)
    process.stdout.write(`${JSON.stringify({ mode: 'run', fingerprint: receipt.fingerprint, accounting: receipt.accounting })}\n`)
    return
  }
  const analysis = await analyzePanel({ output: args.output })
  process.stdout.write(`${JSON.stringify({ mode: 'analyze', fingerprint: analysis.fingerprint, denominator: analysis.denominator })}\n`)
}

if (isDirectEntrypoint()) {
  main().catch(error => {
    process.stderr.write(`${error?.stack ?? error?.message ?? error}\n${usage()}\n`)
    process.exitCode = 1
  })
}

export {
  DEFAULT_OUTPUT,
  DEFAULT_PRIOR_CLOSURE,
  DEFAULT_PRIOR_CLOSURE_SHA256,
  DEFAULT_PRIOR_ROOT,
  DEFAULT_TMP_ROOT,
  EXECUTION_FILES,
  FIXED_LIMITS,
  FIXED_ROUTE,
  NATIVE_PROOF_FILES,
  PREPARED_FILE,
  RUN_START_FILE,
  manifestFingerprint,
  qualityBudgetView,
  validatePriorPhase,
}
