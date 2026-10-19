/** Actual Worker/Runtime trial assembly; all model responses come from the fixed fake Adapter. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EvaluationLedger, parseEvaluationScope, evaluationUsageOf } from '@deepseek-ai/dsh-orchestration-local'
import { RlmCommandId, RlmRuntimeSessionId } from '@deepseek-ai/dsh-rlm-runtime'
import { localIpcAddress } from '@deepseek-ai/dsh-home-paths'
import { JsonRpcLineTransport, requestLocalJsonRpc } from '@deepseek-ai/dsh-sdk-protocol'
import { state } from './adapter.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const limits = { maxDepth: 2, maxChildren: 8, maxTurns: 16, maxCellMs: 10_000, maxOutputBytes: 8192 }
const policy = { version: 1, maxToolRounds: 4 }
const model = 'scripted-offline-model'
const question = 'Read the final UTF8 marker using the shared TypeScript tool.'
const paramsHash = params => sha(JSON.stringify([params.session_id, params.command_id, params.tool, params.arguments]))

/** Compare independent actual sends with individual ledger attempts, never Worker aggregate usage. */
export function usageComplete(snapshot, sends) {
  const sent = snapshot.state.attempts.filter(item => item.state !== 'refused')
  if (sent.length !== sends.length) return false
  const ids = new Set()
  for (const send of sends) {
    if (ids.has(send.attemptId)) return false
    ids.add(send.attemptId)
    const attempt = sent.find(item => item.id === send.attemptId)
    if (!attempt || attempt.state !== 'settled' || !attempt.usage || !send.usage
      || attempt.bodySha256 !== send.bodySha256) return false
    if (JSON.stringify(attempt.usage) !== JSON.stringify(evaluationUsageOf(send.usage))) return false
  }
  return true
}

