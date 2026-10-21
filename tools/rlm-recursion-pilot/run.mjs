#!/opt/homebrew/opt/node@22/bin/node

/**
 * Parent-side runner for the fixed Prime recursion ablation.
 *
 * The worker receives only public task files.  Oracle data, the random task
 * salt, accounting, provider state, and durable request records remain in the
 * parent-owned output tree.  Importing this module has no provider, network,
 * or credential side effect.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  cp,
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
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  compileCurrentSources,
  createModelDispatcher,
  loadRealProvider,
  prepareSharedRuntime,
  reserveBridgePort,
  spawnNativeWorker,
  summarizeConditionResources,
} from '../rlm-arc-pilot/run.mjs'
import { createAttachmentRelay } from '../rlm-arc-pilot/attachment-relay.mjs'
import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { policy as sandboxPolicy } from '../rlm-arc-pilot/sandbox.mjs'
import { aggregateBudgetView, serializeDispatcher } from './control.mjs'
import { auditTask, gradeTask } from './grader.mjs'
import { prepareTasks } from './tasks.mjs'

const execFile = promisify(execFileCallback)
const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(TOOL_DIRECTORY, '../..')
const ARC_TOOL_DIRECTORY = resolve(TOOL_DIRECTORY, '../rlm-arc-pilot')

const DEFAULT_OUTPUT = '/Users/sihaoli/Projects/DeepSeek-Solar-Harness-V4/artifacts/rlm-recursion-20261021'
const TEMP_BASE = process.platform === 'darwin' ? '/private/tmp' : resolve(tmpdir())
const DEFAULT_TMP_ROOT = join(TEMP_BASE, 'rr2')
const DEFAULT_PLAN = join(REPOSITORY_ROOT, 'docs/testing/prime-rlm-recursion-plan.json')
const PREPARED_FILE = 'prepared.json'
const RUN_START_FILE = 'real-run-started.json'
const RUN_RECEIPT_FILE = 'run-receipt.json'
const FORMAT_VERSION = 1
const SHA256 = /^[a-f0-9]{64}$/i

const FIXED_ROUTE = Object.freeze({
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  maxOutputTokens: 16_384,
})

const FIXED_LIMITS = Object.freeze({
  perTreeRequests: 14,
  newPanelRequests: 56,
  cumulativeCap: 522,
  priorCharged: 463,
  priorConfirmed: 456,
  priorUnknown: 7,
  wallTimeMs: 1_200_000,
  autonomousMaxTurns: 14,
  autonomousMaxTokens: 4_000_000,
  physicalConcurrency: 1,
})

const EXECUTION_FILES = Object.freeze([
  'tools/rlm-recursion-pilot/run.mjs',
  'tools/rlm-recursion-pilot/control.mjs',
  'tools/rlm-recursion-pilot/tasks.mjs',
  'tools/rlm-recursion-pilot/grader.mjs',
  'tools/rlm-arc-pilot/run.mjs',
  'tools/rlm-arc-pilot/native-worker.mjs',
  'tools/rlm-arc-pilot/sandbox.mjs',
  'tools/rlm-arc-pilot/ledger.mjs',
  'tools/rlm-arc-pilot/attachment-relay.mjs',
  'package.json',
  'pnpm-lock.yaml',
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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalHash(value) {
  return sha256Bytes(stableJson(value))
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path))
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('RLM_RUNNER_ARGS', `${label} must be an absolute path`)
  return resolve(value)
}

function isWithin(root, candidate) {
  const difference = relative(root, candidate)
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(difference))
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
  try {
    info = await stat(absolute)
  } catch (error) {
    fail('RLM_PATH_MISSING', `${label} is unavailable: ${absolute}`, { cause: error })
  }
  if (!info.isDirectory()) fail('RLM_PATH_TYPE', `${label} is not a directory: ${absolute}`)
  return absolute
}

async function assertRegularFile(path, label) {
  const absolute = requireAbsolute(path, label)
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    fail('RLM_PATH_MISSING', `${label} is unavailable: ${absolute}`, { cause: error })
  }
  if (!info.isFile()) fail('RLM_PATH_TYPE', `${label} is not a regular file: ${absolute}`)
  return absolute
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    fail('RLM_JSON', `${label} is not valid JSON: ${path}`, { cause: error })
  }
}

async function writeExclusiveJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

async function appendDurableJson(path, value) {
  const handle = await open(path, 'a', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify({ formatVersion: FORMAT_VERSION, time: new Date().toISOString(), ...value })}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function gitHead(sourceRoot) {
  try {
    const result = await execFile('git', ['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', maxBuffer: 1_000_000 })
    const head = result.stdout.trim()
    if (!/^[a-f0-9]{40}$/i.test(head)) fail('RLM_SOURCE_HEAD', 'git did not return a commit SHA')
    return head
  } catch (error) {
    if (error?.code === 'RLM_SOURCE_HEAD') throw error
    fail('RLM_SOURCE_HEAD', `cannot determine source HEAD: ${redact(error?.stderr ?? error?.message)}`, { cause: error })
  }
}

async function executionHashes(sourceRoot) {
  const files = {}
  for (const name of EXECUTION_FILES) files[name] = await sha256File(join(sourceRoot, name))
  return files
}

function requireSha256(value, label, code = 'RLM_HASH') {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code, `${label} must be a SHA-256 digest`)
  return value.toLowerCase()
}

function assertEqual(value, expected, code, label) {
  if (value !== expected) fail(code, `${label} must be ${JSON.stringify(expected)}`)
}

function quoteShell(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`
}

function publicTaskKind(task) {
  const kind = task?.privateGold?.taskKind
  return typeof kind === 'string' ? kind.toUpperCase() : null
}

function taskFingerprint(task) {
  return canonicalHash({
    id: task.id,
    family: task.family,
    instruction: task.instruction,
    inputFiles: task.inputFiles,
    recordCount: task.recordCount,
    provenance: task.provenance,
  })
}

function conditionKey(taskIndex, arm) {
  return `${String(taskIndex + 1).padStart(2, '0')}${arm}`
}

function expectedConditionOrder(plan) {
  const output = []
  for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex += 1) {
    for (const arm of plan.tasks[taskIndex].order) output.push({ taskIndex, arm })
  }
  return output
}

function immutablePublicGateScript() {
  return `#!/usr/bin/env python3
import json
import pathlib
import sys

workspace = pathlib.Path(sys.argv[1])
kind = sys.argv[2]
if kind not in ('Q02', 'Q03'):
    raise SystemExit('invalid task kind')

records_path = workspace / 'inputs' / 'records.jsonl'
answer_path = workspace / 'answer.json'
try:
    record_rows = [json.loads(line) for line in records_path.read_text('utf-8').splitlines() if line]
    answer = json.loads(answer_path.read_text('utf-8'))
except Exception as exc:
    raise SystemExit('unreadable output: ' + str(exc))

if not isinstance(answer, dict) or set(answer) - {'labels', 'counts', 'pairs'}:
    raise SystemExit('answer must be a JSON object with only schema fields')
expected_ids = [row.get('id') for row in record_rows]
if any(not isinstance(value, str) for value in expected_ids) or len(set(expected_ids)) != len(expected_ids):
    raise SystemExit('public records have invalid ids')
public_users = {row.get('user') for row in record_rows}
if any(not isinstance(value, str) for value in public_users):
    raise SystemExit('public records have invalid users')
labels = answer.get('labels')
if not isinstance(labels, list) or len(labels) != len(expected_ids):
    raise SystemExit('labels do not cover the public record count')
seen = set()
for label in labels:
    if not isinstance(label, dict) or set(label) != {'id', 'label'}:
        raise SystemExit('each label needs exactly id and label')
    if not isinstance(label['id'], str) or label['id'] in seen or label['id'] not in expected_ids:
        raise SystemExit('labels contain duplicate or unknown ids')
    if label['label'] not in ('entailment', 'contradiction', 'neutral'):
        raise SystemExit('labels contain an invalid semantic label')
    seen.add(label['id'])
if seen != set(expected_ids):
    raise SystemExit('labels are incomplete')
counts = answer.get('counts')
if not isinstance(counts, dict) or set(counts) != {'entailment', 'contradiction', 'neutral'}:
    raise SystemExit('counts must have exactly three label fields')
if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in counts.values()):
    raise SystemExit('counts must be integers')
if sum(counts.values()) != len(expected_ids):
    raise SystemExit('counts must total the public record count')
if kind == 'Q03':
    pairs = answer.get('pairs')
    if not isinstance(pairs, list):
        raise SystemExit('Q03 requires pairs')
    pair_seen = set()
    for pair in pairs:
        if not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(value, str) for value in pair):
            raise SystemExit('pairs must be two public-user strings')
        if pair[0] not in public_users or pair[1] not in public_users:
            raise SystemExit('pairs contain an unknown public user')
        if pair[0] >= pair[1] or tuple(pair) in pair_seen:
            raise SystemExit('pairs must be sorted and unique')
        pair_seen.add(tuple(pair))
elif 'pairs' in answer:
    raise SystemExit('Q02 must not contain pairs')
`
}

function gateCommand({ python, script, workspace, kind }) {
  return `env -i PATH=${quoteShell(dirname(python))} HOME=${quoteShell(join(workspace, '.home'))} TMPDIR=${quoteShell(join(workspace, '.tmp'))} ${quoteShell(python)} ${quoteShell(script)} ${quoteShell(workspace)} ${quoteShell(kind)}`
}

function planTaskExpectation(index) {
  return index === 0
    ? { rowId: 715070021, window: 70016, records: 438, kind: 'Q02', order: ['S0', 'S'] }
    : { rowId: 715070046, window: 70017, records: 438, kind: 'Q03', order: ['S', 'S0'] }
}

/** Validate the immutable paid-run boundary without reading a provider. */
export async function loadPlan(planPath = DEFAULT_PLAN, sourceRoot = REPOSITORY_ROOT) {
  const source = await assertDirectory(sourceRoot, 'sourceRoot')
  const path = await assertRegularFile(planPath, 'plan')
  const plan = await readJson(path, 'plan')
  if (!isRecord(plan) || plan.formatVersion !== 1 || plan.kind !== 'native-recursion-ablation-v1') {
    fail('RLM_PLAN_FORMAT', 'plan must be native-recursion-ablation-v1 formatVersion 1')
  }
  assertEqual(plan.status, 'approved-keyless-pending', 'RLM_PLAN_STATUS', 'plan status')
  if (!isRecord(plan.model)
    || plan.model.provider !== FIXED_ROUTE.provider
    || plan.model.id !== FIXED_ROUTE.model
    || plan.model.reasoningEffort !== FIXED_ROUTE.reasoningEffort
    || plan.model.maxOutputTokens !== FIXED_ROUTE.maxOutputTokens) {
    fail('RLM_PLAN_ROUTE', 'plan model route differs from openai-codex/gpt-6.1-sol/high/16384')
  }
  if (!isRecord(plan.arms) || plan.arms.S0?.maxDepth !== 0 || plan.arms.S?.maxDepth !== 1) {
    fail('RLM_PLAN_ARMS', 'plan must freeze S0 depth 0 and S depth 1')
  }
  if (!isRecord(plan.limits)
    || plan.limits.perTreeRequests !== FIXED_LIMITS.perTreeRequests
    || plan.limits.newPanelRequests !== FIXED_LIMITS.newPanelRequests
    || plan.limits.cumulativeCap !== FIXED_LIMITS.cumulativeCap
    || plan.limits.wallTimeMs !== FIXED_LIMITS.wallTimeMs
    || plan.limits.autonomousMaxTurns !== FIXED_LIMITS.autonomousMaxTurns
    || plan.limits.autonomousMaxTokens !== FIXED_LIMITS.autonomousMaxTokens
    || plan.limits.physicalConcurrency !== FIXED_LIMITS.physicalConcurrency
    || plan.limits.factoryEnabled !== false
    || plan.limits.harnessRefinements !== false
    || plan.limits.crossTaskLearning !== false) {
    fail('RLM_PLAN_LIMITS', 'plan limits differ from the approved 14/56/522 recursion panel')
  }
  if (!isRecord(plan.prior)
    || plan.prior.charged !== FIXED_LIMITS.priorCharged
    || plan.prior.confirmed !== FIXED_LIMITS.priorConfirmed
    || plan.prior.unknown !== FIXED_LIMITS.priorUnknown
    || plan.prior.rawLedgerCurrentlyAvailable !== false
    || plan.prior.charged !== plan.prior.confirmed + plan.prior.unknown
    || plan.prior.evidence !== 'docs/testing/prime-rlm-arc-results.json'
    || plan.prior.evidenceSha256 !== '8137f1224b211622ec941cabf49375b6f9bf5817750728b2e0b1a792a3abcd57') {
    fail('RLM_PLAN_PRIOR', 'plan must retain the verified 463 = 456 + 7 historical prefix')
  }
  const priorEvidencePath = resolve(source, plan.prior.evidence)
  if (!isWithin(source, priorEvidencePath)) fail('RLM_PLAN_PRIOR', 'historical evidence escapes source root')
  const priorEvidence = await assertRegularFile(priorEvidencePath, 'historical aggregate evidence')
  const priorEvidenceSha256 = await sha256File(priorEvidence)
  if (priorEvidenceSha256 !== plan.prior.evidenceSha256) fail('RLM_PLAN_PRIOR_HASH', 'historical aggregate evidence hash changed')
  if (!Array.isArray(plan.tasks) || plan.tasks.length !== 2) fail('RLM_PLAN_TASKS', 'plan must contain exactly two fixed tasks')
  for (let index = 0; index < plan.tasks.length; index += 1) {
    const expected = planTaskExpectation(index)
    const task = plan.tasks[index]
    if (!isRecord(task)
      || task.rowId !== expected.rowId
      || task.window !== expected.window
      || task.records !== expected.records
      || task.kind !== expected.kind
      || JSON.stringify(task.order) !== JSON.stringify(expected.order)) {
      fail('RLM_PLAN_TASKS', `task ${String(index + 1)} differs from the fixed paired panel`)
    }
  }
  return {
    path,
    plan,
    hash: await sha256File(path),
    canonicalHash: canonicalHash(plan),
    priorEvidence: { path: priorEvidence, sha256: priorEvidenceSha256 },
  }
}

