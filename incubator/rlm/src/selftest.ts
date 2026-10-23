import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { access, appendFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'

import { AcpClient } from './acp-client.js'

/** Paths from the verified, bundled Prime runtime. */
export interface RuntimePaths {
  readonly binary: string
  readonly python: string
  readonly packageDir: string
  readonly fingerprint: string
}

export interface SelfTestCheck {
  readonly id: string
  readonly passed: boolean
  readonly detail: string
}

export interface PrimeSelfTestReport {
  readonly formatVersion: 1
  readonly kind: 'local-keyless'
  readonly status: 'passed' | 'failed'
  readonly checks: SelfTestCheck[]
  /** Real external-provider requests. This local-only fixture must keep this at zero. */
  readonly modelRequests: number
  /** Deterministic requests served by this test's 127.0.0.1 fake provider. */
  readonly localModelRequests?: number
  readonly resultDirectory: string
}

export interface PrimeSelfTestOptions {
  readonly runtime: RuntimePaths
  /** The caller normally supplies a unique plugin-owned check directory. */
  readonly directory: string
  /** Optional shorter, plugin-owned directory for macOS's Unix-domain socket limit. */
  readonly socketDirectory?: string
  readonly timeoutMs?: number
  /** Cancels ACP waits; finally still closes only this fixture's resources. */
  readonly signal?: AbortSignal
}

type JsonObject = Record<string, unknown>

interface FakeToolReply {
  readonly kind: 'tool'
  readonly label: string
  readonly code: string
}

interface FakeTextReply {
  readonly kind: 'text'
  readonly label: string
  readonly text: string
}

type FakeReply = FakeToolReply | FakeTextReply

export interface FakeProviderRequest {
  readonly index: number
  readonly scope: string
  readonly sequence: number
  readonly label: string
  readonly model: string | undefined
  readonly latestUserText: string
  readonly toolNames: string[]
}

export interface FakeOpenAiProvider {
  readonly baseUrl: string
  readonly requests: readonly FakeProviderRequest[]
  readonly listening: () => boolean
  close(): Promise<void>
}

interface FixturePaths {
  readonly resultDirectory: string
  readonly home: string
  readonly agentDir: string
  readonly workspace: string
  readonly socket: string
  readonly receipt: string
  readonly grandchildReceipt: string
  readonly childReceipt: string
  readonly acpJournal: string
  readonly providerJournal: string
}

type ScenarioPaths = Pick<FixturePaths, 'receipt' | 'grandchildReceipt' | 'childReceipt'>

const PRIME_META_NAMESPACE = 'ai.primeintellect.prime-agent'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024
const MAX_LOCAL_MODEL_REQUESTS = 64

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return 'unknown error'
  }
}

function boundedText(value: string, max = 2_000): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function pythonString(value: string): string {
  return JSON.stringify(value)
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(contentText).join('\n')
  if (!isRecord(value)) return ''
  const text = typeof value.text === 'string' ? value.text : ''
  const content = contentText(value.content)
  return [text, content].filter(Boolean).join('\n')
}

function latestUserText(body: unknown): string {
  if (!isRecord(body)) return ''
  const messages = asArray(body.messages)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'user') continue
    return contentText(message.content)
  }
  return ''
}

function hasSystemPrompt(body: unknown, marker: string): boolean {
  if (!isRecord(body)) return false
  return asArray(body.messages).some((message) => isRecord(message)
    && message.role === 'system'
    && contentText(message.content).includes(marker))
}

function requestText(body: unknown): string {
  return jsonText(body)
}

function toolNames(body: unknown): string[] {
  if (!isRecord(body)) return []
  return asArray(body.tools)
    .map((tool) => isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === 'string'
      ? tool.function.name
      : undefined)
    .filter((value): value is string => value !== undefined)
}

function receiptMergeCode(receipt: string, fields: string): string {
  return [
    'import json',
    'from pathlib import Path',
    `receipt_path = Path(${pythonString(receipt)})`,
    'receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}',
    fields,
    'receipt_path.write_text(json.dumps(receipt, sort_keys=True))',
  ].join('\n')
}

function rootCellA(): string {
  return [
    'root_seed = 40',
    'print(f"CELL_A_PERSISTED={root_seed}")',
  ].join('\n')
}

function rootCellB(paths: ScenarioPaths): string {
  return [
    'assert root_seed == 40',
    'cell_b = root_seed + 2',
    'entry = rlm.harness.create_memory("Self-test memory", "version-one", id="selftest-persist", path="selftest")',
    'created_version = entry.version',
    'updated = rlm.harness.update_memory("selftest-persist", "Self-test memory", "version-two", path="selftest")',
    'assert created_version == 1 and updated.version >= 2',
    receiptMergeCode(paths.receipt, [
      'receipt["cellA"] = root_seed',
      'receipt["cellB"] = cell_b',
      'receipt["harnessCreateVersion"] = created_version',
      'receipt["harnessUpdateVersion"] = updated.version',
    ].join('\n')),
    'print(f"CELL_B_PERSISTED={cell_b}")',
    'print(f"HARNESS_CREATED_UPDATED={updated.version}")',
  ].join('\n')
}

