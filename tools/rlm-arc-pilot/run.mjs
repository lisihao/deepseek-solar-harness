#!/opt/homebrew/opt/node@22/bin/node

/**
 * Trusted parent-side runner for the frozen four-game ARC pilot.
 *
 * This file deliberately has four separate modes.  `prepare`, `keyless`, and
 * `analyze` never import the private provider module and never read a
 * credential.  `run` and the explicitly accepted `resume-unstarted` mode are
 * the only provider-loading code paths.  Both refuse to begin until their
 * prepared/keyless fingerprints and independent acceptance evidence are
 * present.  This separation is intentional: a local test must not become a
 * billable model experiment merely because a credential happens to exist on
 * the machine.
 */

import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { once } from 'node:events'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { createGameBroker, gradeGame } from './broker.mjs'
import { runBaseline } from './baseline.mjs'
import { Ledger } from './ledger.mjs'
import { policy as sandboxPolicy } from './sandbox.mjs'

const execFile = promisify(execFileCallback)

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(TOOL_DIRECTORY, '../..')
const DEFAULT_PLAN = join(REPOSITORY_ROOT, 'docs/testing/prime-rlm-arc-pilot-plan.json')
const DEFAULT_PRIOR_LEDGER = '/private/tmp/rp-p2020/private/provider-ledger.jsonl'
const DEFAULT_NODE = '/opt/homebrew/opt/node@22/bin/node'
const FIXED_ROUTE = Object.freeze({
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  maxOutputTokens: 16_384,
})
const FIXED_LIMITS = Object.freeze({
  requestLimit: 32,
  total: 522,
  prior: 138,
  newPanel: 384,
  wallTimeMs: 3_600_000,
  actions: 500,
  maxActionBatch: 20,
})
const ORDER_PREFIX = 'solar-prime-arc-pilot-v1|'
const FORMAT_VERSION = 1
const PREPARED_MANIFEST = 'arc-pilot-manifest.json'
const KEYLESS_RECEIPT = 'keyless-acceptance.json'
const RUN_START_MARKER = 'real-run-started.json'
const RESULTS_DIRECTORY = 'results'
const CONTINUATION_KIND = 'prime-rlm-arc-unstarted-continuation-acceptance'
const CONTINUATION_MARKER_PREFIX = 'resume-unstarted-started-'
const CONTINUATION_RECEIPT_PREFIX = 'resume-unstarted-receipt-'
const RUNNER_EXECUTION_FILE = 'tools/rlm-arc-pilot/run.mjs'
const SHA256 = /^[a-f0-9]{64}$/i

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

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path))
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

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail('ARC_RUNNER_ARGS', `${label} must be non-empty text`)
  return value
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('ARC_RUNNER_ARGS', `${label} must be an absolute path`)
  return resolve(value)
}

function isWithin(root, candidate) {
  const difference = relative(root, candidate)
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(difference))
}