function validatePreparedTasks(tasks, plan) {
  if (!Array.isArray(tasks) || tasks.length !== plan.tasks.length) fail('RLM_TASKS', 'source rows did not produce the two fixed tasks')
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]
    const expected = plan.tasks[index]
    const audit = auditTask(task)
    if (!audit.ok) fail('RLM_TASK_AUDIT', `task ${String(index + 1)} failed independent public/private audit: ${audit.errors.join('; ')}`)
    if (task?.provenance?.rowId !== expected.rowId
      || task?.provenance?.contextWindowId !== expected.window
      || task?.recordCount !== expected.records
      || publicTaskKind(task) !== expected.kind) {
      fail('RLM_TASK_PIN', `prepared task ${String(index + 1)} does not match its frozen row/kind pin`)
    }
  }
}

async function assertPrepareOutput(output, sourceRowsPath) {
  const root = await assertDirectory(output, 'output')
  const entries = await readdir(root, { withFileTypes: true })
  if (entries.some(entry => entry.name !== 'parent-private')) {
    fail('RLM_OUTPUT_NOT_FRESH', 'output may contain only parent-private source material before preparation')
  }
  const parentPrivate = await assertDirectory(join(root, 'parent-private'), 'output/parent-private')
  const sourceRows = await assertRegularFile(sourceRowsPath ?? join(parentPrivate, 'source-rows.json'), 'source rows')
  if (!isWithin(parentPrivate, sourceRows)) fail('RLM_SOURCE_SCOPE', 'source rows must stay under output/parent-private')
  if (await exists(join(root, PREPARED_FILE))) fail('RLM_PREPARED_EXISTS', 'prepared manifest already exists; do not overwrite a panel')
  return { root, parentPrivate, sourceRows }
}

async function createFreshTmpRoot(tmpRoot) {
  const root = requireAbsolute(tmpRoot, 'tmpRoot')
  if (!isWithin(TEMP_BASE, root) || root === TEMP_BASE) fail('RLM_TMP_SCOPE', `tmpRoot must be a fresh descendant of ${TEMP_BASE}`)
  if (await exists(root)) fail('RLM_TMP_EXISTS', `tmpRoot already exists: ${root}`)
  const nativeSocket = join(root, 'runs', '04S0', 'tmp', `prime-agent-${String(process.getuid?.() ?? 501)}`, 'worker-000000000000-000000000000.sock')
  if (Buffer.byteLength(nativeSocket) >= 100) fail('RLM_SOCKET_PATH', `native worker socket path is too long: ${nativeSocket}`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  return root
}

async function writePublicInputs(workspace, task) {
  for (const [relativePath, text] of Object.entries(task.inputFiles ?? {})) {
    if (typeof text !== 'string' || relativePath.startsWith('/') || relativePath.split('/').includes('..')) {
      fail('RLM_PUBLIC_INPUT', 'task contains an invalid public input path')
    }
    const path = resolve(workspace, relativePath)
    if (!isWithin(workspace, path)) fail('RLM_PUBLIC_INPUT', 'task input escapes workspace')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  }
}

async function hashPublicInputs(workspace, task) {
  const hashes = {}
  for (const relativePath of Object.keys(task.inputFiles ?? {}).sort()) {
    const path = resolve(workspace, relativePath)
    hashes[relativePath] = await sha256File(path)
  }
  return hashes
}

async function prepareConditionDirectories({ output, tmpRoot, sharedRuntimeRoot, gatePython, gateScript, plan, tasks }) {
  const conditions = []
  let ordinal = 0
  for (const { taskIndex, arm } of expectedConditionOrder(plan)) {
    const task = tasks[taskIndex]
    const id = conditionKey(taskIndex, arm)
    const runDirectory = join(tmpRoot, 'runs', id)
    const durableDirectory = join(output, 'runs', id)
    const workspace = join(runDirectory, 'workspace')
    const data = join(runDirectory, 'data')
    const markerDirectory = join(durableDirectory, 'markers')
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(join(runDirectory, 'home'), { recursive: true, mode: 0o700 }),
      mkdir(join(runDirectory, 'tmp'), { recursive: true, mode: 0o700 }),
      mkdir(data, { recursive: true, mode: 0o700 }),
      mkdir(join(runDirectory, 'client-state'), { recursive: true, mode: 0o700 }),
      mkdir(join(durableDirectory, 'parent-intents'), { recursive: true, mode: 0o700 }),
      mkdir(join(durableDirectory, 'parent-chunks'), { recursive: true, mode: 0o700 }),
      mkdir(markerDirectory, { recursive: true, mode: 0o700 }),
    ])
    await symlink(sharedRuntimeRoot, join(data, 'runtimes'), 'dir')
    await writePublicInputs(workspace, task)
    const inputHashes = await hashPublicInputs(workspace, task)
    const kind = publicTaskKind(task)
    const condition = {
      ordinal,
      id,
      arm,
      taskIndex,
      taskId: task.id,
      kind,
      runDirectory,
      durableDirectory,
      workspace,
      data,
      markerDirectory,
      prompt: { task: task.instruction, sha256: sha256Bytes(task.instruction) },
      inputHashes,
      autonomous: {
        maxTurns: FIXED_LIMITS.autonomousMaxTurns,
        maxTokens: FIXED_LIMITS.autonomousMaxTokens,
        gate: gateCommand({ python: gatePython, script: gateScript, workspace, kind }),
      },
    }
    await writeExclusiveJson(join(markerDirectory, 'condition.json'), {
      formatVersion: FORMAT_VERSION,
      id,
      arm,
      taskIndex,
      taskId: task.id,
      kind,
      prompt: condition.prompt,
      inputHashes,
      autonomous: condition.autonomous,
    })
    conditions.push(condition)
    ordinal += 1
  }
  return conditions
}

