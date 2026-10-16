#!/usr/bin/env node
/**
 * Emit a keyless transcript of the terminal state of an RLM run whose message continuation or root did not succeed, and of what
 * the model is given in each message continuation of a successful one.
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
 * The `batched-messages` scenario shows what messages queued together become: its two children report before the root's turn
 * ends, so the root is continued once, for both messages, under one worker command. The transcript holds the prompt that
 * continuation was given, the delivered and terminal events of both messages, and the usage the run recorded for that command.
 *
 * The `context-capture` scenario records every request the shipping worker sent for a root, one child, and the root's message
 * continuation: what each was given, whether a marker that only the root's task carries reaches the child (in its request and in
 * the `context` its REPL shows), and whether the last line of each task reaches the model. Each request is tied to the
 * production session and command it was sent for through the tool-call ids and the runtime's receipts; a request that cannot be
 * tied to exactly one dispatch fails the scenario. With `DSH_REQUEST_CAPTURE_DIR` set it also writes there the raw requests with
 * their digests and arrival order, the correlation, and the projection used for the snapshot, for a before and after
 * comparison; nothing else reads that variable.
 *
 * `DSH_TERMINAL_FIXTURE_FAULT` is read only by the fault tests of this fixture; it is ignored when unset.
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { OrchestrationArtifactRef, type LogicalTaskGraphV1, type OrchestrationRunId } from '@deepseek-ai/dsh-orchestration'
import { assertLossless, correlate, dispatchFacts, project, projectionSha256, Tokens, type CaptureWho } from './capture.ts'
import { messageText, startFakeDeepSeek, type FakeBody, type FakeDeepSeek, type FakeMessage, type FakeRawRequest, type FakeReply, type FakeUsage } from './fake-deepseek.ts'

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
  /** The `context-prompts` scenario: it captures the raw requests of the root's and a child's message continuations. */
  readonly context?: boolean
  /** The `batched-messages` scenario: two children report while the root's turn is still open. */
  readonly batch?: boolean
  /** The `context-capture` scenario: a root, one child, and a continuation, with every request recorded. */
  readonly capture?: boolean
}

// The tasks of the `context-prompts` scenario. The root's last sentence is the only statement of its output format.
const ROOT_TASK = 'Run scenario context-prompts. Final rule: reply with only {"verdict": "<text>"}.'
const ALPHA_TASK = 'Alpha task: report the alpha figure to your parent.'
const BETA_TASK = 'Beta task: report the beta figure to your parent.'

// The `batched-messages` scenario. The root's last sentence is the only statement of its output format.
const BATCH_ROOT_TASK = 'Run scenario batched-messages. Final rule: reply with only {"verdict": "<text>"}.'
const GAMMA_TASK = 'Gamma task: report the gamma figure to your parent.'
const DELTA_TASK = 'Delta task: report the delta figure to your parent.'
const EPSILON_TASK = 'Epsilon task: report the epsilon figure to your parent.'
const GAMMA_FIGURE = 'gamma figure is 3'
const DELTA_FIGURE = 'delta figure is 4'
const EPSILON_FIGURE = 'epsilon figure is 5'
/** Opens when the first child's message has been queued, so the second child's message is the second to arrive. */
const gammaReported = Promise.withResolvers<undefined>()
/** Opens when both children's messages have been queued, so the root's turn can end with both waiting. */
const bothReported = Promise.withResolvers<undefined>()
/** Opens when a third child's message has been queued while the batch is being continued, so a second continuation follows it. */
const epsilonReported = Promise.withResolvers<undefined>()
const batchChildrenDone = new Set<string>()
/**
 * The usage the fake reported for each tool round of the two continuations of the `batched-messages` scenario. `prompt` includes
 * the cache hits, as on the wire; the worker's records are compared with the sums of these.
 */