function factoryCell(paths: ScenarioPaths): string {
  return [
    'import asyncio',
    'machine = {"run": {"max_parallel": 1, "max_children": 1, "max_transitions": 1, "budget_ms": 10000}, "states": [{"id": "seed", "entry": True, "subagent": {"prompt": "SELFTEST_FACTORY_CHILD: wait for the bounded native factory cancellation."}}], "transitions": []}',
    'rlm.harness.create_factory("Self-test bounded factory", "One child is started then cancelled.", id="selftest-factory", machine=machine)',
    'factory_run = await rlm.factory.run("selftest-factory")',
    'assert factory_run["started"] == ["seed"]',
    'await asyncio.sleep(1.0)',
    'factory_before = await rlm.factory.status(factory_run["run_id"])',
    'factory_stopped = await rlm.factory.stop(factory_run["run_id"])',
    'factory_after = await rlm.factory.status(factory_run["run_id"])',
    'assert factory_after["state"] == "stopped"',
    'assert rlm.harness.delete_factory("selftest-factory") is True',
    receiptMergeCode(paths.receipt, [
      'receipt["factory"] = {',
      '  "runId": factory_run["run_id"],',
      '  "started": factory_run["started"],',
      '  "before": factory_before["state"],',
      '  "stopped": factory_stopped["state"],',
      '  "after": factory_after["state"],',
      '}',
    ].join('\n')),
    'print(f"FACTORY_STOPPED={factory_after[\"state\"]}")',
  ].join('\n')
}

function rootSpawnCell(): string {
  return [
    'root_child = await rlm.spawn("SELFTEST_CHILD: spawn one grandchild, collect it, and write the derived result file.", name="selftest-child")',
    'print(f"ROOT_CHILD_ADMITTED={root_child.rlm_child_id}")',
  ].join('\n')
}

function grandchildCell(paths: ScenarioPaths): string {
  return [
    'import json',
    'from pathlib import Path',
    'operands = [5, 8, 13, 16]',
    'computed = sum(operands)',
    'assert computed == 42',
    `Path(${pythonString(paths.grandchildReceipt)}).write_text(json.dumps({"operands": operands, "computed": computed}, sort_keys=True))`,
    'print(f"GRANDCHILD_COMPUTED={computed}")',
  ].join('\n')
}

function childSpawnCell(): string {
  return [
    'grandchild = await rlm.spawn("SELFTEST_GRANDCHILD: compute the requested value in the native Python kernel and persist its receipt.", name="selftest-grandchild")',
    'print(f"CHILD_GRANDCHILD_ADMITTED={grandchild.rlm_child_id}")',
  ].join('\n')
}

function childCollectCell(paths: ScenarioPaths, collectTimeoutMs: number): string {
  const attempts = Math.max(20, Math.min(40, Math.floor(collectTimeoutMs / 1_000)))
  return [
    'import json',
    'import asyncio',
    'from pathlib import Path',
    'child_results = []',
    `for _ in range(${attempts}):`,
    '    child_results = await rlm.collect(grandchild, timeout_ms=500)',
    '    if len(child_results) == 1 and child_results[0].settled:',
    '        break',
    '    await asyncio.sleep(0.1)',
    'assert len(child_results) == 1 and child_results[0].settled',
    `grandchild_receipt = json.loads(Path(${pythonString(paths.grandchildReceipt)}).read_text())`,
    'assert grandchild_receipt["computed"] == 42',
    'child_total = grandchild_receipt["computed"] + 1',
    `Path(${pythonString(paths.childReceipt)}).write_text(json.dumps({"grandchild": grandchild_receipt, "childTotal": child_total}, sort_keys=True))`,
    'print(f"CHILD_COLLECTED_NATIVE={child_total}")',
  ].join('\n')
}

function rootCollectCell(paths: ScenarioPaths, collectTimeoutMs: number): string {
  const attempts = Math.max(20, Math.min(40, Math.floor(collectTimeoutMs / 1_000)))
  return [
    'import json',
    'import asyncio',
    'from pathlib import Path',
    'root_results = []',
    `for _ in range(${attempts}):`,
    '    root_results = await rlm.collect(root_child, timeout_ms=500)',
    '    if len(root_results) == 1 and root_results[0].settled:',
    '        break',
    '    await asyncio.sleep(0.1)',
    'assert len(root_results) == 1 and root_results[0].settled',
    `child_receipt = json.loads(Path(${pythonString(paths.childReceipt)}).read_text())`,
    'assert child_receipt["childTotal"] == 43',
    'root_observed = child_receipt["childTotal"] - 1',
    'assert root_observed == 42',
    'persisted = [entry for entry in rlm.harness.list("memory") if entry.id == "selftest-persist"]',
    'assert len(persisted) == 1 and persisted[0].content == "version-two"',
    'assert rlm.harness.delete_memory("selftest-persist") is True',
    receiptMergeCode(paths.receipt, [
      'receipt["recursive"] = {',
      '  "grandchild": child_receipt["grandchild"]["computed"],',
      '  "child": child_receipt["childTotal"],',
      '  "root": root_observed,',
      '}',
      'receipt["harnessPersistedAcrossCells"] = True',
      'receipt["harnessDeleted"] = True',
    ].join('\n')),
    'print(f"ROOT_COLLECTED_NATIVE={root_observed}")',
    'print("HARNESS_PERSISTED_DELETED=true")',
  ].join('\n')
}

