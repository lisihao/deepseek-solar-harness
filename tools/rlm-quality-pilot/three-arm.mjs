#!/opt/homebrew/opt/node@22/bin/node

/**
 * One bounded, one-shot quality panel for the same public 32K OOLONG task:
 * D1 (bare model), R32 (original Prime), and S32 (Solar-hosted Prime).
 *
 * Preparation has no provider, credential, or network effects.  The run entry
 * point verifies every frozen byte and the zero-model native proof before it
 * asks the existing provider loader to inspect either a module or credentials.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  chmod,
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
import dns from 'node:dns'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  compileCurrentSources,
  loadRealProvider,
  prepareSharedRuntime,
} from '../rlm-arc-pilot/run.mjs'
import { createAttachmentRelay } from '../rlm-arc-pilot/attachment-relay.mjs'
import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { executeCondition } from '../rlm-recursion-pilot/run.mjs'
import { installNoReuseProfile } from '../rlm-recursion-pilot/network-profile.mjs'
import { executeDirectCondition } from './run.mjs'
import { createLongReadProfile } from './long-read.mjs'
import { gradeTask, loadTask } from './task.mjs'

const execFile = promisify(execFileCallback)
const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(TOOL_DIRECTORY, '../..')
const PREPARED_FILE = 'prepared.json'
const RUN_START_FILE = 'real-run-started.json'
const RUN_RECEIPT_FILE = 'final-receipt.json'
const PREFIX_ALLOCATION_FILE = 'quality-three-arm-v2-allocation.json'
const FORMAT_VERSION = 1
const SHA256 = /^[a-f0-9]{64}$/i
const TEMP_BASE = process.platform === 'darwin' ? '/private/tmp' : resolve(tmpdir())

export const FIXED_GUIDANCE = 'Work only from the provided data; do not look up dataset labels or benchmark answers elsewhere. Check every record rather than estimating from a sample. Work in disjoint batches, keep explicit per-record classifications and aggregate all batches. Use recursive subagents if they are available in your environment.'

export const FIXED_ROUTE = Object.freeze({
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  maxTokens: 16_384,
})

export const FIXED_LIMITS = Object.freeze({
  prefixAdmitted: 524,
  cumulativeCap: 600,
  newPhaseRequests: 65,
  directRequests: 1,
  nativeTreeRequests: 32,
  ledgerPerRun: 32,
  wallTimeMs: 1_200_000,
  autonomousMaxTurns: 32,
  autonomousMaxTokens: 4_000_000,
})

/**
 * These are the exact source files whose bytes the keyless native proof binds.
 * Package source, lockfile, compiled outputs, and the runtime manifest are
 * separately bound in the prepared manifest because they are trees/artifacts.
 */
export const REQUIRED_SOURCE_FILES = Object.freeze([
  'tools/rlm-quality-pilot/three-arm.mjs',
  'tools/rlm-quality-pilot/run.mjs',
  'tools/rlm-quality-pilot/task.mjs',
  'tools/rlm-quality-pilot/long-read.mjs',
  'tools/rlm-quality-pilot/official-score.py',
  'tools/rlm-quality-pilot/native-acceptance.mjs',
  'tools/rlm-arc-pilot/run.mjs',
  'tools/rlm-arc-pilot/native-worker.mjs',
  'tools/rlm-arc-pilot/sandbox.mjs',
  'tools/rlm-arc-pilot/attachment-relay.mjs',
  'tools/rlm-arc-pilot/ledger.mjs',
  'tools/rlm-recursion-pilot/run.mjs',
  'tools/rlm-recursion-pilot/network-profile.mjs',
  'tools/rlm-recursion-pilot/control.mjs',
  'tools/rlm-recursion-pilot/native-acceptance.mjs',
])

function failure(code, detail, options = {}) {
  const error = new Error(`${code}: ${detail}`, options.cause === undefined ? undefined : { cause: options.cause })
  error.code = code
  return error
}

function fail(code, detail, options) {
  throw failure(code, detail, options)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function own(value, key) {
  return isRecord(value) && Object.hasOwn(value, key)
}

function errorText(value) {
  return value instanceof Error ? value.message : String(value)
}

function redact(value) {
  return String(value ?? '')
    .replace(/(api[_-]?key|authorization|credential|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 2_000)
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function canonicalHash(value) {
  return sha256Bytes(stableJson(value))
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path))
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('T3_PATH', `${label} must be an absolute path`)
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
  try { info = await stat(absolute) } catch (error) { fail('T3_FILE', `${label} is unavailable`, { cause: error }) }
  if (!info.isDirectory()) fail('T3_FILE', `${label} is not a directory`)
  return absolute
}

async function assertRegularFile(path, label) {
  const absolute = requireAbsolute(path, label)
  let info
  try { info = await lstat(absolute) } catch (error) { fail('T3_FILE', `${label} is unavailable`, { cause: error }) }
  if (!info.isFile()) fail('T3_FILE', `${label} is not a regular file`)
  return absolute
}

async function readJson(path, label) {
  const file = await assertRegularFile(path, label)
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { fail('T3_JSON', `${label} is not valid JSON`, { cause: error }) }
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
    if (!/^[a-f0-9]{40}$/i.test(head)) fail('T3_SOURCE_HEAD', 'git did not return a full source HEAD')
    return head
  } catch (error) {
    fail('T3_SOURCE_HEAD', `cannot read source HEAD: ${redact(errorText(error))}`)
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
      else fail('T3_SOURCE_FILES', `source tree contains an unsupported node: ${relativePath}`)
    }
  }
  await visit(directory, '')
  if (Object.keys(values).length === 0) fail('T3_SOURCE_FILES', 'source tree must not be empty')
  return values
}

async function executionHashes(sourceRoot) {
  const source = await assertDirectory(sourceRoot, 'sourceRoot')
  const sourceFiles = {}
  for (const relativePath of REQUIRED_SOURCE_FILES) {
    sourceFiles[relativePath] = await sha256File(await assertRegularFile(join(source, relativePath), relativePath))
  }
  const packageRoot = join(source, 'incubator/rlm')
  return {
    sourceFiles,
    packageSource: await hashTree(join(packageRoot, 'src')),
    packageManifest: await sha256File(await assertRegularFile(join(packageRoot, 'package.json'), 'RLM package manifest')),
    lockfile: await sha256File(await assertRegularFile(join(source, 'pnpm-lock.yaml'), 'pnpm lockfile')),
  }
}

function assertExactHashMap(actual, expected, label) {
  if (!isRecord(actual) || !isRecord(expected) || canonicalHash(actual) !== canonicalHash(expected)) {
    fail('T3_FINGERPRINT_SOURCE', `${label} differs from its frozen hash map`)
  }
}

function requireSha256(value, label, code = 'T3_HASH') {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code, `${label} must be a SHA-256 digest`)
  return value.toLowerCase()
}

function safeInteger(value, label, code = 'T3_ACCOUNTING') {
  if (!Number.isSafeInteger(value) || value < 0) fail(code, `${label} must be a non-negative safe integer`)
  return value
}

function publicTask(task) {
  return {
    id: task.id,
    context: task.context,
    question: task.question,
    answerType: task.answerType,
    source: task.source,
    inputFiles: { 'inputs/context.txt': task.context },
  }
}

