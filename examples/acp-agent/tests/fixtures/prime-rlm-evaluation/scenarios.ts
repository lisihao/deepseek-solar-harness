/**
 * The scenarios of the `prime-rlm-evaluation` fixture. Each one runs in its own home and its own driver process, with its own
 * scope file (or none) and its own fake provider behavior. The `tree` scenario is the original one and its handler stays in the
 * driver; the others exercise the paths the integration of the evaluation ledger with the first slice must keep apart:
 * a batched continuation that reads a child's result, a refusal of the first and of a later request, a request that reports no
 * usage, a request that fails with an unknown outcome, a failure that is known and retried, a root without children, and the same
 * root in a home without a scope.
 */
import { messageText, type FakeHandler, type FakeMessage, type FakeReply } from '../prime-rlm-terminal/fake-deepseek.ts'

export const SCENARIO_NAMES = [
  'tree', 'integration', 'refuse-first', 'refuse-later', 'refuse-round', 'cancelled', 'missing-usage', 'unknown-no-replay', 'unknown-error-finish', 'unknown-child', 'unknown-continuation', 'known-retry', 'zero-child',
  'ordinary',
] as const

export type ScenarioName = (typeof SCENARIO_NAMES)[number]

/** The limits of a scope file; every field is required by the ledger. */
export interface ScenarioLimits {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly httpAttempts: number
  readonly concurrentRequests: number
  readonly maxOutputTokensPerRequest: number
}

export interface Scenario {
  readonly name: ScenarioName
  /** `false` runs the same root in a home without an evaluation scope. */
  readonly scoped: boolean
  readonly limits: ScenarioLimits
  readonly retry: { readonly maxAttempts: number; readonly retryableCodes: readonly string[] }
  /** The fake provider's behavior; `undefined` for `tree`, whose handler is in the driver. */
  readonly handler: FakeHandler | undefined
}

export const GAMMA = 'EVAL-GAMMA: report your figure.'
export const DELTA = 'EVAL-DELTA: report your figure.'

const GENEROUS: ScenarioLimits = {
  inputTokens: 5_000_000, outputTokens: 5_000_000, httpAttempts: 60, concurrentRequests: 8, maxOutputTokensPerRequest: 100,
}

/** The task text a request carries: the daemon wraps every API prompt in a JSON envelope, and the model reads its `task`. */
export function taskText(message: FakeMessage): string {
  type Envelope = { readonly dshOperatorContextEnvelope: { readonly task: { readonly content: readonly { readonly text?: string }[] } } }
  return (JSON.parse(messageText(message)) as Envelope).dshOperatorContextEnvelope.task.content.map(block => block.text ?? '').join('\n')
}

const repl = (code: string, extra: { readonly omitUsage?: true } = {}): FakeReply => (
  { kind: 'tool', name: 'typescript_repl', arguments: JSON.stringify({ code }), ...extra }
)
const answer = (text: string): FakeReply => ({ kind: 'text', text, finish: 'stop' })

/**
 * A root with two children that both report before the root's turn ends, so the root is continued once for both messages. The
 * continuation reads a child's stored result in its first round and answers in its second.
 */
function integrationHandler(failFirstRequestOf?: 'gamma' | 'continuation'): FakeHandler {
  const gate = Promise.withResolvers<undefined>()
  let childrenDone = 0
  const failure: FakeReply = { kind: 'http-error', status: 500 }
  return async (messages) => {
    const first = messages[0]
    if (first === undefined) throw new Error('fake DeepSeek received a request without messages')
    const task = taskText(first)
    const afterTool = messages.at(-1)?.role === 'tool'
    if (task.includes('Agent message from')) {
      if (failFirstRequestOf === 'continuation' && !afterTool) return failure
      return afterTool
        ? answer('continued after reading a child result')
        : repl('const kid = (await rlm.listSubagents())[0]; const part = await rlm.readChildResult(kid, { offset: 0, limit: 60 }); part.length')
    }
    const name = task.includes(GAMMA) ? 'gamma' : task.includes(DELTA) ? 'delta' : undefined
    if (name !== undefined) {
      if (failFirstRequestOf === name && !afterTool) {
        childrenDone += 1
        if (childrenDone === 2) gate.resolve(undefined)
        return failure
      }
      if (!afterTool) return repl(`await agentMessage.send("${name} figure", { receiverRole: "parent", mode: "auto" }); "sent"`)
      childrenDone += 1
      if (childrenDone === 2) gate.resolve(undefined)
      return answer(`${name} result line. ${'The child result is long enough to need more than one segment. '.repeat(4)}`)
    }
    if (!afterTool) return repl(`await rlm(${JSON.stringify(GAMMA)}, { name: "gamma" }); await rlm(${JSON.stringify(DELTA)}, { name: "delta" }); "spawned"`)
    await gate.promise
    return answer('root turn ended')
  }
}

