#!/usr/bin/env node
/**
 * Emit a keyless transcript of an RLM run under an evaluation scope: what the ledger admitted, what reached the endpoint, and
 * what the endpoint received in each request.
 *
 * Composition: the production app boot and YAML Loader assemble the orchestration client (`autoStart: true`), and the client
 * starts the production daemon entry exactly as the Desktop does. The home holds an `evaluation-scope.json`, so the daemon opens
 * a ledger. Only the model provider is replaced: `DEEPSEEK_BASE_URL` points the shipping DeepSeek adapter and worker at a
 * loopback server, with a fake key and a PATH without the native CLIs. The server keeps the exact bytes of every request it
 * receives; the transcript joins each to one admitted ledger attempt by sha256. A real provider request cannot happen here: the
 * only endpoint the daemon is given is the loopback server.
 *
 * Every wait is bounded here, and each cleanup step is attempted on its own: the daemons are detached, so a run that is
 * abandoned without cleanup would leave them running. A request whose wait was abandoned keeps running inside the client and
 * may still be starting a daemon, so the driver keeps those requests, refuses new ones once cleanup starts, waits a bounded time
 * for them, stops the daemons it started, and looks once more after a short pause for one that finished starting late. Only
 * daemons whose pid file names this home are stopped. `DSH_EVALUATION_FIXTURE_FAULT=slow-start` is read only by the fault test
 * of this fixture: the first request reaches the client just before the stage limit, as a late daemon start would.
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { LogicalTaskGraphV1 } from '@deepseek-ai/dsh-orchestration'
import { messageText, startFakeDeepSeek, type FakeDeepSeek, type FakeMessage, type FakeReply } from '../prime-rlm-terminal/fake-deepseek.ts'

const configPath = process.argv[2]
const home = process.env.DSH_HOME
if (configPath === undefined || home === undefined) throw new Error('prime-rlm-evaluation fixture requires a config path and an isolated DSH_HOME')
const isolatedHome: string = home

process.env.HOME = isolatedHome
process.env.PATH = '/usr/bin:/bin'
process.env.DEEPSEEK_API_KEY = 'fixture-not-a-key'

const ROOT = 'EVAL-ROOT: combine the results.'
const KID = 'EVAL-KID: ask your own child.'
const GRAND = 'EVAL-GRAND: report to your parent.'
const ADMITTED_LIMIT = 6

const FAKE_MS = 3_000
const BOOT_MS = 12_000
const DAEMON_MS = 12_000
const RUN_MS = 15_000
const RPC_MS = 5_000
const DISPOSE_MS = 3_000
const DAEMON_STOP_MS = 8_000
const FAKE_CLOSE_MS = 2_000
const PS_MS = 2_000
const INFLIGHT_MS = 5_000
const LATE_SWEEP_PAUSE_MS = 700

const fault = process.env.DSH_EVALUATION_FIXTURE_FAULT

/** A wait that ran out of time, as opposed to the awaited work failing. */
class DeadlineError extends Error {}

function within<T>(label: string, work: Promise<T>, limitMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new DeadlineError(`${label} did not return within ${String(Math.round(limitMs))} ms`)) }, Math.max(1, limitMs))
    timer.unref()
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(JSON.stringify(error))) },
    )
  })
}

/** The task text a request carries: the daemon wraps every API prompt in a JSON envelope, and the model reads its `task`. */
function taskText(message: FakeMessage): string {
  type Envelope = { readonly dshOperatorContextEnvelope: { readonly task: { readonly content: readonly { readonly text?: string }[] } } }
  return (JSON.parse(messageText(message)) as Envelope).dshOperatorContextEnvelope.task.content.map(block => block.text ?? '').join('\n')
}

/** A tree of agents: the root asks a child, which asks its own child; each reports upward, so the root is also continued. */
function handle(messages: readonly FakeMessage[]): FakeReply {
  const first = messages[0]
  if (first === undefined) throw new Error('fake DeepSeek received a request without messages')
  if (messages.at(-1)?.role === 'tool') return { kind: 'text', text: 'done', finish: 'stop' }
  const text = taskText(first)
  const repl = (code: string): FakeReply => ({ kind: 'tool', name: 'typescript_repl', arguments: JSON.stringify({ code }) })
  if (text.includes('Agent message from')) {
    return text.includes(KID)
      ? repl('await agentMessage.send("kid report", { receiverRole: "parent", mode: "auto" }); "sent"')
      : { kind: 'text', text: 'root continuation', finish: 'stop' }
  }
  if (text.includes(GRAND)) return repl('await agentMessage.send("grand report", { receiverRole: "parent", mode: "auto" }); "sent"')
  if (text.includes(KID)) return repl(`await rlm(${JSON.stringify(GRAND)}, { name: "grand" }); "spawned"`)
  return repl(`await rlm(${JSON.stringify(KID)}, { name: "kid" }); "spawned"`)
}