function refineScheduleCell(paths: ScenarioPaths): string {
  return [
    'from rlm import host_request',
    'refine_before = await host_request("refine.status", {})',
    'refine_scheduled = await host_request("refine.run", {"instructions": "Persist one narrowly scoped local self-test memory, then allow native rollback verification.", "global": False})',
    'refine_after = await host_request("refine.status", {})',
    'assert refine_before["pending"] is False',
    'assert refine_scheduled["scheduled"] is True',
    'assert refine_after["pending"] is True',
    receiptMergeCode(paths.receipt, [
      'receipt["refineScheduled"] = {',
      '  "before": refine_before["pending"],',
      '  "scheduled": refine_scheduled["scheduled"],',
      '  "after": refine_after["pending"],',
      '}',
    ].join('\n')),
    'print(f"REFINE_PENDING_BEFORE={str(refine_before[\"pending\"]).lower()}")',
    'print(f"REFINE_PENDING_AFTER={str(refine_after[\"pending\"]).lower()}")',
  ].join('\n')
}

function postRefineCell(paths: ScenarioPaths, refinementContextVisible: boolean): string {
  return [
    `assert ${refinementContextVisible ? 'True' : 'False'}, "native refinement notice was absent from the following provider request"`,
    receiptMergeCode(paths.receipt, [
      'receipt["refinementLoadedNextTurn"] = {"id": "selftest-refine-memory", "modelContextObserved": True}',
    ].join('\n')),
    'print("REFINEMENT_LOADED_NEXT_TURN=selftest-refine-memory")',
  ].join('\n')
}

function fixtureScope(body: unknown): string {
  if (hasSystemPrompt(body, "Prime Agent's /refine continual harness subsystem")) {
    return 'refinement'
  }
  const latest = latestUserText(body)
  if (latest.includes('SELFTEST_POST_ROLLBACK')) return 'post-rollback'
  if (latest.includes('SELFTEST_POST_REFINE')) return 'post-refine'
  if (latest.includes('[child-exited:')) {
    if (latest.includes('child:selftest-child')) return 'root-child-exit'
    if (latest.includes('child:selftest-grandchild')) return 'child-grandchild-exit'
    if (latest.includes('child:sw-seed-')) return 'factory-child-exit'
  }
  if (latest.includes('SELFTEST_FACTORY_CHILD')) return 'factory-child'
  if (latest.includes('SELFTEST_GRANDCHILD')) return 'grandchild'
  if (latest.includes('SELFTEST_CHILD')) return 'child'
  if (latest.includes('SELFTEST_ROOT')) return 'root'
  const text = requestText(body)
  if (text.includes('SELFTEST_ROOT')) return 'root'
  if (text.includes('SELFTEST_FACTORY_CHILD')) return 'factory-child'
  if (text.includes('SELFTEST_GRANDCHILD')) return 'grandchild'
  if (text.includes('SELFTEST_CHILD')) return 'child'
  return 'unknown'
}