function manifestFingerprint(manifest) {
  return canonicalHash({
    kind: manifest.kind,
    plan: manifest.plan,
    sourceRows: manifest.sourceRows,
    sourceHead: manifest.sourceHead,
    runner: manifest.runner,
    execution: manifest.execution,
    package: manifest.package,
    shared: {
      compiled: manifest.shared.compiled,
      runtime: manifest.shared.runtime,
      worker: manifest.shared.worker,
    },
    prior: manifest.prior,
    privateTasks: { sha256: manifest.privateTasks.sha256, saltSha256: manifest.privateTasks.saltSha256 },
    conditions: manifest.conditions.map(condition => ({
      id: condition.id,
      arm: condition.arm,
      taskIndex: condition.taskIndex,
      taskId: condition.taskId,
      kind: condition.kind,
      prompt: condition.prompt,
      inputHashes: condition.inputHashes,
      autonomous: condition.autonomous,
    })),
  })
}

/**
 * Create the immutable, zero-model panel.  It never imports a provider or
 * reads credentials.
 */
export async function preparePanel({
  output = DEFAULT_OUTPUT,
  tmpRoot = DEFAULT_TMP_ROOT,
  sourceRowsPath,
  planPath = DEFAULT_PLAN,
  sourceRoot = REPOSITORY_ROOT,
  packageRoot,
  compiler = compileCurrentSources,
  runtimePreparer = prepareSharedRuntime,
} = {}) {
  const source = await assertDirectory(sourceRoot, 'sourceRoot')
  const packageDirectory = await assertDirectory(packageRoot ?? join(source, 'incubator/rlm'), 'packageRoot')
  const { path: frozenPlanPath, plan, hash: planHash, canonicalHash: planCanonicalHash, priorEvidence } = await loadPlan(planPath, source)
  const targetOutput = requireAbsolute(output, 'output')
  const targetSourceRows = sourceRowsPath === undefined ? undefined : requireAbsolute(sourceRowsPath, 'sourceRowsPath')
  const preparedOutput = await assertPrepareOutput(targetOutput, targetSourceRows)
  const temporaryRoot = await createFreshTmpRoot(tmpRoot)
  const shared = join(temporaryRoot, 'shared')
  await mkdir(shared, { recursive: true, mode: 0o700 })

  const rows = await readJson(preparedOutput.sourceRows, 'source rows')
  const salt = randomBytes(32).toString('hex')
  const tasks = prepareTasks(rows, { salt })
  validatePreparedTasks(tasks, plan)

  const privateTasksPath = join(preparedOutput.parentPrivate, 'tasks.json')
  const saltPath = join(preparedOutput.parentPrivate, 'salt.json')
  await writeExclusiveJson(privateTasksPath, { formatVersion: FORMAT_VERSION, tasks })
  await writeExclusiveJson(saltPath, { formatVersion: FORMAT_VERSION, salt })

  const sharedCompile = await compiler({ sourceRoot: source, packageRoot: packageDirectory, shared })
  const runtime = await runtimePreparer({ compiled: sharedCompile.compiled, packageRoot: packageDirectory, shared })
  if (runtime?.manifest?.primeCommit !== plan.primeCommit) fail('RLM_RUNTIME_PIN', 'offline runtime Prime commit differs from the frozen plan')
  const workerSource = await assertRegularFile(join(ARC_TOOL_DIRECTORY, 'native-worker.mjs'), 'native worker source')
  const workerPath = join(shared, 'worker.mjs')
  await copyFile(workerSource, workerPath, fsConstants.COPYFILE_EXCL)
  const gateScript = join(shared, 'check-output.py')
  await writeFile(gateScript, immutablePublicGateScript(), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  const conditions = await prepareConditionDirectories({
    output: preparedOutput.root,
    tmpRoot: temporaryRoot,
    sharedRuntimeRoot: runtime.runtimes,
    gatePython: runtime.paths.python,
    gateScript,
    plan,
    tasks,
  })

  const ledgerPath = join(preparedOutput.root, 'provider-ledger.jsonl')
  const ledger = await Ledger.open(ledgerPath, { total: FIXED_LIMITS.newPanelRequests, perRun: FIXED_LIMITS.perTreeRequests })
  const ledgerReceipt = await ledger.receipt()
  if (ledgerReceipt.admitted !== 0 || ledgerReceipt.priorAdmitted !== 0 || ledgerReceipt.stopped) {
    fail('RLM_NEW_LEDGER', 'new recursion ledger must contain no reconstructed historical calls')
  }

  const runnerPath = fileURLToPath(import.meta.url)
  const manifest = {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-recursion-ablation-prepared',
    preparedAt: new Date().toISOString(),
    output: preparedOutput.root,
    tmpRoot: temporaryRoot,
    parentPrivate: preparedOutput.parentPrivate,
    plan: { path: frozenPlanPath, sha256: planHash, canonicalHash: planCanonicalHash },
    sourceRows: { path: preparedOutput.sourceRows, sha256: await sha256File(preparedOutput.sourceRows) },
    sourceHead: await gitHead(source),
    runner: { path: runnerPath, sha256: await sha256File(runnerPath), sourceRoot: source },
    execution: { files: await executionHashes(source), node: process.version, platform: process.platform, arch: process.arch },
    package: { root: packageDirectory, runtimeManifest: { path: runtime.manifest.path, sha256: runtime.manifest.sha256 } },
    shared: {
      path: shared,
      compiled: { path: sharedCompile.compiled, outputs: sharedCompile.outputs, hash: sharedCompile.hash },
      runtime,
      worker: { path: workerPath, sha256: await sha256File(workerPath) },
      gate: { path: gateScript, sha256: await sha256File(gateScript) },
    },
    prior: {
      charged: FIXED_LIMITS.priorCharged,
      confirmed: FIXED_LIMITS.priorConfirmed,
      unknown: FIXED_LIMITS.priorUnknown,
      evidence: priorEvidence,
    },
    ledger: { path: ledgerPath, total: FIXED_LIMITS.newPanelRequests, perRun: FIXED_LIMITS.perTreeRequests },
    privateTasks: { path: privateTasksPath, sha256: await sha256File(privateTasksPath), saltPath, saltSha256: await sha256File(saltPath) },
    conditions,
    sideEffects: { providerLoaded: false, credentialRead: false, modelCalls: 0, network: false },
  }
  manifest.fingerprint = manifestFingerprint(manifest)
  await writeExclusiveJson(join(preparedOutput.root, PREPARED_FILE), manifest)
  return manifest
}

async function readPreparedManifest(output = DEFAULT_OUTPUT) {
  const root = await assertDirectory(output, 'output')
  const path = await assertRegularFile(join(root, PREPARED_FILE), 'prepared manifest')
  const manifest = await readJson(path, 'prepared manifest')
  if (!isRecord(manifest) || manifest.formatVersion !== FORMAT_VERSION || manifest.kind !== 'prime-rlm-recursion-ablation-prepared') {
    fail('RLM_PREPARED_FORMAT', 'prepared manifest has an unsupported format')
  }
  if (manifest.output !== root) fail('RLM_PREPARED_SCOPE', 'prepared manifest output does not match the selected output directory')
  return { root, path, manifest }
}

async function assertCompiledOutputs(manifest) {
  const outputs = {}
  if (!isRecord(manifest.shared?.compiled?.outputs)) fail('RLM_FINGERPRINT_COMPILED', 'compiled output map is missing')
  for (const [name, expected] of Object.entries(manifest.shared.compiled.outputs)) {
    if (!isRecord(expected) || !SHA256.test(expected.sha256 ?? '') || !Number.isSafeInteger(expected.bytes) || expected.bytes < 0) {
      fail('RLM_FINGERPRINT_COMPILED', `compiled output metadata is invalid: ${name}`)
    }
    const path = resolve(manifest.shared.compiled.path, name)
    if (!isWithin(manifest.shared.compiled.path, path)) fail('RLM_FINGERPRINT_COMPILED', `compiled output escapes its directory: ${name}`)
    const info = await stat(path)
    const sha256 = await sha256File(path)
    if (sha256 !== expected.sha256 || info.size !== expected.bytes) fail('RLM_FINGERPRINT_COMPILED', `compiled output changed: ${name}`)
    outputs[name] = { sha256, bytes: info.size }
  }
  if (canonicalHash(outputs) !== manifest.shared.compiled.hash) fail('RLM_FINGERPRINT_COMPILED', 'compiled output aggregate hash changed')
}

function assertExactHashMap(actual, expected, label) {
  if (!isRecord(actual) || !isRecord(expected) || canonicalHash(actual) !== canonicalHash(expected)) {
    fail('RLM_FINGERPRINT_EXECUTION', `${label} differs from its frozen hash map`)
  }
}

function assertNativeProofHashSubset(actual, expected) {
  const required = [
    'tools/rlm-arc-pilot/run.mjs',
    'tools/rlm-arc-pilot/native-worker.mjs',
    'tools/rlm-arc-pilot/sandbox.mjs',
    'tools/rlm-recursion-pilot/control.mjs',
  ]
  if (!isRecord(actual)) fail('RLM_ACCEPTANCE_NATIVE', 'native proof sourceHashes must be an object')
  for (const name of required) {
    if (actual[name] !== expected?.[name]) fail('RLM_ACCEPTANCE_NATIVE', `native proof does not cover the required mechanism file: ${name}`)
  }
  for (const [name, hash] of Object.entries(actual)) {
    if (!Object.hasOwn(expected ?? {}, name) || hash !== expected[name]) {
      fail('RLM_ACCEPTANCE_NATIVE', `native proof source hash does not match prepared execution: ${name}`)
    }
  }
}

/** Recheck all bytes that can affect a paid dispatch. */
export async function assertPreparedFingerprint(manifest) {
  if (!isRecord(manifest)) fail('RLM_PREPARED_FORMAT', 'prepared manifest must be an object')
  const source = await assertDirectory(manifest.runner?.sourceRoot, 'prepared source root')
  const loadedPlan = await loadPlan(manifest.plan?.path, source)
  if (loadedPlan.hash !== manifest.plan?.sha256 || loadedPlan.canonicalHash !== manifest.plan?.canonicalHash) {
    fail('RLM_FINGERPRINT_PLAN', 'frozen plan bytes changed since preparation')
  }
  if (!isRecord(manifest.prior?.evidence)
    || manifest.prior.evidence.sha256 !== loadedPlan.priorEvidence.sha256
    || manifest.prior.evidence.path !== loadedPlan.priorEvidence.path) {
    fail('RLM_FINGERPRINT_PRIOR', 'historical aggregate evidence no longer matches the frozen plan')
  }
  if (await sha256File(manifest.sourceRows?.path) !== manifest.sourceRows?.sha256) {
    fail('RLM_FINGERPRINT_SOURCE_ROWS', 'private source rows changed since preparation')
  }
  if (await gitHead(source) !== manifest.sourceHead) fail('RLM_FINGERPRINT_SOURCE_HEAD', 'source HEAD changed since preparation')
  const currentExecution = await executionHashes(source)
  assertExactHashMap(currentExecution, manifest.execution?.files, 'execution files')
  if (await sha256File(manifest.runner?.path) !== manifest.runner?.sha256) fail('RLM_FINGERPRINT_RUNNER', 'parent runner bytes changed since preparation')
  if (manifest.execution?.node !== process.version || manifest.execution?.platform !== process.platform || manifest.execution?.arch !== process.arch) {
    fail('RLM_FINGERPRINT_ENVIRONMENT', 'Node/platform/architecture differs from preparation')
  }
  await assertCompiledOutputs(manifest)
  if (await sha256File(manifest.shared?.worker?.path) !== manifest.shared?.worker?.sha256) fail('RLM_FINGERPRINT_WORKER', 'copied native worker changed since preparation')
  if (await sha256File(manifest.shared?.gate?.path) !== manifest.shared?.gate?.sha256) fail('RLM_FINGERPRINT_GATE', 'public output gate changed since preparation')
  if (await sha256File(manifest.shared?.runtime?.manifest?.path) !== manifest.shared?.runtime?.manifest?.sha256) {
    fail('RLM_FINGERPRINT_RUNTIME', 'runtime manifest changed since preparation')
  }
  if (await sha256File(manifest.package?.runtimeManifest?.path) !== manifest.package?.runtimeManifest?.sha256) {
    fail('RLM_FINGERPRINT_RUNTIME', 'package runtime manifest changed since preparation')
  }
  if (manifest.package.runtimeManifest.sha256 !== manifest.shared.runtime.manifest.sha256) {
    fail('RLM_FINGERPRINT_RUNTIME', 'package and shared runtime manifest hashes disagree')
  }
  if (await sha256File(manifest.privateTasks?.path) !== manifest.privateTasks?.sha256
    || await sha256File(manifest.privateTasks?.saltPath) !== manifest.privateTasks?.saltSha256) {
    fail('RLM_FINGERPRINT_PRIVATE_TASKS', 'private tasks or salt changed since preparation')
  }
  const expectedOrder = expectedConditionOrder(loadedPlan.plan)
  if (!Array.isArray(manifest.conditions) || manifest.conditions.length !== expectedOrder.length) {
    fail('RLM_FINGERPRINT_CONDITIONS', 'prepared condition count changed')
  }
  for (let index = 0; index < manifest.conditions.length; index += 1) {
    const condition = manifest.conditions[index]
    const expected = expectedOrder[index]
    if (!isRecord(condition) || condition.id !== conditionKey(expected.taskIndex, expected.arm)
      || condition.taskIndex !== expected.taskIndex || condition.arm !== expected.arm) {
      fail('RLM_FINGERPRINT_CONDITIONS', `condition ${String(index + 1)} order changed`)
    }
    await assertDirectory(condition.runDirectory, `condition ${condition.id} run directory`)
    await assertDirectory(condition.workspace, `condition ${condition.id} workspace`)
    const expectedInputs = condition.inputHashes
    if (!isRecord(expectedInputs)) fail('RLM_FINGERPRINT_INPUTS', `condition ${condition.id} input hash map is missing`)
    const actualInputs = {}
    for (const [relativePath, expectedHash] of Object.entries(expectedInputs)) {
      const path = resolve(condition.workspace, relativePath)
      if (!isWithin(condition.workspace, path)) fail('RLM_FINGERPRINT_INPUTS', `condition ${condition.id} input escapes workspace`)
      actualInputs[relativePath] = await sha256File(path)
      if (actualInputs[relativePath] !== expectedHash) fail('RLM_FINGERPRINT_INPUTS', `condition ${condition.id} input changed: ${relativePath}`)
    }
  }
  if (manifestFingerprint(manifest) !== manifest.fingerprint) fail('RLM_FINGERPRINT_MANIFEST', 'prepared manifest is not self-consistent')
  return { plan: loadedPlan.plan, sourceRoot: source }
}

export async function assertPanelNotStarted(output = DEFAULT_OUTPUT) {
  const root = await assertDirectory(output, 'output')
  if (await exists(join(root, RUN_START_FILE))) fail('RLM_RUN_ALREADY_STARTED', 'real panel has a durable start marker; never replay it')
}

function requireAcceptanceHash(value) {
  return requireSha256(value, '--acceptance-sha256', 'RLM_ACCEPTANCE_HASH')
}

async function assertNativeProof(nativeAcceptance, manifest) {
  if (!isRecord(nativeAcceptance)) fail('RLM_ACCEPTANCE_NATIVE', 'nativeAcceptance is required')
  const path = await assertRegularFile(nativeAcceptance.path, 'native acceptance proof')
  const expectedHash = requireSha256(nativeAcceptance.sha256, 'nativeAcceptance.sha256', 'RLM_ACCEPTANCE_NATIVE')
  const actualHash = await sha256File(path)
  if (actualHash !== expectedHash) fail('RLM_ACCEPTANCE_NATIVE', 'native acceptance proof SHA-256 differs')
  const proof = await readJson(path, 'native acceptance proof')
  if (!isRecord(proof) || proof.accepted !== true || proof.realModelRequests !== 0) {
    fail('RLM_ACCEPTANCE_NATIVE', 'native acceptance proof does not prove accepted zero-model execution')
  }
  if (proof.compiledHash !== manifest.shared.compiled.hash
    || proof.runtimeManifestSha256 !== manifest.shared.runtime.manifest.sha256) {
    fail('RLM_ACCEPTANCE_NATIVE', 'native acceptance proof is not bound to this compiled runtime')
  }
  assertNativeProofHashSubset(proof.sourceHashes, manifest.execution.files)
  return { path, sha256: actualHash, proof }
}

/**
 * Check the human-reviewed zero-cost acceptance binding.  This intentionally
 * happens before provider-module or credential inspection.
 */
export async function assertRunPreflight({ output = DEFAULT_OUTPUT, acceptanceArtifact, acceptanceSha256 } = {}) {
  const { root, path, manifest } = await readPreparedManifest(output)
  await assertPreparedFingerprint(manifest)
  await assertPanelNotStarted(root)
  const acceptancePath = await assertRegularFile(acceptanceArtifact, 'acceptance artifact')
  const expectedAcceptanceHash = requireAcceptanceHash(acceptanceSha256)
  const actualAcceptanceHash = await sha256File(acceptancePath)
  if (actualAcceptanceHash !== expectedAcceptanceHash) fail('RLM_ACCEPTANCE_HASH', 'acceptance artifact SHA-256 differs')
  const acceptance = await readJson(acceptancePath, 'acceptance artifact')
  if (!isRecord(acceptance)
    || acceptance.formatVersion !== FORMAT_VERSION
    || acceptance.kind !== 'native-recursion-ablation-acceptance-v1'
    || acceptance.status !== 'passed'
    || acceptance.manifestFingerprint !== manifest.fingerprint
    || acceptance.planSha256 !== manifest.plan.sha256
    || acceptance.runnerSha256 !== manifest.runner.sha256
    || acceptance.compiledHash !== manifest.shared.compiled.hash
    || acceptance.workerSha256 !== manifest.shared.worker.sha256
    || acceptance.runtimeManifestSha256 !== manifest.shared.runtime.manifest.sha256
    || acceptance.realModelRequests !== 0) {
    fail('RLM_ACCEPTANCE_GATE', 'acceptance artifact does not bind this exact zero-model panel')
  }
  assertExactHashMap(acceptance.executionFiles, manifest.execution.files, 'acceptance execution files')
  const nativeProof = await assertNativeProof(acceptance.nativeAcceptance, manifest)
  return {
    root,
    preparedPath: path,
    manifest,
    acceptance: { path: acceptancePath, sha256: actualAcceptanceHash, value: acceptance, nativeProof },
  }
}

async function loadPrivateTasks(manifest, plan) {
  if (await sha256File(manifest.privateTasks.path) !== manifest.privateTasks.sha256) fail('RLM_PRIVATE_TASKS', 'private task file changed')
  const value = await readJson(manifest.privateTasks.path, 'private task file')
  if (!isRecord(value) || value.formatVersion !== FORMAT_VERSION || !Array.isArray(value.tasks)) {
    fail('RLM_PRIVATE_TASKS', 'private task file has an unsupported format')
  }
  validatePreparedTasks(value.tasks, plan)
  return value.tasks
}

function allText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(allText).join('\n')
  if (isRecord(value)) return typeof value.text === 'string' ? value.text : ''
  return ''
}