const BATCH_ROUNDS: Record<'batch' | 'single', readonly FakeUsage[]> = {
  batch: [
    { promptTokens: 1_000, completionTokens: 40, cacheHitTokens: 600 },
    { promptTokens: 1_200, completionTokens: 30, cacheHitTokens: 900 },
    { promptTokens: 1_500, completionTokens: 25, cacheHitTokens: 1_200 },
  ],
  single: [
    { promptTokens: 700, completionTokens: 20, cacheHitTokens: 100 },
    { promptTokens: 800, completionTokens: 15, cacheHitTokens: 500 },
  ],
}
/** The rounds the fake actually served, as `continuation` and the index of the round. */
const servedRounds: Array<{ readonly continuation: string; readonly round: number; readonly usage: FakeUsage }> = []
/** The raw prompts of the root's message continuations in the `batched-messages` scenario. */
const batchPrompts: string[] = []

// The `context-capture` scenario. A marker only the root's task carries, and a last line in each task that the model must see.
const CANARY = 'CANARY-ONLY-IN-THE-ROOT-TASK-7731'
const CAPTURE_ROOT_TAIL = 'Final rule: reply with only {"verdict": "<text>"}. ROOT-TAIL-RULE'
const CAPTURE_ROOT_TASK = `Run scenario context-capture. Private note for the root only: ${CANARY}. ${CAPTURE_ROOT_TAIL}`
const CHILD_TAIL = 'Final rule: end the report with the exact token CHILD-TAIL-RULE.'
// Long enough to cross any small cap on a task, with the only statement of the output rule on its last line.
const CAPTURE_CHILD_TASK = `Inspector task: read your context and report what it says. ${'Detail line of the inspector task. '.repeat(160)}${CHILD_TAIL}`
const CAPTURE_FIGURE = 'inspector figure is 6'
// The child's final answer: several segments long, with multi-byte characters, and a last line that must come back whole.
const RESULT_TAIL = 'END-OF-THE-CHILD-RESULT'
const CAPTURE_CHILD_ANSWER = `${'Result line with 漢字 and 😀 inside it. '.repeat(24)}${RESULT_TAIL}`
// What the root's continuation runs to read that answer from the stored result of its child, 300 code units at a time.
const READ_RESULT_CODE = [
  'const kid = (await rlm.listSubagents())[0];',
  'let offset = 0; let text = ""; const lengths = []; let fullSha256 = "";',
  'for (;;) {',
  '  const part = await rlm.readChildResult(kid, { offset, limit: 300 });',
  '  text += part.text; lengths.push(part.length); fullSha256 = part.fullSha256;',
  '  if (part.nextOffset === null) break;',
  '  offset = part.nextOffset;',
  '}',
  'JSON.stringify({ text, lengths, fullSha256 })',
].join('\n')
/** Opens when the child has sent its message, so the root's turn ends with that message waiting. */
const captureChildDone = Promise.withResolvers<undefined>()

/** The prompts the `context-prompts` scenario captured from the requests the daemon's model worker sent, by who received them. */
const captured: { rootContinuations: string[]; childContinuations: string[] } = { rootContinuations: [], childContinuations: [] }
const betaMayReport = Promise.withResolvers<undefined>()

// The bodies of the messages the scenario sends. They route the replies and tell who a continuation was for: a message to the
// root carries a child's figure, and the only message to a child carries the root's follow-up. The routing never reads the part
// of the prompt that is under test (the task, the names, and the roster).
const ALPHA_FIGURE = 'alpha figure is 1'
const BETA_FIGURE = 'beta figure is 2'
const FOLLOW_UP = 'check the figure again'

/** The task text a request carries: the daemon wraps every API prompt in a JSON envelope, and the model reads its `task`. */
function taskText(message: FakeMessage): string {
  const text = messageText(message)
  type Envelope = { readonly dshOperatorContextEnvelope: { readonly task: { readonly content: readonly { readonly text?: string }[] } } }
  return (JSON.parse(text) as Envelope).dshOperatorContextEnvelope.task.content.map(block => block.text ?? '').join('\n')
}

/**
 * Session ids differ in every run, and whether the cell that sent a message has returned when its receiver is told of it depends
 * on timing. So the session ids are replaced, and so is the state of exactly the agent that sent the message the prompt is for;
 * every other state in the roster is steady and stays.
 * @param prompt - the prompt as the worker received it.
 * @param sender - the roster entry of the agent whose message woke the session, as the roster prints it.
 */