function requirePrivateTemporaryDirectory(value, label = 'output') {
  const path = requireAbsolute(value, label)
  const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : resolve(tmpdir())
  if (!isWithin(temporaryRoot, path) || path === temporaryRoot) {
    fail('ARC_OUTPUT_SCOPE', `${label} must be a descendant of ${temporaryRoot}`)
  }
  return path
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

async function assertNewDirectory(path, label) {
  if (await exists(path)) fail('ARC_OUTPUT_EXISTS', `${label} already exists: ${path}`)
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function assertDirectory(path, label) {
  const resolved = requireAbsolute(path, label)
  let metadata
  try {
    metadata = await stat(resolved)
  } catch (error) {
    fail('ARC_PATH_MISSING', `${label} is unavailable: ${resolved}`, { cause: error })
  }
  if (!metadata.isDirectory()) fail('ARC_PATH_TYPE', `${label} is not a directory: ${resolved}`)
  return resolved
}

async function assertRegularFile(path, label) {
  const resolved = requireAbsolute(path, label)
  let metadata
  try {
    metadata = await stat(resolved)
  } catch (error) {
    fail('ARC_PATH_MISSING', `${label} is unavailable: ${resolved}`, { cause: error })
  }
  if (!metadata.isFile()) fail('ARC_PATH_TYPE', `${label} is not a regular file: ${resolved}`)
  return resolved
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

async function gitValue(cwd, args, label) {
  try {
    const result = await execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1_000_000 })
    return result.stdout.trim()
  } catch (error) {
    fail('ARC_GIT', `${label} failed: ${redact(error?.stderr ?? error?.message)}`, { cause: error })
  }
}

function conditionKey(gameId, arm) {
  return sha256Bytes(`${ORDER_PREFIX}${gameId}|${arm}`)
}

function conditionId(index, gameId, arm) {
  return `arc-${String(index + 1).padStart(2, '0')}-${arm}-${gameId}-${conditionKey(gameId, arm).slice(0, 12)}`
}

function assertPlan(plan) {
  if (!isRecord(plan) || plan.formatVersion !== 1) fail('ARC_PLAN_FORMAT', 'formatVersion 1 is required')
  if (plan.status !== 'budget_approved_runner_acceptance_pending') fail('ARC_PLAN_STATUS', 'plan is not at the approved runner-acceptance state')
  if (plan.kind !== 'arc-full-harness-exploratory-pilot') fail('ARC_PLAN_KIND', 'unexpected plan kind')
  if (typeof plan.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(plan.sourceCommit)) fail('ARC_PLAN_SOURCE', 'sourceCommit must be a git SHA')
  if (typeof plan.primeCommit !== 'string' || !/^[a-f0-9]{40}$/i.test(plan.primeCommit)) fail('ARC_PLAN_PRIME', 'primeCommit must be a git SHA')
  if (!isRecord(plan.model)
    || plan.model.provider !== FIXED_ROUTE.provider
    || plan.model.id !== FIXED_ROUTE.model
    || plan.model.reasoningEffort !== FIXED_ROUTE.reasoningEffort
    || plan.model.maxOutputTokens !== FIXED_ROUTE.maxOutputTokens) {
    fail('ARC_PLAN_MODEL', 'model pin must remain openai-codex/gpt-6.1-sol/high/16384')
  }
  if (!Array.isArray(plan.cases) || plan.cases.length !== 4) fail('ARC_PLAN_CASES', 'exactly four frozen cases are required')
  const gameIds = new Set()
  for (const entry of plan.cases) {
    if (!isRecord(entry) || typeof entry.gameId !== 'string' || entry.gameId.length === 0 || entry.seed !== 0 || !isRecord(entry.files)) {
      fail('ARC_PLAN_CASES', 'each case needs gameId, seed 0, and file hashes')
    }
    if (gameIds.has(entry.gameId)) fail('ARC_PLAN_CASES', `duplicate gameId ${entry.gameId}`)
    gameIds.add(entry.gameId)
    const files = Object.entries(entry.files)
    if (files.length < 2 || !files.every(([, digest]) => typeof digest === 'string' && SHA256.test(digest))) {
      fail('ARC_PLAN_CASES', `${entry.gameId} has an invalid file hash list`)
    }
  }
  if (!isRecord(plan.arms) || !isRecord(plan.arms.B) || !isRecord(plan.arms.R) || !isRecord(plan.arms.S)) {
    fail('ARC_PLAN_ARMS', 'B, R, and S arms are required')
  }
  if (typeof plan.arms.B.systemPrompt !== 'string' || plan.arms.B.systemPrompt.length === 0) fail('ARC_PLAN_ARMS', 'B.systemPrompt is required')
  for (const arm of ['R', 'S']) {
    const value = plan.arms[arm]
    if (!isRecord(value) || !isRecord(value.autonomous)
      || value.autonomous.maxTurns !== 32 || value.autonomous.maxTokens !== 4_000_000
      || typeof value.autonomous.gate !== 'string' || value.autonomous.gate.length === 0) {
      fail('ARC_PLAN_ARMS', `${arm} autonomous settings are not frozen`)
    }
  }
  if (!isRecord(plan.commonLimits)
    || plan.commonLimits.environmentActionsPerCondition !== FIXED_LIMITS.actions
    || plan.commonLimits.maxActionsPerBatch !== FIXED_LIMITS.maxActionBatch
    || plan.commonLimits.physicalModelRequestsPerTree !== FIXED_LIMITS.requestLimit
    || plan.commonLimits.wallTimeMsPerCondition !== FIXED_LIMITS.wallTimeMs
    || plan.commonLimits.concurrentPhysicalModelRequests !== 1
    || plan.commonLimits.factoryEnabled !== false
    || plan.commonLimits.harnessRefinements !== false
    || plan.commonLimits.crossGameLearning !== false) {
    fail('ARC_PLAN_LIMITS', 'common limits differ from the frozen pilot')
  }
  if (!isRecord(plan.budget)
    || plan.budget.previousCharged !== FIXED_LIMITS.prior
    || plan.budget.currentlyAuthorizedCumulativeCap !== FIXED_LIMITS.total
    || plan.budget.currentlyUnspent !== FIXED_LIMITS.newPanel
    || plan.budget.proposedNewPanelMaximum !== FIXED_LIMITS.newPanel
    || plan.budget.proposedCumulativeMaximum !== FIXED_LIMITS.total
    || plan.budget.approved !== true
    || plan.budget.unknownRequestsRemainCharged !== true
    || typeof plan.budget.authorization !== 'string'
    || plan.budget.authorization.trim().length === 0) {
    fail('ARC_PLAN_BUDGET', 'the 138 + 384 = 522 authorization is not intact')
  }
  return plan
}

export async function loadPlan(planPath = DEFAULT_PLAN) {
  const path = await assertRegularFile(planPath, 'plan')
  let plan
  try {
    plan = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    fail('ARC_PLAN_JSON', `cannot parse ${path}`, { cause: error })
  }
  assertPlan(plan)
  return { path, plan, hash: await sha256File(path), canonicalHash: canonicalHash(plan) }
}

function normalizePriorCalls(ledger) {
  return [...ledger.calls.entries()]
    .sort(([left], [right]) => Number(left.slice('request-'.length)) - Number(right.slice('request-'.length)))
    .map(([id, call]) => ({ id, run: call.run, state: call.state }))
}

async function loadPriorEvidence(priorLedgerPath = DEFAULT_PRIOR_LEDGER) {
  const ledgerPath = await assertRegularFile(priorLedgerPath, 'prior ledger')
  const oldLedger = await Ledger.open(ledgerPath, { total: 146, perRun: 12 })
  const accounting = await oldLedger.receipt()
  if (accounting.admitted !== FIXED_LIMITS.prior
    || accounting.settled !== 135
    || accounting.unknown !== 3
    || accounting.physicalAdmitted !== FIXED_LIMITS.prior) {
    fail('ARC_PRIOR_ACCOUNTING', `expected 138 admitted / 135 settled / 3 unknown; found ${accounting.admitted}/${accounting.settled}/${accounting.unknown}`)
  }
  const reportPath = join(dirname(dirname(ledgerPath)), 'report.json')
  await assertRegularFile(reportPath, 'prior report')
  let report
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch (error) {
    fail('ARC_PRIOR_REPORT', 'prior report is not valid JSON', { cause: error })
  }
  const reportAccounting = report?.accounting
  const receipts = Array.isArray(report?.receipts) ? report.receipts : []
  if (report?.allPriorFailuresRetained !== true
    || reportAccounting?.admitted !== FIXED_LIMITS.prior
    || reportAccounting?.settled !== 135
    || reportAccounting?.unknown !== 3
    || !receipts.every(receipt => receipt?.result?.physicalCleanup === true)) {
    fail('ARC_PRIOR_REPORT', 'prior report does not prove retained failures and recorded physical cleanup')
  }
  return {
    ledgerPath,
    ledgerHash: await sha256File(ledgerPath),
    reportPath,
    reportHash: await sha256File(reportPath),
    accounting: {
      admitted: accounting.admitted,
      settled: accounting.settled,
      unknown: accounting.unknown,
      physicalAdmitted: accounting.physicalAdmitted,
      stopped: accounting.stopped,
    },
    priorCalls: normalizePriorCalls(oldLedger),
  }
}

async function readAuthorPreparation(path, plan) {
  const root = await assertDirectory(path, 'author preparation')
  const reportPath = join(root, 'report.json')
  await assertRegularFile(reportPath, 'author preparation report')
  let report
  try {
    report = JSON.parse(await readFile(reportPath, 'utf8'))
  } catch (error) {
    fail('ARC_AUTHOR_PREPARE', 'author preparation report is not JSON', { cause: error })
  }
  if (report?.mode !== 'prepare' || report?.source?.commit !== plan.sourceCommit || report?.source?.clean !== true) {
    fail('ARC_AUTHOR_PIN', 'author preparation does not prove the pinned clean source')
  }
  const sourceRoot = await assertDirectory(report.source.checkout, 'pinned author source')
  const sourceHead = await gitValue(sourceRoot, ['rev-parse', '--verify', 'HEAD'], 'author source HEAD')
  if (sourceHead !== plan.sourceCommit) fail('ARC_AUTHOR_PIN', `expected author ${plan.sourceCommit}, got ${sourceHead}`)
  const sourceStatus = await gitValue(sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all'], 'author source status')
  if (sourceStatus !== '') fail('ARC_AUTHOR_DIRTY', 'pinned author source is no longer clean')
  const corpus = requireText(report?.download?.corpus, 'author preparation download.corpus')
  await assertDirectory(corpus, 'ARC corpus')
  const games = report?.download?.games
  if (!Array.isArray(games) || games.length !== 25 || games.some(game => game?.status !== 'available' || !Array.isArray(game?.files) || game.files.length === 0)) {
    fail('ARC_CORPUS', 'author preparation does not prove 25 available exact games')
  }
  const actualCorpus = []
  for (const game of games) {
    const files = []
    for (const file of game.files) {
      if (typeof file?.path !== 'string' || typeof file?.sha256 !== 'string' || !SHA256.test(file.sha256)) {
        fail('ARC_CORPUS', `invalid recorded file for ${String(game?.requestedGameId)}`)
      }
      const pathInCorpus = resolve(corpus, file.path)
      if (!isWithin(corpus, pathInCorpus)) fail('ARC_CORPUS', `file escapes corpus: ${file.path}`)
      const digest = await sha256File(pathInCorpus)
      if (digest !== file.sha256.toLowerCase()) fail('ARC_CORPUS_CHANGED', `${file.path} changed after preparation`)
      files.push({ path: file.path, sha256: digest, size: (await stat(pathInCorpus)).size })
    }
    actualCorpus.push({ gameId: game.requestedGameId, files })
  }
  for (const selected of plan.cases) {
    const prepared = actualCorpus.find(item => item.gameId === selected.gameId)
    if (!prepared) fail('ARC_CORPUS', `frozen game is absent: ${selected.gameId}`)
    for (const [basename, expected] of Object.entries(selected.files)) {
      const actual = prepared.files.find(file => file.path.endsWith(`/${basename}`))
      if (!actual || actual.sha256 !== expected.toLowerCase()) {
        fail('ARC_CORPUS_CHANGED', `${selected.gameId}/${basename} does not match the approved hash`)
      }
    }
  }
  const dependencies = report?.dependencies
  if (dependencies?.arcAgi !== '0.9.9' || dependencies?.arcengine !== '0.9.3' || typeof dependencies?.python !== 'string' || !dependencies.python.startsWith('3.12.')) {
    fail('ARC_SDK_PIN', 'prepared ARC SDK must be Python 3.12, arc-agi 0.9.9, arcengine 0.9.3')
  }
  const python = join(requireText(dependencies?.venv, 'author preparation dependencies.venv'), 'bin/python')
  await assertRegularFile(python, 'prepared Python')
  const authorFiles = {}
  for (const file of ['AGENTS.md', 'game-prompt.txt', 'broker_client.py']) {
    const filePath = join(sourceRoot, file)
    await assertRegularFile(filePath, `author ${file}`)
    authorFiles[file] = { path: filePath, sha256: await sha256File(filePath), bytes: (await stat(filePath)).size }
  }
  if (authorFiles['AGENTS.md'].sha256 !== plan.arms.R.guidanceSha256
    || authorFiles['game-prompt.txt'].sha256 !== plan.arms.R.initialPromptSha256) {
    fail('ARC_AUTHOR_PROMPT', 'author guidance or initial prompt differs from the frozen plan')
  }
  return {
    root,
    reportPath,
    reportHash: await sha256File(reportPath),
    sourceRoot,
    sourceHead,
    corpus,
    python,
    dependencies: { python: dependencies.python, arcAgi: dependencies.arcAgi, arcengine: dependencies.arcengine },
    corpus: { path: corpus, games: actualCorpus, hash: canonicalHash(actualCorpus) },
    authorFiles,
  }
}

async function compileCurrentSources({ sourceRoot, packageRoot, shared }) {
  const esbuild = await import('esbuild')
  const compiled = join(shared, 'compiled')
  await mkdir(compiled, { recursive: true, mode: 0o700 })
  const entryPoints = {
    host: join(packageRoot, 'src/core.ts'),
    runtime: join(packageRoot, 'src/runtime.ts'),
    'acp-client': join(packageRoot, 'src/acp-client.ts'),
    'model-wire': join(packageRoot, 'src/model-wire.ts'),
    replay: join(packageRoot, 'src/replay.ts'),
    execution: join(packageRoot, 'src/execution.ts'),
    'prime-evidence': join(packageRoot, 'src/prime-evidence.ts'),
  }
  for (const path of Object.values(entryPoints)) await assertRegularFile(path, 'RLM compile input')
  await esbuild.build({
    absWorkingDir: sourceRoot,
    entryPoints,
    outdir: compiled,
    entryNames: '[name]',
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    sourcemap: false,
    logLevel: 'silent',
  })
  const outputs = {}
  for (const name of Object.keys(entryPoints)) {
    const path = join(compiled, `${name}.mjs`)
    await assertRegularFile(path, `compiled ${name}`)
    outputs[`${name}.mjs`] = { sha256: await sha256File(path), bytes: (await stat(path)).size }
  }
  const nodeModules = join(sourceRoot, 'node_modules')
  await assertDirectory(nodeModules, 'source node_modules')
  await symlink(nodeModules, join(shared, 'node_modules'), 'dir')
  await symlink(join(packageRoot, 'assets'), join(shared, 'assets'), 'dir')
  return { compiled, outputs, hash: canonicalHash(outputs) }
}

async function prepareSharedRuntime({ compiled, packageRoot, shared }) {
  const runtime = await import(pathToFileURL(join(compiled, 'runtime.mjs')).href)
  if (typeof runtime.loadRuntime !== 'function') fail('ARC_RUNTIME_IMPORT', 'compiled runtime did not export loadRuntime')
  const paths = await runtime.loadRuntime(packageRoot, shared)
  const runtimes = join(shared, 'runtimes')
  await assertDirectory(runtimes, 'shared runtimes')
  // The worker sandbox, rather than chmod recursion, enforces shared runtime
  // immutability.  The signed capsule has valid internal links and executable
  // Python names such as python3.12; rewriting modes or rejecting links here
  // would alter the frozen runtime we are trying to verify.
  const manifestPath = join(packageRoot, 'assets/runtime-manifest.json')
  let runtimeManifest
  try { runtimeManifest = JSON.parse(await readFile(manifestPath, 'utf8')) } catch (error) { fail('ARC_RUNTIME_MANIFEST', 'runtime manifest is invalid', { cause: error }) }
  return {
    paths: { binary: paths.binary, python: paths.python, packageDir: paths.packageDir, fingerprint: paths.fingerprint },
    manifest: { path: manifestPath, sha256: await sha256File(manifestPath), primeCommit: runtimeManifest?.primeCommit ?? null, archiveSha256: runtimeManifest?.archiveSha256 ?? null },
    runtimes,
  }
}

function bootstrapInstructions(proxySocket, stateRoot) {
  return [
    'Before the first import of broker_client, set the two broker environment variables exactly as follows:',
    'import os',
    `os.environ["ARC3_GAME_BROKER_SOCKET"] = ${JSON.stringify(proxySocket)}`,
    `os.environ["ARC3_STATE"] = ${JSON.stringify(stateRoot)}`,
    'Then import broker_client and use its terminal-gate through the supplied fixed game broker only.',
  ].join('\n')
}

function fixedGateCommand({ python, workspace, proxySocket, stateRoot }) {
  const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`
  return [
    `env -i PATH=${quote(dirname(python))} HOME=${quote(join(workspace, '.home'))} TMPDIR=${quote(join(workspace, '.tmp'))}`,
    `ARC3_GAME_BROKER_SOCKET=${quote(proxySocket)} ARC3_STATE=${quote(stateRoot)}`,
    `${quote(python)} ${quote(join(workspace, 'broker_client.py'))} terminal-gate`,
  ].join(' ')
}

async function prepareConditionDirectories({ output, sharedRuntimeRoot, gatePython, author, plan }) {
  const arms = ['B', 'R', 'S']
  const conditions = []
  let ordinal = 0
  for (let caseIndex = 0; caseIndex < plan.cases.length; caseIndex += 1) {
    const game = plan.cases[caseIndex]
    const order = [...arms].sort((left, right) => conditionKey(game.gameId, left).localeCompare(conditionKey(game.gameId, right)))
    for (const arm of order) {
      const id = conditionId(ordinal, game.gameId, arm)
      const directory = join(output, 'runs', `${String(ordinal + 1).padStart(2, '0')}${arm}`)
      const workspace = join(directory, 'workspace')
      const data = join(directory, 'data')
      const proxySocket = join(directory, 'guard.sock')
      const stateRoot = join(directory, 'client-state')
      const nativeWorkerSocket = join(directory, 'tmp', `prime-agent-${process.getuid?.() ?? 501}`, 'worker-000000000000-000000000000.sock')
      if (Buffer.byteLength(nativeWorkerSocket) >= 100) fail('ARC_SOCKET_PATH', `native worker TMPDIR socket is too long: ${nativeWorkerSocket}`)
      if (Buffer.byteLength(proxySocket) >= 100) fail('ARC_SOCKET_PATH', `proxy socket is too long: ${proxySocket}`)
      await mkdir(workspace, { recursive: true, mode: 0o700 })
      await Promise.all(['home', 'tmp', 'data', 'client-state'].map(async name => {
        const path = join(directory, name)
        await mkdir(path, { recursive: true, mode: 0o700 })
        await chmod(path, 0o700)
      }))
      await copyFile(author.authorFiles['AGENTS.md'].path, join(workspace, 'AGENTS.md'), fsConstants.COPYFILE_EXCL)
      await copyFile(author.authorFiles['broker_client.py'].path, join(workspace, 'broker_client.py'), fsConstants.COPYFILE_EXCL)
      await symlink(sharedRuntimeRoot, join(data, 'runtimes'), 'dir')
      const bootstrap = bootstrapInstructions(proxySocket, stateRoot)
      const task = arm === 'B'
        ? plan.arms.B.systemPrompt
        : `${await readFile(author.authorFiles['game-prompt.txt'].path, 'utf8')}\n\n${bootstrap}`
      const prompt = arm === 'B'
        ? { systemPrompt: plan.arms.B.systemPrompt }
        : {
            guidance: await readFile(author.authorFiles['AGENTS.md'].path, 'utf8'),
            initialPrompt: await readFile(author.authorFiles['game-prompt.txt'].path, 'utf8'),
            bootstrap,
            task,
          }
      const condition = {
        ordinal,
        id,
        arm,
        gameId: game.gameId,
        seed: game.seed,
        gameFiles: game.files,
        orderKey: conditionKey(game.gameId, arm),
        directory,
        workspace,
        data,
        proxySocket,
        stateRoot,
        privateEngineDirectory: join(output, 'parent-private', 'engines', id),
        prompt,
        promptHash: canonicalHash(prompt),
        autonomous: arm === 'B' ? null : { ...plan.arms[arm].autonomous, gate: fixedGateCommand({ python: gatePython, workspace, proxySocket, stateRoot }) },
      }
      await writeExclusiveJson(join(directory, 'condition.json'), condition)
      conditions.push(condition)
      ordinal += 1
    }
  }
  return conditions
}

const EXECUTION_FILES = [
  'tools/rlm-arc-pilot/run.mjs', 'tools/rlm-arc-pilot/broker.mjs',
  'tools/rlm-arc-pilot/baseline.mjs', 'tools/rlm-arc-pilot/native-worker.mjs',
  'tools/rlm-arc-pilot/sandbox.mjs', 'tools/rlm-arc-pilot/attachment-relay.mjs',
  'tools/rlm-arc-pilot/ledger.mjs', 'tools/fixtures/rlm-arc-prepare/sdk-step-adapter.py',
  'package.json', 'pnpm-lock.yaml',
]

async function executionHashes(sourceRoot) {
  const files = {}
  for (const name of EXECUTION_FILES) files[name] = await sha256File(join(sourceRoot, name))
  return files
}

function prepareFingerprint(manifest) {
  return canonicalHash({
    execution: manifest.execution,
    planHash: manifest.plan.hash,
    runnerHash: manifest.runner.sha256,
    compiledHash: manifest.shared.compiled.hash,
    runtimeHash: manifest.shared.runtime.manifest.sha256,
    corpusHash: manifest.author.corpus.hash,
    conditions: manifest.conditions.map(condition => ({ id: condition.id, orderKey: condition.orderKey, promptHash: condition.promptHash })),
  })
}

/**
 * Construct all non-billable pilot inputs in a new private output directory.
 * Test seams are explicit functions, never command-line flags.
 */
export async function preparePilot({
  output,
  planPath = DEFAULT_PLAN,
  sourceRoot = REPOSITORY_ROOT,
  packageRoot = join(sourceRoot, 'incubator/rlm'),
  authorPreparation,
  priorLedgerPath = DEFAULT_PRIOR_LEDGER,
  compiler = compileCurrentSources,
  runtimePreparer = prepareSharedRuntime,
} = {}) {
  const outputRoot = requirePrivateTemporaryDirectory(output)
  if (!authorPreparation) fail('ARC_PREPARE_ARGS', '--author-preparation is required')
  const source = await assertDirectory(sourceRoot, 'sourceRoot')
  const packageDirectory = await assertDirectory(packageRoot, 'packageRoot')
  const { path: frozenPlanPath, plan, hash: planHash, canonicalHash: planCanonicalHash } = await loadPlan(planPath)
  await assertNewDirectory(outputRoot, 'output')
  try {
    const parentPrivate = join(outputRoot, 'parent-private')
    const shared = join(outputRoot, 'shared')
    await Promise.all([mkdir(parentPrivate, { recursive: true, mode: 0o700 }), mkdir(shared, { recursive: true, mode: 0o700 })])
    await Promise.all([chmod(parentPrivate, 0o700), chmod(shared, 0o700)])
    const author = await readAuthorPreparation(authorPreparation, plan)
    const sharedCompile = await compiler({ sourceRoot: source, packageRoot: packageDirectory, shared })
    const runtime = await runtimePreparer({ compiled: sharedCompile.compiled, packageRoot: packageDirectory, shared })
    if (runtime.manifest.primeCommit !== plan.primeCommit) fail('ARC_RUNTIME_PIN', 'shared runtime Prime commit does not match the plan')
    const prior = await loadPriorEvidence(priorLedgerPath)
    const ledgerPath = join(outputRoot, 'provider-ledger.jsonl')
    const ledger = await Ledger.open(ledgerPath, {
      total: FIXED_LIMITS.total,
      perRun: FIXED_LIMITS.requestLimit,
      priorCalls: prior.priorCalls,
      continuationAuthorization: plan.budget.authorization,
    })
    const ledgerReceipt = await ledger.receipt()
    if (ledgerReceipt.admitted !== FIXED_LIMITS.prior || ledgerReceipt.settled !== 135 || ledgerReceipt.unknown !== 3 || ledgerReceipt.stopped) {
      fail('ARC_NEW_LEDGER', 'new 522-cap ledger did not retain the 138 historical charges while allowing the explicitly authorized continuation')
    }
    const conditions = await prepareConditionDirectories({ output: outputRoot, sharedRuntimeRoot: runtime.runtimes, gatePython: runtime.paths.python, author, plan })
    const runnerPath = fileURLToPath(import.meta.url)
    const sourceHead = await gitValue(source, ['rev-parse', '--verify', 'HEAD'], 'runner source HEAD')
    const manifest = {
      formatVersion: FORMAT_VERSION,
      kind: 'prime-rlm-arc-pilot-prepared',
      preparedAt: new Date().toISOString(),
      output: outputRoot,
      plan: { path: frozenPlanPath, hash: planHash, canonicalHash: planCanonicalHash, approved: plan.budget.approved, authorization: plan.budget.authorization },
      runner: { path: runnerPath, sha256: await sha256File(runnerPath), sourceRoot: source, sourceHead },
      execution: { files: await executionHashes(source), node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch },
      package: { root: packageDirectory, assets: join(packageDirectory, 'assets') },
      author: {
        preparation: { root: author.root, reportPath: author.reportPath, reportHash: author.reportHash },
        sourceRoot: author.sourceRoot,
        sourceHead: author.sourceHead,
        python: author.python,
        dependencies: author.dependencies,
        corpus: author.corpus,
        files: author.authorFiles,
      },
      shared: { path: shared, compiled: { path: sharedCompile.compiled, outputs: sharedCompile.outputs, hash: sharedCompile.hash }, runtime },
      parentPrivate,
      ledger: { path: ledgerPath, prior },
      limits: FIXED_LIMITS,
      conditions,
      sideEffects: { providerLoaded: false, credentialRead: false, modelCalls: 0, network: false },
    }
    manifest.fingerprint = prepareFingerprint(manifest)
    await writeExclusiveJson(join(outputRoot, PREPARED_MANIFEST), manifest)
    return manifest
  } catch (error) {
    // The new output is intentionally retained for diagnosis.  It contains no
    // provider material because prepare never accepts any provider argument.
    await writeFile(join(outputRoot, 'prepare-failed.json'), `${JSON.stringify({ formatVersion: FORMAT_VERSION, error: redact(errorText(error)) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(() => {})
    throw error
  }
}

async function readPreparedManifest(output) {
  const root = requirePrivateTemporaryDirectory(output)
  const path = join(root, PREPARED_MANIFEST)
  await assertRegularFile(path, 'prepared manifest')
  let manifest
  try { manifest = JSON.parse(await readFile(path, 'utf8')) } catch (error) { fail('ARC_PREPARED_JSON', 'prepared manifest is invalid', { cause: error }) }
  if (!isRecord(manifest) || manifest.kind !== 'prime-rlm-arc-pilot-prepared' || manifest.formatVersion !== FORMAT_VERSION) {
    fail('ARC_PREPARED_FORMAT', 'prepared manifest has an unsupported format')
  }
  return { root, path, manifest }
}

function requireSha256(value, label, code = 'ARC_CONTINUATION_ARTIFACT') {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code, `${label} must be a SHA-256 digest`)
  return value.toLowerCase()
}

function requireExactHashMap(value, label) {
  if (!isRecord(value)) fail('ARC_CONTINUATION_ARTIFACT', `${label} must be an object`)
  const expected = [...EXECUTION_FILES].sort()
  const actual = Object.keys(value).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('ARC_CONTINUATION_ARTIFACT', `${label} must name exactly the frozen execution files`)
  return Object.fromEntries(expected.map(name => [name, requireSha256(value[name], `${label}.${name}`)]))
}

function assertRunnerOnlyContinuation(manifest, continuation, currentExecution, currentRunnerHash) {
  if (!continuation) fail('ARC_FINGERPRINT_EXECUTION', 'executed helpers or dependency pins changed since prepare')
  const originalExecution = manifest.execution?.files
  const acceptedExecution = continuation.currentExecutionHashes
  if (!isRecord(originalExecution) || !isRecord(acceptedExecution)) fail('ARC_CONTINUATION_ARTIFACT', 'continuation does not bind execution hashes')
  if (continuation.originalFingerprint !== manifest.fingerprint
    || continuation.originalRunnerSha256 !== manifest.runner?.sha256
    || originalExecution[RUNNER_EXECUTION_FILE] !== manifest.runner?.sha256
    || continuation.currentRunnerSha256 !== currentRunnerHash
    || acceptedExecution[RUNNER_EXECUTION_FILE] !== currentRunnerHash
    || currentRunnerHash === manifest.runner?.sha256) {
    fail('ARC_CONTINUATION_RUNNER', 'continuation does not bind the exact old and current runner bytes')
  }
  for (const name of EXECUTION_FILES) {
    if (name === RUNNER_EXECUTION_FILE) continue
    if (currentExecution[name] !== originalExecution[name] || acceptedExecution[name] !== originalExecution[name]) {
      fail('ARC_CONTINUATION_EXECUTION', `${name} changed; only ${RUNNER_EXECUTION_FILE} may differ for an unstarted continuation`)
    }
  }
  if (canonicalHash(currentExecution) !== canonicalHash(acceptedExecution)) {
    fail('ARC_CONTINUATION_EXECUTION', 'continuation current execution hashes do not match the local files')
  }
}

export async function assertPreparedFingerprint(manifest, { continuation } = {}) {
  const { hash: planHash } = await loadPlan(manifest.plan.path)
  if (planHash !== manifest.plan.hash) fail('ARC_FINGERPRINT_PLAN', 'approved plan bytes have changed since prepare')
  const currentExecution = await executionHashes(manifest.runner.sourceRoot)
  const runnerHash = await sha256File(manifest.runner.path)
  if (canonicalHash(currentExecution) !== canonicalHash(manifest.execution?.files)) {
    assertRunnerOnlyContinuation(manifest, continuation, currentExecution, runnerHash)
  }
  if (manifest.execution.node !== process.version || manifest.execution.platform !== process.platform || manifest.execution.arch !== process.arch) fail('ARC_FINGERPRINT_ENVIRONMENT', 'Node/platform differs from preparation')
  if (runnerHash !== manifest.runner.sha256 && !continuation) fail('ARC_FINGERPRINT_RUNNER', 'runner bytes have changed since prepare')
  if (runnerHash !== manifest.runner.sha256 && continuation) assertRunnerOnlyContinuation(manifest, continuation, currentExecution, runnerHash)
  const outputs = {}
  for (const [name, expected] of Object.entries(manifest.shared.compiled.outputs ?? {})) {
    const path = join(manifest.shared.compiled.path, name)
    const digest = await sha256File(path)
    const bytes = (await stat(path)).size
    if (digest !== expected.sha256 || bytes !== expected.bytes) fail('ARC_FINGERPRINT_COMPILED', `${name} changed since prepare`)
    outputs[name] = { sha256: digest, bytes }
  }
  if (canonicalHash(outputs) !== manifest.shared.compiled.hash) fail('ARC_FINGERPRINT_COMPILED', 'compiled output manifest changed')
  if (await sha256File(manifest.shared.runtime.manifest.path) !== manifest.shared.runtime.manifest.sha256) fail('ARC_FINGERPRINT_RUNTIME', 'runtime manifest changed since prepare')
  for (const condition of manifest.conditions) {
    if (condition.arm !== 'B' && await sha256File(join(condition.workspace, 'AGENTS.md')) !== manifest.author.files['AGENTS.md'].sha256) fail('ARC_FINGERPRINT_PROMPT', 'copied guidance changed before launch')
    if (await sha256File(join(condition.workspace, 'broker_client.py')) !== manifest.author.files['broker_client.py'].sha256) fail('ARC_FINGERPRINT_CLIENT', 'copied author client changed before launch')
  }
  if (prepareFingerprint(manifest) !== manifest.fingerprint) fail('ARC_FINGERPRINT_MANIFEST', 'prepared manifest contents are not self-consistent')
}

class SyntheticBroker {
  constructor({ winAfterActs = 2 } = {}) {
    this.winAfterActs = winAfterActs
    this.acts = 0
    this.calls = []
  }

  observation() {
    return {
      terminal: this.acts >= this.winAfterActs ? 'WIN' : 'ACTIVE',
      actions_taken: this.acts,
      levels_completed: this.acts >= this.winAfterActs ? 1 : 0,
      frame: [[this.acts]],
    }
  }

  async call(op, args = {}) {
    this.calls.push({ op, args: jsonClone(args) })
    if (op === 'act') this.acts += args.actions.length
    return this.observation()
  }

  async inspect() {
    return this.observation()
  }
}

function toolCall(id, name, args) {
  return { id, type: 'tool-call', name, arguments: JSON.stringify(args) }
}

function syntheticFinish(message, replayState) {
  return [
    ...(message.toolCalls ?? []).flatMap((call, index) => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments },
      { type: 'block-end', index, block: call },
    ]),
    ...(message.text === undefined ? [] : [
      { type: 'block-start', index: 20, blockType: 'text' },
      { type: 'text-delta', index: 20, text: message.text },
      { type: 'block-end', index: 20, block: { type: 'text', text: message.text } },
    ]),
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: message.toolCalls?.length ? 'tool-calls' : 'stop' }, replayState },
  ]
}

