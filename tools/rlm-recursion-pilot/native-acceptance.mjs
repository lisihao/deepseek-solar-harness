#!/opt/homebrew/opt/node@22/bin/node

/**
 * Offline native-mechanism acceptance for the S0/S recursion ablation.
 *
 * This deliberately exercises the compiled Solar host and the original Prime
 * capsule through the same parent-side executeCondition path used by the
 * panel.  Its provider is a deterministic in-process DSH-chunk fixture: it
 * has no credential input, no socket client, and no real model request.
 */

import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileCurrentSources, prepareSharedRuntime } from '../rlm-arc-pilot/run.mjs'
import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { executeCondition } from './run.mjs'

const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SOURCE_ROOT = resolve(MODULE_DIRECTORY, '../..')
const DEFAULT_OUTPUT = '/Users/sihaoli/Projects/DeepSeek-Solar-Harness-V4/artifacts/rlm-recursion-20261021/parent-private/keyless/native-acceptance-accepted.json'
const FIXED_ROUTE = Object.freeze({
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  maxTokens: 16_384,
})
const FIXED_AUTONOMOUS = Object.freeze({
  maxTurns: 14,
  maxTokens: 4_000_000,
  gate: 'test -f answer.json',
})
const REQUIRED_SOURCE_FILES = Object.freeze([
  'tools/rlm-arc-pilot/run.mjs',
  'tools/rlm-arc-pilot/native-worker.mjs',
  'tools/rlm-arc-pilot/sandbox.mjs',
  'tools/rlm-recursion-pilot/control.mjs',
  'tools/rlm-recursion-pilot/run.mjs',
])

function fail(code, detail) {
  const error = new Error(`${code}: ${detail}`)
  error.code = code
  throw error
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) fail('NATIVE_ACCEPTANCE_PATH', `${label} must be an absolute path`)
  return resolve(value)
}

function isWithin(root, candidate) {
  const difference = relative(root, candidate)
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(difference))
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path) {
  return sha256Bytes(await readFile(path))
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

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 1_000)
}

function pythonString(value) {
  return JSON.stringify(String(value))
}

async function sourceHashes(sourceRoot) {
  const hashes = {}
  for (const relativePath of REQUIRED_SOURCE_FILES) {
    const path = join(sourceRoot, relativePath)
    if (!(await exists(path))) fail('NATIVE_ACCEPTANCE_SOURCE', `missing ${relativePath}`)
    hashes[relativePath] = await sha256File(path)
  }
  return hashes
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function contentText(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).join('\n')
  if (isRecord(value)) {
    if (typeof value.text === 'string') return value.text
    if ('content' in value) return contentText(value.content)
  }
  return ''
}

function latestUserText(options) {
  if (!isRecord(options) || !Array.isArray(options.messages)) return ''
  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index]
    if (isRecord(message) && message.role === 'user') return contentText(message.content)
  }
  return ''
}

