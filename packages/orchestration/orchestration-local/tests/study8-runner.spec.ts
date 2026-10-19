import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { RlmCommandId, RlmRuntimeSessionId, type RlmRuntimeHostBindings } from '@deepseek-ai/dsh-rlm-runtime'
import { LocalRlmRuntime } from '@deepseek-ai/dsh-rlm-runtime-local'
import { requestLocalJsonRpc } from '@deepseek-ai/dsh-sdk-protocol'
import type { RequestAdmissionInput } from '@deepseek-ai/dsh-llm'
import { EvaluationLedger, parseEvaluationScope } from '@deepseek-ai/dsh-orchestration-local'
import { expect, it, vi } from 'vitest'
import { runStudy8, STUDY8_LIMITS, study8Accounting, study8Admission, study8CellBridge, study8ChildContent, study8LedgerBinding, study8Wait, validateStudy8Binding } from './fixtures/study8/runner.mjs'

const evidence = 'a'.repeat(64)
const route = { provider: 'synthetic-provider', model: 'synthetic-model', workerId: 'deepseek-api', endpoint: 'http://127.0.0.1:1',
  reasoningEffort: 'high', thinking: 'enabled', evidenceSHA256: evidence } as const
const facts = { model: route.model, reasoningEffort: 'high', thinking: 'enabled', bodySha256: 'b'.repeat(64), bodyBytes: 100,
  maxOutputTokens: 4096, hasNonTextContent: false } as const
const bound = { evidenceSHA256: evidence, includesServerTemplate: true, includesReasoningOutput: true,
  forRequest: () => ({ model: route.model, bodySha256: facts.bodySha256, evidenceSHA256: evidence,
    inputTokensUpperBound: 1000, reasoningInclusiveOutputUpperBound: 4096 }) }
const quote = { currency: 'synthetic-only', observedAt: '2026-10-19T00:00:00Z', evidenceSHA256: evidence,
  inputPerMillionUpper: 1, outputPerMillionUpper: 2, noAdditionalRequestOrServerToolFees: true }

it('ends the local receipt wait for a Runtime connection that never answers and retains unknown', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-study8-pending-cell-'))
  const pendingSocket = join(home, 'never.sock')
  const sockets = new Set<import('node:net').Socket>()
  const server = createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(pendingSocket, resolve) })
  const abort = new AbortController()
  const proxy = await study8CellBridge({ modelToolBridge: async () => ({ version: 1, sessionId: 'pending', socketPath: pendingSocket, tools: [] }) }, home, abort.signal)
  try {
    const bridge = await proxy.bridge(RlmRuntimeSessionId('pending'))
    const request = requestLocalJsonRpc(bridge.socketPath, 'tool.call', { session_id: 'pending', command_id: 'never', tool: 'typescript_repl', arguments: { code: '1' } }, new AbortController().signal, () => new Error('proxy closed'))
    void request.catch(() => {})
    await vi.waitFor(() => { expect(proxy.cells.size).toBe(1) })
    abort.abort(new Error('row deadline'))
    await proxy.close()
    expect([...proxy.cells.values()][0]!.state).toBe('unknown')
    await expect(request).rejects.toThrow()
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(home, { recursive: true, force: true })
  }
})

it('stops waiting for a child job that remains pending after cancellation without claiming completion', async () => {
  const abort = new AbortController()
  let finished = false
  const job = new Promise(() => {}).then(() => { finished = true })
  const waiting = study8Wait(job, abort.signal)
  abort.abort(new Error('row deadline'))
  expect(await waiting).toMatchObject({ state: 'unknown' })
  expect(finished).toBe(false)
})