function syntheticModel(responses, observedOptions) {
  let index = 0
  return async options => {
    observedOptions.push(options)
    const response = responses[index]
    index += 1
    if (!response) fail('ARC_KEYLESS_MODEL', 'synthetic response queue was exhausted')
    return (async function* () { yield* syntheticFinish(response.message, response.replayState) })()
  }
}

async function withTemporaryDirectory(root, name, operation) {
  const path = join(root, name)
  await mkdir(path, { recursive: true, mode: 0o700 })
  return await operation(path)
}

async function runActualWireBaselineChecks({ root, manifest, plan, wire }) {
  const route = { provider: FIXED_ROUTE.provider, model: FIXED_ROUTE.model, reasoningEffort: FIXED_ROUTE.reasoningEffort, maxTokens: FIXED_ROUTE.maxOutputTokens }
  const positiveBroker = new SyntheticBroker()
  const positiveOptions = []
  const positive = await withTemporaryDirectory(root, 'keyless-baseline-positive', async directory => runBaseline({
    directory,
    plan,
    gameId: 'synthetic-keyless',
    broker: positiveBroker,
    route,
    wire,
    callModel: syntheticModel([
      { message: { toolCalls: [toolCall('observe', 'observe', {})] }, replayState: { response: { opaque: 'first' } } },
      { message: { toolCalls: [toolCall('act-1', 'act', { actions: [{ name: 'ACTION1', data: {} }] })] }, replayState: { response: { opaque: 'second' } } },
      { message: { toolCalls: [toolCall('act-2', 'act', { actions: [{ name: 'ACTION2', data: {} }] })] }, replayState: { response: { opaque: 'third' } } },
    ], positiveOptions),
    requestLimit: 32,
    wallTimeMs: 10_000,
  }))
  if (positive.state !== 'completed' || positive.stopReason !== 'WIN' || positive.requests !== 3 || positiveBroker.acts !== 2) {
    fail('ARC_KEYLESS_BASELINE', 'actual wire B path did not reach the independent synthetic WIN')
  }
  const replayed = positiveOptions[1]?.messages?.some(message => message?.source?.replayState?.response?.opaque === 'first') === true
  if (!replayed) fail('ARC_KEYLESS_REPLAY', 'opaque replay state was not supplied to the next decoded request')

  const negativeBroker = new SyntheticBroker({ winAfterActs: 2 })
  const negative = await withTemporaryDirectory(root, 'keyless-baseline-text-negative', async directory => runBaseline({
    directory,
    plan,
    gameId: 'synthetic-keyless-negative',
    broker: negativeBroker,
    route,
    wire,
    callModel: syntheticModel([{ message: { text: 'WIN' }, replayState: { response: { opaque: 'text-only' } } }], []),
    requestLimit: 1,
    wallTimeMs: 10_000,
  }))
  if (negative.state !== 'budget_exhausted' || negative.stopReason !== 'REQUEST_LIMIT' || negativeBroker.acts !== 0) {
    fail('ARC_KEYLESS_TEXT_NEGATIVE', 'a text-only WIN was mistaken for broker evidence')
  }
  return {
    actualWire: true,
    positive: { state: positive.state, stopReason: positive.stopReason, requests: positive.requests, brokerCalls: positiveBroker.calls.length },
    textWinNegative: { state: negative.state, stopReason: negative.stopReason, brokerCalls: negativeBroker.calls.length },
    opaqueReplayPreserved: replayed,
  }
}