function directPrompt(task) {
  return `${FIXED_GUIDANCE}\n\n${task.context}\n\n${task.question}`
}

function nativePrompt(task) {
  return [
    'Read inputs/context.txt as the complete provided context for this task.',
    FIXED_GUIDANCE,
    task.question,
    'When finished, JSON-encode the Answer string and write it to answer.json. The file must contain one JSON string, not a JSON object.',
  ].join('\n\n')
}

function requireTask(task) {
  if (!isRecord(task) || task.formatVersion !== 1 || task.kind !== 'paper-oolong-task-v1'
    || typeof task.id !== 'string' || task.id.length === 0
    || typeof task.context !== 'string' || task.context.length === 0
    || typeof task.question !== 'string' || task.question.length === 0
    || task.answerType !== 'ANSWER_TYPE.NUMERIC' || !isRecord(task.source)
    || task.source.repository !== 'oolongbench/oolong-synth'
    || task.source.dataset !== 'trec_coarse'
    || task.source.contextLength !== 32_768
    || !isRecord(task.privateGold) || typeof task.privateGold.answer !== 'string'
    || !isRecord(task.scorer) || typeof task.scorer.path !== 'string' || !isAbsolute(task.scorer.path)
    || !SHA256.test(task.scorer.sha256 ?? '')) {
    fail('T3_TASK', 'task loader did not return the pinned 32K OOLONG TREC numeric task')
  }
  if (!isRecord(task.inputFiles) || Object.keys(task.inputFiles).length !== 1 || task.inputFiles['inputs/context.txt'] !== task.context) {
    fail('T3_TASK', 'task public inputs must contain only the exact context at inputs/context.txt')
  }
  return task
}

async function validatePriorClosure(path) {
  const closurePath = await assertRegularFile(path, 'prior final closure')
  const sha256 = await sha256File(closurePath)
  const closure = await readJson(closurePath, 'prior final closure')
  if (!isRecord(closure) || closure.formatVersion !== 1 || closure.kind !== 'quality-three-arm-connect-timeout-closure-v1'
    || closure.providerClosed !== true || closure.relayClosed !== true
    || closure.networkProfileDisposed !== true || closure.longReadProfileClosed !== true
    || closure.ownedProcessesAbsent !== true || !isRecord(closure.accounting)
    || closure.nativeConditionStarted !== false || closure.modelResponseHeadersObserved !== false
    || closure.connectTimeoutCode !== 'UND_ERR_CONNECT_TIMEOUT' || closure.unknownChargeRetained !== true
    || closure.answersAvailable !== false) {
    fail('T3_PRIOR_CLOSURE', 'prior final closure does not prove the closed connection-timeout attempt')
  }
  const admitted = safeInteger(closure.accounting.cumulativeAdmitted, 'prior cumulativeAdmitted')
  const confirmed = safeInteger(closure.accounting.cumulativeConfirmed, 'prior cumulativeConfirmed')
  const unknown = safeInteger(closure.accounting.cumulativeUnknown, 'prior cumulativeUnknown')
  if (admitted !== FIXED_LIMITS.prefixAdmitted || confirmed + unknown !== admitted) {
    fail('T3_PRIOR_ACCOUNTING', 'prior closure must retain 524 cumulative admissions with confirmed plus unknown equal to 524')
  }
  return { path: closurePath, sha256, accounting: { admitted, confirmed, unknown } }
}

function conditionMarkerPayload(condition) {
  return {
    formatVersion: FORMAT_VERSION,
    id: condition.id,
    arm: condition.arm,
    taskId: condition.taskId,
    protocol: condition.protocol ?? 'bare-direct-v1',
    publicPromptSha256: condition.publicPromptSha256,
    nativePromptSha256: condition.prompt?.sha256 ?? null,
    inputHashes: condition.inputHashes ?? {},
    autonomous: condition.autonomous ?? null,
  }
}

async function writeContext(workspace, context) {
  const path = join(workspace, 'inputs', 'context.txt')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, context, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await chmod(path, 0o444)
  return { path, sha256: await sha256File(path) }
}

async function freezeCondition(condition) {
  const path = join(condition.markerDirectory, 'condition.json')
  await writeExclusiveJson(path, conditionMarkerPayload(condition))
  return { ...condition, marker: { path, sha256: await sha256File(path) } }
}

async function createConditions({ output, tmpRoot, runtimeRoot, task }) {
  const publicPromptText = directPrompt(task)
  const nativeTask = nativePrompt(task)
  const directDirectory = join(output, 'runs', 'D1')
  const direct = {
    id: 'D1',
    arm: 'D',
    taskId: task.id,
    gameId: task.id,
    directory: directDirectory,
    durableDirectory: directDirectory,
    markerDirectory: join(directDirectory, 'markers'),
    publicPrompt: publicPromptText,
    publicPromptSha256: sha256Bytes(publicPromptText),
    inputHashes: {},
    prompt: null,
    autonomous: null,
  }
  await mkdir(direct.markerDirectory, { recursive: true, mode: 0o700 })
  const conditions = [await freezeCondition(direct)]

  for (const [id, arm] of [['R32', 'R'], ['S32', 'S']]) {
    const runDirectory = join(tmpRoot, 'runs', id)
    const durableDirectory = join(output, 'runs', id)
    const workspace = join(runDirectory, 'workspace')
    const data = join(runDirectory, 'data')
    const condition = {
      id,
      arm,
      protocol: 'quality-pilot-v1',
      taskId: task.id,
      gameId: task.id,
      directory: durableDirectory,
      runDirectory,
      durableDirectory,
      workspace,
      data,
      home: join(runDirectory, 'home'),
      session: join(runDirectory, 'session'),
      clientState: join(runDirectory, 'client-state'),
      markerDirectory: join(durableDirectory, 'markers'),
      publicPromptSha256: sha256Bytes(publicPromptText),
      prompt: { task: nativeTask, sha256: sha256Bytes(nativeTask) },
      inputHashes: {},
      autonomous: {
        maxTurns: FIXED_LIMITS.autonomousMaxTurns,
        maxTokens: FIXED_LIMITS.autonomousMaxTokens,
        gate: 'test -s answer.json',
      },
    }
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(condition.home, { recursive: true, mode: 0o700 }),
      mkdir(condition.session, { recursive: true, mode: 0o700 }),
      mkdir(join(runDirectory, 'tmp'), { recursive: true, mode: 0o700 }),
      mkdir(data, { recursive: true, mode: 0o700 }),
      mkdir(condition.clientState, { recursive: true, mode: 0o700 }),
      mkdir(join(durableDirectory, 'parent-intents'), { recursive: true, mode: 0o700 }),
      mkdir(join(durableDirectory, 'parent-chunks'), { recursive: true, mode: 0o700 }),
      mkdir(condition.markerDirectory, { recursive: true, mode: 0o700 }),
    ])
    await symlink(runtimeRoot, join(data, 'runtimes'), 'dir')
    const context = await writeContext(workspace, task.context)
    condition.inputHashes = { 'inputs/context.txt': context.sha256 }
    conditions.push(await freezeCondition(condition))
  }
  return conditions
}

