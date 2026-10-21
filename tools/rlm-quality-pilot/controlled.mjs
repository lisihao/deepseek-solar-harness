#!/opt/homebrew/opt/node@22/bin/node

/**
 * A one-shot four-condition same-task panel.  Preparation and native
 * acceptance are provider-free; the sole real-provider entry point is
 * runControlled(), after every prefix, authorization, source, runtime and
 * proof binding has passed.
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

import { compileCurrentSources, loadRealProvider, prepareSharedRuntime } from '../rlm-arc-pilot/run.mjs'
import { createAttachmentRelay } from '../rlm-arc-pilot/attachment-relay.mjs'
import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { executeCondition } from '../rlm-recursion-pilot/run.mjs'
import { installNoReuseProfile } from '../rlm-recursion-pilot/network-profile.mjs'
import { prepareFixture, createSyntheticProvider, gradeFixture } from '../rlm-recursion-pilot/native-acceptance.mjs'
import { executeDirectCondition } from './run.mjs'
import { createLongReadProfile } from './long-read.mjs'
import { gradeTask, loadTask } from './task.mjs'
import { FIXED_GUIDANCE, FIXED_ROUTE, REQUIRED_SOURCE_FILES } from './three-arm.mjs'

const execFile = promisify(execFileCallback)
const DIRECTORY = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(DIRECTORY, '../..')
const TEMP_BASE = process.platform === 'darwin' ? '/private/tmp' : resolve(tmpdir())
const FORMAT_VERSION = 1
const SHA256 = /^[a-f0-9]{64}$/i
const PREPARED = 'prepared.json'
const STARTED = 'real-run-started.json'
const RECEIPT = 'final-receipt.json'
const ACCEPTED = 'accepted.json'
const ALLOCATION = 'quality-control-v1-allocation.json'

export const FIXED_TASK_PATH = '/Users/sihaoli/Projects/DeepSeek-Solar-Harness-V4/artifacts/rlm-recursion-20261021/parent-private/three-arm-assets-v1/task.json'
export const CONTROL_LIMITS = Object.freeze({
  prefixAdmitted: 600,
  prefixConfirmed: 586,
  prefixUnknown: 14,
  cumulativeCap: 700,
  newMaximum: 97,
  D1: 1,
  R32: 32,
  S32: 32,
  S0_32: 32,
  perRun: 32,
  wallTimeMs: 1_200_000,
  autonomousMaxTurns: 32,
  autonomousMaxTokens: 4_000_000,
})

export const CONTROL_POLICY = [
  'Keep the original six labels and do not invent category definitions.',
  'Use only the already-admitted recursive settings. Do not use rlm.create_session, Factory, or any other API to bypass disabled recursion. If recursion is unavailable, complete the work yourself.',
  'If recursive subagents are available, ask at most two children to judge disjoint batches independently from the original question and original labels; do not give children a new taxonomy from the parent.',
  'After spawning children, end the parent assistant turn with a brief waiting message and wait for native completion notifications. Do not steer, correct, poll, collect, or classify more records before a child is settled.',
  'Cover every record and recheck boundary classifications. If Python and file tools are available, use Python to compute the final count and, in that same Python cell, immediately JSON-encode the final Answer string and write it to answer.json. Otherwise return the final Answer text directly.',
].join(' ')

const FIXED_TASK = Object.freeze({
  id: 'oolong-trec-32k-15000243',
  contextSha256: '64e3a042daf4bf66fbbb8b59d0a008179d5d4ce4a1554d7bcc11eba7f2204150',
  questionSha256: 'd0dcc7bc53389f17e75cc9f12b246966f3524f19a0809a3c2806d6316032560f',
  source: Object.freeze({
    repository: 'oolongbench/oolong-synth',
    revision: '616cca899e8b51ea0ad5446ebab39aa72b3192bc',
    dataset: 'trec_coarse',
    rowId: 15000243,
    contextWindowId: 1,
    contextLength: 32_768,
    parquetFile: 'validation-00005-of-00007.parquet',
    parquetSha256: '8c0d27a796b471b93cd9323646f80a1b1216f88e16612cfb67df1bbe33dbae4b',
    rowIndex: 13,
    contextSha256: '64e3a042daf4bf66fbbb8b59d0a008179d5d4ce4a1554d7bcc11eba7f2204150',
    questionSha256: 'd0dcc7bc53389f17e75cc9f12b246966f3524f19a0809a3c2806d6316032560f',
    selection: 'First file-order 32768-length numeric DESC count item, chosen without consulting answers.',
  }),
})

export const CONTROL_SOURCE_FILES = Object.freeze([
  ...REQUIRED_SOURCE_FILES,
  'tools/rlm-quality-pilot/controlled.mjs',
  'package.json',
  'pnpm-lock.yaml',
  'incubator/rlm/package.json',
  'incubator/rlm/assets/runtime-manifest.json',
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

function sha(value) {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function canonicalHash(value) {
  return sha(stableJson(value))
}

function redact(value) {
  return String(value ?? '')
    .replace(/(api[_-]?key|authorization|credential|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 1_000)
}

function publicError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_:-]+$/.test(error.code) ? error.code : 'CONTROL_RUN_ERROR'
  return { code }
}

async function fileHash(path) {
  return sha(await readFile(path))
}

function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('CONTROL_PATH', `${label} must be an absolute path`)
  return resolve(value)
}

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error }
}

async function regular(path, label) {
  const resolved = absolute(path, label)
  let info
  try { info = await lstat(resolved) } catch (error) { fail('CONTROL_FILE', `${label} is unavailable`, { cause: error }) }
  if (!info.isFile()) fail('CONTROL_FILE', `${label} is not a regular file`)
  return resolved
}

async function directory(path, label) {
  const resolved = absolute(path, label)
  let info
  try { info = await stat(resolved) } catch (error) { fail('CONTROL_FILE', `${label} is unavailable`, { cause: error }) }
  if (!info.isDirectory()) fail('CONTROL_FILE', `${label} is not a directory`)
  return resolved
}

async function readJson(path, label) {
  const file = await regular(path, label)
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) { fail('CONTROL_JSON', `${label} is not valid JSON`, { cause: error }) }
}

async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await file.sync()
  } finally {
    await file.close()
  }
}

async function saveText(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(value, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
}

async function gitHead(source) {
  try {
    const { stdout } = await execFile('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    const value = stdout.trim()
    if (!/^[a-f0-9]{40}$/i.test(value)) fail('CONTROL_SOURCE_HEAD', 'git did not return a full source HEAD')
    return value
  } catch (error) {
    fail('CONTROL_SOURCE_HEAD', `cannot read source HEAD: ${redact(error instanceof Error ? error.message : error)}`)
  }
}

async function treeHashes(root) {
  const values = {}
  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name)
      const key = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(path, key)
      else if (entry.isFile()) values[key] = await fileHash(path)
      else fail('CONTROL_SOURCE_FILES', `unsupported source node ${key}`)
    }
  }
  await visit(await directory(root, 'source tree'), '')
  if (Object.keys(values).length === 0) fail('CONTROL_SOURCE_FILES', 'source tree is empty')
  return values
}

async function sourceHashes(sourceRoot) {
  const source = await directory(sourceRoot, 'sourceRoot')
  const files = {}
  for (const name of CONTROL_SOURCE_FILES) files[name] = await fileHash(await regular(join(source, name), name))
  return {
    files,
    rlmSource: await treeHashes(join(source, 'incubator/rlm/src')),
  }
}

function sameHashMap(left, right, label) {
  if (!isRecord(left) || !isRecord(right) || canonicalHash(left) !== canonicalHash(right)) fail('CONTROL_FINGERPRINT_SOURCE', `${label} changed`)
}

function taskPublic(task) {
  return {
    id: task.id,
    answerType: task.answerType,
    source: task.source,
    contextSha256: sha(task.context),
    questionSha256: sha(task.question),
  }
}

function requireTask(task) {
  if (!isRecord(task) || task.formatVersion !== 1 || task.kind !== 'paper-oolong-task-v1'
    || task.id !== FIXED_TASK.id || task.answerType !== 'ANSWER_TYPE.NUMERIC'
    || typeof task.context !== 'string' || typeof task.question !== 'string'
    || sha(task.context) !== FIXED_TASK.contextSha256 || sha(task.question) !== FIXED_TASK.questionSha256
    || canonicalHash(task.source) !== canonicalHash(FIXED_TASK.source)
    || task.source?.contextSha256 !== sha(task.context) || task.source?.questionSha256 !== sha(task.question)
    || !isRecord(task.privateGold) || typeof task.privateGold.answer !== 'string'
    || !isRecord(task.scorer) || typeof task.scorer.path !== 'string' || !SHA256.test(task.scorer.sha256 ?? '')) {
    fail('CONTROL_TASK', 'task is not the fixed original 32K OOLONG TREC task')
  }
  if (!isRecord(task.inputFiles) || Object.keys(task.inputFiles).length !== 1 || task.inputFiles['inputs/context.txt'] !== task.context) {
    fail('CONTROL_TASK', 'task must expose only inputs/context.txt to native conditions')
  }
  return task
}

function directPrompt(task) {
  return `${FIXED_GUIDANCE}\n\n${CONTROL_POLICY}\n\n${task.context}\n\n${task.question}`
}

function nativePrompt(task) {
  return [
    'Read inputs/context.txt as the complete provided context for this task.',
    FIXED_GUIDANCE,
    CONTROL_POLICY,
    task.question,
    'The entire model-request tree for this condition has a 32-request limit.',
    'JSON-encode the final Answer string and write it to answer.json. The file must contain one non-empty JSON string, not an object.',
  ].join('\n\n')
}

function exactPrefix(receipt) {
  const accounting = receipt?.accounting
  const closes = receipt?.closes
  if (!isRecord(receipt) || receipt.formatVersion !== 1 || receipt.kind !== 'quality-recovery-final-receipt-v1'
    || accounting?.cumulativeAdmitted !== CONTROL_LIMITS.prefixAdmitted
    || accounting?.cumulativeConfirmed !== CONTROL_LIMITS.prefixConfirmed
    || accounting?.cumulativeUnknown !== CONTROL_LIMITS.prefixUnknown
    || accounting?.newAdmitted !== 11 || accounting?.settled !== 11 || accounting?.unknown !== 0 || accounting?.physicalAdmitted !== 11
    || receipt?.error !== null || receipt?.outcome?.cleanupComplete !== true
    || closes?.provider !== 'closed' || closes?.relay !== 'closed' || closes?.networkProfile !== 'closed' || closes?.longReadProfile !== 'closed') {
    fail('CONTROL_PREFIX', 'prior recovery receipt is not the closed 600 = 586 + 14 prefix')
  }
  return { admitted: 600, confirmed: 586, unknown: 14 }
}

function exactVerification(value) {
  const ledger = value?.ledger
  const accounting = value?.accounting
  const closure = value?.closure
  if (!isRecord(value) || value.formatVersion !== 1 || value.kind !== 'quality-recovery-independent-verification-v1'
    || ledger?.admitted !== 11 || ledger?.physical !== 11 || ledger?.settled !== 11 || ledger?.unknown !== 0 || ledger?.inflight !== 0
    || accounting?.cumulativeAdmitted !== 600 || accounting?.cumulativeConfirmed !== 586 || accounting?.cumulativeUnknown !== 14 || accounting?.cap !== 600
    || !Array.isArray(closure?.ownedProcesses) || closure.ownedProcesses.length !== 0
    || closure?.ipcDeleted !== false || !Array.isArray(closure?.sockets) || closure.sockets.length === 0
    || closure.sockets.some(socket => socket?.connectResult !== 61 || socket?.payloadSent !== false)) {
    fail('CONTROL_VERIFICATION', 'prior independent verification does not close the 600-request recovery')
  }
}

function exactAuthorization(value, prefixReceiptSha256, verificationSha256) {
  const plan = value?.currentPlan
  const prefix = value?.closedPrefix
  if (!isRecord(value) || value.formatVersion !== 1 || value.kind !== 'human-request-budget-authorization-v1'
    || value.userText !== '再给增加100次预算' || value.previousCap !== 600 || value.additionalMaximum !== 100 || value.cumulativeCap !== 700
    || value.model !== 'openai-codex/gpt-6.1-sol' || value.reasoningEffort !== 'high'
    || value.noPaidApiFallback !== true || value.noCreditPurchase !== true
    || prefix?.admitted !== 600 || prefix?.confirmed !== 586 || prefix?.unknown !== 14
    || value.prefixReceiptSha256 !== prefixReceiptSha256 || value.independentVerificationSha256 !== verificationSha256
    || plan?.D !== 1 || plan?.R !== 32 || plan?.S !== 32 || plan?.S0 !== 32 || plan?.newMaximum !== 97 || plan?.cumulativeMaximum !== 697
    || value.allPriorOutcomesRetained !== true) {
    fail('CONTROL_AUTHORIZATION', 'authorization-700.json does not bind the approved 97-request four-condition plan')
  }
}

async function loadPrior({ prior, authorization }) {
  const receiptPath = await regular(prior, 'prior recovery receipt')
  const verificationPath = join(dirname(receiptPath), 'parent-private', 'independent-verification.json')
  const authPath = await regular(authorization, 'authorization-700.json')
  const receiptSha256 = await fileHash(receiptPath)
  const verificationSha256 = await fileHash(await regular(verificationPath, 'prior independent verification'))
  const authSha256 = await fileHash(authPath)
  const receipt = await readJson(receiptPath, 'prior recovery receipt')
  const verification = await readJson(verificationPath, 'prior independent verification')
  const auth = await readJson(authPath, 'authorization-700.json')
  const accounting = exactPrefix(receipt)
  exactVerification(verification)
  exactAuthorization(auth, receiptSha256, verificationSha256)
  return {
    receipt: { path: receiptPath, sha256: receiptSha256, accounting },
    verification: { path: verificationPath, sha256: verificationSha256 },
    authorization: { path: authPath, sha256: authSha256 },
  }
}

function markerPayload(condition) {
  return {
    formatVersion: FORMAT_VERSION,
    id: condition.id,
    arm: condition.arm,
    protocol: condition.protocol,
    taskId: condition.taskId,
    directPromptSha256: condition.directPromptSha256 ?? null,
    nativePromptSha256: condition.prompt?.sha256 ?? null,
    inputHashes: condition.inputHashes ?? {},
    autonomous: condition.autonomous ?? null,
  }
}

async function freezeMarker(condition) {
  const path = join(condition.markerDirectory, 'condition.json')
  await save(path, markerPayload(condition))
  return { ...condition, marker: { path, sha256: await fileHash(path) } }
}

async function writeContext(workspace, context) {
  const path = join(workspace, 'inputs', 'context.txt')
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, context, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await chmod(path, 0o400)
  return { path, sha256: await fileHash(path) }
}

async function buildConditions({ output, tmpRoot, privateRoot, runtimeRoot, task }) {
  const directHash = sha(directPrompt(task))
  const native = nativePrompt(task)
  const conditions = []
  const direct = {
    id: 'D1', arm: 'D', protocol: 'quality-control-direct-v1', taskId: task.id, gameId: task.id,
    directory: join(privateRoot, 'runs', 'D1'), durableDirectory: join(privateRoot, 'runs', 'D1'),
    markerDirectory: join(output, 'runs', 'D1', 'markers'), directPromptSha256: directHash,
    prompt: null, inputHashes: {}, autonomous: null,
  }
  await Promise.all([
    mkdir(direct.directory, { recursive: true, mode: 0o700 }),
    mkdir(join(direct.directory, 'parent-intents'), { recursive: true, mode: 0o700 }),
    mkdir(join(direct.directory, 'parent-chunks'), { recursive: true, mode: 0o700 }),
    mkdir(direct.markerDirectory, { recursive: true, mode: 0o700 }),
  ])
  conditions.push(await freezeMarker(direct))

  for (const [id, arm] of [['R32', 'R'], ['S32', 'S'], ['S0_32', 'S0']]) {
    const runDirectory = join(tmpRoot, 'runs', id)
    const workspace = join(runDirectory, 'workspace')
    const durableDirectory = join(privateRoot, 'runs', id)
    const condition = {
      id, arm, protocol: 'quality-control-v1', taskId: task.id, gameId: task.id,
      runDirectory, workspace, data: join(runDirectory, 'data'), home: join(runDirectory, 'home'),
      session: join(runDirectory, 'session'), clientState: join(runDirectory, 'client-state'), durableDirectory,
      markerDirectory: join(output, 'runs', id, 'markers'), directPromptSha256: directHash,
      prompt: { task: native, sha256: sha(native) }, inputHashes: {},
      autonomous: { maxTurns: CONTROL_LIMITS.autonomousMaxTurns, maxTokens: CONTROL_LIMITS.autonomousMaxTokens, gate: 'test -s answer.json' },
    }
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(condition.home, { recursive: true, mode: 0o700 }),
      mkdir(condition.session, { recursive: true, mode: 0o700 }),
      mkdir(join(runDirectory, 'tmp'), { recursive: true, mode: 0o700 }),
      mkdir(condition.data, { recursive: true, mode: 0o700 }),
      mkdir(condition.clientState, { recursive: true, mode: 0o700 }),
      mkdir(join(durableDirectory, 'parent-intents'), { recursive: true, mode: 0o700 }),
      mkdir(join(durableDirectory, 'parent-chunks'), { recursive: true, mode: 0o700 }),
      mkdir(condition.markerDirectory, { recursive: true, mode: 0o700 }),
    ])
    await symlink(runtimeRoot, join(condition.data, 'runtimes'), 'dir')
    condition.inputHashes = { 'inputs/context.txt': (await writeContext(workspace, task.context)).sha256 }
    conditions.push(await freezeMarker(condition))
  }
  return conditions
}

async function freshTmp(tmpRoot, output) {
  const root = absolute(tmpRoot, 'tmpRoot')
  if (!inside(TEMP_BASE, root) || root === TEMP_BASE || inside(root, output) || inside(output, root)) fail('CONTROL_TMP', 'tmpRoot must be a new, non-overlapping descendant of the system temporary root')
  if (await exists(root)) fail('CONTROL_TMP_REPLAY', 'tmpRoot already exists')
  for (const id of ['R32', 'S32', 'S0_32']) {
    const socket = join(root, 'runs', id, 'tmp', 'prime-agent-000000000000-000000000000.sock')
    if (Buffer.byteLength(socket) >= 100) fail('CONTROL_SOCKET', 'tmpRoot is too long for the native socket boundary')
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  return root
}

export function manifestFingerprint(manifest) {
  const { fingerprint: _ignored, ...unsigned } = manifest
  return canonicalHash(unsigned)
}

function fixedRoute(route) {
  if (!isRecord(route) || route.provider !== FIXED_ROUTE.provider || route.model !== FIXED_ROUTE.model
    || route.reasoningEffort !== FIXED_ROUTE.reasoningEffort || route.maxTokens !== FIXED_ROUTE.maxTokens
    || route.configuredMaxOutputTokens !== FIXED_ROUTE.maxTokens) {
    fail('CONTROL_ROUTE', 'route must remain openai-codex/gpt-6.1-sol/high/16384')
  }
}

/** Create the immutable, no-provider controlled panel. */
export async function prepareControlled({
  output,
  tmpRoot,
  prior,
  authorization,
  taskPath = FIXED_TASK_PATH,
  sourceRoot = ROOT,
  packageRoot,
  taskLoader = loadTask,
  compiler = compileCurrentSources,
  runtimePreparer = prepareSharedRuntime,
} = {}) {
  const source = await directory(sourceRoot, 'sourceRoot')
  const targetOutput = absolute(output, 'output')
  if (await exists(targetOutput)) fail('CONTROL_OUTPUT_REPLAY', 'output already exists')
  const priorState = await loadPrior({ prior, authorization })
  const taskFile = await regular(taskPath, 'task artifact')
  const task = requireTask(await taskLoader(taskFile))
  const scorerPath = await regular(task.scorer.path, 'official scorer')
  if (await fileHash(scorerPath) !== task.scorer.sha256.toLowerCase()) fail('CONTROL_SCORER', 'official scorer bytes changed')
  const packageDirectory = await directory(packageRoot ?? join(source, 'incubator/rlm'), 'packageRoot')
  const beforeSources = await sourceHashes(source)
  const temporaryRoot = await freshTmp(tmpRoot, targetOutput)
  await mkdir(targetOutput, { mode: 0o700 })
  const parentPrivate = join(targetOutput, 'parent-private')
  const shared = join(temporaryRoot, 'shared')
  await Promise.all([mkdir(parentPrivate, { recursive: true, mode: 0o700 }), mkdir(shared, { recursive: true, mode: 0o700 })])
  const compiled = await compiler({ sourceRoot: source, packageRoot: packageDirectory, shared })
  if (!isRecord(compiled) || typeof compiled.compiled !== 'string' || !isRecord(compiled.outputs) || !SHA256.test(compiled.hash ?? '')) fail('CONTROL_COMPILE', 'compiler returned an invalid output manifest')
  const runtime = await runtimePreparer({ compiled: compiled.compiled, packageRoot: packageDirectory, shared })
  if (!isRecord(runtime) || !isRecord(runtime.paths) || !isRecord(runtime.manifest) || typeof runtime.runtimes !== 'string' || !SHA256.test(runtime.manifest.sha256 ?? '')) fail('CONTROL_RUNTIME', 'runtime preparation returned an invalid manifest')
  await directory(runtime.runtimes, 'runtime directory')
  const workerSource = await regular(join(source, 'tools/rlm-arc-pilot/native-worker.mjs'), 'native worker')
  const workerPath = join(shared, 'worker.mjs')
  await copyFile(workerSource, workerPath, fsConstants.COPYFILE_EXCL)
  const conditions = await buildConditions({ output: targetOutput, tmpRoot: temporaryRoot, privateRoot: parentPrivate, runtimeRoot: runtime.runtimes, task })
  const ledgerPath = join(parentPrivate, 'provider-ledger.jsonl')
  const ledger = await Ledger.open(ledgerPath, { total: CONTROL_LIMITS.newMaximum, perRun: CONTROL_LIMITS.perRun })
  const initial = await ledger.receipt()
  if (initial.newAdmitted !== 0 || initial.priorAdmitted !== 0 || initial.stopped) fail('CONTROL_LEDGER', 'controlled ledger is not fresh')
  const afterSources = await sourceHashes(source)
  sameHashMap(beforeSources, afterSources, 'source changed during preparation')
  const runnerPath = join(source, 'tools/rlm-quality-pilot/controlled.mjs')
  const taskModulePath = join(source, 'tools/rlm-quality-pilot/task.mjs')
  const manifest = {
    formatVersion: FORMAT_VERSION,
    kind: 'quality-controlled-prepared-v1',
    createdAt: new Date().toISOString(),
    output: targetOutput,
    tmpRoot: temporaryRoot,
    parentPrivate,
    sourceHead: await gitHead(source),
    runner: { sourceRoot: source, path: runnerPath, sha256: await fileHash(await regular(runnerPath, 'controlled runner')) },
    sources: afterSources,
    prior: priorState,
    package: { root: packageDirectory, runtimeManifest: { path: runtime.manifest.path, sha256: runtime.manifest.sha256 } },
    shared: { path: shared, compiled: { path: compiled.compiled, outputs: compiled.outputs, hash: compiled.hash }, runtime, worker: { path: workerPath, sha256: await fileHash(workerPath) } },
    task: {
      path: taskFile,
      sha256: await fileHash(taskFile),
      public: taskPublic(task),
      publicSha256: canonicalHash(taskPublic(task)),
      privateGoldSha256: canonicalHash(task.privateGold),
      scorer: { path: scorerPath, sha256: await fileHash(scorerPath), adapterPath: taskModulePath, adapterSha256: await fileHash(await regular(taskModulePath, 'task adapter')) },
    },
    protectedRoots: [...new Set([parentPrivate, dirname(taskFile), dirname(scorerPath), dirname(priorState.receipt.path), dirname(priorState.authorization.path)])],
    ledger: { path: ledgerPath, total: CONTROL_LIMITS.newMaximum, perRun: CONTROL_LIMITS.perRun },
    route: { ...FIXED_ROUTE, configuredMaxOutputTokens: FIXED_ROUTE.maxTokens },
    limits: { ...CONTROL_LIMITS },
    conditions,
    policy: { commonGuidanceSha256: sha(FIXED_GUIDANCE), controlPolicySha256: sha(CONTROL_POLICY), strategyInstructionsOnly: true },
    sideEffects: { providerLoaded: false, credentialRead: false, modelCalls: 0 },
  }
  manifest.fingerprint = manifestFingerprint(manifest)
  await save(join(targetOutput, PREPARED), manifest)
  return manifest
}