function knownSyntheticChunks() {
  return [{ type: 'finish', reason: { kind: 'stop' } }]
}

async function runLedgerKeylessChecks({ root, manifest }) {
  const ledgerPath = join(root, 'keyless-cap-ledger.jsonl')
  const prior = manifest.ledger.prior.priorCalls
  const ledger = await Ledger.open(ledgerPath, {
    total: FIXED_LIMITS.total,
    perRun: FIXED_LIMITS.requestLimit,
    priorCalls: prior,
    continuationAuthorization: manifest.plan.authorization,
  })
  const runId = 'synthetic-physical-cap'
  const physical = []
  for (let index = 0; index < FIXED_LIMITS.requestLimit; index += 1) {
    const request = await ledger.admit(runId, { synthetic: true, ordinal: index + 1 })
    physical.push({ request, ordinal: ledger.admitPhysical({ runId, logicalRequest: request, event: { synthetic: true } }) })
    if (index < FIXED_LIMITS.requestLimit - 1) await ledger.settle(request, knownSyntheticChunks())
  }
  let physicalCap = false
  try { ledger.admitPhysical({ runId, logicalRequest: physical.at(-1).request, event: { synthetic: 'cap-negative' } }) } catch (error) { physicalCap = error?.message === 'PHYSICAL_REQUEST_LIMIT' }
  if (!physicalCap) fail('ARC_KEYLESS_PHYSICAL_CAP', '33rd physical request was not rejected')
  await ledger.settle(physical.at(-1).request, knownSyntheticChunks())

  const unknownId = await ledger.admit('synthetic-unknown', { synthetic: 'unknown' })
  ledger.admitPhysical({ runId: 'synthetic-unknown', logicalRequest: unknownId, event: { synthetic: true } })
  await ledger.settle(unknownId, [], new Error('synthetic stream interruption'))
  let noReplay = false
  try { await ledger.admit('synthetic-unknown', { synthetic: 'replay-forbidden' }) } catch (error) { noReplay = error?.message === 'EXPERIMENT_STOPPED' }
  if (!noReplay) fail('ARC_KEYLESS_UNKNOWN', 'unknown synthetic request was admitted for replay')
  const unknownReceipt = await ledger.receipt()
  if (unknownReceipt.unknown !== 4 || unknownReceipt.stopped !== true) fail('ARC_KEYLESS_UNKNOWN', 'unknown request was not retained and charged')

  const wholeLedgerPath = join(root, 'keyless-whole-tree-cap-ledger.jsonl')
  const wholeLedger = await Ledger.open(wholeLedgerPath, {
    total: FIXED_LIMITS.total,
    perRun: FIXED_LIMITS.requestLimit,
    priorCalls: prior,
    continuationAuthorization: manifest.plan.authorization,
  })
  let newAdmissions = 0
  for (let index = 0; index < manifest.conditions.length; index += 1) {
    const condition = manifest.conditions[index]
    for (let request = 0; request < FIXED_LIMITS.requestLimit; request += 1) {
      const id = await wholeLedger.admit(condition.id, { synthetic: 'whole-tree', request: request + 1 })
      wholeLedger.admitPhysical({ runId: condition.id, logicalRequest: id, event: { synthetic: true } })
      await wholeLedger.settle(id, knownSyntheticChunks())
      newAdmissions += 1
    }
  }
  if (newAdmissions !== FIXED_LIMITS.newPanel) fail('ARC_KEYLESS_TOTAL_CAP', 'keyless panel did not exercise all 384 newly authorized slots')
  let totalCap = false
  try { await wholeLedger.admit('overflow', { synthetic: 'over-total' }) } catch (error) { totalCap = error?.message === 'EXPERIMENT_REQUEST_LIMIT' }
  const wholeReceipt = await wholeLedger.receipt()
  if (!totalCap || wholeReceipt.admitted !== FIXED_LIMITS.total || wholeReceipt.physicalAdmitted !== FIXED_LIMITS.total) {
    fail('ARC_KEYLESS_TOTAL_CAP', '522 cumulative logical/physical cap was not enforced')
  }
  return {
    physicalCap32: true,
    cumulativeCap522: true,
    unknownRetained: true,
    noFailedReplay: true,
    wholeTree: { prior: FIXED_LIMITS.prior, newAdmissions, total: wholeReceipt.admitted, physical: wholeReceipt.physicalAdmitted },
  }
}

/** Run only synthetic adapter/broker checks.  This never loads provider code. */
export async function keylessPilot({ output } = {}) {
  const { root, manifest } = await readPreparedManifest(output)
  await assertPreparedFingerprint(manifest)
  if (await exists(join(root, KEYLESS_RECEIPT))) fail('ARC_KEYLESS_EXISTS', 'keyless receipt already exists; prepare a new output for a new fingerprint')
  const { plan } = await loadPlan(manifest.plan.path)
  const modelWire = await import(pathToFileURL(join(manifest.shared.compiled.path, 'model-wire.mjs')).href)
  const replay = await import(pathToFileURL(join(manifest.shared.compiled.path, 'replay.mjs')).href)
  const wire = { ...modelWire, ReplayRegistry: replay.ReplayRegistry }
  if (typeof wire.decodeChatRequest !== 'function' || typeof wire.encodeChatStream !== 'function' || typeof wire.ReplayRegistry !== 'function') {
    fail('ARC_KEYLESS_WIRE', 'compiled model wire lacks the required API')
  }
  const baseline = await runActualWireBaselineChecks({ root, manifest, plan, wire })
  const ledger = await runLedgerKeylessChecks({ root, manifest })
  const receipt = {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-arc-keyless-acceptance',
    accepted: true,
    createdAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    planHash: manifest.plan.hash,
    runnerHash: manifest.runner.sha256,
    compiledHash: manifest.shared.compiled.hash,
    checks: { baseline, ledger },
    sideEffects: { providerLoaded: false, credentialRead: false, modelCalls: 0, network: false },
  }
  await writeExclusiveJson(join(root, KEYLESS_RECEIPT), receipt)
  return receipt
}

async function loadKeylessGate(root, manifest) {
  const path = join(root, KEYLESS_RECEIPT)
  await assertRegularFile(path, 'keyless acceptance')
  let receipt
  try { receipt = JSON.parse(await readFile(path, 'utf8')) } catch (error) { fail('ARC_KEYLESS_JSON', 'keyless receipt is invalid', { cause: error }) }
  if (receipt?.kind !== 'prime-rlm-arc-keyless-acceptance' || receipt?.accepted !== true
    || receipt?.fingerprint !== manifest.fingerprint
    || receipt?.planHash !== manifest.plan.hash
    || receipt?.runnerHash !== manifest.runner.sha256
    || receipt?.compiledHash !== manifest.shared.compiled.hash) {
    fail('ARC_KEYLESS_GATE', 'keyless receipt does not bind the current full prepared fingerprint')
  }
  return { path, hash: await sha256File(path), receipt }
}

async function loadExternalAcceptance({ artifact, sha256, manifest }) {
  const path = await assertRegularFile(artifact, 'external acceptance artifact')
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) fail('ARC_ACCEPTANCE_HASH', '--acceptance-sha256 is required')
  const actualHash = await sha256File(path)
  if (actualHash !== sha256.toLowerCase()) fail('ARC_ACCEPTANCE_HASH', 'external acceptance artifact SHA-256 does not match')
  let value
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error) { fail('ARC_ACCEPTANCE_JSON', 'external acceptance artifact is not JSON', { cause: error }) }
  if (value?.accepted !== true || value?.fingerprint !== manifest.fingerprint) {
    fail('ARC_ACCEPTANCE_GATE', 'external acceptance artifact does not accept this exact prepared fingerprint')
  }
  return { path, hash: actualHash, value }
}

function normalizeConditionHashMap(value, label, manifest) {
  if (!isRecord(value)) fail('ARC_CONTINUATION_ARTIFACT', `${label} must be an object`)
  const known = new Set(manifest.conditions.map(condition => condition.id))
  const result = {}
  for (const [id, hash] of Object.entries(value)) {
    if (!known.has(id)) fail('ARC_CONTINUATION_ARTIFACT', `${label} names an unknown condition: ${id}`)
    result[id] = requireSha256(hash, `${label}.${id}`)
  }
  return result
}

function normalizeClosedUnknownRun(value) {
  if (!isRecord(value)) fail('ARC_CONTINUATION_ARTIFACT', 'closedUnknownRun must be an object')
  if (typeof value.runId !== 'string' || value.runId.length === 0) fail('ARC_CONTINUATION_ARTIFACT', 'closedUnknownRun.runId is required')
  if (!Array.isArray(value.unknownCalls) || value.unknownCalls.length === 0 || value.unknownCalls.some(call => typeof call !== 'string')) {
    fail('ARC_CONTINUATION_ARTIFACT', 'closedUnknownRun.unknownCalls must be a non-empty string array')
  }
  if (value.cause !== 'native_budget_closed') fail('ARC_CONTINUATION_ARTIFACT', 'closedUnknownRun.cause must be native_budget_closed')
  if (!isRecord(value.evidenceHash) || value.evidenceHash.algorithm !== 'sha256') fail('ARC_CONTINUATION_ARTIFACT', 'closedUnknownRun.evidenceHash must be a sha256 object')
  return {
    run: value.runId,
    unknownCalls: [...value.unknownCalls],
    cause: value.cause,
    evidenceHash: { algorithm: 'sha256', digest: requireSha256(value.evidenceHash.digest, 'closedUnknownRun.evidenceHash.digest') },
  }
}