async function createFreshTmpRoot(tmpRoot, output) {
  const root = requireAbsolute(tmpRoot, 'tmpRoot')
  if (!isWithin(TEMP_BASE, root) || root === TEMP_BASE) fail('T3_TMP_SCOPE', `tmpRoot must be a new descendant of ${TEMP_BASE}`)
  if (isWithin(root, output) || isWithin(output, root)) fail('T3_TMP_SCOPE', 'output and tmpRoot must not overlap')
  if (await exists(root)) fail('T3_TMP_REPLAY', 'tmpRoot already exists; never reuse a native runtime namespace')
  for (const id of ['R32', 'S32']) {
    const socketPath = join(root, 'runs', id, 'tmp', 'prime-agent-000000000000-000000000000.sock')
    if (Buffer.byteLength(socketPath) >= 100) fail('T3_SOCKET_PATH', 'tmpRoot is too long for the native Unix socket boundary')
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  return root
}

function manifestFingerprint(manifest) {
  const { fingerprint: _ignored, ...rest } = manifest
  return canonicalHash(rest)
}

function assertFixedRoute(route) {
  if (!isRecord(route)
    || route.provider !== FIXED_ROUTE.provider
    || route.model !== FIXED_ROUTE.model
    || route.reasoningEffort !== FIXED_ROUTE.reasoningEffort
    || route.maxTokens !== FIXED_ROUTE.maxTokens
    || route.configuredMaxOutputTokens !== FIXED_ROUTE.maxTokens) {
    fail('T3_ROUTE', 'route must retain openai-codex/gpt-6.1-sol/high with configured maxTokens 16384')
  }
}

/**
 * A view over a fresh 65-call Ledger.  It deliberately uses only the prior
 * aggregate from the final closure; it never invents historical call IDs.
 */
export function threeArmBudgetView(base, conditions, priorAccounting) {
  if (!base || typeof base.admit !== 'function' || typeof base.admitPhysical !== 'function') fail('T3_LEDGER', 'Ledger is required')
  const prior = {
    admitted: safeInteger(priorAccounting?.admitted, 'prior admitted'),
    confirmed: safeInteger(priorAccounting?.confirmed, 'prior confirmed'),
    unknown: safeInteger(priorAccounting?.unknown, 'prior unknown'),
  }
  if (prior.confirmed + prior.unknown !== prior.admitted || prior.admitted !== FIXED_LIMITS.prefixAdmitted) {
    fail('T3_LEDGER', 'Ledger prefix must be the retained 524 aggregate')
  }
  const limits = new Map((conditions ?? []).map(condition => [condition.id, condition.id === 'D1' ? FIXED_LIMITS.directRequests : FIXED_LIMITS.nativeTreeRequests]))
  const assertRun = runId => {
    const limit = limits.get(runId)
    if (!limit) fail('T3_ARM_SCOPE', `unexpected run ${String(runId)}`)
    return limit
  }
  const logicalCount = runId => [...base.calls.values()].filter(call => call.run === runId).length
  const checkCumulative = () => {
    if (prior.admitted + base.calls.size >= FIXED_LIMITS.cumulativeCap) fail('T3_CUMULATIVE_CAP', 'next request would exceed the cumulative 600-request hard cap')
  }
  return {
    async admit(runId, request) {
      const limit = assertRun(runId)
      if (logicalCount(runId) >= limit) fail('T3_ARM_LIMIT', `${runId} would exceed its ${String(limit)} logical-request limit`)
      checkCumulative()
      return base.admit(runId, request)
    },
    admitPhysical({ runId, ...rest } = {}) {
      const limit = assertRun(runId)
      if ((base.physicalByRun.get(runId) ?? 0) >= limit) fail('T3_ARM_LIMIT', `${runId} would exceed its ${String(limit)} physical-request limit`)
      if (prior.admitted + base.physicalAdmissions >= FIXED_LIMITS.cumulativeCap) fail('T3_CUMULATIVE_CAP', 'next physical request would exceed the cumulative 600-request hard cap')
      return base.admitPhysical({ runId, ...rest })
    },
    settle(...args) { return base.settle(...args) },
    appendSync(...args) { return base.appendSync(...args) },
    get stopped() { return base.stopped },
    get calls() { return base.calls },
    get physicalByRun() { return base.physicalByRun },
    async receipt() {
      const receipt = await base.receipt()
      const accounting = {
        ...receipt,
        cumulativeAdmitted: prior.admitted + receipt.newAdmitted,
        cumulativeConfirmed: prior.confirmed + receipt.settled,
        cumulativeUnknown: prior.unknown + receipt.unknown,
        budgets: { D1: FIXED_LIMITS.directRequests, R32: FIXED_LIMITS.nativeTreeRequests, S32: FIXED_LIMITS.nativeTreeRequests },
      }
      if (accounting.cumulativeAdmitted !== accounting.cumulativeConfirmed + accounting.cumulativeUnknown
        || accounting.cumulativeAdmitted > FIXED_LIMITS.cumulativeCap) {
        fail('T3_ACCOUNTING', 'cumulative accounting is inconsistent or exceeds 600')
      }
      return accounting
    },
  }
}

/** Create a prepared, provider-free, one-shot three-arm panel. */
export async function prepareThreeArm({
  output,
  tmpRoot,
  taskPath,
  priorClosure,
  sourceRoot = REPOSITORY_ROOT,
  packageRoot,
  taskLoader = loadTask,
  compiler = compileCurrentSources,
  runtimePreparer = prepareSharedRuntime,
} = {}) {
  const source = await assertDirectory(sourceRoot, 'sourceRoot')
  const targetOutput = requireAbsolute(output, 'output')
  if (await exists(targetOutput)) fail('T3_OUTPUT_REPLAY', 'output already exists; never replay a three-arm panel')
  const prior = await validatePriorClosure(priorClosure)
  if (prior.accounting.admitted + FIXED_LIMITS.newPhaseRequests > FIXED_LIMITS.cumulativeCap) {
    fail('T3_CUMULATIVE_CAP', 'authorized 65 new calls would exceed the 600-request hard cap')
  }
  const taskFile = await assertRegularFile(taskPath, 'private task artifact')
  if (isWithin(targetOutput, taskFile)) fail('T3_TASK_SCOPE', 'private task artifact must not be inside the output namespace')
  const task = requireTask(await taskLoader(taskFile))
  const taskBytesHash = await sha256File(taskFile)
  if (task.artifactSha256 !== undefined && task.artifactSha256 !== taskBytesHash) fail('T3_TASK_HASH', 'task loader artifact hash differs from task bytes')
  const scorerPath = await assertRegularFile(task.scorer.path, 'official scorer')
  const scorerSha256 = await sha256File(scorerPath)
  if (scorerSha256 !== task.scorer.sha256.toLowerCase()) fail('T3_SCORER_HASH', 'official scorer bytes differ from the task pin')
  const packageDirectory = await assertDirectory(packageRoot ?? join(source, 'incubator/rlm'), 'packageRoot')
  const beforeExecution = await executionHashes(source)
  const temporaryRoot = await createFreshTmpRoot(tmpRoot, targetOutput)
  await mkdir(targetOutput, { recursive: false, mode: 0o700 })
  const parentPrivate = join(targetOutput, 'parent-private')
  const shared = join(temporaryRoot, 'shared')
  await Promise.all([
    mkdir(parentPrivate, { recursive: true, mode: 0o700 }),
    mkdir(shared, { recursive: true, mode: 0o700 }),
  ])

  const sharedCompile = await compiler({ sourceRoot: source, packageRoot: packageDirectory, shared })
  if (!isRecord(sharedCompile) || typeof sharedCompile.compiled !== 'string' || !isRecord(sharedCompile.outputs) || !SHA256.test(sharedCompile.hash ?? '')) {
    fail('T3_COMPILE', 'compiler returned an invalid compiled artifact manifest')
  }
  const runtime = await runtimePreparer({ compiled: sharedCompile.compiled, packageRoot: packageDirectory, shared })
  if (!isRecord(runtime) || !isRecord(runtime.paths) || typeof runtime.paths.python !== 'string'
    || !isRecord(runtime.manifest) || !SHA256.test(runtime.manifest.sha256 ?? '')
    || typeof runtime.runtimes !== 'string') {
    fail('T3_RUNTIME', 'runtime preparer returned an invalid runtime manifest')
  }
  await assertDirectory(runtime.runtimes, 'shared runtime directory')
  const workerSource = await assertRegularFile(join(source, 'tools/rlm-arc-pilot/native-worker.mjs'), 'native worker source')
  const workerPath = join(shared, 'worker.mjs')
  await copyFile(workerSource, workerPath, fsConstants.COPYFILE_EXCL)
  const conditions = await createConditions({ output: targetOutput, tmpRoot: temporaryRoot, runtimeRoot: runtime.runtimes, task })
  const ledgerPath = join(targetOutput, 'provider-ledger.jsonl')
  const ledger = await Ledger.open(ledgerPath, { total: FIXED_LIMITS.newPhaseRequests, perRun: FIXED_LIMITS.ledgerPerRun })
  const freshLedger = await ledger.receipt()
  if (freshLedger.newAdmitted !== 0 || freshLedger.priorAdmitted !== 0 || freshLedger.stopped) fail('T3_LEDGER_FRESH', 'new three-arm ledger must start with no admissions')
  const afterExecution = await executionHashes(source)
  assertExactHashMap(afterExecution, beforeExecution, 'execution sources changed during preparation')

  const runnerPath = join(source, 'tools/rlm-quality-pilot/three-arm.mjs')
  const taskModulePath = join(source, 'tools/rlm-quality-pilot/task.mjs')
  const manifest = {
    formatVersion: FORMAT_VERSION,
    kind: 'quality-three-arm-prepared-v1',
    preparedAt: new Date().toISOString(),
    output: targetOutput,
    tmpRoot: temporaryRoot,
    parentPrivate,
    prior,
    sourceHead: await gitHead(source),
    runner: { path: runnerPath, sha256: await sha256File(await assertRegularFile(runnerPath, 'three-arm runner')), sourceRoot: source },
    execution: afterExecution,
    package: {
      root: packageDirectory,
      runtimeManifest: { path: runtime.manifest.path, sha256: runtime.manifest.sha256 },
    },
    shared: {
      path: shared,
      compiled: { path: sharedCompile.compiled, outputs: sharedCompile.outputs, hash: sharedCompile.hash },
      runtime,
      worker: { path: workerPath, sha256: await sha256File(workerPath) },
    },
    task: {
      path: taskFile,
      artifactSha256: taskBytesHash,
      public: publicTask(task),
      publicSha256: canonicalHash(publicTask(task)),
      privateGoldSha256: canonicalHash(task.privateGold),
      scorer: { adapterPath: taskModulePath, adapterSha256: await sha256File(await assertRegularFile(taskModulePath, 'task adapter')), path: scorerPath, sha256: scorerSha256, commit: task.scorer.commit ?? null },
    },
    protectedRoots: [...new Set([parentPrivate, dirname(taskFile), dirname(scorerPath)])],
    ledger: { path: ledgerPath, total: FIXED_LIMITS.newPhaseRequests, perRun: FIXED_LIMITS.ledgerPerRun },
    route: { ...FIXED_ROUTE, configuredMaxOutputTokens: FIXED_ROUTE.maxTokens },
    limits: { ...FIXED_LIMITS },
    conditions,
    sideEffects: { providerLoaded: false, credentialRead: false, modelCalls: 0, network: false },
  }
  manifest.fingerprint = manifestFingerprint(manifest)
  await writeExclusiveJson(join(targetOutput, PREPARED_FILE), manifest)
  return manifest
}

async function readPreparedManifest(output) {
  const root = await assertDirectory(output, 'output')
  const path = await assertRegularFile(join(root, PREPARED_FILE), 'prepared manifest')
  const manifest = await readJson(path, 'prepared manifest')
  if (!isRecord(manifest) || manifest.formatVersion !== FORMAT_VERSION || manifest.kind !== 'quality-three-arm-prepared-v1' || manifest.output !== root) {
    fail('T3_PREPARED_FORMAT', 'prepared manifest has an unsupported format or scope')
  }
  return { root, path, manifest }
}

async function assertCompiledOutputs(manifest) {
  if (!isRecord(manifest.shared?.compiled?.outputs)) fail('T3_FINGERPRINT_COMPILED', 'compiled output map is missing')
  const outputs = {}
  for (const [name, expected] of Object.entries(manifest.shared.compiled.outputs)) {
    if (!isRecord(expected) || !SHA256.test(expected.sha256 ?? '') || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) {
      fail('T3_FINGERPRINT_COMPILED', `invalid compiled output metadata for ${name}`)
    }
    const path = resolve(manifest.shared.compiled.path, name)
    if (!isWithin(manifest.shared.compiled.path, path)) fail('T3_FINGERPRINT_COMPILED', `compiled output escapes its directory: ${name}`)
    const info = await stat(path)
    const sha256 = await sha256File(path)
    if (sha256 !== expected.sha256 || info.size !== expected.bytes) fail('T3_FINGERPRINT_COMPILED', `compiled output changed: ${name}`)
    outputs[name] = { sha256, bytes: info.size }
  }
  if (canonicalHash(outputs) !== manifest.shared.compiled.hash) fail('T3_FINGERPRINT_COMPILED', 'compiled aggregate hash changed')
}

function sameTask(task, manifestTask) {
  return canonicalHash(publicTask(task)) === manifestTask.publicSha256
    && canonicalHash(task.privateGold) === manifestTask.privateGoldSha256
    && task.scorer.path === manifestTask.scorer.path
    && task.scorer.sha256 === manifestTask.scorer.sha256
}

async function assertConditionFingerprint(manifest, task) {
  if (!Array.isArray(manifest.conditions) || manifest.conditions.length !== 3) fail('T3_FINGERPRINT_CONDITIONS', 'prepared panel must contain D1, R32, and S32')
  const expected = [['D1', 'D'], ['R32', 'R'], ['S32', 'S']]
  const expectedDirect = directPrompt(task)
  const expectedNative = nativePrompt(task)
  for (let index = 0; index < expected.length; index += 1) {
    const condition = manifest.conditions[index]
    const [id, arm] = expected[index]
    if (!isRecord(condition) || condition.id !== id || condition.arm !== arm || condition.taskId !== task.id || condition.gameId !== task.id) {
      fail('T3_FINGERPRINT_CONDITIONS', `condition ${String(index + 1)} changed order or identity`)
    }
    const markerPath = await assertRegularFile(condition.marker?.path, `${id} condition marker`)
    if (await sha256File(markerPath) !== condition.marker.sha256) fail('T3_FINGERPRINT_MARKER', `${id} condition marker changed`)
    if (id === 'D1') {
      if (condition.publicPrompt !== expectedDirect || condition.publicPromptSha256 !== sha256Bytes(expectedDirect)
        || condition.prompt !== null || condition.autonomous !== null || canonicalHash(condition.inputHashes) !== canonicalHash({})) {
        fail('T3_FINGERPRINT_PROMPT', 'D1 must retain one full public prompt and no native tools/configuration')
      }
      continue
    }
    if (condition.protocol !== 'quality-pilot-v1' || condition.publicPromptSha256 !== sha256Bytes(expectedDirect)
      || condition.prompt?.task !== expectedNative || condition.prompt?.sha256 !== sha256Bytes(expectedNative)
      || condition.autonomous?.maxTurns !== FIXED_LIMITS.autonomousMaxTurns
      || condition.autonomous?.maxTokens !== FIXED_LIMITS.autonomousMaxTokens
      || condition.autonomous?.gate !== 'test -s answer.json') {
      fail('T3_FINGERPRINT_PROMPT', `${id} native prompt or autonomous configuration changed`)
    }
    const contextPath = resolve(condition.workspace, 'inputs/context.txt')
    if (!isWithin(condition.workspace, contextPath)
      || canonicalHash(condition.inputHashes) !== canonicalHash({ 'inputs/context.txt': sha256Bytes(task.context) })
      || await sha256File(contextPath) !== sha256Bytes(task.context)) {
      fail('T3_FINGERPRINT_INPUTS', `${id} public context bytes changed`)
    }
    for (const path of [condition.runDirectory, condition.workspace, condition.home, condition.session, condition.data, condition.clientState]) {
      await assertDirectory(path, `${id} fresh native path`)
    }
  }
}

/** Recheck every byte or public prompt that can affect a real dispatch. */
export async function assertPreparedFingerprint(manifest, { taskLoader = loadTask } = {}) {
  if (!isRecord(manifest)) fail('T3_PREPARED_FORMAT', 'prepared manifest must be an object')
  const source = await assertDirectory(manifest.runner?.sourceRoot, 'prepared source root')
  if (manifest.runner?.path !== join(source, 'tools/rlm-quality-pilot/three-arm.mjs')
    || await sha256File(await assertRegularFile(manifest.runner?.path, 'prepared runner')) !== manifest.runner?.sha256) {
    fail('T3_FINGERPRINT_RUNNER', 'three-arm runner bytes changed since preparation')
  }
  if (manifest.sourceHead !== await gitHead(source)) fail('T3_FINGERPRINT_SOURCE_HEAD', 'source HEAD changed since preparation')
  assertExactHashMap(await executionHashes(source), manifest.execution, 'execution sources')
  const prior = await validatePriorClosure(manifest.prior?.path)
  if (canonicalHash(prior) !== canonicalHash(manifest.prior)) fail('T3_FINGERPRINT_PRIOR', 'prior final closure changed since preparation')
  assertFixedRoute(manifest.route)
  if (canonicalHash(manifest.limits) !== canonicalHash(FIXED_LIMITS)) fail('T3_FINGERPRINT_LIMITS', 'fixed limits changed')
  if (manifest.ledger?.total !== FIXED_LIMITS.newPhaseRequests || manifest.ledger?.perRun !== FIXED_LIMITS.ledgerPerRun) {
    fail('T3_FINGERPRINT_LEDGER', 'new ledger limits changed')
  }
  if (await sha256File(await assertRegularFile(manifest.package?.runtimeManifest?.path, 'runtime manifest')) !== manifest.package.runtimeManifest.sha256
    || manifest.package.runtimeManifest.sha256 !== manifest.shared?.runtime?.manifest?.sha256) {
    fail('T3_FINGERPRINT_RUNTIME', 'runtime manifest changed since preparation')
  }
  await assertCompiledOutputs(manifest)
  if (await sha256File(await assertRegularFile(manifest.shared?.worker?.path, 'copied native worker')) !== manifest.shared.worker.sha256) {
    fail('T3_FINGERPRINT_WORKER', 'copied native worker changed since preparation')
  }
  const taskFile = await assertRegularFile(manifest.task?.path, 'private task artifact')
  if (await sha256File(taskFile) !== manifest.task.artifactSha256) fail('T3_FINGERPRINT_TASK', 'private task bytes changed since preparation')
  if (await sha256File(await assertRegularFile(manifest.task?.scorer?.adapterPath, 'task scorer adapter')) !== manifest.task.scorer.adapterSha256
    || await sha256File(await assertRegularFile(manifest.task?.scorer?.path, 'official scorer')) !== manifest.task.scorer.sha256) {
    fail('T3_FINGERPRINT_SCORER', 'task scorer bytes changed since preparation')
  }
  const task = requireTask(await taskLoader(taskFile))
  if (!sameTask(task, manifest.task)) fail('T3_FINGERPRINT_TASK', 'loaded task public or private hash changed since preparation')
  await assertConditionFingerprint(manifest, task)
  if (manifestFingerprint(manifest) !== manifest.fingerprint) fail('T3_FINGERPRINT_MANIFEST', 'prepared manifest is not self-consistent')
  return { source, task, prior }
}

async function assertPanelNotStarted(root, manifest) {
  if (await exists(join(dirname(manifest.prior.path), PREFIX_ALLOCATION_FILE))) {
    fail('T3_PREFIX_ALREADY_ALLOCATED', 'this closed spending prefix already funds a panel; another output directory cannot reuse it')
  }
  for (const path of [join(root, RUN_START_FILE), join(root, RUN_RECEIPT_FILE)]) {
    if (await exists(path)) fail('T3_RUN_ALREADY_STARTED', 'real panel has durable execution state; never replay it')
  }
  for (const condition of manifest.conditions) {
    for (const name of ['real-condition-started.json', 'result.json']) {
      if (await exists(join(condition.markerDirectory, name))) fail('T3_CONDITION_REPLAY', `${condition.id} already has a durable execution marker`)
    }
  }
}

async function assertNativeAcceptance(path, manifest, sourceRoot) {
  const proofPath = await assertRegularFile(path, 'quality native acceptance')
  const sha256 = await sha256File(proofPath)
  const proof = await readJson(proofPath, 'quality native acceptance')
  if (!isRecord(proof) || proof.formatVersion !== 1 || proof.kind !== 'quality-native-acceptance-v1'
    || proof.accepted !== true || proof.realModelRequests !== 0 || proof.protocol !== 'quality-pilot-v1'
    || !isRecord(proof.sourceHashes)) {
    fail('T3_ACCEPTANCE', 'native acceptance does not show an accepted zero-model quality-pilot check')
  }
  if (proof.compiledHash !== manifest.shared.compiled.hash || proof.runtimeManifestSha256 !== manifest.shared.runtime.manifest.sha256) {
    fail('T3_ACCEPTANCE', 'native acceptance is not bound to this compiled runtime')
  }
  if (proof.limits?.requestLimit !== FIXED_LIMITS.nativeTreeRequests || proof.limits?.wallTimeMs !== FIXED_LIMITS.wallTimeMs
    || proof.limits?.maxTurns !== FIXED_LIMITS.autonomousMaxTurns || proof.limits?.maxTokens !== FIXED_LIMITS.autonomousMaxTokens) {
    fail('T3_ACCEPTANCE', 'native acceptance limits do not match the frozen quality protocol')
  }
  for (const arm of ['R', 'S']) {
    const result = proof.arms?.[arm]
    if (!isRecord(result) || result.accepted !== true || result.executionCompleted !== true || result.cleanupComplete !== true
      || result.executionPathConfirmed !== true || result.isolation !== true
      || result.worker?.nativeDepth !== 1 || result.worker?.actualDepth !== 1
      || !Number.isSafeInteger(result.observed?.childModelRequestCount) || result.observed.childModelRequestCount <= 0) {
      fail('T3_ACCEPTANCE', `native acceptance arm ${arm} lacks direct recursive execution, cleanup, or isolation evidence`)
    }
  }
  for (const relativePath of REQUIRED_SOURCE_FILES) {
    const actual = await sha256File(await assertRegularFile(join(sourceRoot, relativePath), relativePath))
    if (proof.sourceHashes[relativePath] !== actual || manifest.execution.sourceFiles?.[relativePath] !== actual) {
      fail('T3_ACCEPTANCE', `native acceptance source hash differs for ${relativePath}`)
    }
  }
  return { path: proofPath, sha256, proof }
}

function assertRunArguments({ providerModule, providerSha256, providerPackage, credentialFile, acceptance } = {}) {
  if (typeof providerModule !== 'string' || !isAbsolute(providerModule)
    || typeof credentialFile !== 'string' || !isAbsolute(credentialFile)
    || typeof providerPackage !== 'string' || providerPackage.trim().length === 0
    || !SHA256.test(providerSha256 ?? '') || typeof acceptance !== 'string' || !isAbsolute(acceptance)) {
    fail('T3_RUN_ARGS', '--run requires --acceptance and provider module/hash/package/credential arguments')
  }
}

function assertRealRunRuntime() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node.split('.')[0] !== '22'
    || process.env.NO_PROXY !== 'chatgpt.com' || dns.getDefaultResultOrder() !== 'ipv4first'
    || net.getDefaultAutoSelectFamily() !== false) {
    fail('T3_NETWORK_PROFILE', 'real run requires Node 22/macOS arm64, NO_PROXY=chatgpt.com, ipv4first, and autoSelectFamily=false')
  }
}