async function readPrepared(output) {
  const root = await directory(output, 'output')
  const manifest = await readJson(join(root, PREPARED), 'prepared manifest')
  if (!isRecord(manifest) || manifest.formatVersion !== FORMAT_VERSION || manifest.kind !== 'quality-controlled-prepared-v1' || manifest.output !== root) fail('CONTROL_PREPARED', 'unsupported prepared manifest')
  return { root, manifest }
}

async function verifyOutputs(manifest) {
  const actual = {}
  for (const [name, expected] of Object.entries(manifest.shared?.compiled?.outputs ?? {})) {
    if (!isRecord(expected) || !SHA256.test(expected.sha256 ?? '') || !Number.isSafeInteger(expected.bytes)) fail('CONTROL_COMPILED', `invalid output metadata for ${name}`)
    const path = resolve(manifest.shared.compiled.path, name)
    if (!inside(manifest.shared.compiled.path, path)) fail('CONTROL_COMPILED', `compiled path escaped: ${name}`)
    const info = await stat(path)
    const digest = await fileHash(path)
    if (digest !== expected.sha256 || info.size !== expected.bytes) fail('CONTROL_COMPILED', `compiled output changed: ${name}`)
    actual[name] = { sha256: digest, bytes: info.size }
  }
  if (canonicalHash(actual) !== manifest.shared.compiled.hash) fail('CONTROL_COMPILED', 'compiled aggregate hash changed')
}