function normalizeContinuationAcceptance(value, manifest) {
  if (!isRecord(value) || value.formatVersion !== FORMAT_VERSION || value.kind !== CONTINUATION_KIND || value.accepted !== true) {
    fail('ARC_CONTINUATION_ARTIFACT', 'continuation artifact is not an accepted unstarted-continuation receipt')
  }
  const originalFingerprint = requireSha256(value.originalFingerprint, 'originalFingerprint')
  const originalRunnerSha256 = requireSha256(value.originalRunnerSha256, 'originalRunnerSha256')
  const currentRunnerSha256 = requireSha256(value.currentRunnerSha256, 'currentRunnerSha256')
  const currentExecutionHashes = requireExactHashMap(value.currentExecutionHashes, 'currentExecutionHashes')
  if (originalFingerprint !== manifest.fingerprint || originalRunnerSha256 !== manifest.runner.sha256) {
    fail('ARC_CONTINUATION_ARTIFACT', 'continuation artifact does not bind this original prepared manifest')
  }
  const previous = value.previous
  if (!isRecord(previous)) fail('ARC_CONTINUATION_ARTIFACT', 'previous immutable evidence is required')
  return {
    originalFingerprint,
    originalRunnerSha256,
    currentRunnerSha256,
    currentExecutionHashes,
    previous: {
      runReceiptSha256: requireSha256(previous.runReceiptSha256, 'previous.runReceiptSha256'),
      panelStartMarkerSha256: requireSha256(previous.panelStartMarkerSha256, 'previous.panelStartMarkerSha256'),
      resultSha256: normalizeConditionHashMap(previous.resultSha256, 'previous.resultSha256', manifest),
      startedMarkerSha256: normalizeConditionHashMap(previous.startedMarkerSha256, 'previous.startedMarkerSha256', manifest),
    },
    closedUnknownRun: normalizeClosedUnknownRun(value.closedUnknownRun),
  }
}

async function loadContinuationAcceptance({ artifact, sha256, manifest }) {
  const path = await assertRegularFile(artifact, 'continuation artifact')
  const expectedHash = requireSha256(sha256, '--continuation-sha256', 'ARC_CONTINUATION_HASH')
  const hash = await sha256File(path)
  if (hash !== expectedHash) fail('ARC_CONTINUATION_HASH', 'continuation artifact SHA-256 does not match')
  let value
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error) { fail('ARC_CONTINUATION_ARTIFACT', 'continuation artifact is not JSON', { cause: error }) }
  return { path, hash, ...normalizeContinuationAcceptance(value, manifest) }
}

async function readJson(path, label) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { fail('ARC_CONTINUATION_JSON', `${label} is not JSON`, { cause: error }) }
}

async function conditionEvidence(root, manifest) {
  const resultRoot = join(root, RESULTS_DIRECTORY)
  const knownResultNames = new Set(manifest.conditions.map(condition => `${condition.id}.json`))
  if (await exists(resultRoot)) {
    const info = await lstat(resultRoot)
    if (!info.isDirectory() || info.isSymbolicLink()) fail('ARC_CONTINUATION_RESULTS', 'results directory is not a real directory')
    for (const entry of await readdir(resultRoot)) {
      if (!knownResultNames.has(entry)) fail('ARC_CONTINUATION_RESULTS', `unexpected result file: ${entry}`)
    }
  }
  const resultSha256 = {}
  const startedMarkerSha256 = {}
  const recorded = []
  const unstarted = []
  for (const condition of manifest.conditions) {
    const resultPath = join(resultRoot, `${condition.id}.json`)
    const markerPath = join(condition.directory, 'real-condition-started.json')
    const hasResult = await exists(resultPath)
    const hasMarker = await exists(markerPath)
    if (hasMarker !== hasResult) fail('ARC_CONTINUATION_STARTED_STATE', `${condition.id} has ${hasMarker ? 'a start marker without a result' : 'a result without a start marker'}`)
    if (!hasResult) {
      unstarted.push(condition)
      continue
    }
    await assertRegularFile(resultPath, `result for ${condition.id}`)
    await assertRegularFile(markerPath, `start marker for ${condition.id}`)
    const result = await readJson(resultPath, `result for ${condition.id}`)
    const marker = await readJson(markerPath, `start marker for ${condition.id}`)
    if (result?.condition?.id !== condition.id || result?.condition?.arm !== condition.arm || result?.condition?.gameId !== condition.gameId) {
      fail('ARC_CONTINUATION_RESULT', `${condition.id} result does not bind its frozen condition`)
    }
    if (result.cleanupComplete !== true) fail('ARC_CONTINUATION_CLEANUP', `${condition.id} did not complete cleanup`)
    if (marker?.fingerprint !== manifest.fingerprint || marker?.id !== condition.id) fail('ARC_CONTINUATION_MARKER', `${condition.id} start marker does not bind the prepared fingerprint`)
    resultSha256[condition.id] = await sha256File(resultPath)
    startedMarkerSha256[condition.id] = await sha256File(markerPath)
    recorded.push({ condition, resultPath, markerPath, result })
  }
  return { resultSha256, startedMarkerSha256, recorded, unstarted }
}

function sameHashMap(left, right) {
  return canonicalHash(left) === canonicalHash(right)
}

async function verifyPriorRun(root, manifest, continuation, evidence) {
  const runReceiptPath = join(root, 'run-receipt.json')
  const panelMarkerPath = join(root, RUN_START_MARKER)
  await Promise.all([assertRegularFile(runReceiptPath, 'previous run receipt'), assertRegularFile(panelMarkerPath, 'previous panel start marker')])
  const [receipt, marker, runReceiptSha256, panelStartMarkerSha256] = await Promise.all([
    readJson(runReceiptPath, 'previous run receipt'),
    readJson(panelMarkerPath, 'previous panel start marker'),
    sha256File(runReceiptPath),
    sha256File(panelMarkerPath),
  ])
  if (runReceiptSha256 !== continuation.previous.runReceiptSha256 || panelStartMarkerSha256 !== continuation.previous.panelStartMarkerSha256
    || !sameHashMap(evidence.resultSha256, continuation.previous.resultSha256)
    || !sameHashMap(evidence.startedMarkerSha256, continuation.previous.startedMarkerSha256)) {
    fail('ARC_CONTINUATION_IMMUTABLE', 'previous run receipt, result, or start-marker bytes differ from the accepted continuation evidence')
  }
  if (marker?.fingerprint !== manifest.fingerprint || receipt?.kind !== 'prime-rlm-arc-pilot-run' || receipt?.fingerprint !== manifest.fingerprint
    || typeof receipt?.completedAt !== 'string' || !Array.isArray(receipt.results)) {
    fail('ARC_CONTINUATION_PRIOR_RUN', 'previous run receipt or panel marker is not a completed run for this fingerprint')
  }
  const recordedIds = new Set(evidence.recorded.map(entry => entry.condition.id))
  const receiptIds = new Set()
  for (const entry of receipt.results) {
    const id = entry?.condition?.id
    if (typeof id !== 'string' || receiptIds.has(id) || !recordedIds.has(id) || entry.cleanupComplete !== true) {
      fail('ARC_CONTINUATION_PRIOR_CLEANUP', 'previous run receipt does not prove cleanup for every recorded condition')
    }
    receiptIds.add(id)
  }
  if (receiptIds.size === 0) fail('ARC_CONTINUATION_PRIOR_CLEANUP', 'previous run receipt has no completed cleanup evidence')
  return { runReceiptPath, panelMarkerPath, runReceiptSha256, panelStartMarkerSha256, receipt }
}

function sameClosure(left, right) {
  return left?.run === right.run
    && JSON.stringify(left?.unknownCalls) === JSON.stringify(right.unknownCalls)
    && left?.cause === right.cause
    && left?.evidenceHash?.algorithm === right.evidenceHash.algorithm
    && left?.evidenceHash?.digest === right.evidenceHash.digest
}

function orderedUnknownCalls(ledger, runId) {
  return [...ledger.calls.entries()]
    .filter(([, call]) => call.run === runId && !call.prior && call.state === 'unknown')
    .sort(([left], [right]) => Number(left.slice('request-'.length)) - Number(right.slice('request-'.length)))
    .map(([id]) => id)
}

function validateClosureBeforeMarker(ledger, closure) {
  const existing = ledger.closedRuns.get(closure.run)
  if (existing) {
    if (!sameClosure(existing, closure)) fail('ARC_CONTINUATION_CLOSURE', 'the ledger already has different closure evidence for this run')
    if (ledger.stopped) fail('ARC_CONTINUATION_LEDGER', 'ledger remains stopped after an existing closure')
    return existing
  }
  if (!ledger.stopped) fail('ARC_CONTINUATION_CLOSURE', 'the ledger is not stopped on the accepted unknown run')
  const calls = [...ledger.calls.entries()].filter(([, call]) => call.run === closure.run && !call.prior)
  if (calls.some(([, call]) => call.state === 'admitted')) fail('ARC_CONTINUATION_CLOSURE', 'closed unknown run still has an admitted request')
  const unknownCalls = orderedUnknownCalls(ledger, closure.run)
  if (JSON.stringify(unknownCalls) !== JSON.stringify(closure.unknownCalls)) {
    fail('ARC_CONTINUATION_CLOSURE', 'closed unknown run does not exactly cover the ledger unknown calls')
  }
  const unresolvedElsewhere = [...ledger.calls.entries()].some(([id, call]) => !call.prior && call.state === 'unknown' && call.run !== closure.run && ![...ledger.closedRuns.values()].some(known => known.unknownCalls.includes(id)))
  if (unresolvedElsewhere) fail('ARC_CONTINUATION_CLOSURE', 'ledger has another unresolved unknown run')
  return null
}

async function nextContinuationPaths(root) {
  const slots = new Map()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const match = /^(resume-unstarted-(started|receipt)-(\d+)\.json)$/.exec(entry.name)
    if (!match) continue
    if (!entry.isFile()) fail('ARC_CONTINUATION_HISTORY', `${entry.name} is not a regular file`)
    const number = Number(match[3])
    if (!Number.isSafeInteger(number) || number < 1) fail('ARC_CONTINUATION_HISTORY', `${entry.name} has an invalid continuation number`)
    const state = slots.get(number) ?? {}
    state[match[2]] = entry.name
    slots.set(number, state)
  }
  const numbers = [...slots.keys()].sort((left, right) => left - right)
  for (let index = 0; index < numbers.length; index += 1) {
    const number = numbers[index]
    const state = slots.get(number)
    if (number !== index + 1 || !state.started || !state.receipt) {
      fail('ARC_CONTINUATION_IN_PROGRESS', 'a prior continuation marker or receipt is incomplete; do not start another continuation')
    }
  }
  const number = numbers.length + 1
  const suffix = String(number).padStart(2, '0')
  return {
    number,
    markerPath: join(root, `${CONTINUATION_MARKER_PREFIX}${suffix}.json`),
    receiptPath: join(root, `${CONTINUATION_RECEIPT_PREFIX}${suffix}.json`),
  }
}

/**
 * Perform the non-provider continuation gate and durably close exactly one
 * accepted unknown run before selecting conditions which have never started.
 */
export async function prepareUnstartedContinuation({ output, continuationArtifact, continuationSha256 } = {}) {
  const { root, manifest } = await readPreparedManifest(output)
  const continuation = await loadContinuationAcceptance({ artifact: continuationArtifact, sha256: continuationSha256, manifest })
  await assertPreparedFingerprint(manifest, { continuation })
  const keyless = await loadKeylessGate(root, manifest)
  const evidence = await conditionEvidence(root, manifest)
  const previous = await verifyPriorRun(root, manifest, continuation, evidence)
  if (evidence.unstarted.length === 0) fail('ARC_CONTINUATION_EMPTY', 'every frozen condition already has a verified result')
  if (!Object.hasOwn(continuation.previous.resultSha256, continuation.closedUnknownRun.run)) {
    fail('ARC_CONTINUATION_CLOSURE', 'closed unknown run must have an immutable recorded result')
  }
  const ledger = await Ledger.open(manifest.ledger.path, { total: FIXED_LIMITS.total, perRun: FIXED_LIMITS.requestLimit })
  const existingClosure = validateClosureBeforeMarker(ledger, continuation.closedUnknownRun)
  const beforeAccounting = await ledger.receipt()
  const maxModelRequests = FIXED_LIMITS.newPanel - beforeAccounting.newAdmitted
  if (!Number.isSafeInteger(maxModelRequests) || maxModelRequests < 1) fail('ARC_CONTINUATION_BUDGET', 'no authorized new-panel requests remain')
  const paths = await nextContinuationPaths(root)
  await writeExclusiveJson(paths.markerPath, {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-arc-unstarted-continuation-started',
    startedAt: new Date().toISOString(),
    number: paths.number,
    originalFingerprint: manifest.fingerprint,
    continuationArtifact: { path: continuation.path, sha256: continuation.hash },
    previous: { runReceiptSha256: previous.runReceiptSha256, panelStartMarkerSha256: previous.panelStartMarkerSha256, resultSha256: evidence.resultSha256, startedMarkerSha256: evidence.startedMarkerSha256 },
    selectedConditions: evidence.unstarted.map(condition => condition.id),
  })
  if (!existingClosure) ledger.acknowledgeClosedRun(continuation.closedUnknownRun)
  const accounting = await ledger.receipt()
  if (accounting.stopped) fail('ARC_CONTINUATION_LEDGER', 'ledger remains stopped after the accepted closure')
  return { root, manifest, continuation, keyless, evidence, previous, ledger, paths, accounting, maxModelRequests }
}