function normalized(prompt: string, sender: string): string {
  return prompt
    .replaceAll(/rlm-session-[0-9a-f-]{36}|rlm:orch:run-[0-9a-f-]{36}:rlm:1/gu, '<session id>')
    .replace(new RegExp(`^- ${sender}: (running|idle)$`, 'mu'), `- ${sender}: <running or idle>`)
}

/** The body of the message a continuation was woken by: what follows its sender line, up to the statement of the facts. */
function messageBody(prompt: string): string {
  const start = prompt.indexOf('\n', prompt.indexOf('Agent message from')) + 1
  return prompt.slice(start, prompt.indexOf('\nUse typescript_repl for any state')).trim()
}

/**
 * Answers the requests of the `batched-messages` scenario. A child's second request is made after its cell ran, which is after its
 * message was queued; the root's turn is kept open until both children have made it, and the second child waits for the first.
 */
async function batchReply(messages: readonly FakeMessage[]): Promise<FakeReply> {
  const first = messages[0]
  if (first === undefined) throw new Error('fake DeepSeek received a request without messages')
  const text = taskText(first)
  const afterTool = messages.at(-1)?.role === 'tool'
  const round = messages.filter(message => message.role === 'tool').length
  const repl = (code: string, usage?: FakeUsage): FakeReply => ({ kind: 'tool', name: 'typescript_repl', arguments: JSON.stringify({ code }), ...usage === undefined ? {} : { usage } })
  const answer = (output: string, usage?: FakeUsage): FakeReply => ({ kind: 'text', text: output, finish: 'stop', ...usage === undefined ? {} : { usage } })
  if (text.includes('Agent message from')) {
    // The continuation of the root for gamma's and delta's messages is the only one that names both figures. It spawns a third
    // child in its first round and ends only once that child's message is queued, so a second continuation follows it.
    const together = text.includes(GAMMA_FIGURE) && text.includes(DELTA_FIGURE)
    const kind = together ? 'batch' : 'single'
    const usage = BATCH_ROUNDS[kind][round]
    if (usage === undefined) throw new Error(`unexpected round ${String(round)} of the ${kind} continuation`)
    servedRounds.push({ continuation: kind, round, usage })
    if (round === 0) {
      counts.set('deliver', (counts.get('deliver') ?? 0) + 1)
      batchPrompts.push(text)
    }
    if (together) {
      if (round === 0) return repl(`await rlm(${JSON.stringify(EPSILON_TASK)}, { name: "epsilon" }); "spawned epsilon"`, usage)
      if (round === 1) return repl('(await agentMessage.read()).length', usage)
      await epsilonReported.promise
      return answer('batched continuation output', usage)
    }
    return round === 0 ? repl('"checked"', usage) : answer('epsilon continuation output', usage)
  }
  if (text.includes(BATCH_ROOT_TASK)) {
    if (afterTool) {
      await bothReported.promise
      return answer('root turn ended')
    }
    counts.set('root', (counts.get('root') ?? 0) + 1)
    return repl(`const handles = [await rlm(${JSON.stringify(GAMMA_TASK)}, { name: "gamma" }), await rlm(${JSON.stringify(DELTA_TASK)}, { name: "delta" })]; "spawned"`)
  }
  const which = text.includes(EPSILON_TASK) ? 'epsilon' : text.includes(DELTA_TASK) ? 'delta' : 'gamma'
  if (afterTool) {
    if (which === 'epsilon') {
      epsilonReported.resolve(undefined)
      return answer('child done')
    }
    batchChildrenDone.add(which)
    if (which === 'gamma') gammaReported.resolve(undefined)
    if (batchChildrenDone.size === 2) bothReported.resolve(undefined)
    return answer('child done')
  }
  counts.set('child', (counts.get('child') ?? 0) + 1)
  if (which === 'delta') await gammaReported.promise
  const figure = which === 'epsilon' ? EPSILON_FIGURE : which === 'delta' ? DELTA_FIGURE : GAMMA_FIGURE
  return repl(`await agentMessage.send(${JSON.stringify(figure)}, { receiverRole: "parent", mode: "auto" }); "sent"`)
}