function conditionShape(manifest, task) {
  const expected = [['D1', 'D'], ['R32', 'R'], ['S32', 'S'], ['S0_32', 'S0']]
  if (!Array.isArray(manifest.conditions) || manifest.conditions.length !== expected.length) fail('CONTROL_CONDITIONS', 'controlled panel must have exactly four conditions')
  const directHash = sha(directPrompt(task))
  const native = nativePrompt(task)
  for (let index = 0; index < expected.length; index += 1) {
    const condition = manifest.conditions[index]
    const [id, arm] = expected[index]
    if (!isRecord(condition) || condition.id !== id || condition.arm !== arm || condition.taskId !== task.id || condition.gameId !== task.id) fail('CONTROL_CONDITIONS', `${id} identity changed`)
    if (condition.directPromptSha256 !== directHash) fail('CONTROL_PROMPT', `${id} direct common material changed`)
    if (id === 'D1') {
      if (condition.protocol !== 'quality-control-direct-v1' || condition.prompt !== null || condition.autonomous !== null) fail('CONTROL_CONDITIONS', 'D1 configuration changed')
      continue
    }
    if (condition.protocol !== 'quality-control-v1' || condition.prompt?.task !== native || condition.prompt?.sha256 !== sha(native)
      || condition.autonomous?.maxTurns !== 32 || condition.autonomous?.maxTokens !== 4_000_000 || condition.autonomous?.gate !== 'test -s answer.json') {
      fail('CONTROL_PROMPT', `${id} native task or autonomous limits changed`)
    }
  }
}