export function assertFixedModelOptions(options) {
  if (!isRecord(options) || options.provider !== FIXED_ROUTE.provider || options.model !== FIXED_ROUTE.model
    || options.reasoningEffort !== FIXED_ROUTE.reasoningEffort || options.maxTokens !== FIXED_ROUTE.maxOutputTokens) {
    fail('ARC_ROUTE_CHANGED', 'every physical request must use openai-codex/gpt-6.1-sol/high/16384')
  }
}

/** One physical request at a time, with durable admission before dispatch. */
export function createModelDispatcher({ condition, provider, relay, ledger }) {
  let active
  provider.setPhysicalAdmission(event => {
    if (!active) fail('ARC_PHYSICAL_SCOPE', 'physical POST outside an active request')
    if (active.physicalCount !== 0) fail('ARC_PROVIDER_RETRY', 'a second physical POST for one logical call is forbidden')
    const ordinal = ledger.admitPhysical({ runId: condition.id, logicalRequest: active.logicalRequest, event })
    active.physicalCount += 1
    return ordinal
  })
  async function* call(id, options) {
    assertFixedModelOptions(options)
    if (active) fail('ARC_CONCURRENT_MODEL', 'a previous physical model request is still active')
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(options.signal?.reason ?? new Error('parent caller aborted'))
    if (options.signal?.aborted) forwardAbort()
    else options.signal?.addEventListener('abort', forwardAbort, { once: true })
    const state = { id, controller, logicalRequest: undefined, physicalCount: 0 }
    active = state
    const chunks = []
    let streamError
    let fullyConsumed = false
    try {
      const restored = await relay.restoreOptions(options)
      const { signal: ignoredSignal, ...loggedOptions } = restored
      await appendDurableJson(join(condition.directory, 'parent-model-intents.jsonl'), { type: 'model-intent', id, options: loggedOptions })
      if (controller.signal.aborted) throw controller.signal.reason
      state.logicalRequest = await ledger.admit(condition.id, { arm: condition.arm, gameId: condition.gameId, ipcId: id, options: loggedOptions })
      const prepared = await provider.adapter.prepareCall(FIXED_ROUTE.provider, FIXED_ROUTE.model, controller.signal)
      if (!prepared || typeof prepared.stream !== 'function') fail('ARC_PROVIDER_ADAPTER', 'provider lacks stream()')
      const stream = await prepared.stream({ ...restored, signal: controller.signal })
      if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') fail('ARC_PROVIDER_STREAM', 'provider stream is not AsyncIterable')
      for await (const chunk of stream) {
        await appendDurableJson(join(condition.directory, 'parent-model-chunks.jsonl'), { type: 'model-chunk', id, logicalRequest: state.logicalRequest, chunk })
        chunks.push(chunk)
        yield chunk
      }
      if (state.physicalCount !== 1) fail('ARC_PHYSICAL_OBSERVATION', 'provider stream lacks one physical admission')
      fullyConsumed = true
    } catch (error) {
      streamError = error
      throw error
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort)
      if (!fullyConsumed) {
        streamError ??= failure('ARC_STREAM_ABANDONED', 'consumer did not fully consume the model stream')
        controller.abort(streamError)
      }
      try {
        if (state.logicalRequest) await ledger.settle(state.logicalRequest, chunks, streamError)
      } finally { active = undefined }
      if (state.logicalRequest) {
        const receipt = await ledger.receipt()
        process.stdout.write(`${JSON.stringify({ event: 'model-settled', arm: condition.arm, gameId: condition.gameId, cumulativeRequests: receipt.admitted, unknown: receipt.unknown, physical: receipt.physicalAdmitted })}\n`)
      }
    }
  }
  return {
    call,
    abort(id, reason) { if (active?.id === id) active.controller.abort(new Error(`worker abort: ${String(reason ?? 'unknown')}`)) },
    abortAll(reason) { active?.controller.abort(new Error(String(reason ?? 'worker exited'))) },
  }
}

async function reserveBridgePort() {
  const ipv4 = createNetServer()
  await new Promise((resolveListen, rejectListen) => {
    ipv4.once('error', rejectListen)
    ipv4.listen({ host: '127.0.0.1', port: 0 }, resolveListen)
  })
  const address = ipv4.address()
  if (!address || typeof address === 'string') {
    await new Promise(resolveClose => ipv4.close(resolveClose))
    fail('ARC_BRIDGE_PORT', 'cannot reserve an IPv4 bridge port')
  }
  const port = address.port
  const ipv6 = createNetServer(socket => socket.destroy())
  try {
    await new Promise((resolveListen, rejectListen) => {
      ipv6.once('error', rejectListen)
      ipv6.listen({ host: '::1', port, ipv6Only: true }, resolveListen)
    })
  } catch (error) {
    await new Promise(resolveClose => ipv4.close(resolveClose))
    throw failure('ARC_BRIDGE_PORT', 'cannot reserve matching IPv6 localhost listener', { cause: error })
  }
  return {
    port,
    releaseIpv4: async () => await new Promise(resolveClose => ipv4.close(resolveClose)),
    close: async () => {
      await new Promise(resolveClose => ipv4.close(() => resolveClose())).catch(() => {})
      await new Promise(resolveClose => ipv6.close(() => resolveClose())).catch(() => {})
    },
  }
}

function cleanupIsComplete(receipt) {
  return receipt?.backend?.stopped === true && receipt?.proxy?.removed === true && receipt?.engine?.removed === true
}

async function spawnNativeWorker({ workerPath, sandbox, config, onModel }) {
  const child = spawn('/usr/bin/sandbox-exec', ['-p', sandbox, DEFAULT_NODE, workerPath], {
    cwd: config.directory,
    env: { PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout = `${stdout}${String(chunk)}`.slice(-8_000) })
  child.stderr.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-8_000) })
  let result
  let stopped = false
  let workerError
  const modelJobs = new Set()
  const stop = reason => {
    if (stopped) return
    stopped = true
    try { child.send({ type: 'stop', reason: String(reason) }) } catch { /* Exit evidence remains authoritative. */ }
  }
  child.on('message', message => {
    if (!isRecord(message)) return
    if (message.type === 'model' && typeof message.id === 'string') {
      const job = Promise.resolve(onModel(message.id, message.options))
        .then(async stream => {
          for await (const chunk of stream) child.send({ type: 'chunk', id: message.id, chunk })
          child.send({ type: 'end', id: message.id })
        })
        .catch(error => {
          try { child.send({ type: 'error', id: message.id, error: redact(errorText(error)) }) } catch { /* Worker exit is collected below. */ }
          stop('parent model bridge failure')
        })
        .finally(() => modelJobs.delete(job))
      modelJobs.add(job)
      return
    }
    if (message.type === 'abort' && typeof message.id === 'string') {
      // The active parent stream owns an AbortController keyed by id.
      config.abortModel?.(message.id, message.reason)
      return
    }
    if (message.type === 'result') result = message
  })
  child.once('error', error => { workerError = error; config.abortAll?.('worker transport error') })
  child.once('exit', () => config.abortAll?.('worker exited'))
  let escalation
  const deadline = setTimeout(() => {
    stop('parent wall-time deadline')
    config.abortAll?.('parent wall-time deadline')
    escalation = setTimeout(() => child.kill('SIGTERM'), 20_000)
    escalation.unref()
  }, FIXED_LIMITS.wallTimeMs + 90_000)
  deadline.unref()
  child.send(config.start)
  let exit
  try { exit = await once(child, 'exit') } finally { clearTimeout(deadline); if (escalation) clearTimeout(escalation) }
  await Promise.allSettled([...modelJobs])
  return {
    result,
    exit: { code: exit[0], signal: exit[1] },
    stdout: redact(stdout),
    stderr: redact(stderr),
    error: workerError ? redact(errorText(workerError)) : null,
    stop,
  }
}

async function runNativeCondition({ condition, manifest, modelInfo, provider, relay, ledger }) {
  const workerPath = join(TOOL_DIRECTORY, 'native-worker.mjs')
  await assertRegularFile(workerPath, 'native worker')
  const broker = await createGameBroker({
    sourceRoot: manifest.author.sourceRoot,
    corpus: manifest.author.corpus.path,
    python: manifest.author.python,
    adapterPath: join(REPOSITORY_ROOT, 'tools/fixtures/rlm-arc-prepare/sdk-step-adapter.py'),
    gameId: condition.gameId,
    directory: condition.privateEngineDirectory,
    proxySocket: condition.proxySocket,
  })
  let reservation
  try { reservation = await reserveBridgePort() } catch (error) { await broker.stop(); throw error }
  const dispatcher = createModelDispatcher({ condition, provider, relay, ledger })
  const modelInfoSafe = jsonClone(modelInfo)
  const sandbox = sandboxPolicy({
    directory: condition.directory,
    shared: manifest.shared.path,
    readRoots: [manifest.package.root, TOOL_DIRECTORY, join(manifest.runner.sourceRoot, 'node_modules')],
    bridgePort: reservation.port,
    brokerPrivateRoot: condition.privateEngineDirectory,
    protectedRoots: [manifest.parentPrivate, manifest.author.corpus.path, manifest.ledger.path, join(manifest.output, 'provider-private'), join(manifest.output, 'attachments')],
  })
  const start = {
    type: 'start',
    arm: condition.arm,
    directory: condition.directory,
    shared: manifest.shared.path,
    compiled: manifest.shared.compiled.path,
    packageRoot: manifest.package.root,
    task: condition.prompt.task,
    route: { ...FIXED_ROUTE },
    modelInfo: modelInfoSafe,
    requestLimit: FIXED_LIMITS.requestLimit,
    wallTimeMs: FIXED_LIMITS.wallTimeMs,
    autonomous: condition.autonomous,
    brokerSocket: broker.socket,
    brokerState: broker.stateRoot,
    bridgePort: reservation.port,
    dependencyReadRoots: [manifest.package.root, TOOL_DIRECTORY, join(manifest.runner.sourceRoot, 'node_modules')],
  }
  let worker
  let workerResult
  let brokerObservation
  let brokerError
  let brokerReceipt
  try {
    await reservation.releaseIpv4()
    worker = await spawnNativeWorker({
      workerPath,
      sandbox,
      config: {
        directory: condition.directory,
        start,
        abortModel: (id, reason) => dispatcher.abort(id, reason),
        abortAll: reason => dispatcher.abortAll(reason),
      },
      onModel: dispatcher.call,
    })
    workerResult = worker.result
    try { brokerObservation = await broker.inspect() } catch (error) {
      brokerError = redact(errorText(error))
      const retained = broker.lastObservation()
      if (retained?.terminal === 'WIN') brokerObservation = retained
    }
  } finally {
    try { brokerReceipt = await broker.stop() } catch (error) { brokerReceipt = { error: redact(errorText(error)) } }
    await reservation.close()
  }
  const workerFault = workerResult?.fault
  const workerFaultText = workerFault === undefined || workerFault === null
    ? null
    : redact(typeof workerFault?.message === 'string' ? workerFault.message : errorText(workerFault))
  const gradeError = [brokerError, workerFaultText, worker?.error].filter(value => typeof value === 'string' && value.length > 0).join(' | ') || null
  const grade = gradeGame({ observation: brokerObservation, error: gradeError, stopReason: workerResult?.nativeStopReason })
  const executionCompleted = workerResult?.state === 'completed' && workerResult?.physicalCleanup === true
  return {
    worker: worker ? { result: workerResult ?? null, exit: worker.exit, stderr: worker.stderr, error: worker.error } : null,
    broker: { observation: brokerObservation ?? null, error: brokerError ?? null, cleanup: brokerReceipt ?? null },
    grade,
    executionCompleted,
    cleanupComplete: workerResult?.physicalCleanup === true && cleanupIsComplete(brokerReceipt),
  }
}