/**
 * Answers the requests of the `context-capture` scenario and records each body. The child's first round reads its own `context`;
 * the next request carries that value back as a tool result, which is how the scenario sees what the child's REPL showed.
 */
async function captureReply(messages: readonly FakeMessage[]): Promise<FakeReply> {
  const first = messages[0]
  if (first === undefined) throw new Error('fake DeepSeek received a request without messages')
  const text = taskText(first)
  const round = messages.filter(message => message.role === 'tool').length
  const repl = (code: string): FakeReply => ({ kind: 'tool', name: 'typescript_repl', arguments: JSON.stringify({ code }) })
  const answer = (output: string): FakeReply => ({ kind: 'text', text: output, finish: 'stop' })
  if (text.includes('Agent message from')) {
    if (round === 0) {
      counts.set('deliver', (counts.get('deliver') ?? 0) + 1)
      return repl(READ_RESULT_CODE)
    }
    return answer('capture continuation output')
  }
  if (text.includes(CAPTURE_ROOT_TASK)) {
    if (round > 0) {
      await captureChildDone.promise
      return answer('root turn ended')
    }
    counts.set('root', (counts.get('root') ?? 0) + 1)
    return repl(`const handle = await rlm(${JSON.stringify(CAPTURE_CHILD_TASK)}, { name: "inspector" }); "spawned"`)
  }
  if (round === 0) {
    counts.set('child', (counts.get('child') ?? 0) + 1)
    return repl('JSON.stringify(context)')
  }
  if (round === 1) {
    return repl(`await agentMessage.send(${JSON.stringify(CAPTURE_FIGURE)}, { receiverRole: "parent", mode: "auto" }); "sent"`)
  }
  captureChildDone.resolve(undefined)
  return answer(CAPTURE_CHILD_ANSWER)
}

/** Answers the requests of the `context-prompts` scenario from their content, and keeps the prompts it reports. */
async function contextReply(messages: readonly FakeMessage[]): Promise<FakeReply> {
  const first = messages[0]
  if (first === undefined) throw new Error('fake DeepSeek received a request without messages')
  const text = taskText(first)
  const afterTool = messages.at(-1)?.role === 'tool'
  const repl = (code: string): FakeReply => ({ kind: 'tool', name: 'typescript_repl', arguments: JSON.stringify({ code }) })
  const answer = (output: string): FakeReply => ({ kind: 'text', text: output, finish: 'stop' })
  if (text.includes('Agent message from')) {
    // A continuation. The follow-up goes to alpha; each child's figure goes to the root.
    if (messageBody(text) === FOLLOW_UP) {
      counts.set('deliver', (counts.get('deliver') ?? 0) + 1)
      captured.childContinuations.push(normalized(text, 'parent "root"'))
      return answer('child continuation output')
    }
    if (!afterTool) {
      counts.set('deliver', (counts.get('deliver') ?? 0) + 1)
      captured.rootContinuations.push(normalized(text, captured.rootContinuations.length === 0 ? 'child "alpha"' : 'child "beta"'))
      if (captured.rootContinuations.length === 1) betaMayReport.resolve(undefined)
    }
    if (captured.rootContinuations.length === 1) return answer('first continuation output')
    return afterTool
      ? answer('last continuation output')
      : repl(`await agentMessage.send(${JSON.stringify(FOLLOW_UP)}, { receiverRole: "child", receiverName: "alpha", mode: "follow_up" }); "asked"`)
  }
  if (afterTool) return answer('done')
  if (text.includes(ROOT_TASK)) {
    counts.set('root', (counts.get('root') ?? 0) + 1)
    return repl(`const handles = [await rlm(${JSON.stringify(ALPHA_TASK)}, { name: "alpha" }), await rlm(${JSON.stringify(BETA_TASK)}, { name: "beta" })]; "spawned"`)
  }
  // The first turn of a child: what it was spawned to do is its task.
  counts.set('child', (counts.get('child') ?? 0) + 1)
  const isBeta = text.includes(BETA_TASK)
  if (isBeta) await betaMayReport.promise
  return repl(`await agentMessage.send(${JSON.stringify(isBeta ? BETA_FIGURE : ALPHA_FIGURE)}, { receiverRole: "parent", mode: "auto" }); "sent"`)
}