function chooseFakeReply(body: unknown, paths: ScenarioPaths, collectTimeoutMs: number, sequence = 0): FakeReply {
  const scope = fixtureScope(body)
  if (scope === 'refinement') {
    return {
      kind: 'text', label: 'native-refinement-plan', text: JSON.stringify({
        summary: 'Persist a local self-test observation.',
        rationale: 'The native keyless fixture recorded a bounded mechanism observation.',
        expectedOutcome: 'A following turn can load the local memory before native rollback removes it.',
        edits: [{
          action: 'create', kind: 'memory', id: 'selftest-refine-memory', title: 'Local self-test refinement',
          content: 'Native refinement persistence was observed by a following turn.', path: 'selftest',
          metadata: { source: 'local-keyless' }, reason: 'Exercise the original native persistence and rollback path.',
        }],
      }),
    }
  }
  if (scope === 'root') {
    const stages: readonly FakeReply[] = [
      { kind: 'tool', label: 'root-cell-a', code: rootCellA() },
      { kind: 'tool', label: 'root-cell-b', code: rootCellB(paths) },
      { kind: 'tool', label: 'factory-run-status-stop', code: factoryCell(paths) },
      { kind: 'tool', label: 'root-spawn', code: rootSpawnCell() },
      { kind: 'text', label: 'root-await-child', text: 'The root has queued its native child and is waiting for its terminal notice.' },
    ]
    return stages[sequence] ?? { kind: 'text', label: 'root-idle', text: 'Native self-test root is quiescent.' }
  }
  if (scope === 'child') {
    const stages: readonly FakeReply[] = [
      { kind: 'tool', label: 'child-spawn', code: childSpawnCell() },
      { kind: 'text', label: 'child-await-grandchild', text: 'The child has queued its native grandchild and is waiting for its terminal notice.' },
    ]
    return stages[sequence] ?? { kind: 'text', label: 'child-idle', text: 'Child is quiescent.' }
  }
  if (scope === 'grandchild') {
    return sequence === 0
      ? { kind: 'tool', label: 'grandchild-computation', code: grandchildCell(paths) }
      : { kind: 'text', label: 'grandchild-final', text: 'Grandchild native kernel calculation completed.' }
  }
  if (scope === 'factory-child') {
    return sequence === 0
      ? { kind: 'tool', label: 'factory-child-hold', code: ['import asyncio', 'await asyncio.sleep(30)', 'print("FACTORY_CHILD_RELEASED")'].join('\n') }
      : { kind: 'text', label: 'factory-child-idle', text: 'Factory child is quiescent.' }
  }
  if (scope === 'factory-child-exit') {
    return { kind: 'text', label: 'factory-child-cancelled', text: 'The bounded Factory child cancellation was observed.' }
  }
  if (scope === 'child-grandchild-exit') {
    return sequence === 0
      ? { kind: 'tool', label: 'child-collect', code: childCollectCell(paths, collectTimeoutMs) }
      : { kind: 'text', label: 'child-final', text: 'Child collected its native grandchild result.' }
  }
  if (scope === 'root-child-exit') {
    const stages: readonly FakeReply[] = [
      { kind: 'tool', label: 'root-collect', code: rootCollectCell(paths, collectTimeoutMs) },
      { kind: 'tool', label: 'refine-pending-transition', code: refineScheduleCell(paths) },
      { kind: 'text', label: 'root-turn-complete', text: 'Native self-test mechanism turn completed.' },
    ]
    return stages[sequence] ?? { kind: 'text', label: 'root-idle', text: 'Native self-test root is quiescent.' }
  }
  if (scope === 'post-refine') {
    const refinementContextVisible = requestText(body).includes('selftest-refine-memory')
      && requestText(body).includes('Native refinement persistence was observed by a following turn.')
    return sequence === 0
      ? { kind: 'tool', label: 'post-refinement-observation', code: postRefineCell(paths, refinementContextVisible) }
      : { kind: 'text', label: 'post-refinement-complete', text: 'Native refinement was inspected.' }
  }
  return { kind: 'text', label: 'unsupported-request', text: 'The local self-test provider received an unsupported fixture request.' }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_HTTP_BODY_BYTES) throw new Error('loopback request body exceeds the self-test limit')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendSse(response: ServerResponse, reply: FakeReply, sequence: number): void {
  const delta = reply.kind === 'tool'
    ? {
      tool_calls: [{
        index: 0,
        id: `selftest-call-${sequence}`,
        type: 'function',
        function: { name: 'python_repl', arguments: JSON.stringify({ code: reply.code }) },
      }],
    }
    : { content: reply.text }
  const finishReason = reply.kind === 'tool' ? 'tool_calls' : 'stop'
  const frame = {
    id: `selftest-response-${sequence}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'loopback-v1',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  response.writeHead(200, {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
  })
  response.write(`data: ${JSON.stringify(frame)}\n\n`)
  response.end('data: [DONE]\n\n')
}

/**
 * Starts the only model endpoint used by the self-test. It binds to loopback,
 * is deterministic, and returns tool calls that Prime itself executes.
 */
export async function startFakeOpenAiProvider(paths: ScenarioPaths, collectTimeoutMs = 60_000): Promise<FakeOpenAiProvider> {
  const requests: FakeProviderRequest[] = []
  const sequences = new Map<string, number>()
  let closed = false
  const server: Server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'self-test endpoint not found' } }))
        return
      }
      const text = await readRequestBody(request)
      const body = JSON.parse(text) as unknown
      if (requests.length >= MAX_LOCAL_MODEL_REQUESTS) {
        response.writeHead(429, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'local self-test model request cap reached' } }))
        return
      }
      const scope = fixtureScope(body)
      const sequence = sequences.get(scope) ?? 0
      sequences.set(scope, sequence + 1)
      const reply = chooseFakeReply(body, paths, collectTimeoutMs, sequence)
      const record: FakeProviderRequest = {
        index: requests.length + 1,
        scope,
        sequence,
        label: reply.label,
        model: isRecord(body) && typeof body.model === 'string' ? body.model : undefined,
        latestUserText: latestUserText(body),
        toolNames: toolNames(body),
      }
      requests.push(record)
      sendSse(response, reply, record.index)
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: boundedText(errorDetail(error)) } }))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    throw new Error('loopback fake provider did not expose a TCP port')
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    listening: () => server.listening,
    async close(): Promise<void> {
      if (closed) return
      closed = true
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error === undefined ? resolveClose() : rejectClose(error))
      })
    },
  }
}

async function ensureRuntime(runtime: RuntimePaths): Promise<void> {
  await Promise.all([access(runtime.binary), access(runtime.python)])
  const packageStat = await stat(runtime.packageDir)
  if (!packageStat.isDirectory()) throw new Error('runtime packageDir is not a directory')
  if (!/^[a-f0-9]{16,}$/i.test(runtime.fingerprint)) throw new Error('runtime fingerprint is not a hexadecimal digest')
}

function isolatedEnvironment(paths: FixturePaths, runtime: RuntimePaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: paths.home,
    LANG: process.env.LANG ?? 'C',
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    LC_ALL: process.env.LC_ALL,
    PI_OFFLINE: '1',
    PI_PACKAGE_DIR: runtime.packageDir,
    PRIME_AGENT_CODING_AGENT_DIR: paths.agentDir,
    PRIME_AGENT_DAEMON_SOCKET: paths.socket,
    PRIME_AGENT_KERNEL_PYTHON: runtime.python,
    PRIME_AGENT_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key]
  }
  return env
}

async function writeFixtureSettings(paths: FixturePaths, baseUrl: string): Promise<void> {
  const models = {
    providers: {
      selftest: {
        api: 'openai-completions',
        baseUrl,
        apiKey: 'local-keyless-fixture',
        models: [{
          id: 'loopback-v1',
          name: 'Local keyless loopback fixture',
          api: 'openai-completions',
          reasoning: false,
          contextWindow: 128_000,
          maxTokens: 4_096,
        }],
      },
    },
  }
  await Promise.all([
    writeFile(join(paths.agentDir, 'models.json'), `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(paths.agentDir, 'settings.json'), `${JSON.stringify({ harnessRefinements: true, factory: { enabled: true } }, null, 2)}\n`, { mode: 0o600 }),
  ])
}