async function runBaselineCondition({ condition, manifest, plan, provider, relay, ledger }) {
  const broker = await createGameBroker({
    sourceRoot: manifest.author.sourceRoot,
    corpus: manifest.author.corpus.path,
    python: manifest.author.python,
    adapterPath: join(REPOSITORY_ROOT, 'tools/fixtures/rlm-arc-prepare/sdk-step-adapter.py'),
    gameId: condition.gameId,
    directory: condition.privateEngineDirectory,
    proxySocket: condition.proxySocket,
  })
  const modelWire = await import(pathToFileURL(join(manifest.shared.compiled.path, 'model-wire.mjs')).href)
  const replayModule = await import(pathToFileURL(join(manifest.shared.compiled.path, 'replay.mjs')).href)
  const wire = { ...modelWire, ReplayRegistry: replayModule.ReplayRegistry }
  const dispatcher = createModelDispatcher({ condition, provider, relay, ledger })
  let requestOrdinal = 0
  const callModel = options => dispatcher.call(`B-${++requestOrdinal}`, options)
  let result
  let observation
  let inspectError
  let cleanup
  try {
    // The provider loader's callbacks are attached globally before a condition
    // begins.  The current physical scope identifies this B request.
    result = await runBaseline({
      directory: join(condition.directory, 'baseline'),
      plan,
      gameId: condition.gameId,
      broker,
      route: { provider: FIXED_ROUTE.provider, model: FIXED_ROUTE.model, reasoningEffort: FIXED_ROUTE.reasoningEffort, maxTokens: FIXED_ROUTE.maxOutputTokens },
      wire,
      callModel,
      requestLimit: FIXED_LIMITS.requestLimit,
      wallTimeMs: FIXED_LIMITS.wallTimeMs,
    })
    try { observation = await broker.inspect() } catch (error) {
      inspectError = redact(errorText(error))
      const retained = broker.lastObservation()
      if (retained?.terminal === 'WIN') observation = retained
    }
  } finally {
    try { cleanup = await broker.stop() } catch (error) { cleanup = { error: redact(errorText(error)) } }
  }
  const grade = gradeGame({ observation, error: inspectError, stopReason: result?.stopReason })
  return {
    baseline: result ?? null,
    broker: { observation: observation ?? null, error: inspectError ?? null, cleanup: cleanup ?? null },
    grade,
    executionCompleted: result?.state === 'completed' && result?.physicalCleanup === true,
    cleanupComplete: result?.physicalCleanup === true && cleanupIsComplete(cleanup),
  }
}

async function loadRealProvider({ providerModule, providerSha256, providerPackage, credentialFile, dataRoot, sourceRoot, maxModelRequests, onPhysical, onTransportEvent, attachments }) {
  const modulePath = await assertRegularFile(providerModule, 'provider module')
  if (!SHA256.test(providerSha256 ?? '')) fail('ARC_PROVIDER_HASH', '--provider-sha256 is required for run')
  if (await sha256File(modulePath) !== providerSha256.toLowerCase()) fail('ARC_PROVIDER_HASH', 'provider module hash differs from the explicit pin')
  const credentialPath = await assertRegularFile(credentialFile, 'credential file')
  requireText(providerPackage, 'provider package')
  const providerModuleNamespace = await import(pathToFileURL(modulePath).href)
  if (typeof providerModuleNamespace.loadProvider !== 'function') fail('ARC_PROVIDER_MODULE', 'provider module lacks loadProvider')
  const callbacks = { current: onPhysical }
  const loaded = await providerModuleNamespace.loadProvider({
    sourceRoot,
    providerPackage,
    credentialFile: credentialPath,
    dataRoot,
    attachments,
    maxModelRequests,
    onActualModelRequest: event => callbacks.current(event),
    onActualModelRequestSync: event => callbacks.current(event),
    onTransportEvent,
  })
  if (!loaded?.adapter || !loaded?.modelInfo || typeof loaded.close !== 'function') fail('ARC_PROVIDER_MODULE', 'provider loader returned an invalid adapter')
  return {
    ...loaded,
    setPhysicalAdmission(fn) { callbacks.current = fn },
  }
}

async function runSelectedConditions({ root, manifest, plan, provider, relay, ledger, conditions }) {
  const results = []
  for (const condition of conditions) {
    if (ledger.stopped) break
    const resultPath = join(root, RESULTS_DIRECTORY, `${condition.id}.json`)
    await mkdir(dirname(resultPath), { recursive: true, mode: 0o700 })
    if (await exists(resultPath)) fail('ARC_RESULT_EXISTS', `condition already has a result: ${condition.id}`)
    const invoke = condition.arm === 'B'
      ? () => runBaselineCondition({ condition, manifest, plan, provider, relay, ledger })
      : () => runNativeCondition({ condition, manifest, modelInfo: provider.modelInfo, provider, relay, ledger })
    const conditionStarted = Date.now()
    await writeExclusiveJson(join(condition.directory, 'real-condition-started.json'), { formatVersion: 1, startedAt: new Date(conditionStarted).toISOString(), fingerprint: manifest.fingerprint, id: condition.id })
    process.stdout.write(`${JSON.stringify({ event: 'condition-start', arm: condition.arm, gameId: condition.gameId })}\n`)
    let conditionResult
    try {
      conditionResult = await invoke()
    } catch (error) {
      conditionResult = {
        fatal: redact(errorText(error)),
        grade: gradeGame({ observation: null, error: redact(errorText(error)), stopReason: 'PARENT_ERROR' }),
        executionCompleted: false,
        cleanupComplete: false,
      }
    }
    // Preserve independent WIN facts even when native/provider cleanup later
    // fails.  A failed cleanup blocks the next condition but cannot rewrite
    // the already observed terminal game state.
    const safeResult = {
      formatVersion: FORMAT_VERSION,
      condition: { id: condition.id, arm: condition.arm, gameId: condition.gameId, orderKey: condition.orderKey },
      completedAt: new Date().toISOString(),
      resources: summarizeConditionResources(await ledger.receipt(), condition.id, Date.now() - conditionStarted),
      grade: conditionResult.grade,
      executionCompleted: conditionResult.executionCompleted === true,
      cleanupComplete: conditionResult.cleanupComplete === true,
      details: conditionResult,
    }
    await writeExclusiveJson(resultPath, safeResult)
    results.push({ path: resultPath, ...safeResult })
    const liveAccounting = await ledger.receipt()
    process.stdout.write(`${JSON.stringify({ event: 'condition-result', arm: condition.arm, gameId: condition.gameId, terminal: safeResult.grade?.terminal, levels: safeResult.grade?.levelsCompleted, actions: safeResult.grade?.actionsTaken, cleanup: safeResult.cleanupComplete, cumulativeRequests: liveAccounting.admitted })}\n`)
    if (!safeResult.cleanupComplete || ledger.stopped) break
  }
  return results
}

/**
 * Execute the real panel.  This is intentionally untested here: callers must
 * satisfy the file-bound acceptance gates, and this function is the sole
 * location that dynamically imports a provider module or reads a credential.
 */
export async function assertPanelNotStarted(root) {
  if (await exists(join(root, RUN_START_MARKER))) fail('ARC_RUN_ALREADY_STARTED', 'real panel already has a durable start marker; never replay a failed condition')
}

export async function runPilot({
  output,
  providerModule,
  providerSha256,
  providerPackage,
  credentialFile,
  acceptanceArtifact,
  acceptanceSha256,
} = {}) {
  const { root, manifest } = await readPreparedManifest(output)
  await assertPanelNotStarted(root)
  await assertPreparedFingerprint(manifest)
  const keyless = await loadKeylessGate(root, manifest)
  const external = await loadExternalAcceptance({ artifact: acceptanceArtifact, sha256: acceptanceSha256, manifest })
  const { plan } = await loadPlan(manifest.plan.path)
  await writeExclusiveJson(join(root, RUN_START_MARKER), {
    formatVersion: FORMAT_VERSION,
    startedAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    keyless: { path: keyless.path, hash: keyless.hash },
    externalAcceptance: { path: external.path, hash: external.hash },
    provider: { moduleSha256: providerSha256, package: providerPackage },
  })

  let provider
  let relay
  let ledger
  let results = []
  let panelError
  try {
    ledger = await Ledger.open(manifest.ledger.path, { total: FIXED_LIMITS.total, perRun: FIXED_LIMITS.requestLimit })
    if (ledger.stopped) fail('ARC_LEDGER_STOPPED', 'prepared ledger is already stopped; do not run or replay')
    const relayModule = await import('./attachment-relay.mjs')
    relay = await relayModule.createAttachmentRelay({ sourceRoot: manifest.runner.sourceRoot, dataRoot: join(root, 'attachments') })
    let physicalScope = null
    provider = await loadRealProvider({
      providerModule,
      providerSha256,
      providerPackage,
      credentialFile,
      dataRoot: join(root, 'provider-private'),
      sourceRoot: manifest.runner.sourceRoot,
      maxModelRequests: FIXED_LIMITS.newPanel,
      attachments: relay.store,
      onPhysical: event => {
        if (!physicalScope) fail('ARC_PHYSICAL_SCOPE', 'provider physical request has no active condition')
        return physicalScope(event)
      },
      onTransportEvent: event => ledger.appendSync({ type: 'transport-event', event }),
    })
    results = await runSelectedConditions({ root, manifest, plan, provider, relay, ledger, conditions: manifest.conditions })
  } catch (error) {
    panelError = redact(errorText(error))
  } finally {
    await Promise.allSettled([relay?.close?.(), provider?.close?.()])
  }
  const ledgerReceipt = ledger ? await ledger.receipt() : null
  const runReceipt = {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-arc-pilot-run',
    completedAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    providerLoaded: provider !== undefined,
    results: results.map(result => ({ path: result.path, condition: result.condition, grade: result.grade, executionCompleted: result.executionCompleted, cleanupComplete: result.cleanupComplete })),
    accounting: ledgerReceipt ? { admitted: ledgerReceipt.admitted, newAdmitted: ledgerReceipt.newAdmitted, settled: ledgerReceipt.settled, unknown: ledgerReceipt.unknown, physicalAdmitted: ledgerReceipt.physicalAdmitted, stopped: ledgerReceipt.stopped } : null,
    error: panelError ?? null,
  }
  await writeExclusiveJson(join(root, 'run-receipt.json'), runReceipt)
  if (panelError) throw failure('ARC_RUN_STOPPED', panelError)
  return runReceipt
}

/**
 * Continue only conditions which have never acquired a durable start marker.
 * This has the same provider boundary as --run, but its preflight is bound to
 * an independently accepted closure for the previous charged unknown call.
 */
export async function resumeUnstartedPilot({
  output,
  providerModule,
  providerSha256,
  providerPackage,
  credentialFile,
  continuationArtifact,
  continuationSha256,
} = {}) {
  let prepared
  let provider
  let relay
  let results = []
  let panelError
  try {
    prepared = await prepareUnstartedContinuation({ output, continuationArtifact, continuationSha256 })
    const { root, manifest, ledger, evidence, paths, maxModelRequests } = prepared
    const { plan } = await loadPlan(manifest.plan.path)
    const relayModule = await import('./attachment-relay.mjs')
    relay = await relayModule.createAttachmentRelay({ sourceRoot: manifest.runner.sourceRoot, dataRoot: join(root, 'attachments', `resume-unstarted-${String(paths.number).padStart(2, '0')}`) })
    let physicalScope = null
    provider = await loadRealProvider({
      providerModule,
      providerSha256,
      providerPackage,
      credentialFile,
      dataRoot: join(root, 'provider-private', `resume-unstarted-${String(paths.number).padStart(2, '0')}`),
      sourceRoot: manifest.runner.sourceRoot,
      maxModelRequests,
      attachments: relay.store,
      onPhysical: event => {
        if (!physicalScope) fail('ARC_PHYSICAL_SCOPE', 'provider physical request has no active condition')
        return physicalScope(event)
      },
      onTransportEvent: event => ledger.appendSync({ type: 'transport-event', event }),
    })
    results = await runSelectedConditions({ root, manifest, plan, provider, relay, ledger, conditions: evidence.unstarted })
  } catch (error) {
    panelError = redact(errorText(error))
  } finally {
    await Promise.allSettled([relay?.close?.(), provider?.close?.()])
  }
  if (!prepared) throw failure('ARC_CONTINUATION_STOPPED', panelError ?? 'continuation preflight did not complete')
  const ledgerReceipt = await prepared.ledger.receipt()
  const continuationReceipt = {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-arc-unstarted-continuation-run',
    completedAt: new Date().toISOString(),
    number: prepared.paths.number,
    originalFingerprint: prepared.manifest.fingerprint,
    continuationArtifact: { path: prepared.continuation.path, sha256: prepared.continuation.hash },
    closedUnknownRun: prepared.continuation.closedUnknownRun,
    selectedConditions: prepared.evidence.unstarted.map(condition => condition.id),
    providerLoaded: provider !== undefined,
    results: results.map(result => ({ path: result.path, condition: result.condition, grade: result.grade, executionCompleted: result.executionCompleted, cleanupComplete: result.cleanupComplete })),
    accounting: { admitted: ledgerReceipt.admitted, newAdmitted: ledgerReceipt.newAdmitted, settled: ledgerReceipt.settled, unknown: ledgerReceipt.unknown, physicalAdmitted: ledgerReceipt.physicalAdmitted, stopped: ledgerReceipt.stopped },
    error: panelError ?? null,
  }
  await writeExclusiveJson(prepared.paths.receiptPath, continuationReceipt)
  if (panelError) throw failure('ARC_CONTINUATION_STOPPED', panelError)
  return continuationReceipt
}