function graph(workspace: string): LogicalTaskGraphV1 {
  return {
    version: 1, title: 'keyless evaluation graph', workspace, maxParallel: 1, risk: 'low',
    nodes: [{
      id: 'rlm', title: 'Recursive node', task: ROOT, role: 'recursive synthesis', dependsOn: [],
      requiredForCompletion: true, capabilityRequirements: [], capabilityBudget: [],
      contextPolicy: { maxTokens: 4_096, allowedSourceKinds: ['intent', 'artifact', 'capsule'], unavailableSource: 'block' },
      effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
      approvedSecretRefs: [], readScopes: ['src'], writeScopes: [],
      acceptance: [{ id: 'done', description: 'operator completes', kind: 'operator-completed' }],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
      rlm: { mode: 'enabled', maxDepth: 2, maxChildren: 2, maxTurns: 4 },
    }],
  }
}

const execFileAsync = promisify(execFile)

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined
}

/** Stop one daemon this driver started, after checking from its pid file and its command line that it belongs to this home. */
async function stopOwnDaemon(pidFile: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(pidFile, 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false
    throw error
  }
  const pid = Number(text.trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`pid file ${pidFile} does not hold a pid`)
  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (codeOf(error) === 'ESRCH') return false
      throw error
    }
  }
  if (!alive()) return false
  const command = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], { timeout: PS_MS }).then(
    result => result.stdout,
    (error: unknown) => {
      if (codeOf(error) === 1) return ''
      throw error
    },
  )
  if (command === '') return false
  if (!command.includes(isolatedHome)) throw new Error(`pid ${String(pid)} from ${pidFile} does not belong to this run`)
  process.kill(pid, 'SIGTERM')
  const limit = Date.now() + 4_000
  while (alive() && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 50))
  if (alive()) {
    process.kill(pid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (alive()) throw new Error(`pid ${String(pid)} from ${pidFile} is still running after SIGKILL`)
  return true
}

interface Attempt {
  readonly id?: string
  readonly state: string
  readonly label: string
  readonly bodySha256: string
  readonly bodyBytes: number
  readonly reservedOutput: number
  readonly refusal?: string
}

type Booted = Awaited<ReturnType<typeof boot>>
const owned: { fake?: Promise<FakeDeepSeek>; booted?: Promise<Booted>; service?: Booted['orchestrations'] } = {}

// Requests whose wait was abandoned keep running inside the client; one of them may still be starting a daemon.
const inflight = new Set<Promise<unknown>>()
function track<T>(work: Promise<T>): Promise<T> {
  inflight.add(work)
  const forget = (): void => { inflight.delete(work) }
  work.then(forget, forget)
  return work
}

// Set when cleanup starts: abandoned code that wakes up later cannot start a new request, so nothing can begin after the
// in-flight set was read.
let closing = false

function service(): Booted['orchestrations'] {
  if (closing) throw new Error('the driver is cleaning up; no new request may start')
  if (owned.service === undefined) throw new Error('the orchestration service is not booted')
  return owned.service
}

/** One client request, bounded by `limitMs` (RPC_MS unless the caller says otherwise) and by the end of the caller's stage. */
function rpc<T>(label: string, work: Promise<T>, until: number, limitMs = RPC_MS): Promise<T> {
  return within(`request ${label}`, track(work), Math.min(limitMs, until - Date.now()))
}
const failures: string[] = []
let bodyError: unknown
let transcript: unknown

try {
  const root = join(isolatedHome, 'orchestrations')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'evaluation-scope.json'), JSON.stringify({
    version: 1, scopeId: 'keyless-eval', model: 'deepseek-v4-flash', inputBound: 'request-bytes-audited',
    limits: {
      inputTokens: 5_000_000, outputTokens: 5_000_000, httpAttempts: ADMITTED_LIMIT, concurrentRequests: 8, maxOutputTokensPerRequest: 100,
    },
    generation: { thinking: 'enabled', reasoningEffort: 'high' },
  }))
  owned.fake = startFakeDeepSeek(handle)
  const fake = await within('fake DeepSeek start', owned.fake, FAKE_MS)
  process.env.DEEPSEEK_BASE_URL = fake.baseURL
  owned.booted = boot('prime-rlm-evaluation-keyless', resolveConfigPath(configPath, undefined))
  owned.service = (await within('boot', owned.booted, BOOT_MS)).orchestrations

  const until = Date.now() + DAEMON_MS
  let slowStarted = false
  for (;;) {
    try {
      // slow-start: the first request reaches the client just before the stage limit, as a late start would.
      if (fault === 'slow-start' && !slowStarted) {
        slowStarted = true
        await new Promise(resolve => setTimeout(resolve, DAEMON_MS - 100))
      }
      // The first request starts the daemon, so it may take the whole stage; later requests are bounded by RPC_MS.
      await rpc('list', service().list(), until, DAEMON_MS)
      break
    } catch (error) {
      if (error instanceof DeadlineError || Date.now() >= until) throw error
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  const workspace = join(isolatedHome, 'workspace')
  await mkdir(workspace, { recursive: true })
  const runUntil = Date.now() + RUN_MS
  const compilation = await rpc('compile', service().compile({
    intent: { request: 'evaluation scope' },
    admission: { policy: 'codex', route: 'taskgraph', sourceSessionId: 'evaluation', rlm: 'enabled', continualHarness: 'off', optimization: 'balanced' },
    graph: graph(workspace),
  }), runUntil)
  const started = await rpc(
    'start', service().start({ commandId: `start:${compilation.compilationId}`, compilationId: compilation.compilationId }), runUntil,
  )
  const limit = runUntil
  for (;;) {
    const snapshot = await rpc('inspect', service().inspect(started.runId), runUntil)
    if (['completed', 'failed'].includes(snapshot.state)) break
    if (Date.now() >= limit) throw new Error(`the run did not settle within ${String(RUN_MS)} ms (state ${snapshot.state})`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  const ledger = JSON.parse(await readFile(join(root, 'evaluation-ledger.json'), 'utf8')) as { attempts: Attempt[] }
  const admitted = ledger.attempts.filter(attempt => attempt.state !== 'refused')
  const received = fake.raw.map(({ body, ordinal, sha256 }) => ({ ordinal, sha256, bytes: Buffer.byteLength(body, 'utf8'), parsed: JSON.parse(body) as {
    model: string
    max_tokens: number
    thinking: { type: string }
    reasoning_effort: string
  } }))
  const hashes = admitted.map(attempt => attempt.bodySha256).sort()
  // When asked, write what an auditor can reconcile by hand: each received request with the ledger attempt it joins to and the
  // session that sent it, the final ledger, the sessions of the run, and the outbound counts. The transcript below stays
  // order-insensitive; these files are not part of the snapshot.
  const evidenceDirectory = process.env.DSH_EVALUATION_EVIDENCE_DIR
  if (evidenceDirectory !== undefined) {
    const runtime = JSON.parse(await readFile(join(root, 'rlm-runtime', 'state.json'), 'utf8')) as {
      sessions: { snapshot: { sessionId: string; parentSessionId?: string; depth: number } }[]
    }
    const tree = runtime.sessions.map(entry => ({
      sessionId: entry.snapshot.sessionId, parentSessionId: entry.snapshot.parentSessionId ?? null, depth: entry.snapshot.depth,
    }))
    await mkdir(evidenceDirectory, { recursive: true })
    const rows = received.map((request, index) => {
      const attempt = admitted.find(value => value.bodySha256 === request.sha256)
      const session = attempt?.label.split('@').at(1)
      return {
        index, sha256: request.sha256, bytes: request.bytes, ...request.parsed,
        ledgerAttemptId: (attempt as unknown as { id?: string } | undefined)?.id, label: attempt?.label,
        session, depth: tree.find(entry => entry.sessionId === session)?.depth,
      }
    })
    await writeFile(join(evidenceDirectory, 'received-requests.json'), `${JSON.stringify(rows, null, 2)}\n`)
    await writeFile(join(evidenceDirectory, 'ledger-final.json'), `${JSON.stringify(ledger, null, 2)}\n`)
    await writeFile(join(evidenceDirectory, 'sessions.json'), `${JSON.stringify(tree, null, 2)}\n`)
    await writeFile(join(evidenceDirectory, 'outbound.json'), `${JSON.stringify({
      endpointOrigin: new URL(fake.baseURL).origin,
      requestsReceivedByEndpoint: received.length,
      admittedAttempts: admitted.length,
      refusedAttempts: ledger.attempts.length - admitted.length,
      refusals: ledger.attempts.filter(attempt => attempt.state === 'refused').map(attempt => ({ label: attempt.label, reason: attempt.refusal })),
      note: 'Production daemon process started by the Loader client; its only endpoint is the loopback server and its credential is a fixture value. This process cannot see the daemon\'s own fetches.',
    }, null, 2)}\n`)
  }
  // Order-insensitive: the concurrent requests of a tree do not arrive in a fixed sequence.
  const unique = <T>(values: readonly T[]): T[] => [...new Set(values)].sort()
  transcript = {
    scope: { httpAttempts: ADMITTED_LIMIT, maxOutputTokensPerRequest: 100, inputBound: 'request-bytes-audited' },
    outboundRequests: received.length,
    admittedAttempts: admitted.length,
    everyRequestJoinsOneAdmittedAttempt: JSON.stringify(received.map(request => request.sha256).sort()) === JSON.stringify(hashes)
      && new Set(hashes).size === hashes.length,
    everyBodyLengthMatches: received.every(request => admitted.some(
      attempt => attempt.bodySha256 === request.sha256 && attempt.bodyBytes === request.bytes,
    )),
    attemptStates: unique(admitted.map(attempt => attempt.state)),
    refusals: unique(ledger.attempts.filter(attempt => attempt.state === 'refused').map(attempt => attempt.refusal)),
    wire: {
      models: unique(received.map(request => request.parsed.model)),
      maxTokens: unique(received.map(request => request.parsed.max_tokens)),
      thinking: unique(received.map(request => request.parsed.thinking.type)),
      reasoningEffort: unique(received.map(request => request.parsed.reasoning_effort)),
    },
    requestsByKind: {
      rootTurns: admitted.filter(attempt => attempt.label.includes(':rlm:root#')).length > 0,
      continuations: admitted.filter(attempt => attempt.label.includes(':deliver#')).length > 0,
      children: admitted.filter(attempt => !attempt.label.includes(':rlm:root#') && !attempt.label.includes(':deliver#')).length > 0,
    },
  }
} catch (error) {
  bodyError = error
} finally {
  closing = true
  const step = async (name: string, work: () => Promise<unknown>, limitMs: number): Promise<void> => {
    try {
      await within(`cleanup ${name}`, work(), limitMs)
      process.stderr.write(`cleanup ${name}: ok\n`)
    } catch (error) {
      const message = `cleanup ${name}: FAILED ${error instanceof Error ? error.message : String(error)}`
      failures.push(message)
      process.stderr.write(`${message}\n`)
    }
  }
  // Abandoned requests may still be starting a daemon; give them a bounded chance to finish so its pid file exists.
  await step('settle abandoned requests', async () => { await Promise.allSettled([...inflight]) }, INFLIGHT_MS)
  await step('dispose Loader context', async () => {
    const booted = owned.booted === undefined ? undefined : await owned.booted.then(context => context, () => undefined)
    await booted?.fiber.dispose()
  }, DISPOSE_MS)
  const stopBoth = async (suffix: string): Promise<void> => {
    await step(`stop orchestration daemon${suffix}`, async () => { await stopOwnDaemon(join(isolatedHome, 'orchestrations', 'daemon.pid')) }, DAEMON_STOP_MS)
    await step(`stop Resident daemon${suffix}`, async () => { await stopOwnDaemon(join(isolatedHome, 'resident-operators', 'daemon.pid')) }, DAEMON_STOP_MS)
  }
  await stopBoth('')
  await step('close fake DeepSeek', async () => { await (await owned.fake)?.close() }, FAKE_CLOSE_MS)
  // The orchestration daemon may have started the Resident daemon just before it was stopped; look once more.
  await new Promise(resolve => setTimeout(resolve, LATE_SWEEP_PAUSE_MS))
  await stopBoth(' (late sweep)')
}

if (bodyError !== undefined || failures.length > 0 || transcript === undefined) {
  const reason = bodyError === undefined ? 'cleanup failed' : bodyError instanceof Error ? bodyError.message : JSON.stringify(bodyError)
  process.stderr.write(`prime-rlm-evaluation failed: ${reason}\n`, () => { process.exit(1) })
} else {
  process.stdout.write(`${JSON.stringify({ ...transcript as object, daemonsStopped: true }, null, 2)}\n`, () => { process.exit(0) })
}
