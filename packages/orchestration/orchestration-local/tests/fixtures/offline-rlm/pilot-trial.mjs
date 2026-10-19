/** Four-arm keyless Consumer using the actual Worker, Runtime and original evaluation ledger. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { EvaluationLedger, parseEvaluationScope } from '@deepseek-ai/dsh-orchestration-local'
import { RlmCommandId, RlmRuntimeSessionId } from '@deepseek-ai/dsh-rlm-runtime'
import { state } from './adapter.mjs'
import { cellProxy, usageComplete } from './trial.mjs'

export const sha = value => createHash('sha256').update(value).digest('hex')
export const fakeModel = 'scripted-offline-model'
const specs = {
  codeact_bm25: { placement: 'full', spawn: 'none' },
  chunk_map_reduce: { placement: 'chunks', spawn: 'root-only' },
  rlm_nosub: { placement: 'external', spawn: 'none' },
  rlm_full: { placement: 'external', spawn: 'recursive' },
}
const limits = { maxDepth: 2, maxChildren: 8, maxTurns: 16, maxCellMs: 10_000, maxOutputBytes: 8192 }
const policy = { version: 1, maxToolRounds: 4 }
const stamp = () => ({ at: new Date().toISOString(), monotonicMs: performance.now() })
const source = 'actual-loader-worker-runtime/scripted-inprocess-adapter'

/** Execute once in a new claim directory; an existing claim never reconstructs a trial. */
export async function runPilotTrial(ctx, home, input, scheduled, preparation, diagnostic = 'none') {
  const spec = specs[scheduled.arm]
  assert(spec, 'unsupported fake pilot arm')
  assert.match(scheduled.trial_id, /^[a-zA-Z0-9-]+$/)
  assert.equal(scheduled.case_id, input.case_id)
  assert.equal(scheduled.input_sha256, sha(input.context + '\n' + input.question))
  assert.equal(input.input_sha256, scheduled.input_sha256)
  const raw = Buffer.from(input.context)
  assert.equal(preparation.context_sha256, sha(raw))
  assert.equal(preparation.context_bytes, raw.length)
  assert.equal(Buffer.concat(preparation.chunks.map(chunk => Buffer.from(chunk.text))).compare(raw), 0)
  await mkdir(home, { recursive: true })
  const claim = await open(join(home, 'started'), 'wx')
  const started = stamp()
  await claim.writeFile(JSON.stringify({ trial: scheduled, diagnostic, source, started }) + '\n')
  await claim.close()
  const sessionId = RlmRuntimeSessionId('pilot-' + scheduled.trial_id)
  const corpusPath = join(home, 'context.txt')
  await writeFile(corpusPath, raw, { flag: 'wx' })
  const bm25Path = join(home, 'bm25.json')
  await writeFile(bm25Path, JSON.stringify(preparation.bm25) + '\n', { flag: 'wx' })
  const scopeInput = parseEvaluationScope(JSON.stringify({
    version: 1, scopeId: String(sessionId), model: fakeModel, inputBound: 'request-bytes-audited',
    limits: { inputTokens: 200000, outputTokens: 16000, httpAttempts: 24,
      concurrentRequests: 1, maxOutputTokensPerRequest: 4096 },
    generation: { thinking: 'enabled', reasoningEffort: 'high' },
  }))
  const ledger = EvaluationLedger.open(join(home, 'ledger.json'), scopeInput.scope, scopeInput.sha256)
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(new Error('trial admission deadline')), 1200_000)
  const entries = [], sends = [], physical = [], workers = [], jobs = [], children = [], resultReads = []
  const storedResults = new Map()
  let proxy
  proxy = await cellProxy(ctx.rlmRuntime, home, abort.signal, 64, () => {
    const cell = [...proxy.cells.values()].at(-1)
    cell.forwardObserved = stamp()
    void cell.promise.then(() => { cell.settledObserved = stamp() },
      () => { cell.unknownObserved = stamp() })
  })
  const metaPrefix = 'PILOT_META:'
  const readCode = "const fs = await import('node:fs/promises'); const {TextDecoder} = await import('node:util'); const f = await fs.open(context.corpus.path, 'r'); "
    + "const b = Buffer.alloc(Math.min(64, context.corpus.bytes)); const r = await f.read(b, 0, b.length, 0); "
    + "await f.close(); console.log(new TextDecoder('utf-8', {fatal:true}).decode(b.subarray(0,r.bytesRead), {stream:true}));"
  const readChildCode = "const readComplete = async child => { let r = await rlm.readChildResult(child); "
    + "while(r.status==='not_settled'){ await new Promise(resolve=>setTimeout(resolve,10)); r=await rlm.readChildResult(child); } "
    + "if(r.status!=='settled'||!r.complete||r.truncated||r.stopReason!=='completed') throw new Error('incomplete child result'); return r; };"
  const trial = { entries, sends, lastAdmittedId: undefined, script(options) {
    const firstText = options.messages[0].content.find(block => block.type === 'text').text
    const meta = JSON.parse(firstText.split('\n')[0].slice(metaPrefix.length))
    if (diagnostic === 'unknown' && meta.role === 'root') return { kind: 'unknown' }
    if (options.messages.at(-1).content.some(block => block.type === 'tool-result')) return { kind: 'final' }
    if (diagnostic === 'tool-failure' && meta.role === 'root') {
      return { kind: 'tool', code: "throw new Error('FAKE_PILOT_TOOL_FAILURE');" }
    }
    if (scheduled.arm === 'chunk_map_reduce' && meta.role === 'root') {
      return { kind: 'tool', code: readChildCode + "const maps = []; for (let i=0;i<context.chunks.length;i++) { "
        + "const h = await rlm('map:'+i, {name:'map-'+i}); maps.push({index:i,result:await readComplete(h)}); } console.log(JSON.stringify(maps));" }
    }
    if (meta.role === 'map') return { kind: 'tool', code: "console.log('MAP_CELL_EXECUTED');" }
    if (scheduled.arm === 'codeact_bm25') {
      return { kind: 'tool', code: "const fs = await import('node:fs/promises'); "
        + "const b = await fs.readFile(context.bm25Path); if(b.length>8192) throw new Error('material read cap'); console.log(b.toString('utf8'));" }
    }
    let code = meta.depth === 0 ? readCode : "console.log('RLM_CHILD_CELL_EXECUTED');"
    if (scheduled.arm === 'rlm_full' && meta.depth < 2) {
      code += readChildCode + "const h = await rlm('child depth " + String(meta.depth + 1)
        + "', {name:'depth-" + String(meta.depth + 1) + "'}); console.log(JSON.stringify(await readComplete(h)));"
    }
    return { kind: 'tool', code }
  } }
  state.current = trial

  async function worker(session, role, depth, mapIndex) {
    proxy.check()
    const commandId = String(session) + ':worker'
    const identity = { trial_id: scheduled.trial_id, case_id: input.case_id, input_sha256: input.input_sha256,
      arm: scheduled.arm, role, depth, ...mapIndex === undefined ? {} : { mapIndex } }
    const prompt = [{ type: 'text', text: metaPrefix + JSON.stringify(identity) + '\nQuestion: ' + input.question }]
    if (role === 'root' && spec.placement === 'full') prompt.push({ type: 'text', text: input.context })
    else if (role === 'map') prompt.push({ type: 'text', text: preparation.chunks[mapIndex].text })
    else prompt.push({ type: 'text', text: 'Corpus reference: ' + JSON.stringify({ path: corpusPath, bytes: raw.length, sha256: sha(raw) }) })
    const execution = { commandId, sessionId: String(session), identity, model: fakeModel, prompt,
      started: stamp(), source }
    workers.push(execution)
    try {
      const bridge = await proxy.bridge(session)
      proxy.check()
      const result = await ctx.modelWorkers.execute({
        commandId, workerId: 'deepseek-api', model: fakeModel, prompt, toolExecution: policy,
        modelToolBridge: bridge, signal: abort.signal,
        evaluation: {
          model: fakeModel, maxOutputTokens: 4096, reasoningEffort: 'high',
          remainingOutputTokens: () => ledger.remainingOutputTokens(),
          admission: label => facts => {
            proxy.check()
            const before = ledger.snapshot().state.attempts.length
            try { return ledger.admission(label)(facts) } finally {
              const attempts = ledger.snapshot().state.attempts
              if (attempts.length > before) {
                const attempt = attempts.at(-1)
                trial.lastAdmittedId = attempt.id
                const entry = entries.at(-1)
                Object.assign(entry, { attemptId: attempt.id, commandId, label, admissionObserved: stamp() })
                Object.assign(physical.at(-1), { attemptId: attempt.id, label })
              }
            }
          },
        },
        physicalRequestObserver: facts => {
          const item = { commandId, facts: structuredClone(facts), observed: stamp(), events: [] }
          physical.push(item)
          const event = kind => item.events.push({ kind, ...stamp() })
          return { dispatching: () => event('dispatching'), notSent: () => event('not-sent'),
            terminalResponse: () => event('terminal'), unknown: () => event('unknown') }
        },
      })
      execution.result = structuredClone(result)
      return result
    } catch (error) {
      execution.error = { message: String(error), code: error?.code ?? null }
      throw error
    } finally { execution.finished = stamp() }
  }

  const bindings = { readResult: async request => {
    const stored = storedResults.get(request.resultRef)
    if (!stored) return undefined
    assert.equal(stored.parentSessionId, String(request.sessionId))
    assert.equal(stored.childSessionId, String(request.childSessionId))
    assert.equal(stored.childId, String(request.childId))
    resultReads.push({ request: structuredClone(request), observed: stamp(), contentSha256: sha(JSON.stringify(stored.content)) })
    return structuredClone(stored.content)
  }, dispatchChild: async request => {
    proxy.check()
    let mapIndex
    const role = scheduled.arm === 'chunk_map_reduce' ? 'map' : 'child'
    if (role === 'map') {
      assert.match(request.name, /^map-\d+$/)
      mapIndex = Number(request.name.slice(4))
      assert.equal(request.depth, 1)
      assert(mapIndex < preparation.chunks.length)
      assert(!children.some(child => child.mapIndex === mapIndex), 'duplicate map dispatch')
    }
    children.push({ commandId: String(request.commandId), parentSessionId: String(request.parentSessionId),
      childSessionId: String(request.childSessionId), depth: request.depth, role, mapIndex, observed: stamp() })
    await ctx.rlmRuntime.bindHost(request.childSessionId, bindings)
    const promise = worker(request.childSessionId, role, request.depth, mapIndex)
    jobs.push(promise)
    return { nativeSessionId: String(request.childSessionId), nativeTurnId: String(request.commandId),
      result: promise.then(result => {
        const commandId = String(request.childSessionId) + ':worker'
        const resultRef = 'fake-result:' + sha(JSON.stringify([request.childId, commandId, result]))
        storedResults.set(resultRef, { resultRef, childId: String(request.childId),
          childSessionId: String(request.childSessionId), parentSessionId: String(request.parentSessionId),
          content: { kind: 'fake-pilot-worker-result', commandId, stopReason: result.stopReason, output: result.output } })
        return { status: result.stopReason === 'completed' ? 'settled' : 'indeterminate',
          resultRef, output: result.output, stopReason: result.stopReason }
      },
      error => ({ status: 'failed', error: String(error) })),
      interrupt: () => { abort.abort(new Error('trial interrupted')); return Promise.resolve() } }
  } }
  let rootResult, rootError, drained = false
  try {
    const context = { corpus: { path: corpusPath, bytes: raw.length, sha256: sha(raw) },
      ...spec.placement === 'full' ? { rawCorpus: input.context } : {},
      bm25Path, chunks: preparation.chunks.map(({ start, end, sha256 }) => ({ start, end, sha256 })) }
    await ctx.rlmRuntime.create({ sessionId, commandId: RlmCommandId(String(sessionId) + ':create'),
      executionId: scheduled.trial_id, workspace: home, task: input.question,
      model: { operatorId: 'deepseek-api', model: fakeModel }, limits,
      childSpawnPolicy: { version: 1, mode: spec.spawn, maxTotalChildren: spec.spawn === 'none' ? 0 : 8 },
      context }, bindings)
    try { rootResult = await worker(sessionId, 'root', 0) } catch (error) { rootError = String(error) }
    for (let i = 0; i < jobs.length; i++) await Promise.allSettled([jobs[i]])
    const atCallerReturn = [...proxy.cells.values()].map(cell => cell.state)
    await proxy.close()
    drained = true
    const runtime = JSON.parse(await readFile(join(process.env.DSH_HOME, 'runtime/state.json'), 'utf8'))
    const sessions = new Set(workers.map(w => w.sessionId))
    sessions.add(String(sessionId))
    const runtimeEvidence = {
      version: runtime.version, eventSequence: runtime.eventSequence,
      sessions: runtime.sessions.filter(s => sessions.has(s.snapshot.sessionId)),
      receipts: runtime.receipts.filter(r => sessions.has(r.sessionId ?? r.result?.sessionId)
        || String(r.commandId).startsWith(String(sessionId) + ':')),
      events: runtime.events.filter(e => sessions.has(e.sessionId)),
    }
    const cells = [...proxy.cells.values()].map(({ promise: _promise, ...cell }) => {
      const receipt = runtimeEvidence.receipts.find(r => r.commandId === cell.params.command_id)
      return { ...cell, runtimeReceiptState: receipt?.state ?? null }
    })
    const snapshot = ledger.snapshot()
    const toolErrors = entries.flatMap(entry => entry.request.messages)
      .flatMap(message => message.content).filter(block => block.type === 'tool-result' && block.isError)
    const unresolvedCell = cells.some(cell => cell.runtimeReceiptState === null
      || ['accepted', 'running', 'indeterminate'].includes(cell.runtimeReceiptState))
    const failedCell = cells.some(cell => cell.runtimeReceiptState === 'failed')
    const expectedChildren = scheduled.arm === 'chunk_map_reduce' ? preparation.chunks.length
      : scheduled.arm === 'rlm_full' ? 2 : 0
    const missingWork = children.length !== expectedChildren || workers.some(w => !w.result && !w.error)
    const unknown = snapshot.totals.unknown > 0 || unresolvedCell
    const failed = Boolean(rootError) || failedCell || toolErrors.length > 0
      || snapshot.totals.refused > 0 || Boolean(snapshot.state.boundViolation)
      || missingWork || workers.some(w => w.error || ['error', 'refusal'].includes(w.result?.stopReason))
    const terminal = unknown ? 'unknown' : failed ? 'failed'
      : workers.some(w => w.result?.stopReason === 'max-tokens') ? 'truncated'
        : workers.some(w => w.result?.stopReason === 'aborted') ? 'aborted' : 'completed'
    const rawOutput = rootResult === undefined ? null
      : rootResult.output.filter(block => block.type === 'text').map(block => block.text).join('')
    const firstRoot = entries.find(entry => entry.commandId === String(sessionId) + ':worker')
    const persistent = runtimeEvidence.sessions.find(s => s.snapshot.sessionId === String(sessionId)).context
    const report = {
      schemaVersion: 1, source, fakeOnly: true, nativeProcess: { pid: process.pid, node: process.version,
        argv: process.argv, execArgv: process.execArgv, mode: process.env.DSH_EXAMPLE_MODE ?? 'src' },
      trial: scheduled, caseIdentity: { case_id: input.case_id, input_sha256: input.input_sha256,
        contextSha256: sha(raw), questionSha256: sha(input.question) },
      diagnostic, model: fakeModel, sessionId: String(sessionId), started, finished: stamp(),
      placement: spec.placement, spawnPolicy: spec.spawn, limits, toolExecution: policy,
      inputBound: 'request-bytes-audited', scope: scopeInput,
      preparation, entries, sends, physical, workers, children, cells, atCallerReturn,
      storedResults: [...storedResults.values()], resultReads,
      fixtureMaterialRead: { offset: 0, requestedBytes: Math.min(64, raw.length), capBytes: 8192 },
      runtime: runtimeEvidence, ledger: snapshot, usageComplete: usageComplete(snapshot, sends),
      fakeUsageOnly: true, rawOutput, rawOutputSha256: rawOutput === null ? null : sha(rawOutput),
      rootResult: rootResult ?? null, rootError: rootError ?? null, terminal,
      reasons: { unknownAttempts: snapshot.totals.unknown, unresolvedCell, failedCell,
        toolErrors: toolErrors.length, missingWork, refused: snapshot.totals.refused,
        boundViolation: snapshot.state.boundViolation ?? null },
      initialRootHasFullContext: Boolean(firstRoot?.request.messages[0].content
        .some(block => block.type === 'text' && block.text === input.context)),
      persistentHasFullContext: 'rawCorpus' in persistent,
      originalContextSha256: sha(await readFile(corpusPath)),
      readLimitScope: 'Checked fixture cells only; arbitrary Runtime filesystem access is not isolated',
      paidLaunchAllowed: false, experimentReady: false,
    }
    await writeFile(join(home, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    return { report, evidencePath: join(home, 'evidence.json') }
  } finally {
    state.current = undefined
    clearTimeout(deadline)
    if (!drained) await proxy.close()
    ledger.close()
  }
}