async function verifyMarkersAndInputs(manifest, task) {
  for (const condition of manifest.conditions) {
    if (await fileHash(await regular(condition.marker?.path, `${condition.id} marker`)) !== condition.marker.sha256) fail('CONTROL_MARKER', `${condition.id} marker changed`)
    if (condition.id === 'D1') continue
    const context = join(condition.workspace, 'inputs', 'context.txt')
    if (await fileHash(context) !== sha(task.context) || canonicalHash(condition.inputHashes) !== canonicalHash({ 'inputs/context.txt': sha(task.context) })) fail('CONTROL_INPUTS', `${condition.id} context changed`)
    for (const path of [condition.runDirectory, condition.workspace, condition.home, condition.session, condition.data, condition.clientState, condition.durableDirectory]) await directory(path, `${condition.id} runtime path`)
  }
}

/** Revalidate every effect-relevant input before proof or provider use. */
export async function verifyPrepared(manifest, { taskLoader = loadTask } = {}) {
  const source = await directory(manifest.runner?.sourceRoot, 'prepared source root')
  if (manifest.runner?.path !== join(source, 'tools/rlm-quality-pilot/controlled.mjs') || await fileHash(await regular(manifest.runner.path, 'controlled runner')) !== manifest.runner.sha256) fail('CONTROL_RUNNER', 'controlled runner changed')
  if (await gitHead(source) !== manifest.sourceHead) fail('CONTROL_SOURCE_HEAD', 'source HEAD changed')
  sameHashMap(await sourceHashes(source), manifest.sources, 'bound source bytes')
  const prior = await loadPrior({ prior: manifest.prior?.receipt?.path, authorization: manifest.prior?.authorization?.path })
  if (canonicalHash(prior) !== canonicalHash(manifest.prior)) fail('CONTROL_PRIOR', 'prior receipt, verification, or authorization changed')
  fixedRoute(manifest.route)
  if (canonicalHash(manifest.limits) !== canonicalHash(CONTROL_LIMITS)) fail('CONTROL_LIMITS', 'fixed budget limits changed')
  if (manifest.ledger?.total !== 97 || manifest.ledger?.perRun !== 32) fail('CONTROL_LEDGER', 'ledger limits changed')
  if (await fileHash(await regular(manifest.package?.runtimeManifest?.path, 'runtime manifest')) !== manifest.package.runtimeManifest.sha256
    || manifest.package.runtimeManifest.sha256 !== manifest.shared?.runtime?.manifest?.sha256) fail('CONTROL_RUNTIME', 'runtime manifest changed')
  await verifyOutputs(manifest)
  if (await fileHash(await regular(manifest.shared?.worker?.path, 'copied worker')) !== manifest.shared.worker.sha256) fail('CONTROL_WORKER', 'copied native worker changed')
  if (await fileHash(await regular(manifest.task?.path, 'task artifact')) !== manifest.task.sha256
    || await fileHash(await regular(manifest.task?.scorer?.path, 'official scorer')) !== manifest.task.scorer.sha256
    || await fileHash(await regular(manifest.task?.scorer?.adapterPath, 'task adapter')) !== manifest.task.scorer.adapterSha256) fail('CONTROL_TASK', 'task or scorer bytes changed')
  const task = requireTask(await taskLoader(manifest.task.path))
  if (canonicalHash(taskPublic(task)) !== manifest.task.publicSha256 || canonicalHash(task.privateGold) !== manifest.task.privateGoldSha256) fail('CONTROL_TASK', 'task public or private hash changed')
  conditionShape(manifest, task)
  await verifyMarkersAndInputs(manifest, task)
  if (manifestFingerprint(manifest) !== manifest.fingerprint) fail('CONTROL_MANIFEST', 'prepared manifest is inconsistent')
  return { source, task }
}

function freshRunPaths(root, manifest) {
  return [join(root, STARTED), join(root, RECEIPT), ...manifest.conditions.flatMap(condition => [join(condition.markerDirectory, 'real-condition-started.json'), join(condition.markerDirectory, 'result.json')])]
}

async function assertUnclaimed(root, manifest) {
  for (const path of freshRunPaths(root, manifest)) if (await exists(path)) fail('CONTROL_REPLAY', 'output already has real-run state')
  const allocationPath = join(dirname(manifest.prior.receipt.path), ALLOCATION)
  if (await exists(allocationPath)) fail('CONTROL_PREFIX_ALLOCATED', 'the closed 600 prefix already funds a controlled panel')
}

async function claim(manifest, root) {
  await save(join(dirname(manifest.prior.receipt.path), ALLOCATION), {
    formatVersion: FORMAT_VERSION,
    kind: 'quality-control-prefix-allocation-v1',
    output: root,
    fingerprint: manifest.fingerprint,
    prefixReceiptSha256: manifest.prior.receipt.sha256,
    authorizationSha256: manifest.prior.authorization.sha256,
    cumulativeCap: CONTROL_LIMITS.cumulativeCap,
  })
  await save(join(root, STARTED), { formatVersion: FORMAT_VERSION, fingerprint: manifest.fingerprint, startedAt: new Date().toISOString() })
}

async function claimState(manifest, root) {
  let allocation = null
  let started = null
  try { allocation = await readJson(join(dirname(manifest.prior.receipt.path), ALLOCATION), 'controlled allocation') } catch (error) { if (error?.code !== 'CONTROL_FILE') throw error }
  try { started = await readJson(join(root, STARTED), 'controlled start marker') } catch (error) { if (error?.code !== 'CONTROL_FILE') throw error }
  return { allocationOwned: allocation?.output === root && allocation?.fingerprint === manifest.fingerprint, realStartMarked: started?.fingerprint === manifest.fingerprint }
}

/** Add a 600-call aggregate without reconstructing historical request IDs. */
export function controlledBudget(base, conditions, prefix) {
  if (!base || typeof base.admit !== 'function' || base.total !== 97 || base.perRun !== 32 || base.priorAdmitted !== 0) fail('CONTROL_LEDGER', 'controlled ledger must be a new 97/32 Ledger')
  if (prefix?.admitted !== 600 || prefix?.confirmed !== 586 || prefix?.unknown !== 14) fail('CONTROL_LEDGER', 'controlled ledger requires the closed 600 prefix')
  const limits = new Map(conditions.map(condition => [condition.id, CONTROL_LIMITS[condition.id]]))
  const assertRun = id => {
    const limit = limits.get(id)
    if (!limit) fail('CONTROL_ARM', `unexpected arm ${String(id)}`)
    return limit
  }
  const checkLogical = id => {
    const limit = assertRun(id)
    if ([...base.calls.values()].filter(call => call.run === id).length >= limit) fail('CONTROL_ARM_LIMIT', `${id} exceeds its logical-request limit`)
    if (prefix.admitted + base.calls.size >= CONTROL_LIMITS.cumulativeCap) fail('CONTROL_CAP', 'next logical request exceeds 700')
    return limit
  }
  const checkPhysical = ({ runId, logicalRequest } = {}) => {
    const limit = assertRun(runId)
    const logical = base.calls.get(logicalRequest)
    if (!logical || logical.prior || logical.run !== runId || logical.state !== 'admitted') {
      fail('CONTROL_PHYSICAL_CORRELATION', `${String(runId)} physical request must follow its admitted logical request`)
    }
    if ((base.physicalByRun.get(runId) ?? 0) >= limit) fail('CONTROL_ARM_LIMIT', `${runId} exceeds its physical-request limit`)
    if (prefix.admitted + base.physicalAdmissions >= CONTROL_LIMITS.cumulativeCap) fail('CONTROL_CAP', 'next physical request exceeds 700')
  }
  return {
    async admit(id, request) { checkLogical(id); return base.admit(id, request) },
    admitPhysical({ runId, ...rest } = {}) {
      checkPhysical({ runId, ...rest })
      return base.admitPhysical({ runId, ...rest })
    },
    settle(...args) { return base.settle(...args) },
    appendSync(...args) { return base.appendSync(...args) },
    get stopped() { return base.stopped },
    get calls() { return base.calls },
    get physicalByRun() { return base.physicalByRun },
    async receipt() {
      const value = await base.receipt()
      const result = {
        ...value,
        cumulativeAdmitted: prefix.admitted + value.newAdmitted,
        cumulativeConfirmed: prefix.confirmed + value.settled,
        cumulativeUnknown: prefix.unknown + value.unknown,
      }
      if (result.cumulativeAdmitted !== result.cumulativeConfirmed + result.cumulativeUnknown || result.cumulativeAdmitted > 700) fail('CONTROL_ACCOUNTING', 'cumulative accounting is inconsistent')
      return result
    },
  }
}