// Timer budget, with every limit used: the body fails no later than fake server 3 s + boot 12 s + daemons ready 12 s + five
// scenarios of 12 s = 87 s, plus the diagnostic read of the failing stage, 2 s; the cleanup then takes abandoned requests 5 s +
// dispose 3 s + two daemon stops of 8 s + fake close 2 s + late-sweep pause 0.7 s + two more stops of 8 s = 42.7 s. That is
// 131.7 s of timers. It is a sum of limits, not an absolute bound: creating directories, loading modules, and scheduling are not
// in it. The test passes a 155 s process limit, which leaves room for them, and a 170 s per-test limit above it; a normal
// failure needs about 10 s of cleanup. A stage waits at most STAGE_MS and one request at most RPC_MS.
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

function handle(messages: readonly FakeMessage[]): FakeReply | Promise<FakeReply> {
  const last = messages.at(-1)
  if (last === undefined) throw new Error('fake DeepSeek received a request without messages')
  if (current?.context === true) return contextReply(messages)
  if (current?.batch === true) return batchReply(messages)
  if (current?.capture === true) return captureReply(messages)
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
      id: 'rlm', title: 'Recursive node', task: scenario.context === true ? ROOT_TASK : scenario.batch === true ? BATCH_ROOT_TASK : scenario.capture === true ? CAPTURE_ROOT_TASK : `Run scenario ${scenario.name}.`, role: 'recursive synthesis', dependsOn: [],
      requiredForCompletion: true, capabilityRequirements: [], capabilityBudget: [],
      contextPolicy: { maxTokens: 4_096, allowedSourceKinds: ['intent', 'artifact', 'capsule'], unavailableSource: 'block' },
      effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
      approvedSecretRefs: [], readScopes: ['src'], writeScopes: [],
      acceptance: [{ id: 'done', description: 'operator completes', kind: 'operator-completed' }],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
      ...scenario.batch === true
        ? { rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 3, maxTurns: 12 } }
        : scenario.capture === true
          ? { rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 1, maxTurns: 8 } }
          : scenario.autonomous || scenario.context === true ? { rlm: { mode: 'enabled', maxDepth: 1, maxChildren: 2, maxTurns: 4 } } : {},
      ...scenario.autonomous
        ? {
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

// Set when cleanup starts: abandoned code that wakes up later cannot start a new request, so nothing can begin after the
// in-flight set was read.
let closing = false

function service(): Booted['orchestrations'] {
  if (closing) throw new Error('the driver is cleaning up; no new request may start')
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

type RunEvents = Awaited<ReturnType<Booted['orchestrations']['readEvents']>>['events']

/** A request the capture tied to its dispatch, with its raw body parsed. */
interface FoundRequest {
  readonly who: CaptureWho
  readonly round: number
  readonly raw: FakeRawRequest
  readonly body: FakeBody
}

/** What the root's continuation read back from its child's stored result, taken from the tool result of its next request. */
function resultReadBack(found: readonly FoundRequest[]) {
  const next = found.find(request => request.who === 'continuation' && request.round === 1)
  const tool = next?.body.messages?.filter(message => message.role === 'tool').at(-1)
  if (tool === undefined) return null
  const cell = JSON.parse(messageText(tool)) as { readonly value?: unknown }
  if (typeof cell.value !== 'string') return null
  const read = JSON.parse(cell.value) as { readonly text: string; readonly lengths: readonly number[]; readonly fullSha256: string }
  return {
    segments: read.lengths.length,
    lengths: read.lengths,
    textEqualsStored: read.text === CAPTURE_CHILD_ANSWER,
    tailKept: read.text.endsWith(RESULT_TAIL),
    fullSha256MatchesStored: read.fullSha256 === createHash('sha256').update(CAPTURE_CHILD_ANSWER, 'utf8').digest('hex'),
  }
}

/** The `context` value a child's REPL printed, read back from the tool result of its next request. */
function childContextSeen(found: readonly FoundRequest[]): Record<string, unknown> | undefined {
  const next = found.find(request => request.who === 'child' && request.round === 1)
  const tool = next?.body.messages?.filter(message => message.role === 'tool').at(-1)
  if (tool === undefined) return undefined
  const text = messageText(tool)
  // The tool result is the cell result as JSON text; the cell returned the context as a JSON string.
  const parsed = JSON.parse(text) as { readonly value?: unknown }
  return typeof parsed.value === 'string' ? JSON.parse(parsed.value) as Record<string, unknown> : undefined
}

/** What the text of a request says its dispatch is. Used only to check what the production records say. */
function dispatchHint(firstMessageText: string): CaptureWho {
  const task = taskText({ role: 'user', content: firstMessageText })
  if (task.includes('Agent message from')) return 'continuation'
  return task.includes(CAPTURE_ROOT_TASK) ? 'root' : 'child'
}

/** The runtime's persisted sessions, receipts and events: the production record of which session ran which command. */
async function productionRecords() {
  const state = JSON.parse(await readFile(join(isolatedHome, 'orchestrations', 'rlm-runtime', 'state.json'), 'utf8')) as {
    sessions: Array<{ snapshot: { sessionId: string; parentSessionId?: string } }>
    receipts: Array<{ commandId: string; sessionId?: string; operation?: string }>
    events: Array<{ type: string; sessionId: string; data: Record<string, unknown> }>
  }
  return { sessions: state.sessions.map(session => session.snapshot), receipts: state.receipts, runtimeEvents: state.events }
}

/**
 * What the `context-capture` scenario shows: per request, which production dispatch it was sent for (taken from the tool-call
 * ids and the receipts the runtime kept, not from the text), what it carried, and where the marker and the last line of each
 * task are; the context the child saw; and, when asked, the raw requests, their projection and the correlation, written to a
 * directory. A request that cannot be tied to exactly one dispatch fails the scenario.
 * @param runId - the run of the scenario.
 * @param events - the run's orchestration events, which record the dispatches.
 * @param raw - the requests the fake received while the scenario ran, in arrival order.
 */
async function captureTranscript(runId: OrchestrationRunId, events: RunEvents, raw: readonly FakeRawRequest[]) {
  const { runtimeEvents, ...production } = await productionRecords()
  const facts = dispatchFacts(events, runtimeEvents)
  const { requests: byArrival, otherRun } = correlate(raw, production, facts, String(runId), dispatchHint)
  // Tokens are numbered in the order of the dispatch and round, not of arrival: root and child requests arrive concurrently.
  const order: readonly CaptureWho[] = ['root', 'child', 'continuation']
  const correlated = [...byArrival].sort((left, right) => order.indexOf(left.who) - order.indexOf(right.who) || left.round - right.round)
  const tokens = new Tokens()
  const found: FoundRequest[] = []
  type Projected = { readonly ordinal: number; readonly who: CaptureWho; readonly round: number; readonly projection: unknown }
  const projections: Projected[] = []
  for (const request of correlated) {
    const rawRequest = raw.find(candidate => candidate.ordinal === request.ordinal) as FakeRawRequest
    const body = JSON.parse(rawRequest.body) as FakeBody
    const projection = project(body as never, tokens)
    assertLossless(rawRequest, projection, tokens)
    found.push({ who: request.who, round: request.round, raw: rawRequest, body })
    projections.push({ ordinal: request.ordinal, who: request.who, round: request.round, projection })
  }
  const rows = projections.map(({ who, round, projection }, index) => {
    const text = (found[index] as FoundRequest).raw.body
    const body = (found[index] as FoundRequest).body
    return {
      who, round,
      roles: (body.messages ?? []).map(message => message.role),
      tools: (body.tools ?? []).length,
      containsRootMarker: text.includes(CANARY),
      containsRootTail: text.includes('ROOT-TAIL-RULE'),
      containsChildTail: text.includes('CHILD-TAIL-RULE'),
      bodySha256: projectionSha256(projection),
    }
  }).sort((left, right) => order.indexOf(left.who) - order.indexOf(right.who) || left.round - right.round)
  const context = childContextSeen(found)
  const directory = process.env.DSH_REQUEST_CAPTURE_DIR
  if (directory !== undefined) {
    await mkdir(directory, { recursive: true })
    const write = (name: string, value: unknown): Promise<void> => (
      writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`)
    )
    await write('api-raw.json', raw.map(({ ordinal, sha256, issuedToolCallId, body }) => ({ ordinal, sha256, issuedToolCallId, body })))
    await write('api-correlation.json', { requests: byArrival, otherRun })
    await write('api-projection.json', { tokens: tokens.table(), requests: projections })
  }
  return {
    requests: rows,
    // Requests that belong to another run are named, not classified; a request that belongs to no run fails above.
    requestsOfOtherRuns: otherRun.length,
    resultRead: resultReadBack(found),
    childContext: context === undefined ? null : {
      keys: Object.keys(context).sort(),
      taskIsTheChildsOwn: context.task === CAPTURE_CHILD_TASK,
      containsRootMarker: JSON.stringify(context).includes(CANARY),
    },
  }
}

/**
 * What the `batched-messages` scenario shows. Message and command ids are random, so they are replaced by their position: the
 * messages by the order they arrived in, and the batch command by its first message with the digest left out.
 * @param runId - the run; the runtime state holds the messages of every scenario, and only this run's are reported.
 * @param events - the run's events.
 * @param until - the end of the scenario's time.
 */
async function batchTranscript(runId: OrchestrationRunId, events: RunEvents, until: number) {
  const state = JSON.parse(await readFile(join(isolatedHome, 'orchestrations', 'rlm-runtime', 'state.json'), 'utf8')) as {
    messages: Array<{ messageId: string; toSessionId: string; deliveryStatus: string }>
    events: Array<{ type: string; sessionId: string; data: Record<string, unknown> }>
    messageBatchDispatches: Array<{ sessionId: string }>
  }
  const ofRun = (sessionId: string): boolean => sessionId.includes(String(runId))
  const messages = state.messages.filter(message => ofRun(message.toSessionId))
  const order = messages.map(message => message.messageId)
  const label = (id: unknown): string => `<message ${String(order.indexOf(String(id)) + 1)}>`
  const command = (id: unknown): string => String(id).replace(/^(rlm-message-[0-9a-f-]{36}):batch-(\d+)-[0-9a-f]{8}:deliver$/u, (_whole, first: string, size: string) => `${label(first)}:batch-${size}-<digest>:deliver`)
    .replace(/^(rlm-message-[0-9a-f-]{36}):deliver$/u, (_whole, first: string) => `${label(first)}:deliver`)
  const usage = events.filter(event => event.type === 'rlm.usage' && event.data.source === 'continuation')
  const settledEvents = events.filter(event => event.type === 'rlm.message.continuation.settled')
  // The continuation artifacts as the artifact service returns them: the command, the messages, and what the model answered.
  const artifacts = []
  for (const event of settledEvents) {
    const artifact = await rpc('readArtifact', service().readArtifact(OrchestrationArtifactRef(String(event.data.artifactRef))), until) as {
      commandId: string
      messageIds: string[]
      stopReason: string
      output: Array<{ type: string; text?: string }>
    }
    artifacts.push({
      command: command(artifact.commandId),
      messages: (artifact.messageIds as string[] | undefined ?? []).map(label),
      stopReason: artifact.stopReason,
      answer: artifact.output.filter(block => block.type === 'text').map(block => block.text ?? '').join(''),
    })
  }
  return {
    messagesDelivered: messages.map(message => message.deliveryStatus),
    runtimeEvents: state.events
      .filter(event => ofRun(event.sessionId) && ( event.type === 'rlm.message.delivered' || event.type.startsWith('rlm.message.continuation.') || event.type === 'rlm.message.dispatch_unknown'))
      .map(event => ({
        type: event.type, message: label(event.data.messageId), command: command(event.data.commandId),
        batchIndex: event.data.batchIndex, batchSize: event.data.batchSize, stopReason: event.data.stopReason,
      })),
    runContinuationEvents: events.filter(event => event.type.startsWith('rlm.message.continuation.')).map(event => ({
      type: event.type, messages: (event.data.messageIds as string[]).map(label), command: command(event.data.commandId),
    })),
    heldOrInFlightBatches: state.messageBatchDispatches.filter(record => ofRun(record.sessionId)),
    continuationArtifacts: artifacts,
    artifactRefsDistinct: new Set(settledEvents.map(event => event.data.artifactRef)).size === settledEvents.length,
    // The node's result is the output of the last continuation, not the root's own answer.
    nodeOutput: events.filter(event => event.type === 'node.evidence.accepted').map(event => event.data.outputPreview),
    fakeRounds: servedRounds,
    fakeRoundTotals: Object.fromEntries((['batch', 'single'] as const).map((kind) => {
      const rounds = servedRounds.filter(served => served.continuation === kind)
      return [kind, {
        uncachedInput: rounds.reduce((sum, served) => sum + served.usage.promptTokens - served.usage.cacheHitTokens, 0),
        output: rounds.reduce((sum, served) => sum + served.usage.completionTokens, 0),
        cacheRead: rounds.reduce((sum, served) => sum + served.usage.cacheHitTokens, 0),
        requests: rounds.length,
      }]
    })),
    continuationUsage: usage.map(event => ({
      command: command(event.data.sourceCommandId), inputTokens: event.data.inputTokens, outputTokens: event.data.outputTokens,
      cacheReadInputTokens: event.data.cacheReadInputTokens,
    })),
    continuationPrompts: batchPrompts.map(prompt => prompt
      .replaceAll(/rlm-session-[0-9a-f-]{36}|rlm:orch:run-[0-9a-f-]{36}:rlm:1/gu, '<session id>')
      .replace(/^- (child "(?:gamma|delta)"): (running|idle)$/gmu, '- $1: <running or idle>')),
  }
}

async function run(scenario: Scenario) {
  const workspace = join(isolatedHome, `workspace-${scenario.name}`)
  await mkdir(workspace, { recursive: true })
  counts.clear()
  current = scenario
  const until = Date.now() + SCENARIO_MS
  const fakeStart = (await owned.fake)?.raw.length ?? 0
  const progress: { runId?: OrchestrationRunId } = {}
  type Snapshot = Awaited<ReturnType<Booted['orchestrations']['inspect']>>
  const inspect = (runId: OrchestrationRunId): Promise<Snapshot> => track(fault === 'hang-inspect' ? never<Snapshot>() : service().inspect(runId))
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
    ...scenario.context === true
      ? {
        outputs: events.filter(event => event.type === 'node.evidence.accepted').map(event => event.data.outputPreview),
        rootContinuationPrompts: captured.rootContinuations,
        childContinuationPrompts: captured.childContinuations,
      }
      : {},
    ...scenario.batch === true ? await batchTranscript(started.runId, events, until) : {},
    ...scenario.capture === true ? await captureTranscript(started.runId, events, ((await owned.fake)?.raw ?? []).slice(fakeStart)) : {},
  }
}

const failures: string[] = []
let slowStarted = false
let bodyError: unknown
let transcript: Readonly<Record<'goal' | 'autonomous' | 'context' | 'batched' | 'captured', unknown>> | undefined

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

  // A root with two children that report in turn gets two message continuations, and then messages one child, which gets one.
  // The transcript holds what the model was given in the root's first continuation and in the child's, taken from the requests
  // the shipping worker sent, and what the node ended in.
  const context = await run({ name: 'context-prompts', autonomous: false, context: true })
  // Two children report before the root's turn ends: the root is continued once, for both messages.
  const batched = await run({ name: 'batched-messages', autonomous: false, batch: true })
  // A root, one child with a long task, and a continuation, with every request recorded.
  const captured = await run({ name: 'context-capture', autonomous: false, capture: true })
  transcript = { goal, autonomous, context, batched, captured }
} catch (error) {
  bodyError = error
} finally {
  current = undefined
  closing = true
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