/** One Consumer-owned cell admission proxy; in-memory state deliberately cannot resume a trial. */
export async function cellProxy(runtime, home, signal, cellLimit, onForward) {
  const path = localIpcAddress(home, 'offline-proxy')
  const registered = new Map()
  const cells = new Map()
  const sockets = new Set()
  let forwarded = 0
  const check = () => { if (signal.aborted) throw signal.reason }
  const handle = (method, params) => {
    if (method !== 'tool.call' || params === null || typeof params !== 'object'
      || typeof params.session_id !== 'string' || typeof params.command_id !== 'string'
      || params.tool !== 'typescript_repl' || !params.arguments || typeof params.arguments.code !== 'string') {
      throw new Error('invalid trial tool request')
    }
    const bridge = registered.get(params.session_id)
    if (!bridge) throw new Error('session is outside this trial')
    const key = JSON.stringify([params.session_id, params.command_id])
    const digest = paramsHash(params)
    const prior = cells.get(key)
    if (prior) {
      if (prior.digest !== digest) throw new Error('trial cell identity conflict')
      return prior.promise
    }
    check()
    if (forwarded >= cellLimit) throw new Error('trial cell limit')
    forwarded++
    const cell = { digest, state: 'forwarded', session: params.session_id, params: structuredClone(params) }
    cells.set(key, cell)
    // The actual Runtime does not receive the deadline signal. Retain its eventual outcome independently of the caller's abort.
    cell.promise = requestLocalJsonRpc(bridge.socketPath, method, params, new AbortController().signal,
      () => new Error('owned Runtime bridge disconnected')).then(result => {
      cell.state = 'settled'; cell.result = result; return result
    }, error => { cell.state = 'unknown'; cell.error = String(error); throw error })
    void cell.promise.catch(() => {})
    onForward?.()
    return cell.promise
  }
  const server = createServer(socket => {
    sockets.add(socket)
    const transport = new JsonRpcLineTransport(socket, socket)
    transport.onRequest(handle)
    socket.on('close', () => { sockets.delete(socket); transport.close() })
    transport.start()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  return {
    check, cells, handle,
    get forwarded() { return forwarded },
    async bridge(sessionId) {
      check()
      const bridge = await runtime.modelToolBridge(sessionId)
      check()
      registered.set(String(sessionId), bridge)
      return { ...bridge, socketPath: path }
    },
    async close() {
      await Promise.allSettled([...cells.values()].map(cell => cell.promise))
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

/** Execute one new trial. An existing claim rejects whole-trial reconstruction, even if its ledger could reopen. */
export async function runTrial(ctx, home, corpus, placement, spawnMode, scenario = 'normal') {
  await mkdir(home, { recursive: true })
  const claim = await open(join(home, 'started'), 'wx')
  await claim.close()
  const root = RlmRuntimeSessionId('offline-' + placement + '-' + spawnMode + '-' + scenario)
  const scopeText = JSON.stringify({ version: 1, scopeId: String(root), model,
    inputBound: scenario === 'strict' ? 'proven-token-count' : 'request-bytes-audited',
    limits: { inputTokens: 200000, outputTokens: scenario === 'output-cap' ? 5 : 16000,
      httpAttempts: scenario === 'attempt-cap' ? 1 : 24, concurrentRequests: 1,
      maxOutputTokensPerRequest: scenario === 'output-cap' ? 5 : 20 },
    generation: { thinking: 'enabled', reasoningEffort: 'high' } })
  const parsed = parseEvaluationScope(scopeText)
  let ledger = EvaluationLedger.open(join(home, 'ledger.json'), parsed.scope, parsed.sha256)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('trial admission deadline')), 1200_000)
  const entries = []
  const sends = []
  const evidence = []
  const jobs = []
  const results = []
  const deadlines = []
  const proxy = await cellProxy(ctx.rlmRuntime, home, controller.signal, scenario === 'cell-cap' ? 1 : 64,
    scenario === 'late-cell' ? () => {
      deadlines.push(setTimeout(() => controller.abort(new Error('trial admission deadline')), 10))
    } : undefined)
  const protocol = { path: corpus.path, sha256: corpus.sha256, bytes: corpus.bytes }
  const readCode = "const fs = await import('node:fs/promises'); const f = await fs.open(context.corpus.path, 'r'); "
    + "const b = Buffer.alloc(64); await f.read(b, 0, 64, context.corpus.bytes - 64); await f.close(); console.log(b.toString('utf8'));"
  const script = options => {
    const last = options.messages.at(-1)
    const first = options.messages[0].content.map(block => block.type === 'text' ? block.text : '').join('\n')
    const depth = first.includes('depth:2') ? 2 : first.includes('depth:1') ? 1 : 0
    if (scenario === 'unknown-first' || (scenario === 'known-unknown' && last.content.some(block => block.type === 'tool-result'))) {
      return { kind: 'unknown' }
    }
    if (scenario === 'over-output') return { kind: 'over-output' }
    if (last.content.some(block => block.type === 'tool-result')) return { kind: 'final' }
    let code = depth === 0 ? readCode : "console.log('child depth " + String(depth) + "');"
    if (scenario === 'late-cell') code = "await new Promise(resolve => setTimeout(resolve, 60)); console.log('LATE_CELL_RETURNED');"
    else if ((scenario === 'normal' || scenario === 'cell-cap') && depth < 2) {
      code += "try { await rlm('depth:" + String(depth + 1) + "', {name:'node-" + String(depth + 1)
        + "'}); } catch (error) { console.log('SPAWN_REFUSED:' + error.code); }"
    }
    return { kind: 'tool', code }
  }
  const trial = { entries, sends, script, lastAdmittedId: undefined }
  state.current = trial
  const evaluation = {
    model, maxOutputTokens: 20, reasoningEffort: 'high',
    remainingOutputTokens: () => ledger.remainingOutputTokens(),
    admission: label => facts => {
      proxy.check()
      const ticket = ledger.admission(label)(facts)
      trial.lastAdmittedId = ledger.snapshot().state.attempts.at(-1).id
      return ticket
    },
  }
  async function worker(sessionId, depth) {
    proxy.check()
    const bridge = await proxy.bridge(sessionId)
    proxy.check()
    const prompt = [{ type: 'text', text: question + '\ndepth:' + String(depth) + '\nCorpus reference: ' + JSON.stringify(protocol) }]
    if (depth === 0 && placement === 'full') prompt.push({ type: 'text', text: corpus.text })
    const result = await ctx.modelWorkers.execute({
      commandId: String(sessionId) + ':worker', workerId: 'deepseek-api', model,
      prompt, toolExecution: policy, modelToolBridge: bridge, evaluation, signal: controller.signal,
      physicalRequestObserver: facts => {
        const item = { bodySha256: facts.bodySha256, events: [] }
        evidence.push(item)
        return { dispatching: () => item.events.push('dispatching'), notSent: () => item.events.push('not-sent'),
          terminalResponse: () => item.events.push('terminal'), unknown: () => item.events.push('unknown') }
      },
    })
    results.push(result)
    return result
  }
  const bindings = {
    dispatchChild: async request => {
      proxy.check()
      await ctx.rlmRuntime.bindHost(request.childSessionId, bindings)
      proxy.check()
      const promise = worker(request.childSessionId, request.depth)
      jobs.push(promise)
      return { nativeSessionId: String(request.childSessionId), nativeTurnId: String(request.commandId),
        result: promise.then(result => ({ status: 'settled', ...result })),
        interrupt: () => { controller.abort(new Error('trial interrupted')); return Promise.resolve() } }
    },
  }
  let rootResult
  let workerError
  try {
    await ctx.rlmRuntime.create({ sessionId: root, commandId: RlmCommandId(String(root) + ':create'),
      executionId: String(root), workspace: home, task: question, model: { operatorId: 'deepseek-api', model },
      limits, childSpawnPolicy: { version: 1, mode: spawnMode, maxTotalChildren: spawnMode === 'none' ? 0 : 8 },
      context: { corpus: protocol, ...placement === 'full' ? { rawCorpus: corpus.text } : {} } }, bindings)
    try { rootResult = await worker(root, 0) } catch (error) { workerError = String(error) }
    for (let index = 0; index < jobs.length; index++) await jobs[index]
    const beforeClose = ledger.snapshot()
    const complete = usageComplete(beforeClose, sends)
    const runtimeState = JSON.parse(await readFile(join(process.env.DSH_HOME, 'runtime', 'state.json'), 'utf8'))
    const retained = runtimeState.sessions.find(session => session.snapshot.sessionId === String(root)).context
    assert.equal(retained.corpus.sha256, corpus.sha256)
    assert.equal('rawCorpus' in retained, placement === 'full')
    assert.equal(sha(await readFile(corpus.path)), corpus.sha256)
    const cellsAtReturn = [...proxy.cells.values()].map(cell => cell.state)
    await proxy.close()
    const cellsAfterDrain = [...proxy.cells.values()].map(cell => cell.state)
    // Artifact files preserve full requests, actual sends, tool results and per-attempt facts for local inspection.
    await writeFile(join(home, 'evidence-before-checks.json'), JSON.stringify({ entries, sends, ledger: beforeClose, evidence,
      results, workerError, cellsAtReturn, cellsAfterDrain, persistentContext: retained }, null, 2) + '\n')
    if (scenario === 'normal') {
      assert(complete)
      assert(sends.length >= 2)
      assert.equal(beforeClose.totals.output, sends.length * 5, 'reasoning must not be charged twice')
      assert.equal(evidence.filter(item => item.events.includes('dispatching')).length, sends.length)
      assert.equal(jobs.length, spawnMode === 'none' ? 0 : spawnMode === 'root-only' ? 1 : 2)
      assert.equal(proxy.forwarded, jobs.length + 1)
      const rootCells = [...proxy.cells.values()].filter(cell => cell.session === String(root))
      assert(rootCells.some(cell => JSON.stringify(cell.result).includes('UTF8-END-终点')))
    }
    if (scenario === 'strict') assert.equal(sends.length, 0)
    if (scenario === 'attempt-cap') { assert.equal(sends.length, 1); assert(beforeClose.totals.refused > 0) }
    if (scenario === 'output-cap') {
      assert.equal(sends.length, 1); assert.equal(beforeClose.totals.output, 5)
      assert(entries.length > sends.length); assert(beforeClose.totals.refused > 0)
    }
    if (scenario === 'cell-cap') {
      assert.equal(proxy.forwarded, 1); assert.equal(jobs.length, 1)
      assert(entries.some(entry => JSON.stringify(entry.request.messages).includes('trial cell limit')))
    }
    if (scenario === 'known-unknown') {
      assert.equal(sends.length, 2); assert.equal(complete, false)
      assert.equal(rootResult.usage.outputTokens, 5)
      assert.equal(beforeClose.totals.unknown, 1)
      const before = sends.length
      await worker(root, 0)
      assert.equal(sends.length, before)
      ledger.close()
      ledger = EvaluationLedger.open(join(home, 'ledger.json'), parsed.scope, parsed.sha256)
      assert.equal(ledger.snapshot().totals.unknown, 1)
      assert.equal(ledger.snapshot().totals.outstanding, 1)
    }
    if (scenario === 'over-output') {
      assert(beforeClose.state.boundViolation); assert.equal(beforeClose.totals.output, 21)
      const dispatched = sends.length
      await worker(root, 0)
      assert.equal(sends.length, dispatched)
      assert(ledger.snapshot().totals.refused > 0)
    }
    if (scenario === 'late-cell') {
      assert(controller.signal.aborted)
      assert(cellsAtReturn.includes('forwarded'), 'abort is not a settled cell')
      assert(cellsAfterDrain.every(value => value === 'settled'))
      assert.equal(sends.length, 1)
      await assert.rejects(() => worker(root, 0), /deadline/)
      assert.equal(proxy.forwarded, 1)
    }
    const attempts = beforeClose.state.attempts
    if (sends.length) assert.equal(usageComplete({ state: { attempts: [...attempts, ...attempts.filter(item => item.state !== 'refused')] } }, sends), false)
    if (sends.length) {
      assert.equal(usageComplete(beforeClose, [...sends, sends[0]]), false)
      assert.equal(usageComplete({ state: { attempts: [] } }, sends), false)
    }
    await writeFile(join(home, 'evidence.json'), JSON.stringify({ entries, sends, ledger: beforeClose,
      ledgerAfterChecks: ledger.snapshot(), evidence, results, workerError, cellsAtReturn, cellsAfterDrain,
      cells: [...proxy.cells.values()].map(({ promise: _promise, ...cell }) => cell),
      persistentContext: retained }, null, 2) + '\n')
    return { placement, spawnMode, scenario, actualSends: sends.length, cells: proxy.forwarded,
      descendants: jobs.length, completeUsage: complete, unknown: beforeClose.totals.unknown,
      strictRefused: scenario === 'strict', lateCellRetained: scenario === 'late-cell',
      firstRequestHasFullCorpus: Boolean(entries[0]?.request.messages.some(message =>
        message.content.some(block => block.type === 'text' && block.text === corpus.text))),
      contextHasFullCorpus: 'rawCorpus' in retained,
      parameters: entries[0] === undefined ? null : { model: entries[0].request.model,
        effort: entries[0].request.reasoningEffort, maxTokens: entries[0].request.maxTokens,
        tools: entries[0].request.tools, toolExecution: policy },
      firstPromptContent: entries[0]?.request.messages[0].content,
      cellCodes: [...proxy.cells.values()].map(cell => cell.params.arguments.code),
      perSendParameters: sends.map(send => ({ model: send.request.model, maxTokens: send.request.maxTokens,
        effort: send.request.reasoningEffort, tools: send.request.tools })),
      toolResults: sends.flatMap(send => send.request.messages.flatMap(message => message.content
        .filter(block => block.type === 'tool-result').map(block => ({ isError: block.isError,
          content: block.content.map(part => {
            const { sessionId: _session, commandId: _command, ...semantic } = JSON.parse(part.text)
            return semantic
          }) })))),
      evidencePath: join(home, 'evidence.json') }
  } finally {
    state.current = undefined
    clearTimeout(timer)
    for (const deadline of deadlines) clearTimeout(deadline)
    await proxy.close()
    ledger.close()
  }
}