function parseNativeAnswer(raw) {
  if (typeof raw !== 'string') return { ok: false, code: 'ANSWER_MISSING' }
  try {
    const value = JSON.parse(raw)
    return typeof value === 'string' && value.trim().length > 0 ? { ok: true, answer: value } : { ok: false, code: 'ANSWER_SCHEMA' }
  } catch {
    return { ok: false, code: 'ANSWER_JSON' }
  }
}

function publicGrade(full, answerValid, error) {
  return {
    score: typeof full?.score === 'number' && Number.isFinite(full.score) ? full.score : null,
    primaryScore: typeof full?.primaryScore === 'number' && Number.isFinite(full.primaryScore) ? full.primaryScore : null,
    exact: typeof full?.exact === 'boolean' ? full.exact : null,
    parseConfidence: (typeof full?.parseConfidence === 'number' && Number.isFinite(full.parseConfidence)) || typeof full?.parseConfidence === 'string' ? full.parseConfidence : null,
    scorerSha256: typeof full?.scorerSha256 === 'string' ? full.scorerSha256 : null,
    answerValid,
    graded: !error && isRecord(full),
    errorCode: error ? 'SCORER_ERROR' : null,
  }
}

async function privateArtifact(manifest, relativePath, value) {
  const path = join(manifest.parentPrivate, relativePath)
  await save(path, value)
  return { path, sha256: await fileHash(path) }
}

async function privateText(manifest, relativePath, value) {
  if (typeof value !== 'string') return null
  const path = join(manifest.parentPrivate, relativePath)
  await saveText(path, value)
  return { path, sha256: sha(value), bytes: Buffer.byteLength(value) }
}

async function gradeAndArchive(manifest, condition, task, raw, taskGrader) {
  const answer = condition.id === 'D1'
    ? typeof raw === 'string' && raw.trim().length > 0 ? { ok: true, answer: raw } : { ok: false, code: 'ANSWER_MISSING' }
    : parseNativeAnswer(raw)
  const extension = condition.id === 'D1' ? 'txt' : 'json'
  const answerArchive = await privateText(manifest, `answers/${condition.id}.${extension}`, raw)
  if (!answer.ok) return { answer, answerArchive, grade: publicGrade(null, false), fullGradeArchive: null }
  let full
  let scorerError = null
  try { full = await taskGrader(task, answer.answer) } catch (error) { scorerError = error }
  let fullGradeArchive = null
  if (full !== undefined) fullGradeArchive = await privateArtifact(manifest, `grades/${condition.id}.json`, full)
  return { answer, answerArchive, grade: publicGrade(full, true, scorerError), fullGradeArchive }
}

function hasUnknown(ledger, condition) {
  return [...ledger.calls.values()].some(call => call.run === condition.id && call.state !== 'settled')
}

function publicResources(value) {
  if (!isRecord(value)) return null
  return {
    modelRequests: Number.isSafeInteger(value.modelRequests) ? value.modelRequests : null,
    physicalModelRequests: Number.isSafeInteger(value.physicalModelRequests) ? value.physicalModelRequests : null,
    confirmedModelRequests: Number.isSafeInteger(value.confirmedModelRequests) ? value.confirmedModelRequests : null,
    unknownModelRequests: Number.isSafeInteger(value.unknownModelRequests) ? value.unknownModelRequests : null,
    knownUsageTotals: isRecord(value.knownUsageTotals) ? {
      inputTokens: typeof value.knownUsageTotals.inputTokens === 'number' ? value.knownUsageTotals.inputTokens : null,
      outputTokens: typeof value.knownUsageTotals.outputTokens === 'number' ? value.knownUsageTotals.outputTokens : null,
      totalTokens: typeof value.knownUsageTotals.totalTokens === 'number' ? value.knownUsageTotals.totalTokens : null,
    } : null,
    elapsedMs: typeof value.elapsedMs === 'number' ? value.elapsedMs : null,
  }
}

function publicObserved(value) {
  return {
    childModelRequestCount: Number.isSafeInteger(value?.childModelRequestCount) ? value.childModelRequestCount : null,
    rootModelRequestCount: Number.isSafeInteger(value?.rootModelRequestCount) ? value.rootModelRequestCount : null,
    recursionObserved: typeof value?.recursionObserved === 'boolean' ? value.recursionObserved : null,
    childRosterObserved: value?.childRoster?.observed === true,
  }
}

function publicResult(condition, outcome, graded, ledger) {
  const unknown = hasUnknown(ledger, condition) || Number(outcome?.resources?.unknownModelRequests ?? 0) > 0
  const invalidControl = condition.id === 'S0_32' && Number(outcome?.observed?.childModelRequestCount ?? 0) > 0
  const complete = outcome?.executionCompleted === true && outcome?.cleanupComplete === true && graded.answer.ok && graded.grade.graded
  const status = unknown ? 'unknown' : invalidControl ? 'invalid-control' : complete ? 'completed' : 'incomplete'
  return {
    formatVersion: FORMAT_VERSION,
    condition: { id: condition.id, arm: condition.arm, protocol: condition.protocol, taskId: condition.taskId },
    status,
    executionCompleted: outcome?.executionCompleted === true,
    cleanupComplete: outcome?.cleanupComplete === true,
    answerPresent: graded.answer.ok,
    answerArchiveSha256: graded.answerArchive?.sha256 ?? null,
    grade: graded.grade,
    resources: publicResources(outcome?.resources),
    observed: publicObserved(outcome?.observed),
    invalidControl,
    failure: status === 'completed' ? null : status === 'invalid-control' ? { code: 'S0_CHILD_MODEL_REQUEST' } : status === 'unknown' ? { code: 'UNKNOWN_REQUEST_RETAINED' } : { code: graded.answer.code ?? 'CONDITION_INCOMPLETE' },
  }
}

function notRun(condition, reason) {
  return {
    formatVersion: FORMAT_VERSION,
    condition: { id: condition.id, arm: condition.arm, protocol: condition.protocol, taskId: condition.taskId },
    status: 'not-run', executionCompleted: false, cleanupComplete: false, answerPresent: false, answerArchiveSha256: null,
    grade: publicGrade(null, false), resources: null, observed: publicObserved(null), invalidControl: false,
    failure: { code: reason },
  }
}

async function readMaybe(path) {
  try { return await readFile(path, 'utf8') } catch (error) { if (error?.code === 'ENOENT') return null; throw error }
}

async function executeOne({ manifest, task, condition, provider, relay, ledger, credentialFile, taskGrader, directExecutor, nativeExecutor }) {
  let outcome
  let raw = null
  try {
    if (condition.id === 'D1') {
      outcome = await directExecutor({ manifest, condition: { ...condition, publicPrompt: directPrompt(task) }, provider, relay, ledger })
      raw = outcome.answerText ?? null
    } else {
      const projected = { id: task.id, inputFiles: { 'inputs/context.txt': task.context }, instruction: condition.prompt.task }
      outcome = await nativeExecutor({
        manifest, condition, provider, ledger, relay, task: projected,
        grade: () => ({ schemaValid: true, primaryScore: null, errors: [] }),
        protectedRoots: [...manifest.protectedRoots, dirname(absolute(credentialFile, 'credentialFile'))],
      })
      raw = await readMaybe(join(condition.workspace, 'answer.json'))
    }
  } catch (error) {
    outcome = { executionCompleted: false, cleanupComplete: false, resources: null, observed: null, internalError: redact(error instanceof Error ? error.message : error) }
  }
  const rawOutcome = await privateArtifact(manifest, `outcomes/${condition.id}.json`, outcome)
  const graded = await gradeAndArchive(manifest, condition, task, raw, taskGrader)
  const result = publicResult(condition, outcome, graded, ledger)
  return { result, rawOutcome }
}