it('returns the fake child Worker command identity through the actual Runtime result reader', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-study8-child-identity-'))
  const ctx = new Context()
  const runtime = new LocalRlmRuntime(ctx, { root: home, kernel: { kind: 'quickjs-wasm', memoryLimitBytes: 33554432, maxStackBytes: 262144,
    maxInterruptChecks: 10000, maxBridgeBytes: 1048576, maxLogBytes: 8192, maxCellSourceBytes: 65536,
    maxHostCalls: 32, maxPendingHostCalls: 4, jobBatchSize: 8 } })
  const workerRecords: { commandId: string }[] = [], requestEvents: { commandId: string }[] = []
  let content: ReturnType<typeof study8ChildContent> | undefined
  const bindings: RlmRuntimeHostBindings = {
    dispatchChild: async (request) => {
      const commandId = String(request.childSessionId) + ':worker'
      workerRecords.push({ commandId }); requestEvents.push({ commandId })
      content = study8ChildContent(request, { stopReason: 'completed', output: [{ type: 'text', text: 'fake child success' }] })
      return { nativeSessionId: String(request.childSessionId), nativeTurnId: commandId, interrupt: () => Promise.resolve(),
        result: Promise.resolve({ status: 'settled', stopReason: 'completed', resultRef: 'fake-result', output: content.output }) }
    }, readResult: async () => content }
  const sessionId = RlmRuntimeSessionId('identity-root')
  try {
    await runtime.create({ sessionId, commandId: RlmCommandId('identity-create'), executionId: 'no-model-identity', workspace: home,
      task: 'synthetic identity only', model: { operatorId: 'fake-only', model: 'fake' }, context: {},
      limits: { maxDepth: 2, maxChildren: 8, maxTurns: 64, maxCellMs: 5000, maxOutputBytes: 8192 },
      childSpawnPolicy: { version: 1, mode: 'root-only', maxTotalChildren: 8 } }, bindings)
    const result = await runtime.executeCell({ sessionId, commandId: RlmCommandId('identity-cell'),
      code: 'let child=await rlm("fake identity"); let result=await rlm.readChildResult(child); while(result.status==="not_settled"){ await rlm.listChildren(); result=await rlm.readChildResult(child); } result' })
    expect(result.value).toMatchObject({ commandId: workerRecords[0]!.commandId, text: 'fake child success' })
    expect(requestEvents[0]!.commandId).toBe(workerRecords[0]!.commandId)
    if (content === undefined) throw new Error('the child result reader did not retain its content')
    expect(content.spawnCommandId).not.toBe(content.commandId)
  } finally { await ctx.root.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('refuses missing real route or callable token/ledger bindings before any study claim or Worker call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-study8-gate-'))
  const ctx = { modelWorkers: { execute: vi.fn() } }
  const options = { outputRoot: root, route, bound, quote }
  try {
    expect(() => { validateStudy8Binding({ ...options, route: undefined }) }).toThrow('actual provider')
    expect(() => { validateStudy8Binding({ ...options, bound: { ...bound, forRequest: true } }) }).toThrow('supplier-valid')
    await expect(runStudy8(ctx, options)).rejects.toThrow('original ledger verified-token admission binding unavailable')
    expect(ctx.modelWorkers.execute).not.toHaveBeenCalled()
    await expect(readFile(join(root, 'started.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('requires fixed reasoning, complete quote and a nonsecret endpoint', () => {
  const options = { outputRoot: '/tmp/study8-never-started', route, bound, quote,
    admissionBinding: { evidenceSHA256: evidence, bind() {}, verifyRoute() {} } }
  expect(() => { validateStudy8Binding(options) }).not.toThrow()
  expect(() => { validateStudy8Binding({ ...options, route: { ...route, endpoint: 'https://user:secret@example.test' } }) }).toThrow('credentials')
  expect(() => { validateStudy8Binding({ ...options, route: { ...route, reasoningEffort: 'low' } }) }).toThrow('fixed reasoning')
  expect(() => { validateStudy8Binding({ ...options, bound: { ...bound, includesReasoningOutput: false } }) }).toThrow('reasoning-inclusive')
  expect(() => { validateStudy8Binding({ ...options, quote: { ...quote, noAdditionalRequestOrServerToolFees: false } }) }).toThrow('tariff')
})

it('keeps unknown token reservations and leaves actual token and billing totals unknown', () => {
  const attempts: Parameters<typeof study8Accounting>[0] = [{ state: 'settled', reservedInput: 900, reservedOutput: 4096, usage: { input: 30, output: 20 } },
    { state: 'unknown', reservedInput: 1000, reservedOutput: 4096 }]
  expect(study8Accounting(attempts, quote)).toMatchObject({ acceptedAttempts: 2, complete: false, unknown: true,
    inputHeldOrUsed: 1030, outputHeldOrUsed: 4116, actualTokens: null, actualBilledCost: null })
})

it('rejects wrong request proofs and existing unknown reservations before invoking the admission binding', () => {
  const admit = vi.fn()
  const ledger = { snapshot: () => ({ state: { attempts: [] } }) }
  expect(() => study8Admission(ledger, { admit }, { ...bound, forRequest: () => ({ ...bound.forRequest(), bodySha256: 'c'.repeat(64) }) }, route, 'row#round0', 0, quote, () => {})(facts)).toThrow('exact request')
  const unknown = { snapshot: () => ({ state: { attempts: [{ state: 'unknown' as const, reservedInput: 1000, reservedOutput: 4096 }] } }) }
  expect(() => study8Admission(unknown, { admit }, bound, route, 'row#round0', 0, quote, () => {})(facts)).toThrow('holds the study slot')
  expect(admit).not.toHaveBeenCalled()
})

it('preserves original proven-token-count refusal rather than coercing bytes or adding a ledger field', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-study8-original-ledger-'))
  const parsed = parseEvaluationScope(JSON.stringify({ version: 1, scopeId: 'study8-preflight-only', model: route.model,
    inputBound: 'proven-token-count', limits: { inputTokens: 1600000, outputTokens: 128000, httpAttempts: 192,
      concurrentRequests: 1, maxOutputTokensPerRequest: 4096 }, generation: { thinking: 'enabled', reasoningEffort: 'high' } }))
  const ledger = EvaluationLedger.open(join(home, 'ledger.json'), parsed.scope, parsed.sha256)
  try {
    const binding = { ledger, admit: (label: string, request: RequestAdmissionInput) => ledger.admission(label)(request) }
    expect(() => study8Admission(ledger, binding, bound, route, 'row#round0', 0, quote, () => {})(facts)).toThrow()
    expect(ledger.snapshot().state.attempts).toHaveLength(1)
    expect(ledger.snapshot().state.attempts[0]).toMatchObject({ state: 'refused', refusal: 'input-bound-unproven' })
  } finally { ledger.close(); await rm(home, { recursive: true, force: true }) }
})

it('binds the Consumer to the original ledger and persists the synthetic token proof before downstream send', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-study8-bound-ledger-'))
  const parsed = parseEvaluationScope(JSON.stringify({ version: 1, scopeId: 'study8-binding-only', model: route.model,
    inputBound: 'proven-token-count', limits: { inputTokens: 1600000, outputTokens: 128000, httpAttempts: 192,
      concurrentRequests: 1, maxOutputTokensPerRequest: 4096 }, generation: { thinking: 'enabled', reasoningEffort: 'high' } }))
  const path = join(home, 'ledger.json')
  const ledger = EvaluationLedger.open(path, parsed.scope, parsed.sha256)
  const binding = study8LedgerBinding(ledger)
  const admit = vi.spyOn(binding, 'admit')
  const send = vi.fn(() => {
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { attempts: unknown[] }
    expect(onDisk.attempts.at(-1)).toEqual(expect.objectContaining({ state: 'reserved', bodySha256: facts.bodySha256,
      bodyBytes: 100, reservedInput: 1000, reservedOutput: 4096, tokenBound: bound.forRequest() }))
  })
  const admission = study8Admission(ledger, binding, bound, route, 'row#round0', 0, quote, () => {})
  const dispatch = (): ReturnType<typeof admission> => { const ticket = admission(facts); send(); return ticket }
  try {
    expect(binding.ledger).toBe(ledger)
    const ticket = dispatch()
    expect(dispatch).toThrow('holds the study slot')
    expect(admit).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    ticket.settle({ inputTokens: 30, cacheReadTokens: 10, outputTokens: 25, reasoningTokens: 20 })
    expect(study8Accounting(ledger.snapshot().state.attempts, quote)).toMatchObject({ complete: true,
      actualTokens: { input: 40, output: 25 }, inputHeldOrUsed: 40, outputHeldOrUsed: 25 })
    const unknownTicket = dispatch()
    unknownTicket.abandon()
    expect(dispatch).toThrow('holds the study slot')
    expect(admit).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
    expect(study8Accounting(ledger.snapshot().state.attempts, quote)).toMatchObject({ complete: false, unknown: true,
      actualTokens: null, inputHeldOrUsed: 1040, outputHeldOrUsed: 4121 })
  } finally { ledger.close(); await rm(home, { recursive: true, force: true }) }
})

it('keeps missing and mismatched supplier proof ahead of the real binding and downstream send', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-study8-bound-refusal-'))
  const parsed = parseEvaluationScope(JSON.stringify({ version: 1, scopeId: 'study8-binding-refusal', model: route.model,
    inputBound: 'proven-token-count', limits: { inputTokens: 1600000, outputTokens: 128000, httpAttempts: 192,
      concurrentRequests: 1, maxOutputTokensPerRequest: 4096 }, generation: { thinking: 'enabled', reasoningEffort: 'high' } }))
  const ledger = EvaluationLedger.open(join(home, 'ledger.json'), parsed.scope, parsed.sha256)
  const binding = study8LedgerBinding(ledger)
  const admit = vi.spyOn(binding, 'admit')
  const send = vi.fn()
  try {
    for (const value of [undefined, { ...bound.forRequest(), bodySha256: 'c'.repeat(64) }]) {
      expect(() => {
        study8Admission(ledger, binding, { ...bound, forRequest: () => value }, route, 'row#round0', 0, quote, () => {})(facts)
        send()
      }).toThrow('exact request token bound unavailable')
    }
    expect(admit).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(ledger.snapshot().state.attempts).toHaveLength(0)
  } finally { ledger.close(); await rm(home, { recursive: true, force: true }) }
})