/** All source, input, runtime, and native-proof checks occur before credentials. */
export async function assertRunPreflight({ output, acceptance, taskLoader = loadTask } = {}) {
  const { root, path, manifest } = await readPreparedManifest(output)
  const prepared = await assertPreparedFingerprint(manifest, { taskLoader })
  await assertPanelNotStarted(root, manifest)
  const nativeAcceptance = await assertNativeAcceptance(acceptance, manifest, prepared.source)
  return { root, preparedPath: path, manifest, task: prepared.task, nativeAcceptance }
}

function parseNativeAnswer(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'answer.json is unavailable' }
  try {
    const value = JSON.parse(raw)
    if (typeof value !== 'string') return { ok: false, error: 'answer.json must contain one JSON string' }
    return { ok: true, answer: value }
  } catch (error) {
    return { ok: false, error: `answer.json is not valid JSON: ${redact(errorText(error))}` }
  }
}

function nativeSchemaGrade(_task, raw) {
  const parsed = parseNativeAnswer(raw)
  return { schemaValid: parsed.ok, primaryScore: null, errors: parsed.ok ? [] : [parsed.error] }
}

function safeGradeSummary(grade, { schemaValid = false, errors = [] } = {}) {
  const suppliedErrors = Array.isArray(errors) ? errors.map(redact) : []
  if (!isRecord(grade)) return { score: null, primaryScore: null, exact: null, attemptedParse: null, parseConfidence: null, scorerSha256: null, schemaValid, errors: [...suppliedErrors, 'official scorer returned an invalid result'] }
  return {
    score: typeof grade.score === 'number' && Number.isFinite(grade.score) ? grade.score : null,
    primaryScore: typeof grade.primaryScore === 'number' && Number.isFinite(grade.primaryScore) ? grade.primaryScore : null,
    exact: typeof grade.exact === 'boolean' ? grade.exact : null,
    attemptedParse: typeof grade.attemptedParse === 'string' ? grade.attemptedParse : null,
    parseConfidence: (typeof grade.parseConfidence === 'number' && Number.isFinite(grade.parseConfidence)) || typeof grade.parseConfidence === 'string'
      ? grade.parseConfidence : null,
    scorerSha256: typeof grade.scorerSha256 === 'string' ? grade.scorerSha256 : null,
    schemaValid,
    errors: suppliedErrors,
  }
}

