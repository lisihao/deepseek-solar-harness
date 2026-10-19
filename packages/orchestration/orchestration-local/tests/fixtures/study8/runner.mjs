/** Frozen eight-row Consumer in the existing Worker/Runtime fixture package; no credentials are read here. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { openSync, writeSync, fsyncSync, closeSync } from 'node:fs'
import { createServer } from 'node:net'
import { isAbsolute, join } from 'node:path'
import { EvaluationLedger, parseEvaluationScope } from '@deepseek-ai/dsh-orchestration-local'
import { RlmCommandId, RlmRuntimeSessionId } from '@deepseek-ai/dsh-rlm-runtime'
import { localIpcAddress } from '@deepseek-ai/dsh-home-paths'
import { JsonRpcLineTransport, requestLocalJsonRpc } from '@deepseek-ai/dsh-sdk-protocol'

const sha = value => createHash('sha256').update(value).digest('hex')
const now = () => new Date().toISOString()
const positive = value => Number.isSafeInteger(value) && value > 0
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const STUDY8_LIMITS = Object.freeze({ inputTokens: 1600000, outputTokens: 128000, httpAttempts: 192, concurrentRequests: 1, maxOutputTokensPerRequest: 4096 })
const trialLimits = Object.freeze({ inputTokens: 200000, outputTokens: 16000, httpAttempts: 24, elapsedSeconds: 1200 })
const runtimeLimits = Object.freeze({ maxDepth: 2, maxChildren: 8, maxTurns: 64, maxCellMs: 10000, maxOutputBytes: 8192 })
const frozen = Object.freeze({
  cases: '2814397eac66de436bb468ee40b49c07661626f7182468ae2a0447d72d26f33b',
  freeze: '12ff3b11810f39c3da6ca6aaeff22810c9aa186b23df4e8f12ecf973e6c3194c',
  schedule: '2dc83ffeea644f743f9d83ed51b64ed4e7904f0ebb2d62d55bacd6c926e213c2',
})

/** Stop waiting at the row's deadline without claiming the underlying remote execution stopped. */
export function study8Wait(promise, signal) {
  return new Promise(resolve => {
    let done = false
    const finish = value => { if (!done) { done = true; signal.removeEventListener('abort', aborted); resolve(value) } }
    const aborted = () => finish({ state: 'unknown', reason: 'row closed before execution receipt' })
    Promise.resolve(promise).then(value => finish({ state: 'settled', value }), error => finish({ state: 'failed', error }))
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}
/** Store the Worker execution identity separately from the command that requested its spawn. */
export function study8ChildContent(request, value) {
  return { kind: 'study8-real-worker-result', commandId: String(request.childSessionId) + ':worker',
    spawnCommandId: String(request.commandId), stopReason: value.stopReason, output: value.output }
}
export const STUDY8_PROMPT = 'Use typescript_repl for programmable analysis. The root REPL has the full original material in context.material; inspect all material needed to answer the question. Child REPLs receive only the task you explicitly pass. You may delegate through rlm(task, options); Host policy enforces child admission. Use rlm.listChildren() and rlm.readChildResult(child,{offset,limit}) to read results, retaining all segments when needed. There are no Node imports, filesystem, network or timers in this QuickJS guest. Return the final answer as text. Do not invent missing material or claim a tool succeeded without its result.'

/** Validate controller-owned runtime inputs before creating a claim, Runtime or Worker request. No JSON flag substitutes for callable proof. */
export function validateStudy8Binding(options) {
  const { route, bound, quote, admissionBinding } = options
  assert(route && ['provider', 'model', 'workerId', 'endpoint'].every(key => typeof route[key] === 'string' && route[key].length > 0), 'actual provider/model/worker/endpoint required')
  const url = new URL(route.endpoint)
  assert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'endpoint must contain no credentials or query')
  assert(route.reasoningEffort === 'high' && route.thinking === 'enabled' && digest(route.evidenceSHA256), 'fixed reasoning and verified route evidence required')
  assert(bound && digest(bound.evidenceSHA256) && bound.includesServerTemplate === true && bound.includesReasoningOutput === true
    && typeof bound.forRequest === 'function', 'supplier-valid input and reasoning-inclusive output bound required')
  assert(quote && typeof quote.currency === 'string' && quote.currency.length > 0 && digest(quote.evidenceSHA256)
    && Number.isFinite(Date.parse(quote.observedAt)) && quote.noAdditionalRequestOrServerToolFees === true
    && ['inputPerMillionUpper', 'outputPerMillionUpper'].every(key => Number.isFinite(quote[key]) && quote[key] >= 0), 'applicable dated complete tariff required')
  assert(admissionBinding && typeof admissionBinding.bind === 'function' && typeof admissionBinding.verifyRoute === 'function'
    && digest(admissionBinding.evidenceSHA256), 'original ledger verified-token admission binding unavailable')
  assert(isAbsolute(options.outputRoot), 'absolute isolated outputRoot required')
}

/** Read only runner-safe frozen inputs. Controller oracle files are never opened. */
export async function loadFrozenStudy8(paths) {
  const values = {}
  for (const key of ['cases', 'freeze', 'schedule']) {
    const bytes = await readFile(paths[key])
    assert.equal(sha(bytes), frozen[key], 'frozen ' + key + ' SHA mismatch')
    values[key] = JSON.parse(bytes)
  }
  const schedule = values.schedule.schedule
  const order = ['115010016:1:root-only', '115010016:1:recursive', '115010016:2:recursive', '115010016:2:root-only',
    '15000200:1:recursive', '15000200:1:root-only', '15000200:2:root-only', '15000200:2:recursive']
  assert.equal(values.cases.length, 2)
  assert.deepEqual(schedule.map(row => [row.case_id, row.repeat, row.spawnPolicy].join(':')), order)
  for (const row of schedule) {
    const item = values.cases.find(value => String(value.case_id) === row.case_id)
    assert(item && typeof item.context === 'string' && typeof item.question === 'string')
    assert.equal(item.input_sha256, row.input_sha256)
    assert.equal(sha(item.context + '\n' + item.question), row.input_sha256)
  }
  return { schedule, cases: values.cases, hashes: frozen }
}

async function durableNew(path, value) {
  const handle = await open(path, 'wx')
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() }
  finally { await handle.close() }
}