function realRuntime() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node.split('.')[0] !== '22'
    || process.env.NO_PROXY !== 'chatgpt.com' || dns.getDefaultResultOrder() !== 'ipv4first' || net.getDefaultAutoSelectFamily() !== false) {
    fail('CONTROL_NETWORK', 'real run requires Node 22/macOS arm64, NO_PROXY=chatgpt.com, ipv4first, and autoSelectFamily=false')
  }
}

function proofIsolationPassed(value) {
  return isRecord(value) && value.publicInputRead === true
    && value.inputWriteErrno === 1 && value.protectedCanaryReadErrno === 1 && value.publicSocketErrno === 1
}

async function captureProofArtifact(manifest, path, label) {
  const file = await regular(path, label)
  if (!inside(manifest.parentPrivate, file)) fail('CONTROL_PROOF_EVIDENCE', `${label} escaped parent-private evidence storage`)
  return { path: file, sha256: await fileHash(file) }
}

async function verifyProofArtifact(manifest, artifact, label) {
  if (!isRecord(artifact) || typeof artifact.path !== 'string' || !SHA256.test(artifact.sha256 ?? '')) {
    fail('CONTROL_PROOF_EVIDENCE', `${label} artifact metadata is invalid`)
  }
  const file = await regular(artifact.path, label)
  if (!inside(manifest.parentPrivate, file) || await fileHash(file) !== artifact.sha256.toLowerCase()) {
    fail('CONTROL_PROOF_EVIDENCE', `${label} evidence bytes changed`)
  }
  return file
}

async function readProofArtifact(manifest, artifact, label) {
  return readJson(await verifyProofArtifact(manifest, artifact, label), label)
}

async function captureFixtureArtifacts(manifest, arm, evidenceRoot) {
  const names = arm === 'S0'
    ? { sandbox: 'workspace/sandbox-receipt.json', spawn: 'workspace/s0-receipt.json' }
    : {
        sandbox: 'workspace/sandbox-receipt.json',
        childSandbox: 'workspace/child-sandbox-receipt.json',
        root: 'workspace/root-receipt.json',
        child: 'workspace/child-receipt.json',
      }
  const values = {}
  for (const [name, relativePath] of Object.entries(names)) {
    values[name] = await captureProofArtifact(manifest, join(evidenceRoot, relativePath), `${arm} fixture ${name}`)
  }
  return values
}

async function proofArm({ arm, manifest, output }) {
  const fixtureArm = arm === 'S0' ? 'S0' : 'S'
  const fixture = await prepareFixture({ sourceRoot: manifest.runner.sourceRoot, shared: manifest.shared.path, tempRoot: join(manifest.tmpRoot, 'proof', arm), artifactRoot: join(output, 'parent-private', 'native-proof', arm, 'fixture'), arm: fixtureArm })
  const condition = {
    ...fixture.condition,
    id: `proof-${arm}`,
    arm,
    protocol: 'quality-control-v1',
    autonomous: { maxTurns: 32, maxTokens: 4_000_000, gate: 'test -s answer.json' },
  }
  const ledger = await Ledger.open(join(fixture.condition.durableDirectory, 'proof-ledger.jsonl'), { total: 32, perRun: 32 })
  const providerFixture = createSyntheticProvider({ arm: fixtureArm, fixture: fixture.fixture })
  let outcome
  try {
    outcome = await executeCondition({
      manifest: { ...manifest, parentPrivate: fixture.parentPrivate }, condition, provider: providerFixture.provider,
      ledger, relay: { async restoreOptions(options) { return options } }, task: fixture.task,
      grade: gradeFixture, protectedRoots: [fixture.protectedCanaryRoot],
    })
  } finally {
    await providerFixture.provider.close()
  }
  const proofDirectory = join(manifest.parentPrivate, 'native-proof', arm)
  const outcomePath = join(proofDirectory, 'outcome.json')
  const providerStatsPath = join(proofDirectory, 'provider-stats.json')
  await save(outcomePath, outcome)
  await save(providerStatsPath, providerFixture.stats())
  const evidenceRoot = await directory(outcome.nativeEvidence, `${arm} retained native evidence`)
  if (!inside(manifest.parentPrivate, evidenceRoot)) fail('CONTROL_PROOF_EVIDENCE', `${arm} native evidence escaped parent-private storage`)
  const workerResult = await captureProofArtifact(manifest, join(evidenceRoot, 'parent-worker-result.json'), `${arm} retained worker result`)
  const retainedWorker = await readProofArtifact(manifest, workerResult, `${arm} retained worker result`)
  const rawResult = retainedWorker.result?.raw
  const originalJournal = arm === 'R' ? rawResult?.rawJournal : rawResult?.nativeJournal
  if (typeof originalJournal !== 'string' || !inside(condition.runDirectory, originalJournal)) {
    fail('CONTROL_PROOF_EVIDENCE', `${arm} worker did not retain its native journal path`)
  }
  const evidence = {
    outcome: await captureProofArtifact(manifest, outcomePath, `${arm} retained outcome`),
    workerResult,
    nativeJournal: await captureProofArtifact(manifest, join(evidenceRoot, relative(condition.runDirectory, originalJournal)), `${arm} retained native journal`),
    providerStats: await captureProofArtifact(manifest, providerStatsPath, `${arm} provider fixture stats`),
    fixture: await captureFixtureArtifacts(manifest, arm, evidenceRoot),
  }
  const persistedOutcome = await readProofArtifact(manifest, evidence.outcome, `${arm} retained outcome`)
  const providerStats = await readProofArtifact(manifest, evidence.providerStats, `${arm} provider fixture stats`)
  const base = {
    accepted: persistedOutcome.executionCompleted === true && persistedOutcome.cleanupComplete === true && persistedOutcome.inputsUnchanged === true
      && persistedOutcome.grading?.primaryScore === 1 && providerStats.realModelRequests === 0 && providerStats.providerClosed === true,
    executionCompleted: persistedOutcome.executionCompleted === true,
    cleanupComplete: persistedOutcome.cleanupComplete === true,
    nativeDepth: persistedOutcome.worker?.nativeDepth ?? null,
    actualDepth: persistedOutcome.worker?.actualDepth ?? null,
    requests: persistedOutcome.worker?.requests ?? null,
    childModelRequestCount: persistedOutcome.observed?.childModelRequestCount ?? null,
    provider: providerStats,
    inputUnchanged: persistedOutcome.inputsUnchanged === true,
    evidence,
  }
  if (arm === 'S0') {
    const receipt = await readProofArtifact(manifest, evidence.fixture.spawn, 'S0 fixture spawn receipt')
    const sandbox = await readProofArtifact(manifest, evidence.fixture.sandbox, 'S0 fixture sandbox receipt')
    const executionPathConfirmed = !!rawResult?.hostStartRecord && typeof rawResult?.nativeJournal === 'string'
    return {
      ...base,
      executionPathConfirmed,
      spawnRejected: receipt.spawnRejected === true,
      accepted: base.accepted && base.nativeDepth === 0 && base.actualDepth === 0 && base.requests !== null
        && base.childModelRequestCount === 0 && receipt.spawnRejected === true && isRecord(receipt.rejection)
        && typeof receipt.rejection.type === 'string' && typeof receipt.rejection.message === 'string'
        && proofIsolationPassed(sandbox) && executionPathConfirmed,
    }
  }
  const pathConfirmed = arm === 'R'
    ? rawResult?.kind === 'original-prime-acp' && !!rawResult?.rootSession
    : !!rawResult?.hostStartRecord && typeof rawResult?.nativeJournal === 'string' && rawResult?.kind !== 'original-prime-acp'
  const root = await readProofArtifact(manifest, evidence.fixture.root, `${arm} fixture root receipt`)
  const child = await readProofArtifact(manifest, evidence.fixture.child, `${arm} fixture child receipt`)
  const sandbox = await readProofArtifact(manifest, evidence.fixture.sandbox, `${arm} fixture sandbox receipt`)
  const childSandbox = await readProofArtifact(manifest, evidence.fixture.childSandbox, `${arm} fixture child sandbox receipt`)
  const fixtureAccepted = root.answer === 42 && root.collectSettled === true && root.rootPersistentAcrossCells === true
    && child.persistentAcrossCells === true && child.sameWorkspaceInput === true
    && typeof child.inputSha256 === 'string' && root.childInputSha256 === child.inputSha256
    && proofIsolationPassed(sandbox) && childSandbox.actor === 'child' && proofIsolationPassed(childSandbox)
  return {
    ...base,
    executionPathConfirmed: pathConfirmed,
    accepted: base.accepted && base.nativeDepth === 1 && base.actualDepth === 1 && base.requests === 8
      && base.childModelRequestCount === 3 && providerStats.syntheticPhysicalAdmissions === 8 && pathConfirmed && fixtureAccepted,
  }
}