export function summarizeConditionResources(receipt, runId, elapsedMs) {
  const rows = receipt.rows ?? []
  const admissions = rows.filter(row => row.type === 'request-admitted' && row.run === runId)
  const ids = new Set(admissions.map(row => row.id))
  const settled = rows.filter(row => row.type === 'request-settled' && ids.has(row.id))
  const known = settled.filter(row => row.state === 'settled')
  const usages = known.filter(row => row.usageKnown === true && isRecord(row.usage)).map(row => row.usage)
  const knownTotal = field => {
    const values = usages.map(usage => usage[field]).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null
  }
  return {
    modelRequests: admissions.length,
    physicalModelRequests: rows.filter(row => row.type === 'physical-request-admitted' && row.runId === runId).length,
    confirmedModelRequests: known.length,
    unknownModelRequests: admissions.length - known.length,
    requestsWithKnownUsage: usages.length,
    requestsWithoutKnownUsage: admissions.length - usages.length,
    knownUsageTotals: { inputTokens: knownTotal('inputTokens'), outputTokens: knownTotal('outputTokens'), totalTokens: knownTotal('totalTokens') },
    elapsedMs,
  }
}

function emptyResult(condition) {
  return {
    condition: { id: condition.id, arm: condition.arm, gameId: condition.gameId, orderKey: condition.orderKey },
    grade: { win: 0, denominator: 1, terminal: null, levelsCompleted: null, actionsTaken: null, completed: false, budgetFailure: false, unknown: true, errorPresent: false, stopReason: 'NOT_RUN' },
    executionCompleted: false,
    cleanupComplete: false,
    status: 'not-run',
  }
}

/** Summarize all twelve frozen cells without exposing raw model inputs or outputs. */
export async function analyzePilot({ output } = {}) {
  const { root, manifest } = await readPreparedManifest(output)
  const results = []
  for (const condition of manifest.conditions) {
    const path = join(root, RESULTS_DIRECTORY, `${condition.id}.json`)
    if (!(await exists(path))) {
      results.push(emptyResult(condition))
      continue
    }
    let value
    try { value = JSON.parse(await readFile(path, 'utf8')) } catch (error) { value = { ...emptyResult(condition), status: 'invalid-result', error: redact(errorText(error)) } }
    results.push({ ...emptyResult(condition), ...value, status: value?.executionCompleted === true ? 'recorded' : 'recorded-incomplete' })
  }
  const byArm = Object.fromEntries(['B', 'R', 'S'].map(arm => {
    const cells = results.filter(result => result.condition.arm === arm)
    return [arm, {
      win: cells.reduce((sum, result) => sum + (result.grade?.win ?? 0), 0),
      denominator: cells.length,
      levelsCompleted: cells.map(result => result.grade?.levelsCompleted).filter(Number.isInteger),
      recorded: cells.filter(result => result.status !== 'not-run').length,
      executionCompleted: cells.filter(result => result.executionCompleted === true).length,
      recordedModelRequests: cells.reduce((sum, result) => sum + (result.resources?.modelRequests ?? 0), 0),
      unknownModelRequests: cells.reduce((sum, result) => sum + (result.resources?.unknownModelRequests ?? 0), 0),
    }]
  }))
  let accounting = null
  try {
    const ledger = await Ledger.open(manifest.ledger.path, { total: FIXED_LIMITS.total, perRun: FIXED_LIMITS.requestLimit })
    const receipt = await ledger.receipt()
    accounting = {
      historicalCharged: FIXED_LIMITS.prior,
      historicalConfirmed: 135,
      historicalUnknown: 3,
      newLogical: receipt.newAdmitted,
      cumulativeLogical: receipt.admitted,
      cumulativePhysical: receipt.physicalAdmitted,
      settled: receipt.settled,
      unknown: receipt.unknown,
      stopped: receipt.stopped,
    }
  } catch (error) {
    accounting = { error: redact(errorText(error)) }
  }
  const report = {
    formatVersion: FORMAT_VERSION,
    kind: 'prime-rlm-arc-pilot-analysis',
    createdAt: new Date().toISOString(),
    fingerprint: manifest.fingerprint,
    metrics: { primary: 'Independent broker WIN count / four frozen games per arm', byArm, accounting },
    results,
    limitations: [
      'This report does not estimate general reasoning efficacy.',
      'It does not report RHAE, recursion-specific benefit, or historical-model reproduction.',
      'A broker WIN and execution/cleanup completion are reported as separate facts.',
    ],
  }
  const reportPath = join(root, 'analysis.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'w' })
  const rows = results.map(result => `| ${result.condition.gameId} | ${result.condition.arm} | ${result.grade?.terminal ?? '—'} | ${result.grade?.win ?? 0} | ${result.grade?.levelsCompleted ?? '—'} | ${result.resources?.modelRequests ?? '—'} | ${result.resources?.elapsedMs ?? '—'} | ${result.executionCompleted === true ? 'yes' : 'no'} | ${result.cleanupComplete === true ? 'yes' : 'no'} | ${result.status} |`)
  const markdown = [
    '# ARC pilot analysis',
    '',
    `Fingerprint: \`${manifest.fingerprint}\``,
    '',
    '| Game | Arm | Independent terminal | WIN | Levels | Requests | Elapsed ms | Execution completed | Cleanup complete | Record |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- | --- |',
    ...rows,
    '',
    `Historical accounting remains 135 confirmed and 3 unknown charged; new logical admissions: ${accounting?.newLogical ?? 'unavailable'}, cumulative logical admissions: ${accounting?.cumulativeLogical ?? 'unavailable'}, cumulative physical admissions: ${accounting?.cumulativePhysical ?? 'unavailable'}.`,
    '',
    'The primary metric is independent broker WIN count out of four frozen games per arm. This report makes no general efficacy, recursion-specific, RHAE, or exact-reproduction claim.',
    '',
  ].join('\n')
  await writeFile(join(root, 'analysis.md'), markdown, { encoding: 'utf8', mode: 0o600, flag: 'w' })
  return report
}

export { EXECUTION_FILES, assertRunnerOnlyContinuation, conditionEvidence, verifyPriorRun, validateClosureBeforeMarker, nextContinuationPaths }

export function parseArgs(argv) {
  const result = { mode: undefined, output: undefined, planPath: DEFAULT_PLAN, sourceRoot: REPOSITORY_ROOT, packageRoot: undefined, authorPreparation: undefined, priorLedgerPath: DEFAULT_PRIOR_LEDGER }
  const provider = { providerModule: undefined, providerSha256: undefined, providerPackage: undefined, credentialFile: undefined }
  const runAcceptance = { acceptanceArtifact: undefined, acceptanceSha256: undefined }
  const continuation = { continuationArtifact: undefined, continuationSha256: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--help' || item === '-h') return { help: true }
    if (['--prepare', '--keyless', '--run', '--resume-unstarted', '--analyze'].includes(item)) {
      const mode = item.slice(2)
      if (result.mode !== undefined) fail('ARC_ARGS', 'exactly one mode is required')
      result.mode = mode
      continue
    }
    const mapping = {
      '--output': 'output', '--plan': 'planPath', '--source-root': 'sourceRoot', '--package-root': 'packageRoot', '--author-preparation': 'authorPreparation', '--prior-ledger': 'priorLedgerPath',
      '--provider-module': 'providerModule', '--provider-sha256': 'providerSha256', '--provider-package': 'providerPackage', '--credential-file': 'credentialFile',
      '--acceptance-artifact': 'acceptanceArtifact', '--acceptance-sha256': 'acceptanceSha256',
      '--continuation-artifact': 'continuationArtifact', '--continuation-sha256': 'continuationSha256',
    }
    const key = mapping[item]
    if (!key) fail('ARC_ARGS', `unknown option ${item}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail('ARC_ARGS', `${item} requires a value`)
    if (own(result, key)) result[key] = value
    else if (own(provider, key)) provider[key] = value
    else if (own(runAcceptance, key)) runAcceptance[key] = value
    else continuation[key] = value
    index += 1
  }
  if (!result.mode) fail('ARC_ARGS', 'one of --prepare, --keyless, --run, --resume-unstarted, --analyze is required')
  if (!result.output) fail('ARC_ARGS', '--output is required')
  const providerValues = Object.values(provider).filter(value => value !== undefined)
  const runAcceptanceValues = Object.values(runAcceptance).filter(value => value !== undefined)
  const continuationValues = Object.values(continuation).filter(value => value !== undefined)
  if (!['run', 'resume-unstarted'].includes(result.mode) && (providerValues.length > 0 || runAcceptanceValues.length > 0 || continuationValues.length > 0)) {
    fail('ARC_ARGS', 'provider and credential options are valid only with --run or --resume-unstarted')
  }
  if (result.mode === 'run' && (providerValues.length !== Object.keys(provider).length || runAcceptanceValues.length !== Object.keys(runAcceptance).length || continuationValues.length !== 0)) {
    fail('ARC_ARGS', '--run requires the provider module/hash/package, credential file, and acceptance artifact/hash')
  }
  if (result.mode === 'resume-unstarted' && (providerValues.length !== Object.keys(provider).length || continuationValues.length !== Object.keys(continuation).length || runAcceptanceValues.length !== 0)) {
    fail('ARC_ARGS', '--resume-unstarted requires the provider module/hash/package, credential file, and continuation artifact/hash')
  }
  if (result.mode !== 'prepare' && (result.authorPreparation !== undefined || result.priorLedgerPath !== DEFAULT_PRIOR_LEDGER || result.sourceRoot !== REPOSITORY_ROOT || result.packageRoot !== undefined || result.planPath !== DEFAULT_PLAN)) {
    fail('ARC_ARGS', 'prepare-only inputs are not accepted by this mode')
  }
  return { ...result, ...provider, ...runAcceptance, ...continuation, packageRoot: result.packageRoot ?? join(result.sourceRoot, 'incubator/rlm') }
}

function usage() {
  return [
    'Usage:',
    '  /opt/homebrew/opt/node@22/bin/node tools/rlm-arc-pilot/run.mjs --prepare --output /private/tmp/rac-... --author-preparation /private/tmp/dsh-rlm-arc-prepare-...',
    '  /opt/homebrew/opt/node@22/bin/node tools/rlm-arc-pilot/run.mjs --keyless --output /private/tmp/rac-...',
    '  /opt/homebrew/opt/node@22/bin/node tools/rlm-arc-pilot/run.mjs --analyze --output /private/tmp/rac-...',
    '  /opt/homebrew/opt/node@22/bin/node tools/rlm-arc-pilot/run.mjs --run --output /private/tmp/rac-... --provider-module <private-path> --provider-sha256 <sha256> --provider-package <package> --credential-file <private-path> --acceptance-artifact <accepted-json> --acceptance-sha256 <sha256>',
    '  /opt/homebrew/opt/node@22/bin/node tools/rlm-arc-pilot/run.mjs --resume-unstarted --output /private/tmp/rac-... --provider-module <private-path> --provider-sha256 <sha256> --provider-package <package> --credential-file <private-path> --continuation-artifact <accepted-json> --continuation-sha256 <sha256>',
  ].join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (process.versions.node.split('.')[0] !== '22' || process.platform !== 'darwin' || process.arch !== 'arm64') fail('ARC_RUNTIME_PLATFORM', 'this manual runner requires Node 22 on macOS arm64')
  let result
  if (args.mode === 'prepare') result = await preparePilot(args)
  else if (args.mode === 'keyless') result = await keylessPilot(args)
  else if (args.mode === 'analyze') result = await analyzePilot(args)
  else if (args.mode === 'run') result = await runPilot(args)
  else result = await resumeUnstartedPilot(args)
  process.stdout.write(`${JSON.stringify({ mode: args.mode, output: args.output, fingerprint: result.fingerprint ?? result.originalFingerprint ?? null, accepted: result.accepted ?? null, modelCalls: ['run', 'resume-unstarted'].includes(args.mode) ? 'see ledger' : 0 }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`rlm-arc-pilot: ${redact(errorText(error))}\n`)
    process.exitCode = 2
  })
}