function toolChunks(label, code) {
  const id = `native-acceptance-${label}`
  const argumentsText = JSON.stringify({ code })
  return [
    { type: 'tool-call-delta', index: 0, id, name: 'python_repl', argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'python_repl', arguments: argumentsText } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textChunks(text) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function sandboxChecksCode(fixture, actor) {
  const receiptPath = actor === 'child' ? fixture.childSandboxReceiptPath : fixture.sandboxReceiptPath
  return [
    'import errno',
    'import json',
    'import socket',
    'from pathlib import Path',
    `gold_path = Path(${pythonString(fixture.goldPath)})`,
    `protected_canary_path = Path(${pythonString(fixture.protectedCanaryPath)})`,
    `sandbox_receipt_path = Path(${pythonString(receiptPath)})`,
    'public_input = json.loads(gold_path.read_text())',
    'assert public_input["left"] == 19 and public_input["right"] == 23',
    'input_write_errno = None',
    'try:',
    '    gold_path.write_text("tamper")',
    'except OSError as exc:',
    '    input_write_errno = exc.errno',
    'assert input_write_errno == errno.EPERM, input_write_errno',
    'protected_read_errno = None',
    'try:',
    '    protected_canary_path.read_text()',
    'except OSError as exc:',
    '    protected_read_errno = exc.errno',
    'assert protected_read_errno == errno.EPERM, protected_read_errno',
    'public_socket_errno = None',
    'outbound = socket.socket(socket.AF_INET, socket.SOCK_STREAM)',
    'try:',
    '    outbound.settimeout(0.25)',
    '    outbound.connect(("203.0.113.1", 443))',
    'except OSError as exc:',
    '    public_socket_errno = exc.errno',
    'finally:',
    '    outbound.close()',
    'assert public_socket_errno == errno.EPERM, public_socket_errno',
    'sandbox_receipt_path.write_text(json.dumps({',
    `    "actor": ${pythonString(actor)},`,
    '    "publicInputRead": True,',
    '    "inputWriteErrno": input_write_errno,',
    '    "protectedCanaryReadErrno": protected_read_errno,',
    '    "publicSocketErrno": public_socket_errno,',
    '}, sort_keys=True))',
    'print("NATIVE_SANDBOX_EPROM_CONFIRMED")',
  ].join('\n')
}

function s0SpawnCode(fixture) {
  return [
    sandboxChecksCode(fixture, 's0-root'),
    's0_spawn_rejection = None',
    'try:',
    '    await rlm.spawn("NR_CHILD_SHOULD_NOT_START: this depth-zero fixture must reject native recursion.", name="native-acceptance-s0-child")',
    'except Exception as exc:',
    '    s0_spawn_rejection = {"type": type(exc).__name__, "message": str(exc)[:500], "code": getattr(exc, "code", None)}',
    'assert s0_spawn_rejection is not None',
    's0_rejection_text = (str(s0_spawn_rejection.get("code") or "") + " " + s0_spawn_rejection["type"] + " " + s0_spawn_rejection["message"]).lower()',
    'assert "rlm recursion depth limit reached" in s0_rejection_text, s0_spawn_rejection',
    'assert "rlm_depth=0" in s0_rejection_text and "rlm_max_depth=0" in s0_rejection_text, s0_spawn_rejection',
    `Path(${pythonString(fixture.s0ReceiptPath)}).write_text(json.dumps({"spawnRejected": True, "rejection": s0_spawn_rejection}, sort_keys=True))`,
    `Path(${pythonString(fixture.answerPath)}).write_text(json.dumps({"arm": "S0", "spawnRejected": True}, sort_keys=True))`,
    'print("S0_NATIVE_SPAWN_REJECTED")',
  ].join('\n')
}

function rootSpawnCode(fixture) {
  return [
    sandboxChecksCode(fixture, 's-root'),
    'root_left = public_input["left"]',
    'root_persistent_marker = "native-root-persisted"',
    'root_child = await rlm.spawn("NR_CHILD_SINGLE: read the shared public input, retain a value across two Python cells, and write child-receipt.json.", name="native-acceptance-child")',
    `Path(${pythonString(fixture.rootStartedPath)}).write_text(json.dumps({"rootLeft": root_left, "spawned": True}, sort_keys=True))`,
    'print("S_NATIVE_CHILD_ADMITTED")',
  ].join('\n')
}

function childFirstCell(fixture) {
  return [
    sandboxChecksCode(fixture, 'child'),
    'import json',
    'from pathlib import Path',
    `child_gold_path = Path(${pythonString(fixture.goldPath)})`,
    'child_public_input = json.loads(child_gold_path.read_text())',
    'child_right = child_public_input["right"]',
    'child_persistent_marker = "native-child-persisted"',
    'assert child_right == 23',
    'print("S_CHILD_FIRST_CELL")',
  ].join('\n')
}

function childSecondCell(fixture) {
  return [
    'import json',
    'from pathlib import Path',
    'assert child_persistent_marker == "native-child-persisted"',
    'assert child_public_input["left"] == 19',
    `Path(${pythonString(fixture.childReceiptPath)}).write_text(json.dumps({`,
    '    "right": child_right,',
    '    "sameWorkspaceInput": True,',
    '    "persistentAcrossCells": True,',
    `    "inputSha256": ${pythonString(fixture.goldSha256)},`,
    '}, sort_keys=True))',
    'print("S_CHILD_SECOND_CELL_PERSISTED")',
  ].join('\n')
}

function rootCollectCode(fixture) {
  return [
    'import asyncio',
    'import json',
    'from pathlib import Path',
    'assert root_persistent_marker == "native-root-persisted"',
    'root_results = []',
    'for _ in range(120):',
    '    root_results = await rlm.collect(root_child, timeout_ms=500)',
    '    if len(root_results) == 1 and root_results[0].settled:',
    '        break',
    '    await asyncio.sleep(0.05)',
    'assert len(root_results) == 1 and root_results[0].settled',
    `child_receipt = json.loads(Path(${pythonString(fixture.childReceiptPath)}).read_text())`,
    'assert child_receipt["persistentAcrossCells"] is True',
    'answer = root_left + child_receipt["right"]',
    'assert answer == 42',
    `Path(${pythonString(fixture.rootReceiptPath)}).write_text(json.dumps({`,
    '    "answer": answer,',
    '    "collectSettled": True,',
    '    "rootPersistentAcrossCells": True,',
    '    "childInputSha256": child_receipt["inputSha256"],',
    '}, sort_keys=True))',
    `Path(${pythonString(fixture.answerPath)}).write_text(json.dumps({"arm": "S", "answer": answer}, sort_keys=True))`,
    'print("S_ROOT_COLLECTED_42")',
  ].join('\n')
}

function selectReply(arm, latestUser, state, fixture) {
  if (arm === 'S0') {
    if (state.s0Stage++ === 0) return { role: 's0-root-spawn', chunks: toolChunks('s0-spawn', s0SpawnCode(fixture)) }
    return { role: 's0-root-stop', chunks: textChunks('Depth-zero rejection was observed by the native Python kernel.') }
  }
  if (latestUser.includes('NR_CHILD_SINGLE')) {
    const stage = state.childStage++
    if (stage === 0) return { role: 'child-first-cell', chunks: toolChunks('child-first', childFirstCell(fixture)) }
    if (stage === 1) return { role: 'child-second-cell', chunks: toolChunks('child-second', childSecondCell(fixture)) }
    return { role: 'child-stop', chunks: textChunks('The child has written its settled native receipt.') }
  }
  if (latestUser.includes('[child-exited:')) {
    if (!state.rootCollected) {
      state.rootCollected = true
      return { role: 'root-collect', chunks: toolChunks('root-collect', rootCollectCode(fixture)) }
    }
    return { role: 'root-stop', chunks: textChunks('The root collected the settled child and wrote answer.json.') }
  }
  if (latestUser.includes('NR_ROOT_SINGLE')) {
    if (!state.rootSpawned) {
      state.rootSpawned = true
      return { role: 'root-spawn', chunks: toolChunks('root-spawn', rootSpawnCode(fixture)) }
    }
    return { role: 'root-wait', chunks: textChunks('The root is waiting for the original native child-exited continuation.') }
  }
  return { role: 'unexpected', chunks: textChunks('The deterministic offline fixture received an unsupported native prompt.') }
}

/**
 * A local provider-shaped fixture.  It returns only DSH chunks and records a
 * synthetic physical-admission receipt for each consumed stream.  It has no
 * provider module, credential input, network client, or real model request.
 */
export function createSyntheticProvider({ arm, fixture }) {
  if (arm !== 'S0' && arm !== 'S') fail('NATIVE_ACCEPTANCE_ARM', 'synthetic provider arm must be S0 or S')
  const state = { s0Stage: 0, rootSpawned: false, rootCollected: false, childStage: 0 }
  const records = []
  let physicalAdmission
  let active = 0
  let maximumActive = 0
  let closed = false
  const provider = {
    modelInfo: {
      name: 'offline-native-acceptance',
      context: { contextWindow: 128_000 },
      inputModalities: ['text'],
    },
    adapter: {
      async prepareCall(providerName, model, signal) {
        if (providerName !== FIXED_ROUTE.provider || model !== FIXED_ROUTE.model) {
          fail('NATIVE_ACCEPTANCE_ROUTE', 'synthetic provider received a route other than the frozen route')
        }
        return {
          stream: async function* stream(options) {
            if (closed) fail('NATIVE_ACCEPTANCE_PROVIDER', 'synthetic provider was closed before stream consumption')
            if (signal?.aborted) throw signal.reason ?? new Error('synthetic provider aborted')
            if (typeof physicalAdmission !== 'function') fail('NATIVE_ACCEPTANCE_ADMISSION', 'parent did not install a physical-admission callback')
            const latestUser = latestUserText(options)
            const reply = selectReply(arm, latestUser, state, fixture)
            active += 1
            maximumActive = Math.max(maximumActive, active)
            const event = {
              kind: 'synthetic-dsh-chunks-v1',
              synthetic: true,
              arm,
              ordinal: records.length + 1,
              role: reply.role,
            }
            const physicalOrdinal = physicalAdmission(event)
            records.push({
              ordinal: records.length + 1,
              role: reply.role,
              physicalOrdinal,
              latestUserMarker: latestUser.includes('[child-exited:') ? 'child-exited' : latestUser.includes('NR_CHILD_SINGLE') ? 'child' : latestUser.includes('NR_ROOT_SINGLE') ? 'root' : latestUser.includes('NR_S0_ROOT') ? 's0-root' : 'other',
            })
            try {
              for (const chunk of reply.chunks) {
                if (signal?.aborted) throw signal.reason ?? new Error('synthetic provider aborted')
                yield chunk
              }
            } finally {
              active -= 1
            }
          },
        }
      },
    },
    setPhysicalAdmission(callback) {
      if (typeof callback !== 'function') fail('NATIVE_ACCEPTANCE_ADMISSION', 'physical-admission callback must be a function')
      physicalAdmission = callback
    },
    async close() { closed = true },
  }
  return {
    provider,
    records,
    stats: () => ({
      syntheticPhysicalAdmissions: records.length,
      realModelRequests: 0,
      maximumConcurrentPhysicalStreams: maximumActive,
      providerClosed: closed,
    }),
  }
}

export async function prepareFixture({ sourceRoot, shared, tempRoot, artifactRoot, arm }) {
  const id = `native-${arm.toLowerCase()}`
  const runDirectory = join(tempRoot, 'runs', id)
  const workspace = join(runDirectory, 'workspace')
  const durableDirectory = join(artifactRoot, 'parent-private', 'keyless', 'native-acceptance-evidence', arm)
  const parentPrivate = join(artifactRoot, 'parent-private')
  const protectedCanaryRoot = join(tempRoot, 'parent-only-canary', arm)
  const goldPath = join(workspace, 'inputs', 'gold.json')
  const answerPath = join(workspace, 'answer.json')
  const sandboxReceiptPath = join(workspace, 'sandbox-receipt.json')
  const childSandboxReceiptPath = join(workspace, 'child-sandbox-receipt.json')
  const rootStartedPath = join(workspace, 'root-started.json')
  const rootReceiptPath = join(workspace, 'root-receipt.json')
  const childReceiptPath = join(workspace, 'child-receipt.json')
  const s0ReceiptPath = join(workspace, 's0-receipt.json')
  const protectedCanaryPath = join(protectedCanaryRoot, 'credential-canary.txt')
  const publicInput = `${JSON.stringify({ formatVersion: 1, left: 19, right: 23 })}\n`
  await Promise.all([
    mkdir(join(workspace, 'inputs'), { recursive: true, mode: 0o700 }),
    mkdir(join(runDirectory, 'home'), { recursive: true, mode: 0o700 }),
    mkdir(join(runDirectory, 'tmp'), { recursive: true, mode: 0o700 }),
    mkdir(join(runDirectory, 'data'), { recursive: true, mode: 0o700 }),
    mkdir(join(runDirectory, 'client-state'), { recursive: true, mode: 0o700 }),
    mkdir(join(durableDirectory, 'parent-intents'), { recursive: true, mode: 0o700 }),
    mkdir(parentPrivate, { recursive: true, mode: 0o700 }),
    mkdir(protectedCanaryRoot, { recursive: true, mode: 0o700 }),
  ])
  await Promise.all([
    writeFile(goldPath, publicInput, { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    // The canary is deliberately non-secret.  The worker only attempts an
    // open under SBPL and records errno; it never receives or emits contents.
    writeFile(protectedCanaryPath, 'not-a-credential-canary\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    symlink(join(shared, 'runtimes'), join(runDirectory, 'data', 'runtimes'), 'dir'),
  ])
  const goldSha256 = await sha256File(goldPath)
  const fixture = { goldPath, goldSha256, protectedCanaryPath, sandboxReceiptPath, childSandboxReceiptPath, answerPath, rootStartedPath, rootReceiptPath, childReceiptPath, s0ReceiptPath }
  const task = {
    id: `offline-native-${arm.toLowerCase()}`,
    expectedArm: arm,
    inputFiles: { 'inputs/gold.json': publicInput },
  }
  const condition = {
    id,
    arm,
    taskIndex: arm === 'S0' ? 0 : 1,
    taskId: task.id,
    kind: 'native-acceptance',
    runDirectory,
    durableDirectory,
    workspace,
    data: join(runDirectory, 'data'),
    prompt: {
      task: arm === 'S0'
        ? 'NR_S0_ROOT: use the native Python kernel to prove that depth zero rejects rlm.spawn after isolation checks.'
        : 'NR_ROOT_SINGLE: use the native Python kernel to run one depth-one child, then collect the settled child and derive 42.',
    },
    inputHashes: { 'inputs/gold.json': goldSha256 },
    autonomous: { ...FIXED_AUTONOMOUS },
  }
  return { fixture, task, condition, parentPrivate, protectedCanaryRoot }
}

export function gradeFixture(task, text) {
  const errors = []
  let value
  try { value = JSON.parse(text) } catch { errors.push('answer.json is not JSON') }
  if (!isRecord(value) || value.arm !== task.expectedArm) errors.push('answer arm does not match the fixture')
  if (task.expectedArm === 'S0' && value?.spawnRejected !== true) errors.push('S0 answer does not record a rejected spawn')
  if (task.expectedArm === 'S' && value?.answer !== 42) errors.push('S answer is not the derived value 42')
  return {
    primaryScore: errors.length === 0 ? 1 : 0,
    schemaValid: errors.length === 0,
    errors,
  }
}

async function readJson(path, label) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { fail('NATIVE_ACCEPTANCE_JSON', `${label}: ${safeError(error)}`) }
}

async function socketPaths(root) {
  const output = []
  async function walk(current) {
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith('.sock')) output.push(path)
    }
  }
  await walk(root)
  return output
}

async function summarizeArm({ arm, outcome, fixture, providerFixture, condition }) {
  const sandbox = await readJson(fixture.sandboxReceiptPath, `${arm} sandbox receipt`)
  const sockets = await socketPaths(condition.data)
  const cleanup = {
    workerExited: outcome.worker?.exit?.code === 0 && outcome.worker?.exit?.signal === null,
    workerPhysicalCleanup: outcome.worker?.physicalCleanup === true,
    executeConditionCleanup: outcome.cleanupComplete === true,
    retainedNativeSocketArtifacts: sockets.map(path => relative(condition.runDirectory, path)),
    passed: outcome.cleanupComplete === true,
  }
  const isolation = {
    publicInputRead: sandbox.publicInputRead === true,
    inputWriteErrno: sandbox.inputWriteErrno ?? null,
    protectedCanaryReadErrno: sandbox.protectedCanaryReadErrno ?? null,
    publicSocketErrno: sandbox.publicSocketErrno ?? null,
    passed: sandbox.publicInputRead === true
      && sandbox.inputWriteErrno === 1
      && sandbox.protectedCanaryReadErrno === 1
      && sandbox.publicSocketErrno === 1,
    credentialHandling: 'No credential path was supplied or read. A non-secret protected canary was opened by native Python and SBPL returned EPERM before contents could be read.',
  }
  const common = {
    executionCompleted: outcome.executionCompleted === true,
    nativeDepth: outcome.worker?.nativeDepth ?? null,
    actualDepth: outcome.worker?.actualDepth ?? null,
    workerRequests: outcome.worker?.requests ?? null,
    admittedModelRequests: outcome.observed?.admittedModelRequests ?? null,
    childModelRequestCount: outcome.observed?.childModelRequestCount ?? null,
    rootModelRequestCount: outcome.observed?.rootModelRequestCount ?? null,
    childRoster: outcome.observed?.childRoster ?? null,
    provider: { records: providerFixture.records, ...providerFixture.stats() },
    isolation,
    cleanup,
    inputHashesUnchanged: outcome.inputsUnchanged === true,
  }
  if (arm === 'S0') {
    const receipt = await readJson(fixture.s0ReceiptPath, 'S0 receipt')
    return {
      ...common,
      spawnRejected: receipt.spawnRejected === true,
      spawnRejection: receipt.rejection ?? null,
      noChildProviderRequest: outcome.observed?.childModelRequestCount === 0 && providerFixture.records.every(record => !record.role.startsWith('child-')),
      accepted: common.executionCompleted && common.nativeDepth === 0 && common.actualDepth === 0
        && receipt.spawnRejected === true && isRecord(receipt.rejection) && typeof receipt.rejection.type === 'string'
        && typeof receipt.rejection.message === 'string' && outcome.observed?.childModelRequestCount === 0
        && isolation.passed && cleanup.passed && outcome.inputsUnchanged === true,
    }
  }
  const [childReceipt, rootReceipt] = await Promise.all([
    readJson(fixture.childReceiptPath, 'S child receipt'),
    readJson(fixture.rootReceiptPath, 'S root receipt'),
  ])
  const childSandbox = await readJson(fixture.childSandboxReceiptPath, 'S child sandbox receipt')
  const childRequests = providerFixture.records.filter(record => record.role.startsWith('child-'))
  return {
    ...common,
    rootCollectSettled: rootReceipt.collectSettled === true,
    derivedAnswer: rootReceipt.answer ?? null,
    rootPersistentAcrossCells: rootReceipt.rootPersistentAcrossCells === true,
    childPersistentAcrossCells: childReceipt.persistentAcrossCells === true,
    sameWorkspaceInput: childReceipt.sameWorkspaceInput === true && childReceipt.inputSha256 === fixture.goldSha256 && rootReceipt.childInputSha256 === fixture.goldSha256,
    childProviderRequestObserved: childRequests.length > 0 && outcome.observed?.childModelRequestCount > 0,
    rosterObserved: outcome.observed?.childRoster?.observed === true,
    childIsolationInherited: childSandbox.actor === 'child'
      && childSandbox.publicInputRead === true
      && childSandbox.inputWriteErrno === 1
      && childSandbox.protectedCanaryReadErrno === 1
      && childSandbox.publicSocketErrno === 1,
    accepted: common.executionCompleted && common.nativeDepth === 1 && common.actualDepth === 1
      && rootReceipt.collectSettled === true && rootReceipt.answer === 42
      && rootReceipt.rootPersistentAcrossCells === true && childReceipt.persistentAcrossCells === true
      && childReceipt.sameWorkspaceInput === true && childReceipt.inputSha256 === fixture.goldSha256
      && rootReceipt.childInputSha256 === fixture.goldSha256
      && childRequests.length > 0 && outcome.observed?.childModelRequestCount > 0
      && outcome.observed?.childRoster?.observed === true
      && childSandbox.actor === 'child'
      && childSandbox.publicInputRead === true
      && childSandbox.inputWriteErrno === 1
      && childSandbox.protectedCanaryReadErrno === 1
      && childSandbox.publicSocketErrno === 1
      && isolation.passed && cleanup.passed && outcome.inputsUnchanged === true,
  }
}

async function runArm({ arm, manifest, artifactRoot, sourceRoot, tempRoot }) {
  const prepared = await prepareFixture({ sourceRoot, shared: manifest.shared.path, tempRoot, artifactRoot, arm })
  const ledger = await Ledger.open(join(prepared.condition.durableDirectory, 'parent-ledger.jsonl'), { total: 14, perRun: 14 })
  const relay = { async restoreOptions(options) { return options } }
  const providerFixture = createSyntheticProvider({ arm, fixture: prepared.fixture })
  const outcome = await executeCondition({
    manifest: { ...manifest, parentPrivate: prepared.parentPrivate },
    condition: prepared.condition,
    provider: providerFixture.provider,
    ledger,
    relay,
    task: prepared.task,
    grade: gradeFixture,
    protectedRoots: [prepared.protectedCanaryRoot],
  })
  await providerFixture.provider.close()
  return summarizeArm({ arm, outcome, fixture: prepared.fixture, providerFixture, condition: prepared.condition })
}

async function writeProof(path, value) {
  const output = requireAbsolute(path, 'output')
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  if (await exists(output)) fail('NATIVE_ACCEPTANCE_OUTPUT_EXISTS', `output already exists: ${output}`)
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

/**
 * Run the zero-real-model native acceptance through the real panel condition
 * assembly.  The return value is the persisted proof object.
 */
export async function runNativeAcceptance({ output = DEFAULT_OUTPUT, tempRoot, sourceRoot = DEFAULT_SOURCE_ROOT } = {}) {
  const startedAt = new Date().toISOString()
  const resolvedOutput = requireAbsolute(output, 'output')
  const artifactRoot = resolve(dirname(resolvedOutput), '..', '..')
  const source = requireAbsolute(sourceRoot, 'sourceRoot')
  const packageRoot = join(source, 'incubator', 'rlm')
  const actualTempRoot = tempRoot === undefined
    ? await mkdtemp('/private/tmp/rk2-')
    : requireAbsolute(tempRoot, 'tempRoot')
  if (!isWithin('/private/tmp', actualTempRoot) || actualTempRoot === '/private/tmp') {
    fail('NATIVE_ACCEPTANCE_TMP', 'tempRoot must be a descendant of /private/tmp')
  }
  if (tempRoot !== undefined) {
    if (await exists(actualTempRoot)) fail('NATIVE_ACCEPTANCE_TMP_EXISTS', `tempRoot already exists: ${actualTempRoot}`)
    await mkdir(actualTempRoot, { recursive: true, mode: 0o700 })
  }

  const sourceHashesBefore = await sourceHashes(source)
  const shared = join(actualTempRoot, 'shared')
  await mkdir(shared, { recursive: true, mode: 0o700 })
  let compiled
  let runtime
  let manifest
  const armResults = {}
  let unexpectedError = null
  try {
    compiled = await compileCurrentSources({ sourceRoot: source, packageRoot, shared })
    runtime = await prepareSharedRuntime({ compiled: compiled.compiled, packageRoot, shared })
    const workerSource = join(source, 'tools', 'rlm-arc-pilot', 'native-worker.mjs')
    const workerPath = join(shared, 'worker.mjs')
    await copyFile(workerSource, workerPath, fsConstants.COPYFILE_EXCL)
    manifest = {
      shared: {
        path: shared,
        compiled: { path: compiled.compiled, outputs: compiled.outputs, hash: compiled.hash },
        runtime,
        worker: { path: workerPath, sha256: await sha256File(workerPath) },
      },
      package: { root: packageRoot },
      runner: { sourceRoot: source },
      parentPrivate: join(artifactRoot, 'parent-private'),
    }
    armResults.S0 = await runArm({ arm: 'S0', manifest, artifactRoot, sourceRoot: source, tempRoot: actualTempRoot })
    armResults.S = await runArm({ arm: 'S', manifest, artifactRoot, sourceRoot: source, tempRoot: actualTempRoot })
  } catch (error) {
    unexpectedError = safeError(error)
  }
  const sourceHashesAfter = await sourceHashes(source)
  const sourceUnchanged = sameJson(sourceHashesBefore, sourceHashesAfter)
  const accepted = unexpectedError === null
    && sourceUnchanged
    && armResults.S0?.accepted === true
    && armResults.S?.accepted === true
    && armResults.S0?.provider?.realModelRequests === 0
    && armResults.S?.provider?.realModelRequests === 0
  const report = {
    formatVersion: 1,
    kind: 'prime-rlm-recursion-native-acceptance-v1',
    startedAt,
    completedAt: new Date().toISOString(),
    accepted,
    realModelRequests: 0,
    protocol: 'recursion-ablation-v1',
    fixedConfiguration: {
      route: FIXED_ROUTE,
      requestLimit: 14,
      wallTimeMs: 1_200_000,
      autonomous: FIXED_AUTONOMOUS,
      depths: { S0: 0, S: 1 },
    },
    sourceRoot: source,
    sourceHashes: sourceHashesBefore,
    sourceUnchanged,
    compiledHash: compiled?.hash ?? null,
    runtimeManifestSha256: runtime?.manifest?.sha256 ?? null,
    runtimeFingerprint: runtime?.paths?.fingerprint ?? null,
    originalCapsule: runtime?.manifest?.primeCommit ?? null,
    arms: armResults,
    cleanup: {
      S0: armResults.S0?.cleanup ?? null,
      S: armResults.S?.cleanup ?? null,
      temporaryRuntimeRoot: actualTempRoot,
      temporaryFilesRetained: true,
    },
    isolation: {
      credentialRead: false,
      externalProviderRequests: 0,
      publicNetworkDenied: true,
      loopbackBridgeUsed: true,
      note: 'The only provider was an in-process deterministic DSH-chunk fixture. The compiled host used its required local loopback/Unix bridge. Native Python used a non-secret protected canary to verify an EPERM read denial; no real credential path was supplied or opened.',
    },
    unexpectedError,
    limitations: [
      'This is a mechanism and isolation acceptance, not a model-quality or comparative-efficacy result.',
      'Every recorded physical admission is synthetic and does not represent a real provider request or model usage.',
      'The first native fixture uses one child; the separate serializeDispatcher focused test covers queued concurrent streams.',
    ],
  }
  await writeProof(resolvedOutput, report)
  return report
}

function parseArgs(argv) {
  const result = { output: undefined, tempRoot: undefined, sourceRoot: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--help' || item === '-h') return { help: true }
    const key = item === '--output' ? 'output' : item === '--temp-root' ? 'tempRoot' : item === '--source-root' ? 'sourceRoot' : undefined
    if (!key) fail('NATIVE_ACCEPTANCE_ARGS', `unknown option ${item}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail('NATIVE_ACCEPTANCE_ARGS', `${item} requires a value`)
    result[key] = value
    index += 1
  }
  if (!result.output) fail('NATIVE_ACCEPTANCE_ARGS', '--output is required')
  return result
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write('Usage: /opt/homebrew/opt/node@22/bin/node tools/rlm-recursion-pilot/native-acceptance.mjs --output <absolute-json> [--temp-root <fresh-/private/tmp/rk2-...>] [--source-root <checkout>]\n')
    return
  }
  if (process.versions.node.split('.')[0] !== '22') fail('NATIVE_ACCEPTANCE_NODE', `Node 22 is required; found ${process.version}`)
  const report = await runNativeAcceptance(args)
  process.stdout.write(`${JSON.stringify({ output: args.output, accepted: report.accepted, realModelRequests: report.realModelRequests, s0: report.arms.S0?.accepted ?? false, s: report.arms.S?.accepted ?? false }, null, 2)}\n`)
  if (!report.accepted) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`native-acceptance: ${safeError(error)}\n`)
    process.exitCode = 2
  })
}