/** Execute the zero-real-model proof for R32, S32 and S0_32. */
export async function acceptControlled(output) {
  const { root, manifest } = await readPrepared(output)
  const prepared = await verifyPrepared(manifest)
  if (await exists(join(manifest.parentPrivate, ACCEPTED))) fail('CONTROL_PROOF_REPLAY', 'native proof already exists')
  const before = await sourceHashes(prepared.source)
  const arms = {}
  for (const arm of ['R', 'S', 'S0']) arms[arm] = await proofArm({ arm, manifest, output: root })
  sameHashMap(await sourceHashes(prepared.source), before, 'source changed during native proof')
  const proof = {
    formatVersion: FORMAT_VERSION,
    kind: 'quality-controlled-native-proof-v1',
    fingerprint: manifest.fingerprint,
    preparedSha256: await fileHash(join(root, PREPARED)),
    sourceHashes: manifest.sources,
    compiledHash: manifest.shared.compiled.hash,
    runtimeManifestSha256: manifest.shared.runtime.manifest.sha256,
    realModelRequests: 0,
    noCredentialsOrRealProviderLoaded: true,
    accepted: arms.R.accepted === true && arms.S.accepted === true && arms.S0.accepted === true,
    limits: { parent: 97, native: 32, D1: 1, R32: 32, S32: 32, S0_32: 32 },
    strategyModelAdherenceVerified: false,
    arms,
  }
  await save(join(manifest.parentPrivate, ACCEPTED), proof)
  return proof
}

async function assertProofArmEvidence(manifest, arm, value) {
  if (!isRecord(value?.evidence) || !isRecord(value.evidence.fixture)) fail('CONTROL_PROOF', `native proof arm ${arm} lacks retained evidence`)
  const outcome = await readProofArtifact(manifest, value.evidence.outcome, `${arm} retained outcome`)
  const worker = await readProofArtifact(manifest, value.evidence.workerResult, `${arm} retained worker result`)
  const journal = await verifyProofArtifact(manifest, value.evidence.nativeJournal, `${arm} retained native journal`)
  const journalInfo = await stat(journal)
  const provider = await readProofArtifact(manifest, value.evidence.providerStats, `${arm} provider fixture stats`)
  if (journalInfo.size < 1 || !inside(dirname(value.evidence.workerResult.path), journal)
    || outcome?.condition?.id !== `proof-${arm}` || outcome?.condition?.arm !== arm
    || outcome?.executionCompleted !== true || outcome?.cleanupComplete !== true || outcome?.inputsUnchanged !== true
    || outcome?.grading?.primaryScore !== 1 || worker?.result?.arm !== arm || worker?.result?.state !== 'completed'
    || provider?.realModelRequests !== 0 || provider?.providerClosed !== true) {
    fail('CONTROL_PROOF', `native proof arm ${arm} retained outcome is incomplete`)
  }
  const raw = worker.result?.raw
  if (arm === 'R') {
    if (raw?.kind !== 'original-prime-acp' || !isRecord(raw.rootSession) || typeof raw.rawJournal !== 'string') {
      fail('CONTROL_PROOF', 'native proof arm R did not retain the original Prime path')
    }
  } else if (!isRecord(raw?.hostStartRecord) || typeof raw.nativeJournal !== 'string' || raw.kind === 'original-prime-acp') {
    fail('CONTROL_PROOF', `native proof arm ${arm} did not retain the plugin host path`)
  }
  if (arm === 'S0') {
    const sandbox = await readProofArtifact(manifest, value.evidence.fixture.sandbox, 'S0 fixture sandbox receipt')
    const spawn = await readProofArtifact(manifest, value.evidence.fixture.spawn, 'S0 fixture spawn receipt')
    if (outcome.worker?.nativeDepth !== 0 || outcome.worker?.actualDepth !== 0 || outcome.observed?.childModelRequestCount !== 0
      || spawn?.spawnRejected !== true || !isRecord(spawn.rejection) || typeof spawn.rejection.type !== 'string'
      || typeof spawn.rejection.message !== 'string' || !proofIsolationPassed(sandbox)) {
      fail('CONTROL_PROOF', 'native proof arm S0 fixture evidence is incomplete')
    }
    return
  }
  const sandbox = await readProofArtifact(manifest, value.evidence.fixture.sandbox, `${arm} fixture sandbox receipt`)
  const childSandbox = await readProofArtifact(manifest, value.evidence.fixture.childSandbox, `${arm} fixture child sandbox receipt`)
  const root = await readProofArtifact(manifest, value.evidence.fixture.root, `${arm} fixture root receipt`)
  const child = await readProofArtifact(manifest, value.evidence.fixture.child, `${arm} fixture child receipt`)
  if (outcome.worker?.nativeDepth !== 1 || outcome.worker?.actualDepth !== 1 || outcome.worker?.requests !== 8
    || outcome.observed?.childModelRequestCount !== 3 || provider?.syntheticPhysicalAdmissions !== 8
    || root?.answer !== 42 || root?.collectSettled !== true || root?.rootPersistentAcrossCells !== true
    || child?.persistentAcrossCells !== true || child?.sameWorkspaceInput !== true
    || typeof child?.inputSha256 !== 'string' || root?.childInputSha256 !== child.inputSha256
    || !proofIsolationPassed(sandbox) || childSandbox?.actor !== 'child' || !proofIsolationPassed(childSandbox)) {
    fail('CONTROL_PROOF', `native proof arm ${arm} fixture evidence is incomplete`)
  }
}

async function assertAcceptance(manifest) {
  const path = join(manifest.parentPrivate, ACCEPTED)
  const proof = await readJson(path, 'controlled native proof')
  if (!isRecord(proof) || proof.kind !== 'quality-controlled-native-proof-v1' || proof.accepted !== true
    || proof.fingerprint !== manifest.fingerprint || proof.preparedSha256 !== await fileHash(join(manifest.output, PREPARED))
    || proof.realModelRequests !== 0 || proof.noCredentialsOrRealProviderLoaded !== true
    || proof.compiledHash !== manifest.shared.compiled.hash || proof.runtimeManifestSha256 !== manifest.shared.runtime.manifest.sha256
    || proof.strategyModelAdherenceVerified !== false || canonicalHash(proof.sourceHashes) !== canonicalHash(manifest.sources)) {
    fail('CONTROL_PROOF', 'native proof does not bind this prepared panel')
  }
  for (const arm of ['R', 'S']) {
    const value = proof.arms?.[arm]
    if (!isRecord(value) || value.accepted !== true || value.executionCompleted !== true || value.cleanupComplete !== true
      || value.nativeDepth !== 1 || value.actualDepth !== 1 || value.requests !== 8 || value.childModelRequestCount !== 3 || value.executionPathConfirmed !== true) {
      fail('CONTROL_PROOF', `native proof arm ${arm} is incomplete`)
    }
    await assertProofArmEvidence(manifest, arm, value)
  }
  const s0 = proof.arms?.S0
  if (!isRecord(s0) || s0.accepted !== true || s0.executionCompleted !== true || s0.cleanupComplete !== true
    || s0.nativeDepth !== 0 || s0.actualDepth !== 0 || s0.childModelRequestCount !== 0 || s0.spawnRejected !== true || s0.executionPathConfirmed !== true) {
    fail('CONTROL_PROOF', 'native proof arm S0 is incomplete')
  }
  await assertProofArmEvidence(manifest, 'S0', s0)
  return { path, sha256: await fileHash(path), proof }
}

function assertRunArgs({ providerModule, providerSha256, providerPackage, credentialFile }) {
  if (typeof providerModule !== 'string' || !isAbsolute(providerModule) || !SHA256.test(providerSha256 ?? '')
    || typeof providerPackage !== 'string' || providerPackage.trim().length === 0
    || typeof credentialFile !== 'string' || !isAbsolute(credentialFile)) fail('CONTROL_ARGS', 'run requires provider module/hash/package and credential file')
}

async function preflight({ output, taskLoader = loadTask } = {}) {
  const { root, manifest } = await readPrepared(output)
  const prepared = await verifyPrepared(manifest, { taskLoader })
  await assertUnclaimed(root, manifest)
  const proof = await assertAcceptance(manifest)
  return { root, manifest, task: prepared.task, proof }
}