/** Totals use the original durable attempts, retaining unknown reservations. Absent usage never becomes zero. */
export function study8Accounting(attempts, quote) {
  const sent = attempts.filter(item => item.state !== 'refused')
  const complete = sent.every(item => item.state === 'settled' && item.usage && Number.isFinite(item.usage.input) && Number.isFinite(item.usage.output))
  const inputHeldOrUsed = sent.reduce((sum, item) => sum + (item.state === 'settled' && item.usage ? item.usage.input : item.reservedInput), 0)
  const outputHeldOrUsed = sent.reduce((sum, item) => sum + (item.state === 'settled' && item.usage ? item.usage.output : item.reservedOutput), 0)
  return { acceptedAttempts: sent.length, complete, inputHeldOrUsed, outputHeldOrUsed,
    unknown: sent.some(item => item.state === 'unknown' || item.state !== 'settled'),
    actualTokens: complete ? { input: inputHeldOrUsed, output: outputHeldOrUsed } : null,
    currency: quote.currency,
    tariffCostUpper: (inputHeldOrUsed * quote.inputPerMillionUpper + outputHeldOrUsed * quote.outputPerMillionUpper) / 1000000,
    actualBilledCost: null }
}

/** Bind the original ledger's synchronous verified-token admission; supplier verification remains the controller's responsibility. */
export function study8LedgerBinding(ledger) {
  return { ledger, admit: (label, facts, proof) => ledger.admission(label, () => proof)(facts) }
}

