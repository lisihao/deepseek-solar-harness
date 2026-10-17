import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, LlmError, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type RequestAdmissionInput, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ModelWorkerRuntime, { type ModelWorkerExecuteRequest, type ModelWorkerPhysicalRequestObserver } from '@deepseek-ai/dsh-model-worker'
import { describe, expect, it } from 'vitest'
import apply, { DEEPSEEK_WORKER_ID } from '../src/index.ts'

type Mode = 'no-usage' | 'retry' | 'aborted' | 'cancelled-normal' | 'invalid-tool-response'

class PhysicalRequestFixture extends LlmAdapter {
  override readonly enforcesAdmission = true
  dispatched = 0

  constructor(private readonly mode: Mode, private readonly controller: AbortController) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'high' }] } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const admit = (attempt: number) => {
      const body = JSON.stringify({ model: options.model, messages: options.messages, attempt })
      return options.admission?.({
        model: options.model, bodyBytes: Buffer.byteLength(body),
        bodySha256: createHash('sha256').update(body).digest('hex'),
        maxOutputTokens: undefined, thinking: undefined, reasoningEffort: undefined, hasNonTextContent: false,
      })
    }
    if (this.mode === 'retry') {
      const abandoned = admit(0)
      this.dispatched++
      abandoned?.abandon()
    }
    const ticket = admit(1)
    this.dispatched++
    try {
      if (this.mode === 'aborted') {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'fixture stream aborted', code: 'ABORTED' } } }
        return
      }
      if (this.mode === 'invalid-tool-response') {
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'complete' } }
      if (this.mode === 'cancelled-normal') this.controller.abort(new Error('cancelled before terminal proof'))
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      // An admission reservation without usage stays held; physical completion is a separate fact.
      ticket?.abandon()
    }
  }
}

function observation() {
  const records: Array<{ facts: RequestAdmissionInput; events: string[] }> = []
  const observer: ModelWorkerPhysicalRequestObserver = (facts) => {
    const record = { facts, events: [] as string[] }
    records.push(record)
    return {
      dispatching: () => { record.events.push('dispatching') },
      notSent: () => { record.events.push('not-sent') },
      terminalResponse: () => { record.events.push('terminal') },
      unknown: () => { record.events.push('unknown') },
    }
  }
  return { records, observer }
}

async function setup(mode: Mode) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ModelWorkerRuntime)
  const controller = new AbortController()
  const adapter = new PhysicalRequestFixture(mode, controller)
  ctx.llm.registerAdapter(['deepseek-official'], adapter)
  await ctx.plugin(apply)
  const observed = observation()
  const request: ModelWorkerExecuteRequest = {
    commandId: 'evidence-command', workerId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-pro',
    prompt: [{ type: 'text', text: 'one bounded task' }], signal: controller.signal,
    physicalRequestObserver: observed.observer,
  }
  return { ctx, adapter, observed, request }
}

describe('DeepSeek worker actual request evidence', () => {
  it('records terminal response without inventing missing usage', async () => {
    const { ctx, adapter, observed, request } = await setup('no-usage')
    try {
      const result = await ctx.modelWorkers.execute(request)
      expect(result.stopReason).toBe('completed')
      expect(result.usage).toBeUndefined()
      expect(adapter.dispatched).toBe(1)
      expect(observed.records.map(record => record.events)).toEqual([['dispatching', 'terminal']])
    } finally { await ctx.root.fiber.dispose() }
  })

  it('retains a previous physical attempt unknown when a later response completes', async () => {
    const { ctx, adapter, observed, request } = await setup('retry')
    try {
      await ctx.modelWorkers.execute(request)
      expect(adapter.dispatched).toBe(2)
      expect(observed.records.map(record => record.events)).toEqual([
        ['dispatching', 'unknown'], ['dispatching', 'terminal'],
      ])
      expect(observed.records[0]?.facts.bodySha256).not.toBe(observed.records[1]?.facts.bodySha256)
    } finally { await ctx.root.fiber.dispose() }
  })

  it.each(['aborted', 'cancelled-normal'] as const)('keeps %s distinct from provider terminal proof', async (mode) => {
    const { ctx, observed, request } = await setup(mode)
    try {
      await ctx.modelWorkers.execute(request)
      expect(observed.records.map(record => record.events)).toEqual([['dispatching', 'unknown']])
    } finally { await ctx.root.fiber.dispose() }
  })

  it('keeps known terminal request evidence when subsequent tool processing fails', async () => {
    const { ctx, observed, request } = await setup('invalid-tool-response')
    try {
      await expect(ctx.modelWorkers.execute({
        ...request,
        rlmPlan: {
          version: 1, enabled: true, fidelity: 'dsh-optimized', strategyId: 'fixture', strategyVersion: '1', reason: 'fixture',
          instruction: 'fixture', maxDepth: 1, maxChildren: 1, maxTurns: 1, planSha256: 'fixture',
        },
        modelToolBridge: {
          version: 1, socketPath: 'unused-no-tool-call', sessionId: 'fixture',
          tools: [{ name: 'typescript_repl', description: 'fixture', inputSchema: { type: 'object' } }],
        },
      })).rejects.toThrow('without a complete tool call')
      expect(observed.records.map(record => record.events)).toEqual([['dispatching', 'terminal']])
    } finally { await ctx.root.fiber.dispose() }
  })

  it('preserves existing scope refusal before dispatch and records non-dispatch separately', async () => {
    const { ctx, adapter, observed, request } = await setup('no-usage')
    try {
      const result = await ctx.modelWorkers.execute({
        ...request,
        evaluation: {
          model: request.model, maxOutputTokens: 10, reasoningEffort: 'high', remainingOutputTokens: () => 10,
          admission: () => () => { throw new LlmError('fixture scope refused', 'ADMISSION_REFUSED') },
        },
      })
      expect(result.stopReason).toBe('error')
      expect(adapter.dispatched).toBe(0)
      expect(observed.records.map(record => record.events)).toEqual([['not-sent']])
    } finally { await ctx.root.fiber.dispose() }
  })

  it('refuses an unqualified worker before invoking its execution method', async () => {
    const ctx = new Context()
    await ctx.plugin(ModelWorkerRuntime)
    let executions = 0
    ctx.modelWorkers.register({
      id: 'unqualified', offers: () => Promise.resolve([]),
      execute: () => { executions++; return Promise.resolve({ output: [], stopReason: 'completed' as const }) },
    })
    try {
      expect(() => ctx.modelWorkers.execute({
        commandId: 'refused', workerId: 'unqualified', model: 'fixture', prompt: [],
        signal: new AbortController().signal, physicalRequestObserver: observation().observer,
      })).toThrow('cannot report physical request evidence')
      expect(executions).toBe(0)
    } finally { await ctx.root.fiber.dispose() }
  })
})