/** The only real-provider entry point; no retry or cross-output continuation exists. */
export async function runControlled({
  output,
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
  runtimeAssert = realRuntime,
} = {}) {
  const ready = await preflight({ output, taskLoader })
  assertRunArgs({ providerModule, providerSha256, providerPackage, credentialFile })
  const modulePath = await regular(providerModule, 'provider module')
  if (await fileHash(modulePath) !== providerSha256.toLowerCase()) fail('CONTROL_PROVIDER_HASH', 'provider module hash differs')
  await regular(credentialFile, 'credential file') // metadata only; contents remain unread until loadRealProvider.
  runtimeAssert()
  const { root, manifest, task, proof } = ready
  const records = new Map()
  let base
  let ledger
  let provider
  let relay
  let longRead
  let network
  let error = null
  let stage = 'claim'
  let stopReason = 'all conditions processed'
  const closes = {}
  const originalFetch = globalThis.fetch
  try {
    await claim(manifest, root)
    stage = 'ledger'
    base = await Ledger.open(manifest.ledger.path, { total: 97, perRun: 32 })
    const initial = await base.receipt()
    if (initial.newAdmitted !== 0 || initial.priorAdmitted !== 0 || initial.stopped) fail('CONTROL_LEDGER', 'prepared ledger is not fresh')
    ledger = controlledBudget(base, manifest.conditions, manifest.prior.receipt.accounting)
    stage = 'provider-setup'
    longRead = longReadProfileFactory({ baseFetch: originalFetch, bodyTimeoutMs: CONTROL_LIMITS.wallTimeMs })
    network = networkProfileInstaller({ baseFetch: longRead.fetch, onDiagnostic: event => base.appendSync({ type: 'network-diagnostic', event }) })
    globalThis.fetch = network.fetch
    relay = await relayFactory({ sourceRoot: manifest.runner.sourceRoot, dataRoot: join(manifest.parentPrivate, 'attachments') })
    provider = await providerLoader({
      providerModule, providerSha256, providerPackage, credentialFile,
      dataRoot: join(manifest.parentPrivate, 'provider-private'), sourceRoot: manifest.runner.sourceRoot,
      maxModelRequests: 97, attachments: relay.store,
      onPhysical: () => fail('CONTROL_PHYSICAL_SCOPE', 'physical request occurred outside a condition dispatcher'),
      onTransportEvent: event => base.appendSync({ type: 'transport-event', event }),
    })
    stage = 'conditions'
    for (const condition of manifest.conditions) {
      if (ledger.stopped) { stopReason = 'UNKNOWN_REQUEST_RETAINED'; break }
      const startPath = join(condition.markerDirectory, 'real-condition-started.json')
      await save(startPath, { formatVersion: FORMAT_VERSION, fingerprint: manifest.fingerprint, id: condition.id, arm: condition.arm, startedAt: new Date().toISOString() })
      const { result } = await executeOne({ manifest, task, condition, provider, relay, ledger, credentialFile, taskGrader, directExecutor, nativeExecutor })
      await save(join(condition.markerDirectory, 'result.json'), result)
      records.set(condition.id, result)
      if (result.status === 'unknown' || result.cleanupComplete !== true || ledger.stopped) {
        stopReason = result.status === 'unknown' ? 'UNKNOWN_REQUEST_RETAINED' : result.cleanupComplete !== true ? 'CLEANUP_INCOMPLETE' : 'LEDGER_STOPPED'
        break
      }
    }
  } catch (caught) {
    error = publicError(caught)
    await privateArtifact(manifest, 'errors/run-error.json', { message: redact(caught instanceof Error ? caught.message : caught) }).catch(() => {})
    stopReason = 'SETUP_OR_EXECUTION_ERROR'
  } finally {
    try { await provider?.close?.(); closes.provider = provider ? 'closed' : 'not-loaded' } catch (caught) { closes.provider = 'failed'; error ??= publicError(caught) }
    try { await relay?.close?.(); closes.relay = relay ? 'closed' : 'not-created' } catch (caught) { closes.relay = 'failed'; error ??= publicError(caught) }
    try { network?.dispose?.(); closes.networkProfile = network ? 'closed' : 'not-created' } catch (caught) { closes.networkProfile = 'failed'; error ??= publicError(caught) }
    try { await longRead?.close?.(); closes.longReadProfile = longRead ? 'closed' : 'not-created' } catch (caught) { closes.longReadProfile = 'failed'; error ??= publicError(caught) }
    globalThis.fetch = originalFetch
  }
  for (const condition of manifest.conditions) {
    if (records.has(condition.id)) continue
    const result = notRun(condition, stopReason)
    await save(join(condition.markerDirectory, 'result.json'), result)
    records.set(condition.id, result)
  }
  const accounting = ledger ? await ledger.receipt() : base ? await base.receipt() : null
  const results = manifest.conditions.map(condition => records.get(condition.id))
  const closeFailed = Object.values(closes).some(value => value === 'failed')
  if (closeFailed) {
    error ??= { code: 'CONTROL_CLOSE_FAILED' }
    if (stopReason === 'all conditions processed') stopReason = 'CLOSE_FAILED'
  }
  const status = error || closeFailed
    ? 'error'
    : results.every(result => result?.status === 'completed' && result.executionCompleted === true && result.cleanupComplete === true && result.answerPresent === true && result.grade?.graded === true)
      ? 'completed'
      : 'incomplete'
  const receipt = {
    formatVersion: FORMAT_VERSION,
    kind: 'quality-controlled-final-receipt-v1',
    status,
    completedAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    configuredRoute: { provider: manifest.route.provider, model: manifest.route.model, reasoningEffort: manifest.route.reasoningEffort, configuredMaxOutputTokens: manifest.route.configuredMaxOutputTokens },
    authorization: { sha256: manifest.prior.authorization.sha256, cumulativeCap: 700, newMaximum: 97, cumulativeMaximum: 697 },
    nativeProofSha256: proof.sha256,
    strategyModelAdherenceVerified: false,
    results,
    accounting: accounting ? {
      prefix: manifest.prior.receipt.accounting,
      new: { admitted: accounting.newAdmitted, confirmed: accounting.settled, unknown: accounting.unknown, physicalAdmitted: accounting.physicalAdmitted },
      cumulative: { admitted: accounting.cumulativeAdmitted, confirmed: accounting.cumulativeConfirmed, unknown: accounting.cumulativeUnknown, cap: 700, withinCap: accounting.cumulativeAdmitted <= 700 },
      stopped: accounting.stopped,
    } : null,
    claimState: await claimState(manifest, root),
    stage,
    closes,
    stopReason,
    error,
  }
  await save(join(root, RECEIPT), receipt)
  return receipt
}

export function parseArgs(argv) {
  const result = { mode: undefined }
  const options = new Map([
    ['--output', 'output'], ['--tmp-root', 'tmpRoot'], ['--prior', 'prior'], ['--authorization', 'authorization'], ['--task', 'taskPath'],
    ['--provider-module', 'providerModule'], ['--provider-sha256', 'providerSha256'], ['--provider-package', 'providerPackage'], ['--credential-file', 'credentialFile'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (['--prepare', '--accept', '--run'].includes(value)) {
      if (result.mode) fail('CONTROL_ARGS', 'choose exactly one mode')
      result.mode = value.slice(2)
      continue
    }
    const property = options.get(value)
    if (!property || index + 1 >= argv.length || argv[index + 1].startsWith('--') || result[property] !== undefined) fail('CONTROL_ARGS', `unknown, duplicate, or incomplete argument ${String(value)}`)
    result[property] = argv[index + 1]
    index += 1
  }
  if (!result.mode || !result.output) fail('CONTROL_ARGS', 'mode and --output are required')
  const prep = ['tmpRoot', 'prior', 'authorization']
  const run = ['providerModule', 'providerSha256', 'providerPackage', 'credentialFile']
  if (result.mode === 'prepare') {
    if (prep.some(name => !result[name]) || run.some(name => result[name] !== undefined)) fail('CONTROL_ARGS', 'prepare requires tmp-root, prior, authorization, and no provider arguments')
  } else if (result.mode === 'accept') {
    if (prep.some(name => result[name] !== undefined) || run.some(name => result[name] !== undefined) || result.taskPath !== undefined) fail('CONTROL_ARGS', 'accept uses only --output')
  } else if (prep.some(name => result[name] !== undefined) || run.some(name => !result[name]) || result.taskPath !== undefined) {
    fail('CONTROL_ARGS', 'run requires provider arguments and no preparation arguments')
  }
  return result
}

function directEntrypoint() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (directEntrypoint()) {
  const args = parseArgs(process.argv.slice(2))
  const action = args.mode === 'prepare' ? prepareControlled : args.mode === 'accept' ? () => acceptControlled(args.output) : runControlled
  action(args).then(result => {
    process.stdout.write(`${JSON.stringify({ kind: result.kind, fingerprint: result.fingerprint, accepted: result.accepted, realModelRequests: result.realModelRequests, accounting: result.accounting ?? null })}\n`)
  }).catch(error => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}
