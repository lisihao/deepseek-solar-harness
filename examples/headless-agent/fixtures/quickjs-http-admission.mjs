/** Black-box HTTP evidence for the existing Worker, Runtime and evaluation ledger. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { EvaluationLedger, parseEvaluationScope } from '@deepseek-ai/dsh-orchestration-local'
import { RlmCommandId, RlmRuntimeSessionId } from '@deepseek-ai/dsh-rlm-runtime'

const [config] = process.argv.slice(2)
assert(config && process.env.DSH_HOME, 'isolated config and home required')
const home = process.env.DSH_HOME
const sha = value => createHash('sha256').update(value).digest('hex')
function assertTransportEvidence(record) {
  assert(record.sends.every(item => item.method === 'POST' && item.path === '/chat/completions'
    && item.parseStatus === 'parsed'), 'every HTTP arrival is classified')
  const attempts = record.ledger.state.attempts
  assert.equal(record.observations.length, attempts.length, 'one observer per ledger attempt')
  for (const [index, attempt] of attempts.entries()) {
    const observation = record.observations[index]
    assert.equal(observation.facts.bodySha256, attempt.bodySha256, 'observer body association')
    const expected = attempt.state === 'refused' ? ['not-sent']
      : ['dispatching', attempt.state === 'unknown' ? 'unknown' : 'terminal']
    assert.deepEqual(observation.events, expected, 'observer terminal state')
  }
  assert.deepEqual(attempts.filter(item => item.state !== 'refused').map(item => item.bodySha256),
    record.sends.map(item => item.bodySha256), 'physical sends match admitted ledger attempts')
}
const received = []
let disconnect = false
const server = createServer(async (request, response) => {
  const arrival = { ordinal: received.length + 1, method: request.method, path: request.url, parseStatus: 'pending' }
  received.push(arrival)
  try {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/chat/completions')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const body = JSON.parse(raw)
    Object.assign(arrival, { bodySha256: sha(raw), model: body.model, maxTokens: body.max_tokens, parseStatus: 'parsed' })
    if (disconnect) {
      disconnect = false
      response.destroy()
      return
    }
    const firstUser = body.messages.find(message => message.role === 'user')?.content
    const isRoot = typeof firstUser === 'string' && firstUser.includes('HTTP_ROOT')
    if (!isRoot && typeof firstUser === 'string' && firstUser.includes('HTTP_CHILD')) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const tool = isRoot && !body.messages.some(message => message.role === 'tool')
    const delta = tool ? { tool_calls: [{
      index: 0, id: 'http-tool', type: 'function',
      function: { name: 'typescript_repl', arguments: JSON.stringify({
        code: 'if (typeof process !== "undefined" || typeof require !== "undefined") throw new Error("ambient host authority"); const child = await rlm("HTTP_CHILD", {name:"http-child"}); '
          + 'let result = await rlm.readChildResult(child); '
          + 'while (result.status === "not_settled") { await rlm.listChildren(); '
          + 'result = await rlm.readChildResult(child); } '
          + 'if (result.status !== "settled" || !result.complete || result.truncated '
          + '|| result.stopReason !== "completed") throw new Error("incomplete child result"); '
          + 'console.log(JSON.stringify(result));',
      }) },
    }] } : { content: 'synthetic HTTP result' }
    const frame = { id: 'synthetic-http', object: 'chat.completion.chunk', created: 1, model: body.model }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: ' + JSON.stringify({ ...frame, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
    response.end('data: ' + JSON.stringify({ ...frame, choices: [{ index: 0, delta: {},
      finish_reason: tool ? 'tool_calls' : 'stop' }], usage: {
      prompt_tokens: 9, completion_tokens: 5, total_tokens: 14,
      prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 9,
      completion_tokens_details: { reasoning_tokens: 3 },
    } }) + '\n\ndata: [DONE]\n\n')
  } catch (error) {
    arrival.parseStatus = 'invalid'
    arrival.error = String(error)
    response.writeHead(500)
    response.end(String(error))
  }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const address = server.address()
assert(address && typeof address !== 'string')
process.env.DSH_HTTP_TEST_URL = 'http://127.0.0.1:' + address.port
process.env.DSH_HTTP_TEST_AUTH = 'synthetic-not-a-provider-key'
let ctx
const evidence = { fakeProvider: true, actualExternalModelRequests: 0, scenarios: [] }
try {
  ctx = await boot('quickjs-http-admission-fixture', resolveConfigPath(config, undefined), undefined, undefined,
    new URL('../../package.json', import.meta.url).href)
  for (const scenario of ['root-child-tool', 'strict-refusal', 'unknown-then-success', 'unknown-holds-slot']) {
    const dir = join(home, scenario)
    await mkdir(dir)
    const parsed = parseEvaluationScope(JSON.stringify({
      version: 1, scopeId: scenario, model: 'synthetic-http-model',
      inputBound: scenario === 'strict-refusal' ? 'proven-token-count' : 'request-bytes-audited',
      limits: { inputTokens: 200000, outputTokens: 16000, httpAttempts: 24,
        concurrentRequests: scenario === 'unknown-then-success' ? 2 : 1, maxOutputTokensPerRequest: 20 },
      generation: { thinking: 'enabled', reasoningEffort: 'high' },
    }))
    const ledger = EvaluationLedger.open(join(dir, 'ledger.json'), parsed.scope, parsed.sha256)
    const admissions = [], observations = [], children = [], jobs = [], resultReads = []
    const storedResults = new Map()
    const root = RlmRuntimeSessionId('http-' + scenario)
    const before = received.length
    const execute = async (sessionId, commandId, text, tools) => {
      const bridge = tools ? await ctx.rlmRuntime.modelToolBridge(sessionId) : undefined
      return ctx.modelWorkers.execute({
        commandId, workerId: 'deepseek-api', model: 'synthetic-http-model',
        prompt: [{ type: 'text', text }],
        ...(bridge ? { modelToolBridge: bridge, toolExecution: { version: 1, maxToolRounds: 2 } } : {}),
        signal: AbortSignal.timeout(10000),
        evaluation: {
          model: 'synthetic-http-model', maxOutputTokens: 20, reasoningEffort: 'high',
          remainingOutputTokens: () => ledger.remainingOutputTokens(),
          admission: label => facts => {
            const ticket = ledger.admission(label)(facts)
            admissions.push({ label, bodySha256: facts.bodySha256 })
            return ticket
          },
        },
        physicalRequestObserver: facts => {
          const item = { facts, events: [] }
          observations.push(item)
          return { dispatching: () => item.events.push('dispatching'),
            notSent: () => item.events.push('not-sent'), terminalResponse: () => item.events.push('terminal'),
            unknown: () => item.events.push('unknown') }
        },
      })
    }
    const bindings = { readResult: async request => {
      const stored = storedResults.get(request.resultRef)
      if (!stored) return undefined
      assert.equal(stored.parentSessionId, String(request.sessionId))
      assert.equal(stored.childSessionId, String(request.childSessionId))
      assert.equal(stored.childId, String(request.childId))
      resultReads.push({ resultRef: request.resultRef, contentSha256: sha(JSON.stringify(stored.content)) })
      return structuredClone(stored.content)
    }, dispatchChild: async request => {
      children.push(String(request.childSessionId))
      await ctx.rlmRuntime.bindHost(request.childSessionId, bindings)
      const result = execute(request.childSessionId, String(request.childSessionId) + ':worker', 'HTTP_CHILD', false)
      jobs.push(result)
      return { nativeSessionId: String(request.childSessionId), nativeTurnId: String(request.commandId),
        result: result.then(value => {
          const commandId = String(request.childSessionId) + ':worker'
          const resultRef = 'http-result:' + sha(JSON.stringify([request.childId, commandId, value]))
          storedResults.set(resultRef, { childId: String(request.childId),
            childSessionId: String(request.childSessionId), parentSessionId: String(request.parentSessionId),
            content: { kind: 'synthetic-http-worker-result', commandId, stopReason: value.stopReason, output: value.output } })
          return { status: value.stopReason === 'completed' ? 'settled' : 'indeterminate',
            resultRef, output: value.output, stopReason: value.stopReason }
        }), interrupt: async () => {} }
    } }
    await ctx.rlmRuntime.create({ sessionId: root, commandId: RlmCommandId(scenario + ':create'),
      executionId: scenario, workspace: dir, task: 'synthetic HTTP test', context: {},
      model: { operatorId: 'deepseek-api', model: 'synthetic-http-model' },
      limits: { maxDepth: 2, maxChildren: 2, maxTurns: 8, maxCellMs: 5000, maxOutputBytes: 8192 },
      childSpawnPolicy: { version: 1, mode: 'root-only', maxTotalChildren: 1 },
    }, bindings)
    if (scenario === 'root-child-tool') {
      const result = await execute(root, 'http-root', 'HTTP_ROOT', true)
      await Promise.all(jobs)
      assert.equal(result.stopReason, 'completed', JSON.stringify({ result, admissions, observations,
        ledger: ledger.snapshot(), arrivals: received.slice(before) }))
      assert.equal(children.length, 1)
      assert.equal(resultReads.length, 1, 'parent reads the complete child result before its next model round')
      assert.equal(received.length - before, 3)
      assert(admissions.some(item => item.label.includes(String(root)) && item.label.includes('#round')))
      assert(admissions.some(item => item.label.includes(children[0]) && item.label.includes('#plain')))
    } else if (scenario === 'strict-refusal') {
      await execute(root, 'http-refused', 'HTTP_REFUSED', false).catch(() => {})
      assert.equal(received.length - before, 0)
      assert.equal(admissions.length, 0)
      assert.equal(ledger.snapshot().state.attempts.at(-1)?.state, 'refused')
      assert.equal(ledger.snapshot().state.attempts.at(-1)?.refusal, 'input-bound-unproven')
    } else {
      disconnect = true
      await execute(root, 'http-unknown', 'HTTP_UNKNOWN', false).catch(() => {})
      assert.equal(received.length - before, 1, 'no hidden HTTP retry')
      assert.equal(ledger.snapshot().totals.unknown, 1)
      const held = structuredClone(ledger.snapshot().state.attempts.find(item => item.state === 'unknown'))
      const persisted = JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8'))
      assert.deepEqual(persisted.attempts.find(item => item.id === held.id), held,
        'unknown reservation is durably stored')
      assert.equal(ledger.snapshot().totals.outstanding, 1)
      const result = await execute(root, 'http-after-unknown', 'HTTP_SUCCESS', false)
      if (scenario === 'unknown-then-success') {
        assert.equal(result.stopReason, 'completed')
        assert.equal(received.length - before, 2)
      } else {
        assert.notEqual(result.stopReason, 'completed')
        assert.equal(received.length - before, 1, 'held slot refuses a subsequent HTTP send at study concurrency one')
        assert.equal(ledger.snapshot().state.attempts.at(-1).state, 'refused')
        assert.equal(ledger.snapshot().state.attempts.at(-1).refusal, 'concurrency-exhausted')
      }
      assert.equal(ledger.snapshot().totals.unknown, 1)
      assert.deepEqual(ledger.snapshot().state.attempts.find(item => item.id === held.id), held)
      assert.deepEqual(JSON.parse(await readFile(join(dir, 'ledger.json'), 'utf8'))
        .attempts.find(item => item.id === held.id), held, 'later result does not rewrite durable unknown')
    }
    const sends = received.slice(before)
    assert.deepEqual(admissions.map(item => item.bodySha256), sends.map(item => item.bodySha256))
    assert.equal(ledger.snapshot().state.attempts.filter(item => item.state !== 'refused').length, sends.length)
    assert(sends.every(item => item.maxTokens === 20))
    const record = { scenario, admissions, observations, sends, resultReads, ledger: ledger.snapshot(),
      diagnosticConcurrency: scenario === 'unknown-then-success' ? 2 : 1 }
    assertTransportEvidence(record)
    const badAssociation = structuredClone(record)
    badAssociation.observations[0].facts.bodySha256 = '0'.repeat(64)
    assert.throws(() => assertTransportEvidence(badAssociation), /observer body association/)
    record.observerBodyMutationRejected = true
    if (sends.length > 0) {
      const unclassifiedArrival = structuredClone(record)
      unclassifiedArrival.sends[0].parseStatus = 'invalid'
      assert.throws(() => assertTransportEvidence(unclassifiedArrival), /every HTTP arrival is classified/)
      record.unclassifiedArrivalMutationRejected = true
    }
    const unknownIndex = observations.findIndex(item => item.events.includes('unknown'))
    if (unknownIndex !== -1) {
      const missingUnknown = structuredClone(record)
      missingUnknown.observations[unknownIndex].events.pop()
      assert.throws(() => assertTransportEvidence(missingUnknown), /observer terminal state/)
      record.missingUnknownMutationRejected = true
    }
    evidence.scenarios.push(record)
    await writeFile(join(dir, 'evidence.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' })
  }
  if (process.env.DSH_EXAMPLE_MODE === 'lib') {
    for (const id of ['@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-orchestration-local']) {
      assert.match(import.meta.resolve(id), /\/lib\/index\.js$/)
    }
    assert(!process.execArgv.some(argument => /tsx/.test(argument)))
  }
  const guestStore = JSON.parse(await readFile(join(home, 'runtime', 'quickjs-state-v1.json'), 'utf8'))
  assert.equal(guestStore.version, 8)
  assert.equal(guestStore.kernelCodec, 'quickjs-json-v1')
  evidence.guestBackend = 'quickjs-wasm'
  await writeFile(join(home, 'http-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(JSON.stringify({ fakeProvider: true, guestBackend: 'quickjs-wasm', actualExternalModelRequests: 0,
    actualLocalHttpSends: received.length, scenarios: evidence.scenarios.map(item => item.scenario) }) + '\n')
} catch (error) {
  const destination = process.env.DSH_HTTP_TEST_ARTIFACTS
  if (destination) {
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'failure.json'), JSON.stringify({
      error: String(error), received, completedScenarios: evidence.scenarios,
    }, null, 2) + '\n', { flag: 'wx' })
  }
  throw error
} finally {
  await ctx?.fiber.dispose()
  await new Promise(resolve => server.close(resolve))
}