/** A trusted binding must return a ticket from this exact ledger, with a durable reservation covering the exact request proof. */
export function study8Admission(ledger, binding, bound, route, label, priorRows, quote, check) {
  return facts => {
    check()
    assert.equal(facts.model, route.model)
    assert.equal(facts.reasoningEffort, route.reasoningEffort)
    assert.equal(facts.thinking, route.thinking)
    assert(facts.maxOutputTokens !== undefined && facts.maxOutputTokens <= 4096 && facts.maxOutputTokens > 0)
    const proof = bound.forRequest(facts)
    assert(proof && proof.model === facts.model && proof.bodySha256 === facts.bodySha256 && digest(proof.evidenceSHA256)
      && positive(proof.inputTokensUpperBound) && positive(proof.reasoningInclusiveOutputUpperBound), 'exact request token bound unavailable')
    assert(proof.reasoningInclusiveOutputUpperBound <= facts.maxOutputTokens, 'reasoning output is not bounded by the wire ceiling')
    const before = ledger.snapshot().state.attempts
    assert(!before.some(item => item.state === 'unknown' || item.state === 'reserved'), 'unknown or outstanding request holds the study slot')
    const rowAttempts = before.slice(priorRows)
    const totals = study8Accounting(rowAttempts, quote)
    assert(rowAttempts.length < 24 && totals.inputHeldOrUsed + proof.inputTokensUpperBound <= 200000
      && totals.outputHeldOrUsed + facts.maxOutputTokens <= 16000, 'trial cumulative cap exhausted')
    const ticket = binding.admit(label, facts, proof)
    const after = ledger.snapshot().state.attempts
    const attempt = after.at(-1)
    assert.equal(after.length, before.length + 1, 'binding must admit into the original ledger exactly once')
    assert(attempt && attempt.state === 'reserved' && attempt.model === facts.model && attempt.bodySha256 === facts.bodySha256
      && attempt.reservedInput >= proof.inputTokensUpperBound && attempt.reservedOutput >= proof.reasoningInclusiveOutputUpperBound,
    'original reservation does not cover supplier bounds')
    if (totals.inputHeldOrUsed + attempt.reservedInput > 200000 || totals.outputHeldOrUsed + attempt.reservedOutput > 16000) {
      ticket.abandon()
      throw new Error('original reservation exceeds remaining trial cap; reservation retained')
    }
    return ticket
  }
}