function isDepthOneChildOptions(options) {
  if (!isRecord(options) || !Array.isArray(options.messages)) return false
  return options.messages.some(message => {
    if (!isRecord(message) || (message.role !== 'system' && message.role !== 'developer')) return false
    return /(?:^|\n)Recursive agent depth:\s*1(?:\s|$)/.test(allText(message.content))
  })
}

function observedChildRequests(receipt, condition) {
  const physical = new Set((receipt.rows ?? [])
    .filter(row => row?.type === 'physical-request-admitted' && row.runId === condition.id)
    .map(row => row.logicalRequest))
  return (receipt.rows ?? [])
    .filter(row => row?.type === 'request-admitted' && row.run === condition.id && isDepthOneChildOptions(row.request?.options))
    .map(row => ({ logicalRequest: row.id, ipcId: row.request?.ipcId ?? null, physicalAdmitted: physical.has(row.id) }))
}

function collectRosterRows(value, output, depth = 0) {
  if (depth > 24 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectRosterRows(item, output, depth + 1)
    return
  }
  if (Array.isArray(value.subagents)) {
    for (const row of value.subagents) {
      if (isRecord(row) && typeof row.id === 'string' && row.id.length > 0 && typeof row.status === 'string' && row.status.length > 0) {
        output.push(row.status)
      }
    }
  }
  for (const child of Object.values(value)) collectRosterRows(child, output, depth + 1)
}

