#!/usr/bin/env node
/**
 * Emit a keyless transcript of the terminal state of an RLM run whose message continuation or root did not succeed.
 *
 * Composition: the production app boot and YAML Loader assemble the orchestration client (`autoStart: true`), and the client
 * starts the production daemon entry (`startup`) and the Resident daemon it needs, exactly as the Desktop does. Only the
 * model provider is replaced: `DEEPSEEK_BASE_URL` points the shipping DeepSeek adapter and model worker at a loopback server
 * that answers from the request, so the real client protocol, daemon, model-tool bridge, and RLM runtime run without a network
 * or an API key. The daemons are detached; this driver stops only the two it started and checks their identity first.
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { LogicalTaskGraphV1, OrchestrationRunId } from '@deepseek-ai/dsh-orchestration'
import { messageText, startFakeDeepSeek, type FakeMessage, type FakeReply } from './fake-deepseek.ts'

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

// Each stage waits at most STAGE_MS, a scenario at most SCENARIO_MS, and the daemons at most DAEMON_MS. The test passes a 60 s
// process limit, so the driver reports a stuck stage and still reaches its cleanup before the launcher's SIGKILL.
const DAEMON_MS = 15_000
const STAGE_MS = 8_000
const SCENARIO_MS = 15_000

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

/** Stop one daemon this driver started, after checking from its pid file and its command line that it is ours. */
async function stopOwnDaemon(pidFile: string): Promise<boolean> {
  let pid: number
  try {
    pid = Number((await readFile(pidFile, 'utf8')).trim())
  } catch {
    // No pid file means this daemon never started, so there is nothing to stop.
    return true
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      // Signal 0 fails with ESRCH once the process is gone.
      return false
    }
  }
  if (!alive()) return true
  const command = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)]).then(result => result.stdout, () => '')
  // A pid that does not name this isolated home belongs to someone else and is never signalled.
  if (!command.includes(isolatedHome)) return false
  process.kill(pid, 'SIGTERM')
  const limit = Date.now() + 5_000
  while (alive() && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 50))
  if (alive()) {
    process.kill(pid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return !alive()
}

const fake = await startFakeDeepSeek(handle)
process.env.DEEPSEEK_BASE_URL = fake.baseURL
const ctx = await boot('prime-rlm-terminal-keyless', resolveConfigPath(configPath, undefined))
const orchestration = ctx.orchestrations

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
  while (!await ready()) {
    if (Date.now() >= limit) throw new Error(`${scenario}: stage "${stage}" did not happen in time; ${await observed()}`)
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
  const observed = async (): Promise<string> => {
    const snapshot = progress.runId === undefined ? undefined : await orchestration.inspect(progress.runId)
    const runState = snapshot === undefined ? 'not started' : `${snapshot.state}, node ${String(snapshot.nodes[0]?.state)}`
    return `requests ${JSON.stringify(Object.fromEntries(KINDS.map(kind => [kind, counts.get(kind) ?? 0])))}; run ${runState}`
  }
  const compilation = await orchestration.compile({
    intent: { request: scenario.name },
    admission: {
      policy: 'codex', route: 'taskgraph', sourceSessionId: scenario.name, rlm: 'enabled', continualHarness: 'off', optimization: 'balanced',
    },
    graph: graph(workspace, scenario),
  })
  const started = await orchestration.start({ commandId: `start:${compilation.compilationId}`, compilationId: compilation.compilationId })
  progress.runId = started.runId
  await waitFor(scenario.name, 'root request', () => (counts.get('root') ?? 0) > 0, observed, STAGE_MS, until)
  if (!scenario.autonomous) {
    await waitFor(scenario.name, 'message continuation', () => (counts.get('deliver') ?? 0) > 0, observed, STAGE_MS, until)
  }
  let state = await orchestration.inspect(started.runId)
  await waitFor(scenario.name, 'settle', async () => {
    state = await orchestration.inspect(started.runId)
    return ['completed', 'failed'].includes(state.state)
  }, observed, STAGE_MS, until)
  const events = (await orchestration.readEvents({ runId: started.runId, limit: 400 })).events
  return {
    run: state.state,
    node: state.nodes[0]?.state,
    stopReasons: events.filter(event => event.type === 'rlm.execution.settled').map(event => event.data.stopReason),
    continuations: events.filter(event => event.type.startsWith('rlm.message.continuation.')).map(event => event.type),
    // Counts, not an order: the concurrent root, child, and continuation calls do not arrive in a fixed sequence.
    requests: Object.fromEntries(KINDS.map(kind => [kind, counts.get(kind) ?? 0])),
  }
}

let transcript: { readonly goal: unknown; readonly autonomous: unknown } | undefined
try {
  await waitFor('startup', 'daemon ready', async () => {
    try {
      await orchestration.list()
      return true
    } catch {
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
} finally {
  current = undefined
  await ctx.fiber.dispose()
  const stopped = [
    await stopOwnDaemon(join(isolatedHome, 'orchestrations', 'daemon.pid')),
    await stopOwnDaemon(join(isolatedHome, 'resident-operators', 'daemon.pid')),
  ]
  await fake.close()
  if (transcript !== undefined) {
    process.stdout.write(`${JSON.stringify({ ...transcript, daemonsStopped: stopped.every(Boolean) }, null, 2)}\n`)
  }
}
