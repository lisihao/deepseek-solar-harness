#!/usr/bin/env node
/**
 * Emit a keyless transcript of the terminal state of an RLM run whose message continuation or root did not succeed.
 *
 * Composition: the production app boot and YAML Loader assemble the orchestration client (`autoStart: true`), and the client
 * starts the production daemon entry (`startup`) and the Resident daemon it needs, exactly as the Desktop does. Only the
 * model provider is replaced: `DEEPSEEK_BASE_URL` points the shipping DeepSeek adapter and model worker at a loopback server
 * that answers from the request, so the real client protocol, daemon, model-tool bridge, and RLM runtime run without a network
 * or an API key. The daemons are detached; this driver stops only the two it started and checks their identity first.
 * It relies on `ps` and POSIX signals and is run on macOS and Linux; CI runs the snapshot suite only in its Linux job.
 *
 * Every wait is bounded here, not by the client: the shipping client has no response limit once a request is connected, so a
 * request that never returns would otherwise hold the driver until the launcher's SIGKILL, which skips cleanup and leaves the
 * detached daemons running. Each resource is covered by the outer try/finally from the moment it is created, and each cleanup
 * step is attempted on its own with its own limit.
 *
 * `DSH_TERMINAL_FIXTURE_FAULT` is read only by the fault tests of this fixture; it is ignored when unset.
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { LogicalTaskGraphV1, OrchestrationRunId } from '@deepseek-ai/dsh-orchestration'
import { messageText, startFakeDeepSeek, type FakeDeepSeek, type FakeMessage, type FakeReply } from './fake-deepseek.ts'

const configPath = process.argv[2]
const home = process.env.DSH_HOME
if (configPath === undefined || home === undefined) {
  throw new Error('prime-rlm-terminal fixture requires a config path and an isolated DSH_HOME')
}
const isolatedHome: string = home

// Everything the detached daemons inherit is set here, overwriting the caller's values: no real key, no real HOME, and a PATH
// without the native CLIs, so no Resident operator can qualify and the API worker is the only one offered.
process.env.HOME = isolatedHome
process.env.PATH = '/usr/bin:/bin'
process.env.DEEPSEEK_API_KEY = 'fixture-not-a-key'

type Kind = 'root' | 'child' | 'deliver' | 'goal continuation' | 'later turn'
const KINDS: readonly Kind[] = ['root', 'child', 'deliver', 'goal continuation', 'later turn']

interface Scenario {
  readonly name: string
  readonly autonomous: boolean
}

// Worst case, with every limit used: the body fails no later than fake server 3 s + boot 12 s + daemons ready 12 s + two
// scenarios of 12 s = 51 s, and the cleanup then takes abandoned requests 5 s + dispose 3 s + two daemon stops of 8 s + fake
// close 2 s + late-sweep pause 0.7 s + two more stops of 8 s = 42.7 s, 93.7 s in all. The test passes a 100 s process limit, so
// even that case has reported its stage and finished its cleanup before the launcher's SIGKILL; a normal failure needs about
// 10 s of cleanup. A stage waits at most STAGE_MS and one request at most RPC_MS.
const FAKE_MS = 3_000
const BOOT_MS = 12_000
const DAEMON_MS = 12_000
const SCENARIO_MS = 12_000
const STAGE_MS = 8_000
const RPC_MS = 5_000
const DIAGNOSTIC_MS = 2_000
const DISPOSE_MS = 3_000
const DAEMON_STOP_MS = 8_000
const FAKE_CLOSE_MS = 2_000
const INFLIGHT_MS = 5_000
const LATE_SWEEP_PAUSE_MS = 700
const PS_MS = 2_000

const fault = process.env.DSH_TERMINAL_FIXTURE_FAULT
const never = <T>(): Promise<T> => new Promise<T>(() => undefined)

/** A wait that ran out of time, as opposed to the awaited work failing. */
class DeadlineError extends Error {}

/**
 * Race one piece of work against a limit. The work keeps running when it loses, but its result is only observed here, the
 * timer is cleared on either outcome, and the timer never keeps the process alive.
 */
function within<T>(label: string, work: Promise<T>, limitMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const message = `${label} did not return within ${String(Math.round(limitMs))} ms`
    const timer = setTimeout(() => { reject(new DeadlineError(message)) }, Math.max(1, limitMs))
    timer.unref()
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(JSON.stringify(error))) },
    )
  })
}

type Booted = Awaited<ReturnType<typeof boot>>