async function readChildRosterEvidence(worker) {
  const path = worker?.result?.raw?.nativeJournal
  if (typeof path !== 'string' || !isAbsolute(path)) return { available: false, observed: false, count: 0, statuses: [] }
  try {
    const statuses = []
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      if (!line) continue
      try { collectRosterRows(JSON.parse(line), statuses) } catch { /* A malformed journal line remains worker evidence, not parent evidence. */ }
    }
    return { available: true, observed: statuses.length > 0, count: statuses.length, statuses: [...new Set(statuses)].sort() }
  } catch (error) {
    return { available: false, observed: false, count: 0, statuses: [], error: redact(errorText(error)) }
  }
}

function readOnlyInputsSandbox(base, workspace) {
  return `${base}\n(deny file-write* (subpath ${JSON.stringify(join(workspace, 'inputs'))}))\n`
}

function specialNodeType(info) {
  if (info.isSocket()) return 'socket'
  if (info.isFIFO()) return 'fifo'
  if (info.isCharacterDevice()) return 'character-device'
  if (info.isBlockDevice()) return 'block-device'
  return 'other'
}

async function copyNativeEvidence(condition, worker) {
  const destination = join(condition.durableDirectory, 'native-evidence')
  const omissions = []
  await cp(condition.runDirectory, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
    filter: async source => {
      const info = await lstat(source)
      if (info.isDirectory() || info.isFile() || info.isSymbolicLink()) return true
      omissions.push({ path: relative(condition.runDirectory, source) || '.', type: specialNodeType(info) })
      return false
    },
  })
  await writeExclusiveJson(join(destination, 'omissions.json'), {
    formatVersion: FORMAT_VERSION,
    copiedAt: new Date().toISOString(),
    omissions,
    note: 'Non-file IPC and special filesystem nodes were not copied. This record does not assert that any listener was closed.',
  })
  await writeExclusiveJson(join(destination, 'parent-worker-result.json'), {
    formatVersion: FORMAT_VERSION,
    result: worker?.result ?? null,
    exit: worker?.exit ?? null,
    stdout: worker?.stdout ?? '',
    stderr: worker?.stderr ?? '',
    error: worker?.error ?? null,
  })
  return { path: destination, omissions }
}

function failedGrade(task, reason, grade) {
  try {
    const result = grade(task, '')
    return { ...result, errors: [...(Array.isArray(result?.errors) ? result.errors : []), String(reason)] }
  } catch (error) {
    return { primaryScore: 0, schemaValid: false, errors: [String(reason), errorText(error)] }
  }
}

/**
 * Execute one already-authorized cell.  It receives a loaded provider but does
 * not load credentials itself.  All parent dispatch logs use durable output.
 */