function spawnPrime(binary: string, paths: FixturePaths, runtime: RuntimePaths, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(binary, [
    '--mode', 'acp',
    '--offline',
    '--daemon-socket', paths.socket,
    '--provider', 'selftest',
    '--model', 'loopback-v1',
    '--cwd', paths.workspace,
  ], {
    cwd: paths.workspace,
    env: isolatedEnvironment(paths, runtime),
    stdio: 'pipe',
  }) as ChildProcessWithoutNullStreams
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit(true)
    })
  })
}

interface CommandResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

async function runOwnedCommand(binary: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<CommandResult> {
  const child = spawn(binary, args, { cwd, env, stdio: 'pipe' })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)))
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(Buffer.from(chunk)))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, timeoutMs)
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  clearTimeout(timer)
  return {
    code,
    signal,
    stdout: boundedText(Buffer.concat(stdout).toString('utf8')),
    stderr: boundedText(Buffer.concat(stderr).toString('utf8')),
    timedOut,
  }
}

async function appendJournal(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify({ time: new Date().toISOString(), value })}\n`, { mode: 0o600 })
}

function responseStopReason(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.stopReason === 'string' ? value.stopReason : undefined
}

function updateValue(update: unknown): JsonObject | undefined {
  return isRecord(update) ? update : undefined
}

function updateToolTexts(updates: readonly unknown[]): string[] {
  const texts: string[] = []
  for (const params of updates) {
    const update = isRecord(params) ? updateValue(params.update) : undefined
    if (!update || update.sessionUpdate !== 'tool_call_update') continue
    for (const item of asArray(update.content)) {
      if (!isRecord(item) || !isRecord(item.content) || typeof item.content.text !== 'string') continue
      texts.push(item.content.text)
    }
  }
  return texts
}

function primeMeta(update: unknown): JsonObject | undefined {
  if (!isRecord(update) || !isRecord(update.update) || !isRecord(update.update._meta)) return undefined
  const meta = update.update._meta[PRIME_META_NAMESPACE]
  return isRecord(meta) ? meta : undefined
}

function hasRosterObservation(updates: readonly unknown[]): boolean {
  return updates.some((update) => {
    const subagents = primeMeta(update)?.subagents
    return Array.isArray(subagents) && subagents.some((row) => isRecord(row)
      && typeof row.id === 'string' && row.id.length > 0
      && typeof row.status === 'string' && row.status.length > 0)
  })
}

function hasRefinementObservation(updates: readonly unknown[], expectedStatus: string): boolean {
  return updates.some((update) => primeMeta(update)?.refinement !== undefined
    && isRecord(primeMeta(update)?.refinement)
    && primeMeta(update)?.refinement !== undefined
    && (primeMeta(update)?.refinement as JsonObject).status === expectedStatus)
}

interface HarnessStateFile {
  readonly path: string
  readonly state: JsonObject
}

async function findHarnessStates(root: string): Promise<readonly HarnessStateFile[]> {
  const found: HarnessStateFile[] = []
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8) return undefined
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path, depth + 1)
      } else if (entry.isFile() && entry.name === 'harness_state.json') {
        try {
          const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
          if (isRecord(parsed)) found.push({ path, state: parsed })
        } catch {
          // A malformed isolated receipt is evidence of a failed check, not a reason to read outside it.
        }
      }
    }
  }
  await visit(root, 0)
  return found
}

async function readHarnessState(path: string): Promise<JsonObject | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function entriesForKind(state: JsonObject | undefined, kind: string): JsonObject {
  if (!state || !isRecord(state.entries) || !isRecord(state.entries[kind])) return {}
  return state.entries[kind]
}

function latestRefinementId(state: JsonObject | undefined): string | undefined {
  if (!state) return undefined
  const refinements = asArray(state.refinements)
  for (let index = refinements.length - 1; index >= 0; index -= 1) {
    const row = refinements[index]
    if (isRecord(row) && typeof row.id === 'string' && row.id.length > 0) return row.id
  }
  return undefined
}

function hasRollbackHistory(state: JsonObject | undefined, refinementId: string): boolean {
  return asArray(state?.refinements).some((row) => isRecord(row)
    && row.trigger === `Rollback refinement ${refinementId}`
    && asArray(row.changes).includes('delete memory:selftest-refine-memory'))
}

function check(checks: SelfTestCheck[], id: string, passed: boolean, detail: string): void {
  checks.push({ id, passed, detail })
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error(typeof signal.reason === 'string' ? signal.reason : 'Prime local self-test cancelled')
}

async function closeSession(client: AcpClient | undefined, sessionId: string | undefined, timeoutMs: number): Promise<void> {
  if (!client || !sessionId) return
  try {
    await client.request('session/close', { sessionId }, { timeoutMs })
  } catch {
    // Cleanup continues through the owned daemon shutdown. The report records that shutdown result.
  }
}

/**
 * Explicit, isolated mechanism self-test. It never starts on plugin load.
 * The local provider supplies deterministic tool calls; Prime's unmodified
 * kernel, recursive host, Factory, Continual Harness and refinement boundary
 * perform the actual work and produce the observed receipts.
 */
export async function runPrimeSelfTest(options: PrimeSelfTestOptions): Promise<PrimeSelfTestReport> {
  const checks: SelfTestCheck[] = []
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const resultDirectory = resolve(options.directory)
  const socketDirectory = resolve(options.socketDirectory ?? resultDirectory)
  const paths: FixturePaths = {
    resultDirectory,
    home: join(resultDirectory, 'home'),
    agentDir: join(resultDirectory, 'agent'),
    workspace: join(resultDirectory, 'workspace'),
    socket: join(socketDirectory, 'p.sock'),
    receipt: join(resultDirectory, 'native-receipt.json'),
    grandchildReceipt: join(resultDirectory, 'grandchild-receipt.json'),
    childReceipt: join(resultDirectory, 'child-receipt.json'),
    acpJournal: join(resultDirectory, 'acp.jsonl'),
    providerJournal: join(resultDirectory, 'provider.json'),
  }
  const collectTimeoutMs = Math.max(10_000, Math.min(60_000, Math.floor(timeoutMs * 0.6)))
  let provider: FakeOpenAiProvider | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  let client: AcpClient | undefined
  let sessionId: string | undefined
  let journalTail = Promise.resolve()
  const updates: unknown[] = []
  let shutdown: CommandResult | undefined

  try {
    throwIfAborted(options.signal)
    if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) throw new RangeError('timeoutMs must be at least 10000')
    if (Buffer.byteLength(paths.socket, 'utf8') >= 100) {
      throw new RangeError(`owned Prime daemon socket path is too long for macOS: ${paths.socket}`)
    }
    await mkdir(paths.agentDir, { recursive: true, mode: 0o700 })
    await Promise.all([
      mkdir(paths.home, { recursive: true, mode: 0o700 }),
      mkdir(paths.workspace, { recursive: true, mode: 0o700 }),
      mkdir(socketDirectory, { recursive: true, mode: 0o700 }),
    ])
    await ensureRuntime(options.runtime)
    check(checks, 'runtime', true, `已验证 Prime 二进制、离线 Python、包目录和运行时指纹 ${options.runtime.fingerprint.slice(0, 16)}。`)

    provider = await startFakeOpenAiProvider(paths, collectTimeoutMs)
    throwIfAborted(options.signal)
    await writeFixtureSettings(paths, provider.baseUrl)
    check(checks, 'isolation', true, '已创建独立 HOME、agent 目录、daemon socket、settings 和仅指向 127.0.0.1 的 models.json；未读取用户凭据。')

    const env = isolatedEnvironment(paths, options.runtime)
    child = spawnPrime(options.runtime.binary, paths, options.runtime, env)
    client = new AcpClient(child, {
      record: async (direction, value) => {
        journalTail = journalTail.then(() => appendJournal(paths.acpJournal, { direction, value }))
        await journalTail
      },
      onUpdate: (value) => { updates.push(value) },
    })
    const initialized = await client.request('initialize', {
      clientCapabilities: {},
      clientInfo: { name: 'dsh-prime-keyless-selftest', version: '1' },
    }, { timeoutMs, signal: options.signal })
    const initializedRecord = isRecord(initialized) ? initialized : undefined
    if (!initializedRecord || initializedRecord.protocolVersion !== 1) throw new Error('Prime ACP initialize did not return protocolVersion 1')
    const created = await client.request('session/new', { cwd: paths.workspace, mcpServers: [] }, { timeoutMs, signal: options.signal })
    if (!isRecord(created) || typeof created.sessionId !== 'string') {
      throw new Error('Prime ACP session/new did not return a sessionId')
    }
    sessionId = created.sessionId
    check(checks, 'acp', true, '已通过 Prime 原生 ACP 初始化并创建持久会话。')

    throwIfAborted(options.signal)
    const main = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'SELFTEST_ROOT: run the isolated native Prime RLM, Factory, Harness and refinement boundary mechanism fixture.' }],
    }, { timeoutMs, signal: options.signal })
    if (responseStopReason(main) !== 'end_turn') throw new Error(`root mechanism prompt stopped as ${String(responseStopReason(main))}`)

    const receipt = JSON.parse(await readFile(paths.receipt, 'utf8')) as JsonObject
    const toolTexts = updateToolTexts(updates)
    const requiredToolMarkers = [
      'CELL_B_PERSISTED=42',
      'FACTORY_STOPPED=stopped',
      'ROOT_COLLECTED_NATIVE=42',
      'REFINE_PENDING_AFTER=true',
    ]
    const missingMarkers = requiredToolMarkers.filter((marker) => !toolTexts.some((text) => text.includes(marker)))
    check(checks, 'native-tool-results', missingMarkers.length === 0,
      missingMarkers.length === 0
        ? '根 ACP 的原生 tool_call_update 包含两段持久 Python cell、Factory、递归 collect 和 refine pending 标记；子层实际收据由 recursive 检查验证。'
        : `缺少原生工具结果标记：${missingMarkers.join(', ')}`)

    const recursive = isRecord(receipt.recursive) ? receipt.recursive : undefined
    const recursivePassed = receipt.cellA === 40 && receipt.cellB === 42
      && recursive?.grandchild === 42 && recursive.child === 43 && recursive.root === 42
    check(checks, 'persistent-recursion', recursivePassed,
      recursivePassed
        ? 'Prime 原生内核跨两 cell 保留 root_seed；root→child→grandchild 的 spawn/collect 通过子进程生成的实际收据完成 42→43→42 计算。'
        : `原生递归收据不符合预期：${boundedText(jsonText({ cellA: receipt.cellA, cellB: receipt.cellB, recursive }))}`)

    const factory = isRecord(receipt.factory) ? receipt.factory : undefined
    const factoryPassed = Array.isArray(factory?.started) && factory.started.includes('seed')
      && factory?.after === 'stopped' && factory?.stopped === 'stopped'
    check(checks, 'factory', factoryPassed,
      factoryPassed
        ? '在隔离 settings.factory.enabled=true 下，原生 Factory.run 启动受 max_children=1 限制的 seed child，随后 status/stop 返回 stopped。'
        : `原生 Factory 状态不符合预期：${boundedText(jsonText(factory))}`)

    const harnessPassed = receipt.harnessCreateVersion === 1
      && typeof receipt.harnessUpdateVersion === 'number'
      && receipt.harnessUpdateVersion >= 2
      && receipt.harnessPersistedAcrossCells === true
      && receipt.harnessDeleted === true
    check(checks, 'harness-crud', harnessPassed,
      harnessPassed
        ? '原生 Continual Harness 在不同 Python cell 中完成 create/update/read/delete，并保留版本变化证据。'
        : `Continual Harness CRUD 收据不符合预期：${boundedText(jsonText(receipt))}`)

    const refineSchedule = isRecord(receipt.refineScheduled) ? receipt.refineScheduled : undefined
    const refinementBoundary = refineSchedule?.before === false && refineSchedule.scheduled === true && refineSchedule.after === true
      && hasRefinementObservation(updates, 'complete')
      && provider.requests.some((request) => request.label === 'native-refinement-plan')
    check(checks, 'refinement-boundary', refinementBoundary,
      refinementBoundary
        ? '原生 refine.run 在 cell 内从 pending=false 变为 true；turn boundary 调用原始 planner，并从 loopback provider 获得一个实际编辑计划。'
        : `未观察到完整 refine pending→boundary 路径：${boundedText(jsonText(refineSchedule))}`)

    const stateAfterRefine = (await findHarnessStates(paths.agentDir)).find(({ state }) => {
      const memory = entriesForKind(state, 'memory')['selftest-refine-memory']
      return isRecord(memory) && typeof latestRefinementId(state) === 'string'
    })
    const memoryAfterRefine = stateAfterRefine === undefined
      ? undefined
      : entriesForKind(stateAfterRefine.state, 'memory')['selftest-refine-memory']
    const refinementId = stateAfterRefine === undefined ? undefined : latestRefinementId(stateAfterRefine.state)
    if (!stateAfterRefine || !isRecord(memoryAfterRefine) || typeof refinementId !== 'string') {
      throw new Error('native refinement did not persist its expected memory and refinement id')
    }
    throwIfAborted(options.signal)
    const postRefine = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'SELFTEST_POST_REFINE: inspect the native refinement memory on the following turn.' }],
    }, { timeoutMs, signal: options.signal })
    if (responseStopReason(postRefine) !== 'end_turn') throw new Error('post-refinement observation did not end the turn')
    const receiptAfterRefine = JSON.parse(await readFile(paths.receipt, 'utf8')) as JsonObject
    const loaded = isRecord(receiptAfterRefine.refinementLoadedNextTurn)
      && receiptAfterRefine.refinementLoadedNextTurn.id === 'selftest-refine-memory'
      && receiptAfterRefine.refinementLoadedNextTurn.modelContextObserved === true
    check(checks, 'refinement-persistence', loaded,
      loaded
        ? `原生 planner 创建的 memory 已持久化；后续 turn 的实际 provider request 携带该 refinement notice，refinement id 为 ${refinementId}。`
        : `后续 turn 未确认原生 refinement 在模型上下文中可见：${boundedText(jsonText(receiptAfterRefine.refinementLoadedNextTurn))}`)

    throwIfAborted(options.signal)
    const rollback = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: `/refine rollback ${refinementId}` }],
    }, { timeoutMs, signal: options.signal })
    if (responseStopReason(rollback) !== 'end_turn') throw new Error('native refinement rollback did not end the turn')
    const stateAfterRollback = await readHarnessState(stateAfterRefine.path)
    const memoryAfterRollback = entriesForKind(stateAfterRollback, 'memory')['selftest-refine-memory']
    const rollbackId = latestRefinementId(stateAfterRollback)
    if (memoryAfterRollback !== undefined) throw new Error('native refinement rollback left its memory entry behind')
    const rollbackPassed = rollbackId !== undefined && rollbackId !== refinementId
      && hasRollbackHistory(stateAfterRollback, refinementId)
    check(checks, 'refinement-rollback', rollbackPassed,
      rollbackPassed
        ? `原生 /refine rollback 删除了已验证的 memory；持久状态新增 rollback 记录 ${rollbackId}。`
        : '未从原生持久状态同时确认 refinement rollback 的删除及历史记录。')

    check(checks, 'native-roster', hasRosterObservation(updates),
      hasRosterObservation(updates)
        ? 'ACP 的 Prime namespaced metadata 记录了原生子代理 roster 更新。'
        : '未观察到 ACP 子代理 roster 更新。')
  } catch (error) {
    check(checks, 'execution', false, boundedText(errorDetail(error)))
  } finally {
    await closeSession(client, sessionId, Math.min(timeoutMs, 15_000))
    try {
      await client?.dispose()
    } catch (error) {
      check(checks, 'acp-close', false, boundedText(errorDetail(error)))
    }
    try {
      await journalTail
    } catch (error) {
      check(checks, 'acp-journal', false, boundedText(errorDetail(error)))
    }
    if (child !== undefined) {
      try {
        shutdown = await runOwnedCommand(options.runtime.binary, ['shutdown', '--force', '--json'], paths.workspace,
          isolatedEnvironment(paths, options.runtime), Math.min(timeoutMs, 20_000))
        const shutdownPassed = !shutdown.timedOut && shutdown.code === 0
        check(checks, 'owned-daemon-shutdown', shutdownPassed,
          shutdownPassed
            ? '使用同一隔离 agentDir 和 daemon socket 调用了 Prime 原生 shutdown --force --json。'
            : `Prime 原生 shutdown 未成功：${boundedText(jsonText(shutdown))}`)
      } catch (error) {
        check(checks, 'owned-daemon-shutdown', false, boundedText(errorDetail(error)))
      }
      const exited = await waitForExit(child, 5_000)
      if (!exited) {
        child.kill('SIGTERM')
        const terminated = await waitForExit(child, 5_000)
        check(checks, 'owned-acp-process', terminated,
          terminated ? '仅终止了本次自检创建且未自行退出的 ACP child。' : '本次自检创建的 ACP child 未在 SIGTERM 后退出。')
      } else {
        check(checks, 'owned-acp-process', true, '本次自检创建的 ACP child 已退出。')
      }
    }
    if (provider !== undefined) {
      try {
        await provider.close()
        check(checks, 'loopback-provider-cleanup', !provider.listening(), '仅本次自检创建的 loopback fake provider 已关闭。')
      } catch (error) {
        check(checks, 'loopback-provider-cleanup', false, boundedText(errorDetail(error)))
      }
    }
    if (provider !== undefined) {
      try {
        await writeFile(paths.providerJournal, `${JSON.stringify({ formatVersion: 1, requests: provider.requests, shutdown }, null, 2)}\n`, { mode: 0o600 })
      } catch (error) {
        check(checks, 'provider-journal', false, boundedText(errorDetail(error)))
      }
    }
  }

  let report: PrimeSelfTestReport = {
    formatVersion: 1,
    kind: 'local-keyless',
    status: checks.every((item) => item.passed) ? 'passed' : 'failed',
    checks,
    modelRequests: 0,
    localModelRequests: provider?.requests.length ?? 0,
    resultDirectory,
  }
  try {
    await writeFile(join(resultDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    check(checks, 'report-write', false, `无法持久化自检报告：${boundedText(errorDetail(error))}`)
    report = {
      ...report,
      status: 'failed',
      checks,
    }
  }
  return report
}

/** Test-only seams for deterministic provider routing and lifecycle tests. */
export const __selftestInternals = {
  chooseFakeReply,
  latestUserText,
  startFakeOpenAiProvider,
}