async function gradeDirect(task, answer, taskGrader) {
  if (typeof answer !== 'string') return safeGradeSummary(null, { schemaValid: false, errors: ['bare assistant text is unavailable'] })
  try { return safeGradeSummary(await taskGrader(task, answer), { schemaValid: true }) } catch (error) {
    return safeGradeSummary(null, { schemaValid: true, errors: [`official scorer failed: ${redact(errorText(error))}`] })
  }
}

async function gradeNative(task, raw, taskGrader) {
  const parsed = parseNativeAnswer(raw)
  if (!parsed.ok) return safeGradeSummary(null, { schemaValid: false, errors: [parsed.error] })
  try { return safeGradeSummary(await taskGrader(task, parsed.answer), { schemaValid: true }) } catch (error) {
    return safeGradeSummary(null, { schemaValid: true, errors: [`official scorer failed: ${redact(errorText(error))}`] })
  }
}

async function readMaybe(path) {
  try { return await readFile(path, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function archiveAnswer(manifest, condition, raw, extension) {
  if (typeof raw !== 'string') return { present: false, sha256: null, bytes: null, archive: null }
  const archive = join(manifest.parentPrivate, 'answers', `${condition.id}.${extension}`)
  await writeExclusiveText(archive, raw)
  return { present: true, sha256: sha256Bytes(raw), bytes: Buffer.byteLength(raw), archive: `${condition.id}.${extension}` }
}

function hasUnknownCall(ledger, condition) {
  return [...ledger.calls.values()].some(call => call.run === condition.id && call.state !== 'settled')
}

function safeOutcomeResources(outcome) {
  return isRecord(outcome?.resources) ? outcome.resources : null
}

function safeOutcomeObserved(outcome) {
  return isRecord(outcome?.observed) ? outcome.observed : { childModelRequestCount: null, rootModelRequestCount: null, recursionObserved: null }
}

function conditionRecord(condition, outcome, grading, archived, ledger) {
  const unknown = hasUnknownCall(ledger, condition)
    || Number(outcome?.resources?.unknownModelRequests ?? 0) > 0
  const completed = outcome?.executionCompleted === true && outcome?.cleanupComplete === true && grading.schemaValid === true
  return {
    formatVersion: FORMAT_VERSION,
    condition: { id: condition.id, arm: condition.arm, protocol: condition.protocol ?? 'bare-direct-v1', taskId: condition.taskId },
    status: unknown ? 'unknown' : completed ? 'completed' : 'incomplete',
    startedAt: outcome?.startedAt ?? null,
    completedAt: outcome?.completedAt ?? new Date().toISOString(),
    answer: {
      present: archived.present,
      sha256: archived.sha256,
      bytes: archived.bytes,
      archive: archived.archive,
      encoding: condition.id === 'D1' ? 'direct-text' : 'json-string',
      error: typeof outcome?.answer?.error === 'string' ? redact(outcome.answer.error) : null,
    },
    grading,
    resources: safeOutcomeResources(outcome),
    observed: safeOutcomeObserved(outcome),
    worker: isRecord(outcome?.worker) ? outcome.worker : null,
    workerError: typeof outcome?.workerError === 'string' ? redact(outcome.workerError) : null,
    nativeEvidence: typeof outcome?.nativeEvidence === 'string' ? outcome.nativeEvidence : null,
    inputsUnchanged: typeof outcome?.inputsUnchanged === 'boolean' ? outcome.inputsUnchanged : null,
    executionCompleted: outcome?.executionCompleted === true,
    cleanupComplete: outcome?.cleanupComplete === true,
  }
}

function failedOutcome(condition, error) {
  return {
    condition: { id: condition.id, arm: condition.arm, taskId: condition.taskId },
    answer: { present: false, sha256: null, error: redact(errorText(error)) },
    resources: null,
    observed: { childModelRequestCount: null, rootModelRequestCount: null, recursionObserved: null },
    executionCompleted: false,
    cleanupComplete: false,
  }
}

function notRunRecord(condition, reason) {
  return {
    formatVersion: FORMAT_VERSION,
    condition: { id: condition.id, arm: condition.arm, protocol: condition.protocol ?? 'bare-direct-v1', taskId: condition.taskId },
    status: 'not-run',
    startedAt: null,
    completedAt: new Date().toISOString(),
    answer: { present: false, sha256: null, bytes: null, archive: null, encoding: condition.id === 'D1' ? 'direct-text' : 'json-string', error: null },
    grading: { score: null, primaryScore: null, exact: null, attemptedParse: null, parseConfidence: null, scorerSha256: null, schemaValid: false, errors: [] },
    resources: null,
    observed: { childModelRequestCount: 0, rootModelRequestCount: 0, recursionObserved: false },
    worker: null,
    workerError: null,
    nativeEvidence: null,
    inputsUnchanged: null,
    executionCompleted: false,
    cleanupComplete: false,
    notRunReason: reason,
  }
}

async function runCondition({ manifest, task, condition, provider, relay, ledger, credentialFile, taskGrader, directExecutor, nativeExecutor }) {
  if (condition.id === 'D1') {
    const outcome = await directExecutor({ manifest, condition, provider, relay, ledger })
    const archived = await archiveAnswer(manifest, condition, outcome.answerText, 'txt')
    const grading = await gradeDirect(task, outcome.answerText, taskGrader)
    return conditionRecord(condition, outcome, grading, archived, ledger)
  }
  const projectedTask = {
    id: task.id,
    inputFiles: { 'inputs/context.txt': task.context },
    instruction: condition.prompt.task,
  }
  const outcome = await nativeExecutor({
    manifest,
    condition,
    provider,
    ledger,
    relay,
    task: projectedTask,
    grade: nativeSchemaGrade,
    protectedRoots: [...manifest.protectedRoots, dirname(requireAbsolute(credentialFile, 'credentialFile'))],
  })
  const raw = await readMaybe(join(condition.workspace, 'answer.json'))
  const archived = await archiveAnswer(manifest, condition, raw, 'json')
  const grading = await gradeNative(task, raw, taskGrader)
  return conditionRecord(condition, outcome, grading, archived, ledger)
}

function sanitizedReceiptResult(result) {
  const { attemptedParse: _rawParsedAnswer, ...sanitizedGrading } = result.grading
  return {
    condition: result.condition,
    status: result.status,
    answer: result.answer,
    grading: sanitizedGrading,
    resources: result.resources,
    observed: result.observed,
    executionCompleted: result.executionCompleted,
    cleanupComplete: result.cleanupComplete,
    notRunReason: result.notRunReason ?? null,
  }
}

/**
 * The sole real-provider entry point.  It has neither retry nor continuation
 * behavior: any unknown request or incomplete condition fences later arms.
 */
export async function runThreeArm({
  output,
  acceptance,
  providerModule,
  providerSha256,
  providerPackage,
  credentialFile,
  taskLoader = loadTask,
  taskGrader = gradeTask,
  providerLoader = loadRealProvider,
  relayFactory = createAttachmentRelay,
  directExecutor = executeDirectCondition,
  nativeExecutor = executeCondition,
  longReadProfileFactory = createLongReadProfile,
  networkProfileInstaller = installNoReuseProfile,
  runtimeAssert = assertRealRunRuntime,
} = {}) {
  const preflight = await assertRunPreflight({ output, acceptance, taskLoader })
  assertRunArguments({ providerModule, providerSha256, providerPackage, credentialFile, acceptance })
  runtimeAssert()
  const { root, manifest, task, nativeAcceptance } = preflight
  // An exclusive claim on the prior receipt prevents a different output
  // directory from resetting the same cumulative spending prefix.
  await writeExclusiveJson(join(dirname(manifest.prior.path), PREFIX_ALLOCATION_FILE), {
    formatVersion: FORMAT_VERSION, output: root, fingerprint: manifest.fingerprint,
    priorSha256: manifest.prior.sha256, cumulativeCap: FIXED_LIMITS.cumulativeCap,
  })
  await writeExclusiveJson(join(root, RUN_START_FILE), {
    formatVersion: FORMAT_VERSION,
    startedAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    nativeAcceptance: { sha256: nativeAcceptance.sha256 },
    provider: { moduleSha256: providerSha256.toLowerCase(), package: providerPackage },
    configuredRoute: { ...manifest.route },
  })

  let baseLedger
  let ledger
  let provider
  let relay
  let longReadProfile
  let networkProfile
  let panelError = null
  let stopReason = 'all conditions completed'
  const records = new Map()
  const closes = {}
  const originalFetch = globalThis.fetch
  try {
    baseLedger = await Ledger.open(manifest.ledger.path, { total: FIXED_LIMITS.newPhaseRequests, perRun: FIXED_LIMITS.ledgerPerRun })
    const initial = await baseLedger.receipt()
    if (initial.newAdmitted !== 0 || initial.priorAdmitted !== 0 || initial.stopped) fail('T3_LEDGER_STARTED', 'prepared ledger is not fresh')
    ledger = threeArmBudgetView(baseLedger, manifest.conditions, manifest.prior.accounting)
    longReadProfile = longReadProfileFactory({ baseFetch: originalFetch, bodyTimeoutMs: FIXED_LIMITS.wallTimeMs })
    networkProfile = networkProfileInstaller({
      baseFetch: longReadProfile.fetch,
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
      onPhysical: () => fail('T3_PHYSICAL_SCOPE', 'provider physical request occurred outside an active condition dispatcher'),
      onTransportEvent: event => baseLedger.appendSync({ type: 'transport-event', event }),
    })
    for (const condition of manifest.conditions) {
      if (ledger.stopped) {
        stopReason = 'ledger retained an unresolved or unknown request'
        break
      }
      const startPath = join(condition.markerDirectory, 'real-condition-started.json')
      const resultPath = join(condition.markerDirectory, 'result.json')
      if (await exists(startPath) || await exists(resultPath)) fail('T3_CONDITION_REPLAY', `${condition.id} already has a durable execution marker`)
      await writeExclusiveJson(startPath, {
        formatVersion: FORMAT_VERSION,
        startedAt: new Date().toISOString(),
        fingerprint: manifest.fingerprint,
        id: condition.id,
        arm: condition.arm,
      })
      let record
      try {
        record = await runCondition({ manifest, task, condition, provider, relay, ledger, credentialFile, taskGrader, directExecutor, nativeExecutor })
      } catch (error) {
        record = conditionRecord(condition, failedOutcome(condition, error), safeGradeSummary(null, { schemaValid: false, errors: [redact(errorText(error))] }), { present: false, sha256: null, bytes: null, archive: null }, ledger)
      }
      await writeExclusiveJson(resultPath, record)
      records.set(condition.id, record)
      if (record.status === 'unknown' || record.cleanupComplete !== true || ledger.stopped) {
        stopReason = record.status === 'unknown'
          ? `${condition.id} retained an unknown request`
          : record.cleanupComplete !== true ? `${condition.id} cleanup was incomplete` : 'ledger retained an unresolved or unknown request'
        break
      }
    }
  } catch (error) {
    panelError = redact(errorText(error))
    stopReason = 'panel setup or provider failure'
  } finally {
    try { await provider?.close?.(); closes.provider = provider ? 'closed' : 'not-loaded' } catch (error) { closes.provider = 'failed'; panelError ??= `provider close: ${redact(errorText(error))}` }
    try { await relay?.close?.(); closes.relay = relay ? 'closed' : 'not-created' } catch (error) { closes.relay = 'failed'; panelError ??= `relay close: ${redact(errorText(error))}` }
    try { networkProfile?.dispose?.(); closes.networkProfile = networkProfile ? 'disposed' : 'not-installed' } catch (error) { closes.networkProfile = 'failed'; panelError ??= `network profile dispose: ${redact(errorText(error))}` }
    try { await longReadProfile?.close?.(); closes.longReadProfile = longReadProfile ? 'closed' : 'not-created' } catch (error) { closes.longReadProfile = 'failed'; panelError ??= `long read profile close: ${redact(errorText(error))}` }
    globalThis.fetch = originalFetch
  }

  for (const condition of manifest.conditions) {
    if (records.has(condition.id)) continue
    const record = notRunRecord(condition, stopReason)
    await writeExclusiveJson(join(condition.markerDirectory, 'result.json'), record)
    records.set(condition.id, record)
  }
  const accounting = ledger ? await ledger.receipt() : baseLedger ? await baseLedger.receipt() : null
  const receipt = {
    formatVersion: FORMAT_VERSION,
    kind: 'quality-three-arm-final-receipt-v1',
    completedAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    providerLoaded: provider !== undefined,
    configuredRoute: { ...manifest.route },
    nativeAcceptance: { sha256: nativeAcceptance.sha256 },
    results: manifest.conditions.map(condition => sanitizedReceiptResult(records.get(condition.id))),
    accounting: accounting ? {
      prefix: { admitted: manifest.prior.accounting.admitted, confirmed: manifest.prior.accounting.confirmed, unknown: manifest.prior.accounting.unknown },
      new: { admitted: accounting.newAdmitted, confirmed: accounting.settled, unknown: accounting.unknown, physicalAdmitted: accounting.physicalAdmitted },
      cumulative: { admitted: accounting.cumulativeAdmitted, confirmed: accounting.cumulativeConfirmed, unknown: accounting.cumulativeUnknown, cap: FIXED_LIMITS.cumulativeCap, withinCap: accounting.cumulativeAdmitted <= FIXED_LIMITS.cumulativeCap },
      stopped: accounting.stopped,
    } : null,
    closes,
    stopReason,
    error: panelError,
  }
  await writeExclusiveJson(join(root, RUN_RECEIPT_FILE), receipt)
  if (panelError) throw failure('T3_RUN_STOPPED', panelError)
  return receipt
}

export function parseArgs(argv) {
  const result = { mode: undefined }
  const options = new Map([
    ['--output', 'output'], ['--tmp-root', 'tmpRoot'], ['--task', 'taskPath'], ['--prior-closure', 'priorClosure'],
    ['--acceptance', 'acceptance'], ['--provider-module', 'providerModule'], ['--provider-sha256', 'providerSha256'],
    ['--provider-package', 'providerPackage'], ['--credential-file', 'credentialFile'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--prepare' || value === '--run') {
      if (result.mode !== undefined) fail('T3_ARGS', 'choose exactly one of --prepare or --run')
      result.mode = value.slice(2)
      continue
    }
    const property = options.get(value)
    if (!property || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail('T3_ARGS', `unknown or incomplete argument: ${String(value)}`)
    if (result[property] !== undefined) fail('T3_ARGS', `duplicate argument: ${value}`)
    result[property] = argv[index + 1]
    index += 1
  }
  if (!result.mode) fail('T3_ARGS', 'choose exactly one of --prepare or --run')
  const prepareOnly = ['tmpRoot', 'taskPath', 'priorClosure']
  const runOnly = ['acceptance', 'providerModule', 'providerSha256', 'providerPackage', 'credentialFile']
  if (!result.output) fail('T3_ARGS', '--output is required')
  if (result.mode === 'prepare') {
    if (prepareOnly.some(name => !result[name])) fail('T3_ARGS', '--prepare requires --tmp-root, --task, and --prior-closure')
    if (runOnly.some(name => result[name] !== undefined)) fail('T3_ARGS', 'run-only arguments are not valid with --prepare')
  } else {
    if (runOnly.some(name => !result[name])) fail('T3_ARGS', '--run requires --acceptance and provider module/hash/package/credential arguments')
    if (prepareOnly.some(name => result[name] !== undefined)) fail('T3_ARGS', 'prepare-only arguments are not valid with --run')
  }
  return result
}

function usage() {
  return [
    'Usage:',
    '  node tools/rlm-quality-pilot/three-arm.mjs --prepare --output <new-output> --tmp-root <new-short-tmp-root> --task <task-json> --prior-closure <connection-timeout-final-closure>',
    '  node tools/rlm-quality-pilot/three-arm.mjs --run --output <prepared-output> --acceptance <quality-native-acceptance-json> --provider-module <private-module> --provider-sha256 <sha256> --provider-package <name> --credential-file <private-file>',
  ].join('\n')
}

function isDirectEntrypoint() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'prepare') {
    const manifest = await prepareThreeArm(args)
    process.stdout.write(`${JSON.stringify({ mode: 'prepare', fingerprint: manifest.fingerprint, output: manifest.output })}\n`)
    return
  }
  const receipt = await runThreeArm(args)
  process.stdout.write(`${JSON.stringify({ mode: 'run', fingerprint: receipt.fingerprint, accounting: receipt.accounting })}\n`)
}

if (isDirectEntrypoint()) {
  main().catch(error => {
    process.stderr.write(`${error?.stack ?? error?.message ?? error}\n${usage()}\n`)
    process.exitCode = 1
  })
}

export { PREPARED_FILE, RUN_START_FILE, RUN_RECEIPT_FILE, PREFIX_ALLOCATION_FILE, manifestFingerprint, validatePriorClosure }