export async function executeCondition({
  manifest,
  condition,
  provider,
  ledger,
  relay,
  task,
  grade = gradeTask,
  protectedRoots = [],
  spawnWorker = spawnNativeWorker,
  reservePort = reserveBridgePort,
  sandboxBuilder = sandboxPolicy,
} = {}) {
  if (!isRecord(manifest) || !isRecord(condition) || !provider || !ledger || !relay || !task) {
    fail('RLM_CONDITION_ARGS', 'manifest, condition, provider, ledger, relay, and task are required')
  }
  const protocol = condition.protocol ?? 'recursion-ablation-v1'
  const qualityPilot = protocol === 'quality-pilot-v1'
  const qualityRecovery = protocol === 'quality-recovery-v1'
  if (protocol !== 'recursion-ablation-v1' && !qualityPilot && !qualityRecovery) fail('RLM_CONDITION_PROTOCOL', 'unsupported explicit condition protocol')
  if (qualityPilot && condition.arm !== 'R' && condition.arm !== 'S') fail('RLM_CONDITION_PROTOCOL', 'quality text task requires R or S')
  if (qualityRecovery && condition.arm !== 'S') fail('RLM_CONDITION_PROTOCOL', 'quality recovery requires S')
  const nativeLimits = qualityRecovery
    ? { protocol: 'quality-recovery-v1', requestLimit: 11, wallTimeMs: 1_200_000 }
    : qualityPilot
      ? { protocol: 'quality-pilot-v1', requestLimit: 32, wallTimeMs: 1_200_000 }
      : { protocol: 'recursion-ablation-v1', requestLimit: FIXED_LIMITS.perTreeRequests, wallTimeMs: FIXED_LIMITS.wallTimeMs }
  const startedAt = Date.now()
  const beforeInputs = await hashPublicInputs(condition.workspace, task)
  const durableDispatch = { ...condition, directory: join(condition.durableDirectory, 'parent-intents'), gameId: condition.taskId }
  let reservation
  let worker = null
  let workerError = null
  let evidence = null
  let dispatcher
  try {
    const baseDispatcher = createModelDispatcher({ condition: durableDispatch, provider, relay, ledger })
    dispatcher = serializeDispatcher(baseDispatcher)
    reservation = await reservePort()
    const baseSandbox = sandboxBuilder({
      directory: condition.runDirectory,
      shared: manifest.shared.path,
      readRoots: [manifest.package.root, join(manifest.shared.path, 'node_modules'), join(manifest.runner.sourceRoot, 'node_modules')],
      bridgePort: reservation.port,
      protectedRoots: [manifest.parentPrivate, ...protectedRoots],
    })
    const start = {
      type: 'start',
      protocol: nativeLimits.protocol,
      arm: condition.arm,
      directory: condition.runDirectory,
      shared: manifest.shared.path,
      compiled: manifest.shared.compiled.path,
      packageRoot: manifest.package.root,
      task: condition.prompt.task,
      route: { ...FIXED_ROUTE },
      modelInfo: provider.modelInfo,
      requestLimit: nativeLimits.requestLimit,
      wallTimeMs: nativeLimits.wallTimeMs,
      autonomous: condition.autonomous,
      bridgePort: reservation.port,
      dependencyReadRoots: [manifest.package.root, join(manifest.shared.path, 'node_modules'), join(manifest.runner.sourceRoot, 'node_modules')],
    }
    await reservation.releaseIpv4()
    worker = await spawnWorker({
      workerPath: manifest.shared.worker.path,
      sandbox: readOnlyInputsSandbox(baseSandbox, condition.workspace),
      config: {
        directory: condition.runDirectory,
        start,
        abortModel: (id, reason) => dispatcher.abort(id, reason),
        abortAll: reason => dispatcher.abortAll(reason),
      },
      onModel: dispatcher.call,
    })
  } catch (error) {
    workerError = redact(errorText(error))
  } finally {
    await reservation?.close?.().catch(error => { workerError ??= redact(errorText(error)) })
  }

  const afterInputs = await hashPublicInputs(condition.workspace, task)
  const inputsUnchanged = canonicalHash(beforeInputs) === canonicalHash(afterInputs) && canonicalHash(afterInputs) === canonicalHash(condition.inputHashes)
  if (!inputsUnchanged) workerError ??= 'RLM_INPUT_MUTATED: sandboxed worker changed public input bytes'
  try {
    evidence = await copyNativeEvidence(condition, worker)
  } catch (error) {
    workerError ??= `RLM_NATIVE_EVIDENCE: ${redact(errorText(error))}`
  }

  let answerText = ''
  let answerError = null
  try {
    answerText = await readFile(join(condition.workspace, 'answer.json'), 'utf8')
  } catch (error) {
    answerError = redact(errorText(error))
  }
  let grading
  try {
    grading = grade(task, answerText)
  } catch (error) {
    grading = failedGrade(task, errorText(error), grade)
  }
  if (answerError) grading = { ...grading, errors: [...(Array.isArray(grading?.errors) ? grading.errors : []), `answer.json unavailable: ${answerError}`] }

  const receipt = await ledger.receipt()
  const childIntents = observedChildRequests(receipt, condition)
  const childRequests = childIntents.filter(child => child.physicalAdmitted)
  const childRoster = await readChildRosterEvidence(worker)
  const expectedDepth = qualityPilot || qualityRecovery || condition.arm === 'S' ? 1 : 0
  const physicalCleanup = worker?.result?.physicalCleanup === true
  const exitedCleanly = worker?.exit?.code === 0 && worker?.exit?.signal === null
  const depthMatches = worker?.result?.nativeDepth === expectedDepth && worker?.result?.actualDepth === expectedDepth
  const executionCompleted = worker?.result?.state === 'completed' && physicalCleanup && exitedCleanly && depthMatches && inputsUnchanged && workerError === null
  return {
    condition: { id: condition.id, arm: condition.arm, taskIndex: condition.taskIndex, taskId: condition.taskId, kind: condition.kind },
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    worker: worker ? {
      state: worker.result?.state ?? null,
      nativeDepth: worker.result?.nativeDepth ?? null,
      actualDepth: worker.result?.actualDepth ?? null,
      requests: worker.result?.requests ?? null,
      physicalCleanup,
      exit: worker.exit ?? null,
      error: worker.error ?? null,
      fault: worker.result?.fault ?? null,
    } : null,
    workerError,
    nativeEvidence: evidence?.path ?? null,
    nativeEvidenceOmissions: evidence?.omissions ?? [],
    inputsUnchanged,
    answer: { present: answerError === null, sha256: answerError === null ? sha256Bytes(answerText) : null, error: answerError },
    grading,
    resources: summarizeConditionResources(receipt, condition.id, Date.now() - startedAt),
    observed: {
      admittedModelRequests: (receipt.rows ?? []).filter(row => row?.type === 'request-admitted' && row.run === condition.id).length,
      childIntents: childIntents.map(({ logicalRequest, ipcId }) => ({ logicalRequest, ipcId })),
      childIntentCount: childIntents.length,
      childModelRequests: childRequests.map(({ logicalRequest, ipcId }) => ({ logicalRequest, ipcId })),
      childModelRequestCount: childRequests.length,
      rootModelRequestCount: Math.max(0, (receipt.rows ?? []).filter(row => row?.type === 'request-admitted' && row.run === condition.id).length - childRequests.length),
      childRoster,
      recursionObserved: childRequests.length > 0,
      unexpectedChildInS0: condition.arm === 'S0' && childRequests.length > 0,
    },
    executionCompleted,
    cleanupComplete: physicalCleanup && exitedCleanly,
  }
}

function assertRunArguments({ providerModule, providerSha256, providerPackage, credentialFile } = {}) {
  if (typeof providerModule !== 'string' || !isAbsolute(providerModule)
    || typeof credentialFile !== 'string' || !isAbsolute(credentialFile)
    || typeof providerPackage !== 'string' || providerPackage.trim().length === 0
    || !SHA256.test(providerSha256 ?? '')) {
    fail('RLM_RUN_ARGS', '--run requires provider module/hash/package and credential file')
  }
}

function assertRealRunRuntime() {
  if (process.versions.node.split('.')[0] !== '22' || process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('RLM_REAL_RUNTIME', `real run requires Node 22 on macOS arm64; found ${process.version}/${process.platform}/${process.arch}`)
  }
}

function resultPathFor(condition) {
  return join(condition.markerDirectory, 'result.json')
}

function startPathFor(condition) {
  return join(condition.markerDirectory, 'real-condition-started.json')
}

function safeConditionResult(condition, value) {
  return {
    formatVersion: FORMAT_VERSION,
    condition: value.condition ?? { id: condition.id, arm: condition.arm, taskIndex: condition.taskIndex, taskId: condition.taskId, kind: condition.kind },
    startedAt: value.startedAt ?? null,
    completedAt: value.completedAt ?? new Date().toISOString(),
    status: value.executionCompleted === true ? 'completed' : 'incomplete',
    ...value,
  }
}

async function parentFailureResult(condition, task, reason, ledger) {
  let resources
  let observed
  try {
    const receipt = await ledger.receipt()
    const childIntents = observedChildRequests(receipt, condition)
    const childRequests = childIntents.filter(child => child.physicalAdmitted)
    const admittedModelRequests = (receipt.rows ?? []).filter(row => row?.type === 'request-admitted' && row.run === condition.id).length
    resources = summarizeConditionResources(receipt, condition.id, null)
    observed = {
      admittedModelRequests,
      childIntents: childIntents.map(({ logicalRequest, ipcId }) => ({ logicalRequest, ipcId })),
      childIntentCount: childIntents.length,
      childModelRequests: childRequests.map(({ logicalRequest, ipcId }) => ({ logicalRequest, ipcId })),
      childModelRequestCount: childRequests.length,
      rootModelRequestCount: Math.max(0, admittedModelRequests - childRequests.length),
      childRoster: { available: false, observed: false, count: 0, statuses: [] },
      recursionObserved: childRequests.length > 0,
      unexpectedChildInS0: condition.arm === 'S0' && childRequests.length > 0,
    }
  } catch (error) {
    resources = { modelRequests: null, physicalModelRequests: null, confirmedModelRequests: null, unknownModelRequests: null, requestsWithKnownUsage: null, requestsWithoutKnownUsage: null, knownUsageTotals: { inputTokens: null, outputTokens: null, totalTokens: null }, elapsedMs: null, accountingError: redact(errorText(error)) }
    observed = { admittedModelRequests: null, childIntents: [], childIntentCount: null, childModelRequests: [], childModelRequestCount: null, rootModelRequestCount: null, childRoster: { available: false, observed: false, count: 0, statuses: [] }, recursionObserved: false, unexpectedChildInS0: false }
  }
  return {
    condition: { id: condition.id, arm: condition.arm, taskIndex: condition.taskIndex, taskId: condition.taskId, kind: condition.kind },
    completedAt: new Date().toISOString(),
    worker: null,
    workerError: redact(errorText(reason)),
    nativeEvidence: null,
    inputsUnchanged: false,
    answer: { present: false, sha256: null, error: null },
    grading: failedGrade(task, errorText(reason), gradeTask),
    resources,
    observed,
    executionCompleted: false,
    cleanupComplete: false,
  }
}