/** Bound local receipt waits by the row signal; closing the socket does not stop remote Runtime execution. */
export async function study8CellBridge(runtime, home, signal) {
  const socketPath = localIpcAddress(home, 'study8-cells')
  const registered = new Map(), cells = new Map(), sockets = new Set(), outbound = new Set()
  const check = () => { if (signal.aborted) throw signal.reason }
  const server = createServer(socket => {
    sockets.add(socket)
    const transport = new JsonRpcLineTransport(socket, socket)
    transport.onRequest((method, params) => {
      assert(method === 'tool.call' && params && typeof params.session_id === 'string' && typeof params.command_id === 'string'
        && params.tool === 'typescript_repl' && typeof params.arguments?.code === 'string', 'invalid study tool request')
      const bridge = registered.get(params.session_id)
      assert(bridge, 'session outside this trial')
      const key = JSON.stringify([params.session_id, params.command_id]), hash = sha(JSON.stringify(params))
      const previous = cells.get(key)
      if (previous) { assert.equal(previous.hash, hash, 'cell identity conflict'); return previous.promise }
      check()
      assert(cells.size < 64, 'shared trial cell cap exhausted')
      const cell = { hash, commandId: params.command_id, state: 'forwarded' }
      cells.set(key, cell)
      const receiptAbort = new AbortController()
      outbound.add(receiptAbort)
      cell.promise = requestLocalJsonRpc(bridge.socketPath, method, params, receiptAbort.signal, () => new Error('Runtime disconnected'))
        .then(value => { cell.state = 'settled'; return value }, error => { cell.state = 'unknown'; throw error })
        .finally(() => outbound.delete(receiptAbort))
      void cell.promise.catch(() => {})
      return cell.promise
    })
    socket.on('close', () => { sockets.delete(socket); transport.close() })
    transport.start()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  return { check, cells, async bridge(id) { check(); const value = await runtime.modelToolBridge(id); check(); registered.set(String(id), value); return { ...value, socketPath } },
    async close() {
      await study8Wait(Promise.allSettled([...cells.values()].map(cell => cell.promise)), signal)
      for (const cell of cells.values()) if (cell.state === 'forwarded') cell.state = 'unknown'
      for (const controller of outbound) controller.abort(new Error('local receipt wait closed; Runtime outcome remains unknown'))
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    } }
}

/**
 * Execute the frozen sequence once using actual configured ModelWorkers and Runtime. Caller supplies a trusted binding for the
 * original ledger's proven-token-count mode through `study8LedgerBinding`; missing route or supplier evidence is a preflight
 * refusal, never a byte-count fallback.
 * The report keeps all eight rows. An unknown attempt stops later rows and is never reconstructed or retried.
 */
export async function runStudy8(ctx, options) {
  validateStudy8Binding(options)
  const inputs = await loadFrozenStudy8(options.inputs)
  assert(await options.admissionBinding.verifyRoute(ctx, options.route), 'configured route does not match verified identity')
  await mkdir(options.outputRoot, { recursive: true })
  const runId = 'study8-' + randomUUID(), startedAt = now()
  await durableNew(join(options.outputRoot, 'started.json'), { runId, startedAt, frozen, route: options.route,
    boundEvidence: options.bound.evidenceSHA256, quote: options.quote, promptSHA256: sha(STUDY8_PROMPT), limits: STUDY8_LIMITS })
  const parsed = parseEvaluationScope(JSON.stringify({ version: 1, scopeId: runId, model: options.route.model,
    inputBound: 'proven-token-count', limits: STUDY8_LIMITS, generation: { thinking: 'enabled', reasoningEffort: 'high' } }))
  const ledger = EvaluationLedger.open(join(options.outputRoot, 'ledger.json'), parsed.scope, parsed.sha256)
  const journal = openSync(join(options.outputRoot, 'request-events.jsonl'), 'wx')
  const append = event => { writeSync(journal, JSON.stringify({ at: now(), ...event }) + '\n'); fsyncSync(journal) }
  let binding, studyError, observedPhysicalDispatches = 0
  const rows = inputs.schedule.map(row => ({ ...row, executionId: null, status: 'not-started', quality: null }))
  try {
    binding = options.admissionBinding.bind(ledger)
    assert(binding && binding.ledger === ledger && typeof binding.admit === 'function', 'admission owner must be the original ledger')
    const studyDeadline = Date.now() + 9600000
    for (const [index, row] of rows.entries()) {
      if (Date.now() >= studyDeadline) { row.status = 'not-started-study-deadline'; continue }
      const item = inputs.cases.find(value => String(value.case_id) === row.case_id)
      const home = join(options.outputRoot, row.designTrialKey)
      await mkdir(home)
      row.executionId = runId + ':' + String(index + 1)
      row.startedAt = now()
      await durableNew(join(home, 'started.json'), { ...row, route: options.route })
      const firstAttempt = ledger.snapshot().state.attempts.length
      const abort = new AbortController(), deadline = setTimeout(() => abort.abort(new Error('trial deadline exceeded')), Math.min(1200000, studyDeadline - Date.now()))
      const workers = [], physical = [], jobs = [], children = [], resultReads = [], results = new Map()
      let proxy, rootResult, error, unresolvedWork = false
      const root = RlmRuntimeSessionId(row.executionId)
      const worker = async (session, task) => {
        proxy.check()
        const commandId = String(session) + ':worker'
        const prompt = [{ type: 'text', text: STUDY8_PROMPT + '\nQuestion/task:\n' + task }]
        const record = { commandId, sessionId: String(session), startedAt: now(), prompt, promptSHA256: sha(JSON.stringify(prompt)) }
        workers.push(record)
        try {
          const bridge = await proxy.bridge(session)
          record.toolManifestSHA256 = sha(JSON.stringify(bridge.tools))
          const result = await ctx.modelWorkers.execute({ commandId, workerId: options.route.workerId, model: options.route.model,
            prompt, modelToolBridge: bridge, toolExecution: { version: 1, maxToolRounds: 64 }, signal: abort.signal,
            evaluation: { model: options.route.model, maxOutputTokens: 4096, reasoningEffort: 'high',
              remainingOutputTokens: () => Math.min(ledger.remainingOutputTokens(), 16000 - study8Accounting(ledger.snapshot().state.attempts.slice(firstAttempt), options.quote).outputHeldOrUsed),
              admission: label => study8Admission(ledger, binding, { ...options.bound, forRequest: facts => {
                const proof = options.bound.forRequest(facts)
                append({ kind: 'bound-proof', commandId, label, bodySha256: facts.bodySha256, proof })
                return proof
              } }, options.route, label, firstAttempt, options.quote, proxy.check) },
            physicalRequestObserver: facts => {
              const observed = { commandId, facts, events: [] }; physical.push(observed)
              const event = kind => {
                if (kind === 'dispatching') {
                  const attempt = ledger.snapshot().state.attempts.at(-1)
                  assert(attempt?.state === 'reserved' && attempt.bodySha256 === facts.bodySha256, 'dispatch without original durable reservation')
                  assert(observed.attemptId === undefined, 'duplicate dispatch event')
                  observed.attemptId = attempt.id
                  observedPhysicalDispatches++
                }
                observed.events.push({ kind, at: now() })
                append({ kind, commandId, attemptId: observed.attemptId ?? null, facts })
                if (kind === 'unknown') abort.abort(new Error('unknown provider outcome; no later study dispatch'))
              }
              return { dispatching: () => event('dispatching'), notSent: () => event('not-sent'), terminalResponse: () => event('terminal'), unknown: () => event('unknown') }
            } })
          record.result = result
          return result
        } catch (failure) { record.error = String(failure); throw failure }
        finally { record.finishedAt = now() }
      }
      const bindings = { readResult: async request => {
        const stored = results.get(request.resultRef)
        if (!stored) return undefined
        assert(stored.parent === String(request.sessionId) && stored.child === String(request.childSessionId) && stored.childId === String(request.childId), 'result owner mismatch')
        resultReads.push({ ...request, at: now(), sha256: sha(JSON.stringify(stored.content)) })
        return stored.content
      }, dispatchChild: async request => {
        proxy.check()
        assert.equal(request.model.model, options.route.model, 'child may not switch model')
        assert.equal(request.model.operatorId, options.route.workerId, 'child may not switch worker')
        children.push({ childId: String(request.childId), sessionId: String(request.childSessionId), parent: String(request.parentSessionId), depth: request.depth })
        await ctx.rlmRuntime.bindHost(request.childSessionId, bindings)
        const job = worker(request.childSessionId, request.task)
        jobs.push(job)
        return { nativeSessionId: String(request.childSessionId), nativeTurnId: String(request.commandId), interrupt: () => { abort.abort(new Error('child interrupted')); return Promise.resolve() },
          result: job.then(value => {
            const ref = 'study8-result:' + sha(JSON.stringify([request.childId, value]))
            results.set(ref, { parent: String(request.parentSessionId), child: String(request.childSessionId), childId: String(request.childId),
              content: study8ChildContent(request, value) })
            return { status: value.stopReason === 'completed' ? 'settled' : 'indeterminate', resultRef: ref, stopReason: value.stopReason, output: value.output }
          }, failure => ({ status: 'failed', error: String(failure) })) }
      } }
      try {
        proxy = await study8CellBridge(ctx.rlmRuntime, home, abort.signal)
        await ctx.rlmRuntime.create({ sessionId: root, commandId: RlmCommandId(row.executionId + ':create'), executionId: row.executionId,
          workspace: home, task: item.question, context: { material: item.context },
          model: { operatorId: options.route.workerId, model: options.route.model, profile: { model: options.route.model, effort: 'high' } },
          limits: runtimeLimits, childSpawnPolicy: { version: 1, mode: row.spawnPolicy, maxTotalChildren: 8 } }, bindings)
        const outcome = await study8Wait(worker(root, item.question), abort.signal)
        if (outcome.state === 'unknown') unresolvedWork = true
        else if (outcome.state === 'failed') throw outcome.error
        else rootResult = outcome.value
      } catch (failure) { error = String(failure) }
      finally {
        for (let position = 0; position < jobs.length; position++) {
          const outcome = await study8Wait(jobs[position], abort.signal)
          if (outcome.state === 'unknown') unresolvedWork = true
        }
        abort.abort(new Error('trial closed; later admission and child dispatch unavailable'))
        if (proxy) await proxy.close()
        clearTimeout(deadline)
      }
      const attempts = ledger.snapshot().state.attempts.slice(firstAttempt)
      const accounting = study8Accounting(attempts, options.quote)
      const unknown = unresolvedWork || accounting.unknown || [...(proxy?.cells.values() ?? [])].some(cell => cell.state !== 'settled')
      const sends = physical.filter(value => value.events.some(event => event.kind === 'dispatching'))
      const transportComplete = sends.length === attempts.filter(value => value.state !== 'refused').length
        && new Set(sends.map(value => value.attemptId)).size === sends.length
      if (!error && workers.some(value => value.result && !sends.some(send => send.commandId === value.commandId))) error = 'Worker returned without an observed admitted physical request'
      row.status = unknown || !transportComplete ? 'unknown' : attempts.some(value => value.state === 'refused') ? 'refused' : error || workers.some(value => value.error) ? 'failed'
        : rootResult?.stopReason === 'completed' ? 'completed' : rootResult?.stopReason ?? 'failed'
      row.finishedAt = now(); row.elapsedMs = Date.parse(row.finishedAt) - Date.parse(row.startedAt)
      row.accounting = accounting; row.error = error ?? null
      row.unresolvedWork = unresolvedWork; row.remoteStopProven = false
      row.output = rootResult?.output ?? null
      row.outputSHA256 = row.output === null ? null : sha(JSON.stringify(row.output))
      await durableNew(join(home, 'evidence.json'), { runId, row, route: options.route, attempts, workers, physical, children, resultReads,
        cells: [...(proxy?.cells.values() ?? [])].map(({ promise: _, ...cell }) => cell), inputSHA256: item.input_sha256,
        contextSHA256: sha(item.context), questionSHA256: sha(item.question), quote: options.quote,
        quality: null, qualityOwner: 'separate controller-only official scorer', observedPhysicalDispatches: sends.length })
      if (row.status === 'unknown') { for (const later of rows.slice(index + 1)) later.status = 'not-started-prior-unknown'; break }
    }
  } catch (failure) { studyError = String(failure); throw failure }
  finally {
    await durableNew(join(options.outputRoot, 'report.json'), { runId, startedAt, finishedAt: now(), rows, ledger: ledger.snapshot(),
      route: options.route, quote: options.quote, limits: STUDY8_LIMITS, trialLimits, runtimeLimits,
      accounting: study8Accounting(ledger.snapshot().state.attempts, options.quote), quality: null,
      error: studyError ?? null,
      qualityOwner: 'separate controller-only official scorer', observedPhysicalDispatches })
    closeSync(journal)
    ledger.close()
  }
  return { runId, reportPath: join(options.outputRoot, 'report.json'), rows }
}