/** A root that runs one cell and answers. */
function singleRoundHandler(options: { readonly firstWithoutUsage?: boolean } = {}): FakeHandler {
  return (messages) => {
    if (messages.at(-1)?.role === 'tool') return answer('done')
    return repl('1 + 1', options.firstWithoutUsage === true ? { omitUsage: true } : {})
  }
}

const NO_RETRY = { maxAttempts: 1, retryableCodes: [] as readonly string[] }

function scenario(name: ScenarioName, handler: FakeHandler | undefined, over: Partial<Omit<Scenario, 'name' | 'handler'>> = {}): Scenario {
  return { name, scoped: true, limits: GENEROUS, retry: NO_RETRY, handler, ...over }
}

export function scenarioOf(name: ScenarioName): Scenario {
  const single = singleRoundHandler()
  switch (name) {
    case 'tree':
      return scenario(name, undefined, { limits: { ...GENEROUS, httpAttempts: 6 } })
    case 'integration':
      return scenario(name, integrationHandler())
    case 'refuse-first':
      // Every body is longer than 50 bytes, so the first request is refused before anything is sent.
      return scenario(name, integrationHandler(), { limits: { ...GENEROUS, inputTokens: 50 } })
    case 'refuse-later':
      // Root: 2 requests; each of the two children: 2. The continuation's first request is the 7th.
      return scenario(name, integrationHandler(), { limits: { ...GENEROUS, httpAttempts: 6 } })
    case 'refuse-round':
      // The root's first request settles; its second request, the next round of the same command, is the second attempt.
      return scenario(name, single, { limits: { ...GENEROUS, httpAttempts: 1 } })
    case 'cancelled':
      // The second round of the root is held open until the driver cancels the run.
      return scenario(name, (messages, body, raw) => (messages.at(-1)?.role === 'tool' ? new Promise<FakeReply>(() => undefined) : single(messages, body, raw)))
    case 'missing-usage':
      return scenario(name, singleRoundHandler({ firstWithoutUsage: true }))
    case 'unknown-no-replay':
      // The first request reports no usage and the worker then rejects it with MODEL_WORKER_INVALID, which the retry policy would
      // replay. Room is left in the attempts, the output and the concurrency, so a second request would be admitted if the node
      // were retried.
      return scenario(name, (messages, body, raw) => (raw.ordinal === 0 ? { kind: 'empty-tool-calls', omitUsage: true } : single(messages, body, raw)), {
        retry: { maxAttempts: 2, retryableCodes: ['MODEL_WORKER_INVALID', 'OPERATOR_STOPPED', 'SERVER'] },
      })
    case 'unknown-error-finish':
      // The first request gets an HTTP 500: the worker reports it as a result that stopped with an error, and the ledger holds the
      // request as unknown.
      return scenario(name, (messages, body, raw) => (raw.ordinal === 0 ? { kind: 'http-error', status: 500 } : single(messages, body, raw)), {
        retry: { maxAttempts: 2, retryableCodes: ['MODEL_WORKER_INVALID', 'OPERATOR_STOPPED', 'SERVER'] },
      })
    case 'unknown-child':
      // The first request of one child gets an HTTP 500: that child's outcome is unknown, and the other child still reports.
      return scenario(name, integrationHandler('gamma'))
    case 'unknown-continuation':
      // The continuation's first request gets an HTTP 500: its two messages end with an unknown outcome and are not sent again.
      return scenario(name, integrationHandler('continuation'))
    case 'known-retry':
      // The first request settles with usage and the worker then rejects it (code MODEL_WORKER_INVALID); the second attempt succeeds.
      return scenario(name, (messages, body, raw) => (raw.ordinal === 0 ? { kind: 'empty-tool-calls' } : single(messages, body, raw)), {
        retry: { maxAttempts: 2, retryableCodes: ['MODEL_WORKER_INVALID'] },
      })
    case 'zero-child':
      return scenario(name, single)
    case 'ordinary':
      return scenario(name, single, { scoped: false })
  }
}