/**
 * The sole real-provider entry point.  Every preflight and acceptance binding
 * is checked before this function asks loadRealProvider to inspect a module or
 * credential file.
 */
export async function runPanel({
  output = DEFAULT_OUTPUT,
  providerModule,
  providerSha256,
  providerPackage,
  credentialFile,
  acceptanceArtifact,
  acceptanceSha256,
} = {}) {
  const preflight = await assertRunPreflight({ output, acceptanceArtifact, acceptanceSha256 })
  assertRunArguments({ providerModule, providerSha256, providerPackage, credentialFile })
  assertRealRunRuntime()
  const { root, manifest, acceptance } = preflight
  const loadedPlan = await loadPlan(manifest.plan.path, manifest.runner.sourceRoot)
  const tasks = await loadPrivateTasks(manifest, loadedPlan.plan)
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
  const results = []
  let panelError = null
  const closes = {}
  try {
    baseLedger = await Ledger.open(manifest.ledger.path, { total: FIXED_LIMITS.newPanelRequests, perRun: FIXED_LIMITS.perTreeRequests })
    const initial = await baseLedger.receipt()
    if (initial.newAdmitted !== 0 || initial.priorAdmitted !== 0 || initial.stopped) {
      fail('RLM_LEDGER_STARTED', 'prepared new ledger is not a fresh runnable ledger')
    }
    ledger = aggregateBudgetView(baseLedger, {
      runIds: manifest.conditions.map(condition => condition.id),
      priorCharged: FIXED_LIMITS.priorCharged,
      priorConfirmed: FIXED_LIMITS.priorConfirmed,
      priorUnknown: FIXED_LIMITS.priorUnknown,
      globalCap: FIXED_LIMITS.cumulativeCap,
      maxNew: FIXED_LIMITS.newPanelRequests,
      perTreeLimit: FIXED_LIMITS.perTreeRequests,
    })
    relay = await createAttachmentRelay({ sourceRoot: manifest.runner.sourceRoot, dataRoot: join(root, 'attachments') })
    provider = await loadRealProvider({
      providerModule,
      providerSha256,
      providerPackage,
      credentialFile,
      dataRoot: join(root, 'provider-private'),
      sourceRoot: manifest.runner.sourceRoot,
      maxModelRequests: FIXED_LIMITS.newPanelRequests,
      attachments: relay.store,
      onPhysical: () => fail('RLM_PHYSICAL_SCOPE', 'provider physical request occurred outside a condition dispatcher'),
      onTransportEvent: event => baseLedger.appendSync({ type: 'transport-event', event }),
    })
    for (const condition of manifest.conditions) {
      if (ledger.stopped) break
      const task = tasks[condition.taskIndex]
      const markerPath = startPathFor(condition)
      const resultPath = resultPathFor(condition)
      if (await exists(markerPath) || await exists(resultPath)) {
        fail('RLM_CONDITION_REPLAY', `condition ${condition.id} already has a durable start/result marker`)
      }
      await writeExclusiveJson(markerPath, {
        formatVersion: FORMAT_VERSION,
        startedAt: new Date().toISOString(),
        fingerprint: manifest.fingerprint,
        id: condition.id,
        arm: condition.arm,
      })
      let outcome
      try {
        outcome = await executeCondition({
          manifest,
          condition,
          provider,
          ledger,
          relay,
          task,
          protectedRoots: [dirname(requireAbsolute(credentialFile, 'credentialFile'))],
        })
      } catch (error) {
        outcome = await parentFailureResult(condition, task, error, ledger)
      }
      const recorded = safeConditionResult(condition, outcome)
      await writeExclusiveJson(resultPath, recorded)
      results.push(recorded)
      if (recorded.cleanupComplete !== true || ledger.stopped) break
    }
  } catch (error) {
    panelError = redact(errorText(error))
  } finally {
    try {
      await relay?.close?.()
      closes.relay = 'closed'
    } catch (error) {
      closes.relay = redact(errorText(error))
      panelError ??= `relay close: ${closes.relay}`
    }
    try {
      await provider?.close?.()
      closes.provider = 'closed'
    } catch (error) {
      closes.provider = redact(errorText(error))
      panelError ??= `provider close: ${closes.provider}`
    }
  }
  const accounting = ledger ? await ledger.receipt() : baseLedger ? await baseLedger.receipt() : null
  const receipt = {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-recursion-ablation-run',
    completedAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    providerLoaded: provider !== undefined,
    results: results.map(result => ({
      condition: result.condition,
      status: result.status,
      grading: result.grading,
      resources: result.resources,
      observed: result.observed,
      executionCompleted: result.executionCompleted,
      cleanupComplete: result.cleanupComplete,
    })),
    accounting: accounting ? {
      newAdmitted: accounting.newAdmitted,
      settled: accounting.settled,
      unknown: accounting.unknown,
      physicalAdmitted: accounting.physicalAdmitted,
      cumulativeAdmitted: accounting.cumulativeAdmitted ?? FIXED_LIMITS.priorCharged + accounting.newAdmitted,
      cumulativeConfirmed: accounting.cumulativeConfirmed ?? FIXED_LIMITS.priorConfirmed + accounting.settled,
      cumulativeUnknown: accounting.cumulativeUnknown ?? FIXED_LIMITS.priorUnknown + accounting.unknown,
      stopped: accounting.stopped,
    } : null,
    closes,
    error: panelError,
  }
  await writeExclusiveJson(join(root, RUN_RECEIPT_FILE), receipt)
  if (panelError) throw failure('RLM_RUN_STOPPED', panelError)
  return receipt
}

function notRunCell(condition) {
  return {
    condition: { id: condition.id, arm: condition.arm, taskIndex: condition.taskIndex, taskId: condition.taskId, kind: condition.kind },
    status: 'not-run',
    grading: null,
    resources: { modelRequests: 0, physicalModelRequests: 0, confirmedModelRequests: 0, unknownModelRequests: 0, requestsWithKnownUsage: 0, requestsWithoutKnownUsage: 0, knownUsageTotals: { inputTokens: null, outputTokens: null, totalTokens: null }, elapsedMs: 0 },
    observed: { childIntentCount: 0, childModelRequestCount: 0, recursionObserved: false, childRoster: { available: false, observed: false, count: 0, statuses: [] } },
    executionCompleted: false,
    cleanupComplete: false,
  }
}

async function conditionAnalysisCell(condition) {
  const path = resultPathFor(condition)
  if (!(await exists(path))) return notRunCell(condition)
  try {
    const result = await readJson(path, `result for ${condition.id}`)
    if (!isRecord(result)) throw new Error('result is not an object')
    return { ...notRunCell(condition), ...result, status: result.status ?? (result.executionCompleted === true ? 'completed' : 'incomplete') }
  } catch (error) {
    return { ...notRunCell(condition), status: 'invalid-result', error: redact(errorText(error)) }
  }
}

function scoreOf(cell) {
  const score = cell?.grading?.primaryScore
  return typeof score === 'number' && Number.isFinite(score) ? score : null
}

function knownTokenSummary(cells) {
  const fields = ['inputTokens', 'outputTokens', 'totalTokens']
  const result = {}
  for (const field of fields) {
    const values = cells.map(cell => cell?.resources?.knownUsageTotals?.[field]).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    result[field] = { knownTotal: values.length ? values.reduce((sum, value) => sum + value, 0) : null, cellsWithKnownUsage: values.length, cellsWithoutKnownUsage: cells.length - values.length }
  }
  return result
}

function pairedTaskSummary(cells, taskIndex) {
  const taskCells = cells.filter(cell => cell.condition.taskIndex === taskIndex)
  const s = taskCells.find(cell => cell.condition.arm === 'S')
  const s0 = taskCells.find(cell => cell.condition.arm === 'S0')
  const sScore = scoreOf(s)
  const s0Score = scoreOf(s0)
  const childCount = s?.observed?.childModelRequestCount ?? 0
  return {
    taskIndex,
    taskId: s?.condition?.taskId ?? s0?.condition?.taskId ?? null,
    kind: s?.condition?.kind ?? s0?.condition?.kind ?? null,
    S: { status: s?.status ?? 'not-run', score: sScore, childModelRequests: childCount, childRosterObserved: s?.observed?.childRoster?.observed === true },
    S0: { status: s0?.status ?? 'not-run', score: s0Score },
    scoreDeltaSMinusS0: sScore === null || s0Score === null ? null : sScore - s0Score,
    recursionInterpretation: childCount > 0
      ? 'S had at least one physically admitted depth-1 child request; this single paired result remains diagnostic.'
      : 'S had no physically admitted depth-1 child request; this cell is capability-enabled evidence, not observed recursive-effect evidence.',
  }
}