it('refuses a wire reservation beyond trial output before binding and admits an exact remaining wire cap', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-study8-trial-wire-cap-'))
  const parsed = parseEvaluationScope(JSON.stringify({ version: 1, scopeId: 'study8-trial-wire-cap', model: route.model,
    inputBound: 'proven-token-count', limits: STUDY8_LIMITS, generation: { thinking: 'enabled', reasoningEffort: 'high' } }))
  const path = join(home, 'ledger.json')
  const ledger = EvaluationLedger.open(path, parsed.scope, parsed.sha256)
  const binding = study8LedgerBinding(ledger)
  const send = vi.fn()
  try {
    for (let index = 0; index < 3; index += 1) {
      binding.admit(`prior-${String(index)}`, facts, bound.forRequest()).settle({ inputTokens: 1, outputTokens: 4000 })
    }
    const admit = vi.spyOn(binding, 'admit')
    const before = ledger.snapshot()
    const bytes = await readFile(path, 'utf8')
    const smallOutputBound = { ...bound, forRequest: () => ({ ...bound.forRequest(), reasoningInclusiveOutputUpperBound: 1 }) }
    const admission = study8Admission(ledger, binding, smallOutputBound, route, 'last#round0', 0, quote, () => {})
    expect(() => { admission(facts); send() }).toThrow('trial cumulative cap exhausted')
    expect(admit).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(ledger.snapshot()).toEqual(before)
    expect(await readFile(path, 'utf8')).toBe(bytes)
    const ticket = admission({ ...facts, maxOutputTokens: 4000 })
    send()
    expect(admit).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(ledger.snapshot().totals).toMatchObject({ output: 16000, unknown: 0, inFlight: 1, attempts: 4 })
    ticket.settle({ inputTokens: 1, outputTokens: 1 })
  } finally { ledger.close(); await rm(home, { recursive: true, force: true }) }
})