const counts = new Map<Kind, number>()
let current: Scenario | undefined

function classify(text: string, scenario: Scenario): Kind {
  if (text.includes('Agent message from')) return 'deliver'
  if (text.includes('finish the objective')) return 'goal continuation'
  if (text.includes('child evidence') && !text.includes(scenario.name)) return 'child'
  if (text.includes(scenario.name)) return 'root'
  return 'later turn'
}

function reply(kind: Kind, scenario: Scenario): FakeReply {
  if (scenario.autonomous) {
    // The root stops at its token limit with partial text; a later Autonomous round, if one starts, would succeed.
    return kind === 'root'
      ? { kind: 'text', text: 'partial root answer', finish: 'length' }
      : { kind: 'text', text: 'later turn answer', finish: 'stop' }
  }
  switch (kind) {
    case 'root':
      return {
        kind: 'tool',
        name: 'typescript_repl',
        arguments: JSON.stringify({
          code: 'await rlm("child evidence", { name: "evidence" }); await goal.create("finish the objective", { continuationBudget: 2 }); "ok"',
        }),
      }
    case 'child':
      return {
        kind: 'tool',
        name: 'typescript_repl',
        arguments: JSON.stringify({ code: 'await agentMessage.send("child evidence", { receiverRole: "parent", mode: "auto" }); "sent"' }),
      }
    case 'deliver':
      // The message continuation of the root stops at its token limit with partial text.
      return { kind: 'text', text: 'partial continuation', finish: 'length' }
    case 'goal continuation':
      return { kind: 'tool', name: 'typescript_repl', arguments: JSON.stringify({ code: 'await goal.complete(); "goal complete"' }) }
    case 'later turn':
      throw new Error('unexpected request outside the scripted turns')
  }
}

function handle(messages: readonly FakeMessage[]): FakeReply {
  const last = messages.at(-1)
  if (last === undefined) throw new Error('fake DeepSeek received a request without messages')
  // The round after a tool call ends the turn.
  if (last.role === 'tool') return { kind: 'text', text: 'done', finish: 'stop' }
  if (current === undefined) throw new Error('fake DeepSeek received a request between scenarios')
  const text = messageText(last)
  const kind = classify(text, current)
  counts.set(kind, (counts.get(kind) ?? 0) + 1)
  try {
    return reply(kind, current)
  } catch (error) {
    throw new Error(`${(error as Error).message}: ${text.slice(0, 160)}`, { cause: error })
  }
}

function graph(workspace: string, scenario: Scenario): LogicalTaskGraphV1 {
  return {
    version: 1, title: 'keyless terminal graph', workspace, maxParallel: 1, risk: 'low',
    nodes: [{
      id: 'rlm', title: 'Recursive node', task: `Run scenario ${scenario.name}.`, role: 'recursive synthesis', dependsOn: [],
      requiredForCompletion: true, capabilityRequirements: [], capabilityBudget: [],
      contextPolicy: { maxTokens: 4_096, allowedSourceKinds: ['intent', 'artifact', 'capsule'], unavailableSource: 'block' },
      effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
      approvedSecretRefs: [], readScopes: ['src'], writeScopes: [],
      acceptance: [{ id: 'done', description: 'operator completes', kind: 'operator-completed' }],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
      ...scenario.autonomous
        ? {
          rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 2, maxTurns: 4 },
          // Only the built-in acceptance check: the production daemon takes no custom evaluators.
          autonomous: {
            mode: 'enabled', maxContinuations: 2,
            endCondition: { version: 1, operator: 'all', checks: [{ id: 'completed', kind: 'acceptance', ref: 'done' }] },
          },
        }
        : {},
    }],
  }
}

const execFileAsync = promisify(execFile)

/** The errno code of a failure, when it has one. */
function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined
}

/**
 * Stop one daemon this driver started, after checking from its pid file and its command line that it is ours. Only a missing
 * pid file (ENOENT) and a missing process (ESRCH) mean "nothing to stop"; every other failure is kept and reported.
 * @param pidFile - the pid file inside the isolated home.
 * @returns whether a daemon was found and stopped (`false` when there was none).
 */
async function stopOwnDaemon(pidFile: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(pidFile, 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false
    throw error
  }
  const pid = Number(text.trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`pid file ${pidFile} does not hold a pid: ${JSON.stringify(text.slice(0, 40))}`)
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
  // `ps` exits with 1 and no output when the process is gone; a timeout or a missing `ps` is not that and is kept.
  const command = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], { timeout: PS_MS }).then(
    result => result.stdout,
    (error: unknown) => {
      if (codeOf(error) === 1) return ''
      throw error
    },
  )
  if (command === '') return false
  // A pid that does not name this isolated home belongs to someone else and is never signalled.
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