/** Produce a derived, four-cell report without loading a provider or raw oracle. */
export async function analyzePanel({ output = DEFAULT_OUTPUT } = {}) {
  const { root, manifest } = await readPreparedManifest(output)
  const cells = []
  for (const condition of manifest.conditions) cells.push(await conditionAnalysisCell(condition))
  let accounting
  try {
    const base = await Ledger.open(manifest.ledger.path, { total: FIXED_LIMITS.newPanelRequests, perRun: FIXED_LIMITS.perTreeRequests })
    const view = aggregateBudgetView(base, {
      runIds: manifest.conditions.map(condition => condition.id),
      priorCharged: FIXED_LIMITS.priorCharged,
      priorConfirmed: FIXED_LIMITS.priorConfirmed,
      priorUnknown: FIXED_LIMITS.priorUnknown,
      globalCap: FIXED_LIMITS.cumulativeCap,
      maxNew: FIXED_LIMITS.newPanelRequests,
      perTreeLimit: FIXED_LIMITS.perTreeRequests,
    })
    const receipt = await view.receipt()
    accounting = {
      historical: { charged: FIXED_LIMITS.priorCharged, confirmed: FIXED_LIMITS.priorConfirmed, unknown: FIXED_LIMITS.priorUnknown },
      new: { admitted: receipt.newAdmitted, confirmed: receipt.settled, unknown: receipt.unknown, physicalAdmitted: receipt.physicalAdmitted },
      cumulative: { charged: receipt.cumulativeAdmitted, confirmed: receipt.cumulativeConfirmed, unknown: receipt.cumulativeUnknown, cap: FIXED_LIMITS.cumulativeCap, withinCap: receipt.cumulativeAdmitted <= FIXED_LIMITS.cumulativeCap },
      stopped: receipt.stopped,
    }
  } catch (error) {
    accounting = { error: redact(errorText(error)) }
  }
  const analysis = {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-recursion-ablation-analysis',
    createdAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    denominator: { plannedConditions: 4, recordedConditions: cells.filter(cell => cell.status !== 'not-run').length, completedConditions: cells.filter(cell => cell.executionCompleted === true).length, failedOrIncompleteConditions: cells.filter(cell => !['not-run', 'completed'].includes(cell.status)).length, notRunConditions: cells.filter(cell => cell.status === 'not-run').length },
    cells,
    pairs: [pairedTaskSummary(cells, 0), pairedTaskSummary(cells, 1)],
    resources: {
      tokens: knownTokenSummary(cells),
      elapsedMs: cells.reduce((sum, cell) => sum + (Number.isFinite(cell?.resources?.elapsedMs) ? cell.resources.elapsedMs : 0), 0),
      unknownModelRequests: cells.reduce((sum, cell) => sum + (Number.isSafeInteger(cell?.resources?.unknownModelRequests) ? cell.resources.unknownModelRequests : 0), 0),
    },
    accounting,
    limitations: [
      'This is a two-task diagnostic pilot with four planned conditions, not a general efficacy estimate.',
      'A completed answer, an independent score, native cleanup, and observed recursive child use are separate facts.',
      'An S cell without a physically admitted depth-1 child request cannot establish a recursive-effect result.',
    ],
  }
  await writeFile(join(root, 'analysis.json'), `${JSON.stringify(analysis, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' })
  const rows = cells.map(cell => {
    const totalTokens = cell?.resources?.knownUsageTotals?.totalTokens
    return `| ${cell.condition.taskIndex + 1} | ${cell.condition.kind} | ${cell.condition.arm} | ${cell.status} | ${scoreOf(cell) ?? '—'} | ${cell?.observed?.childModelRequestCount ?? 0} | ${cell?.resources?.modelRequests ?? 0} | ${cell?.resources?.unknownModelRequests ?? 0} | ${typeof totalTokens === 'number' ? totalTokens : 'unknown'} | ${cell?.resources?.elapsedMs ?? 0} |`
  })
  const markdown = [
    '# Prime recursion ablation analysis',
    '',
    `Prepared fingerprint: \`${manifest.fingerprint}\``,
    '',
    `Four planned cells: ${analysis.denominator.recordedConditions} recorded, ${analysis.denominator.completedConditions} execution-complete, ${analysis.denominator.failedOrIncompleteConditions} failed or incomplete, ${analysis.denominator.notRunConditions} not run.`,
    '',
    '| Task | Kind | Arm | Status | Primary score | Actual depth-1 child requests | Logical requests | Unknown requests | Known total tokens | Elapsed ms |',
    '| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    ...analysis.pairs.map(pair => `Task ${pair.taskIndex + 1} (${pair.kind}): S − S0 score = ${pair.scoreDeltaSMinusS0 ?? 'not comparable'}; ${pair.recursionInterpretation}`),
    '',
    accounting?.cumulative
      ? `Historical prefix remains ${accounting.historical.charged} charged (${accounting.historical.confirmed} confirmed, ${accounting.historical.unknown} unknown). New admitted: ${accounting.new.admitted}; cumulative charged: ${accounting.cumulative.charged}/${accounting.cumulative.cap}; cumulative unknown: ${accounting.cumulative.unknown}.`
      : `Accounting unavailable: ${accounting?.error ?? 'unknown error'}.`,
    '',
    'This report does not generalize from two pairs, and it does not call a no-child S result a recursion effect.',
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
    sourceRowsPath: undefined,
    planPath: DEFAULT_PLAN,
    providerModule: undefined,
    providerSha256: undefined,
    providerPackage: undefined,
    credentialFile: undefined,
    acceptanceArtifact: undefined,
    acceptanceSha256: undefined,
  }
  const options = new Map([
    ['--output', 'output'], ['--tmp-root', 'tmpRoot'], ['--source-rows', 'sourceRowsPath'], ['--plan', 'planPath'],
    ['--provider-module', 'providerModule'], ['--provider-sha256', 'providerSha256'], ['--provider-package', 'providerPackage'], ['--credential-file', 'credentialFile'],
    ['--acceptance-artifact', 'acceptanceArtifact'], ['--acceptance-sha256', 'acceptanceSha256'],
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--prepare' || item === '--run' || item === '--analyze') {
      if (result.mode !== undefined) fail('RLM_ARGS', 'choose exactly one of --prepare, --run, or --analyze')
      result.mode = item.slice(2)
      continue
    }
    const property = options.get(item)
    if (!property || index + 1 >= argv.length || argv[index + 1].startsWith('--')) fail('RLM_ARGS', `unknown or incomplete argument: ${String(item)}`)
    if (result[property] !== undefined && !(property === 'output' || property === 'tmpRoot' || property === 'planPath')) fail('RLM_ARGS', `duplicate argument: ${item}`)
    result[property] = argv[index + 1]
    index += 1
  }
  if (result.mode === undefined) fail('RLM_ARGS', 'choose exactly one of --prepare, --run, or --analyze')
  const prepareOnly = ['tmpRoot', 'sourceRowsPath', 'planPath']
  const runOnly = ['providerModule', 'providerSha256', 'providerPackage', 'credentialFile', 'acceptanceArtifact', 'acceptanceSha256']
  if (result.mode !== 'prepare' && prepareOnly.some(name => result[name] !== (name === 'tmpRoot' ? DEFAULT_TMP_ROOT : name === 'planPath' ? DEFAULT_PLAN : undefined))) {
    fail('RLM_ARGS', '--tmp-root, --source-rows, and --plan are only valid with --prepare')
  }
  if (result.mode !== 'run' && runOnly.some(name => result[name] !== undefined)) fail('RLM_ARGS', 'provider, credential, and acceptance flags are only valid with --run')
  return result
}

function usage() {
  return [
    'Usage:',
    '  /opt/homebrew/opt/node@22/bin/node tools/rlm-recursion-pilot/run.mjs --prepare --output <persistent-output> --tmp-root /private/tmp/rr2 [--source-rows <private-source-rows>] [--plan <frozen-plan>]',
    '  /opt/homebrew/opt/node@22/bin/node tools/rlm-recursion-pilot/run.mjs --run --output <persistent-output> --provider-module <private-module> --provider-sha256 <sha256> --provider-package <name> --credential-file <private-file> --acceptance-artifact <binding-json> --acceptance-sha256 <sha256>',
    '  node tools/rlm-recursion-pilot/run.mjs --analyze --output <persistent-output>',
  ].join('\n')
}

function isDirectEntrypoint() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'prepare') {
    const manifest = await preparePanel({ output: args.output, tmpRoot: args.tmpRoot, sourceRowsPath: args.sourceRowsPath, planPath: args.planPath })
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
  DEFAULT_TMP_ROOT,
  EXECUTION_FILES,
  FIXED_LIMITS,
  FIXED_ROUTE,
  PREPARED_FILE,
  RUN_START_FILE,
  manifestFingerprint,
  // Test-only seams: no provider or native process is exposed here.
  __test,
}

const __test = { parentFailureResult, isDepthOneChildOptions, observedChildRequests }