// What the outer try/finally owns. A promise is kept, not just its value, so a resource that arrives after its wait was
// abandoned is still disposed.
const owned: { fake?: Promise<FakeDeepSeek>; booted?: Promise<Booted>; service?: Booted['orchestrations'] } = {}

// Requests whose wait was abandoned keep running inside the client; one of them may still be starting a daemon.
const inflight = new Set<Promise<unknown>>()
function track<T>(work: Promise<T>): Promise<T> {
  inflight.add(work)
  const forget = (): void => { inflight.delete(work) }
  work.then(forget, forget)
  return work
}

function service(): Booted['orchestrations'] {
  if (owned.service === undefined) throw new Error('the orchestration service is not booted')
  return owned.service
}

/** One client request, bounded by RPC_MS and by the end of the caller's scenario. */
function rpc<T>(label: string, work: Promise<T>, until: number): Promise<T> {
  return within(`request ${label}`, track(work), Math.min(RPC_MS, until - Date.now()))
}

/** Waits for one named condition and fails with the stage and the last observed state, never silently. */
async function waitFor(
  scenario: string,
  stage: string,
  ready: () => boolean | Promise<boolean>,
  observed: () => string | Promise<string>,
  limitMs: number,
  until: number,
): Promise<void> {
  const limit = Math.min(Date.now() + limitMs, until)
  for (;;) {
    let isReady = false
    try {
      // A check that never returns must not outlast the stage either.
      isReady = await within(`${stage} check`, Promise.resolve(ready()), limit - Date.now())
    } catch (error) {
      if (!(error instanceof DeadlineError)) throw error
    }
    if (isReady) return
    if (Date.now() >= limit) {
      const state = await within('diagnostic', Promise.resolve(observed()), DIAGNOSTIC_MS)
        .catch(() => 'run state unavailable: the diagnostic read did not return')
      throw new Error(`${scenario}: stage "${stage}" did not happen in time; ${state}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function run(scenario: Scenario) {
  const workspace = join(isolatedHome, `workspace-${scenario.name}`)
  await mkdir(workspace, { recursive: true })
  counts.clear()
  current = scenario
  const until = Date.now() + SCENARIO_MS
  const progress: { runId?: OrchestrationRunId } = {}
  type Snapshot = Awaited<ReturnType<Booted['orchestrations']['inspect']>>
  const inspect = (runId: OrchestrationRunId): Promise<Snapshot> => (fault === 'hang-inspect' ? never<Snapshot>() : track(service().inspect(runId)))
  const observed = async (): Promise<string> => {
    const requests = JSON.stringify(Object.fromEntries(KINDS.map(kind => [kind, counts.get(kind) ?? 0])))
    const snapshot = progress.runId === undefined ? undefined : await inspect(progress.runId)
    const runState = snapshot === undefined ? 'not started' : `${snapshot.state}, node ${String(snapshot.nodes[0]?.state)}`
    return `requests ${requests}; run ${runState}`
  }
  const compilation = await rpc('compile', service().compile({
    intent: { request: scenario.name },
    admission: {
      policy: 'codex', route: 'taskgraph', sourceSessionId: scenario.name, rlm: 'enabled', continualHarness: 'off', optimization: 'balanced',
    },
    graph: graph(workspace, scenario),
  }), until)
  const started = await rpc('start', fault === 'hang-start'
    ? never<Awaited<ReturnType<Booted['orchestrations']['start']>>>()
    : service().start({ commandId: `start:${compilation.compilationId}`, compilationId: compilation.compilationId }), until)
  progress.runId = started.runId
  await waitFor(scenario.name, 'root request', () => (counts.get('root') ?? 0) > 0, observed, STAGE_MS, until)
  if (!scenario.autonomous) {
    await waitFor(scenario.name, 'message continuation', () => (counts.get('deliver') ?? 0) > 0, observed, STAGE_MS, until)
  }
  const settled: { state?: Snapshot } = {}
  await waitFor(scenario.name, 'settle', async () => {
    settled.state = await inspect(started.runId)
    return ['completed', 'failed'].includes(settled.state.state)
  }, observed, STAGE_MS, until)
  const state = settled.state
  if (state === undefined) throw new Error(`${scenario.name}: the run was never observed`)
  const events = (await rpc('readEvents', service().readEvents({ runId: started.runId, limit: 400 }), until)).events
  return {
    run: state.state,
    node: state.nodes[0]?.state,
    stopReasons: events.filter(event => event.type === 'rlm.execution.settled').map(event => event.data.stopReason),
    continuations: events.filter(event => event.type.startsWith('rlm.message.continuation.')).map(event => event.type),
    // Counts, not an order: the concurrent root, child, and continuation calls do not arrive in a fixed sequence.
    requests: Object.fromEntries(KINDS.map(kind => [kind, counts.get(kind) ?? 0])),
  }
}

const failures: string[] = []
let slowStarted = false
let bodyError: unknown
let transcript: { readonly goal: unknown; readonly autonomous: unknown } | undefined

try {
  owned.fake = startFakeDeepSeek(handle)
  const fake = await within('fake DeepSeek start', owned.fake, FAKE_MS)
  process.env.DEEPSEEK_BASE_URL = fake.baseURL
  if (fault === 'bad-pid-file') await mkdir(join(isolatedHome, 'orchestrations', 'daemon.pid'), { recursive: true })
  const target = fault === 'fail-boot' || fault === 'bad-pid-file' ? join(isolatedHome, 'missing-cordis.yml') : configPath
  owned.booted = boot('prime-rlm-terminal-keyless', resolveConfigPath(target, undefined))
  owned.service = (await within('boot', owned.booted, BOOT_MS)).orchestrations

  await waitFor('startup', 'daemon ready', async () => {
    try {
      // slow-start: the first request reaches the client just before the stage limit, as a late start would.
      if (fault === 'slow-start' && !slowStarted) {
        slowStarted = true
        await new Promise(resolve => setTimeout(resolve, DAEMON_MS - 100))
      }
      await rpc('list', service().list(), Date.now() + DAEMON_MS)
      return true
    } catch (error) {
      if (error instanceof DeadlineError) throw error
      // The client reports a connection error until the daemon it started is listening; the stage limit bounds the retries.
      return false
    }
  }, () => 'the orchestration daemon did not answer', DAEMON_MS, Date.now() + DAEMON_MS)

  // The root completes, a child's parent message makes the daemon continue the root, that continuation stops at its token
  // limit, and the root has an active goal whose next turn would succeed.
  const goal = await run({ name: 'goal-after-failed-message', autonomous: false })

  // Autonomous Mode with an end condition that a later round would satisfy, after a root that stopped at its token limit.
  const autonomous = await run({ name: 'autonomous-after-token-limit', autonomous: true })
  transcript = { goal, autonomous }
} catch (error) {
  bodyError = error
} finally {
  current = undefined
  // Every step is attempted whatever happened before it, with its own limit; each outcome is reported on stderr.
  const step = async (name: string, work: () => Promise<unknown>, limitMs: number): Promise<boolean> => {
    try {
      await within(`cleanup ${name}`, work(), limitMs)
      process.stderr.write(`cleanup ${name}: ok\n`)
      return true
    } catch (error) {
      const message = `cleanup ${name}: FAILED ${error instanceof Error ? error.message : String(error)}`
      failures.push(message)
      process.stderr.write(`${message}\n`)
      return false
    }
  }
  // Abandoned requests may still be starting a daemon; give them a bounded chance to finish so its pid file exists.
  await step('settle abandoned requests', async () => { await Promise.allSettled([...inflight]) }, INFLIGHT_MS)
  await step('dispose Loader context', async () => {
    // A boot that lost its wait may still resolve; a boot that rejected left nothing to dispose.
    const booted = owned.booted === undefined ? undefined : await owned.booted.then(context => context, () => undefined)
    await booted?.fiber.dispose()
    if (fault === 'fail-dispose') throw new Error('injected dispose failure')
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

// Nothing is printed as a transcript unless the body and every cleanup step succeeded, so a partial cleanup cannot pass.
if (bodyError !== undefined || failures.length > 0 || transcript === undefined) {
  const reason = bodyError === undefined ? 'cleanup failed' : bodyError instanceof Error ? bodyError.message : JSON.stringify(bodyError)
  process.stderr.write(`prime-rlm-terminal failed: ${reason}\n`, () => { process.exit(1) })
} else {
  // Exit explicitly: a request that never returned can keep the event loop alive after cleanup.
  process.stdout.write(`${JSON.stringify({ ...transcript, daemonsStopped: true }, null, 2)}\n`, () => { process.exit(0) })
}
