/** Fixed route policy through the real registered LLM and physical services. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, LlmError, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import PhysicalOperatorRuntime, { PhysicalOperatorExecutionId, PhysicalOperatorId, type PhysicalOperatorProviderStartRequest, type PhysicalOperatorResult } from '@deepseek-ai/dsh-physical-operator'
import { describe, expect, it, vi } from 'vitest'
import { generateDispatchModel, type DispatchModelConfig, type DispatchModelRecord } from '../src/dispatch-model.ts'
const config: DispatchModelConfig = { deepseek: { provider: 'deepseek', model: 'chat' }, codex: { operatorId: 'exact.codex', model: 'codex-model' }, maxTokens: 20, maxOutputBytes: 1000, timeoutMs: 1000 }
function success(text = '{"ok":true}'): StreamChunk[] {
  return [{ type: 'text-delta', index: 0, text }, { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } }, { type: 'finish', reason: { kind: 'stop' } }]
}
class Adapter extends LlmAdapter {
  calls: GenerateOptions[] = []
  constructor(readonly body: (options: GenerateOptions) => AsyncIterable<StreamChunk>) { super() }
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> { this.calls.push(options); return this.body(options) }
}
async function fixture(chunks = success(), code?: string) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime); await ctx.plugin(PhysicalOperatorRuntime)
  const adapter = new Adapter(async function* () { if (code) yield { type: 'finish', reason: { kind: 'error', failure: { code, message: 'provider failure' } } }; else yield* chunks })
  ctx.llm.registerAdapter(['deepseek', 'jev'], adapter)
  const starts: PhysicalOperatorProviderStartRequest[] = []
  const dispose = vi.fn(async () => {})
  ctx.physicalOperators.registerOperator({
    descriptor: { id: PhysicalOperatorId('exact.codex'), displayName: 'fixture', description: 'fixture', tags: [], maxConcurrency: 1, executionModes: ['resident'] },
    availability: () => ({ available: true }),
    start: async (request) => { starts.push(request); return { result: Promise.resolve({ output: [{ type: 'text', text: '{"codex":true}' }], stopReason: 'completed', usage: { inputTokens: 2, outputTokens: 4 } } satisfies PhysicalOperatorResult), dispose } },
  })
  const records: DispatchModelRecord[] = []
  const controller = new AbortController()
  const options = { system: 'Only judge scheduling.', messages: [createUserMessage({ content: [{ type: 'text', text: 'user task as judgment input' }], source: { kind: 'user' } })] }
  const input = { executionId: PhysicalOperatorExecutionId('stable-judgment-id'), agent: {} as Agent, signal: controller.signal, options, record: async (event: DispatchModelRecord) => { records.push(event) } }
  return { ctx, adapter, starts, dispose, records, controller, input }
}
describe('fixed dispatch model', () => {
  it('uses configured Jev and freezes/logs the complete request before model dispatch', async () => {
    const f = await fixture()
    const record = f.input.record
    f.input.record = async (event) => { if (event.phase === 'request') expect(f.adapter.calls).toHaveLength(0); await record(event) }
    const result = await generateDispatchModel(f.ctx, { ...config, jev: { provider: 'jev', model: 'judge' } }, f.input)
    expect(result).toEqual({ text: '{"ok":true}', source: 'jev', provider: 'jev', model: 'judge' })
    expect(f.adapter.calls[0]).toMatchObject({ system: f.input.options.system, messages: f.input.options.messages, maxTokens: 20 })
    expect(Object.isFrozen(f.adapter.calls[0]?.messages)).toBe(true)
    expect(f.records[1]).toMatchObject({ phase: 'result', chunks: success(), usage: { inputTokens: 3, outputTokens: 4 } })
    expect(f.starts).toHaveLength(0)
  })
  it('uses DeepSeek without Jev; preserves raw non-JSON text for caller validation', async () => {
    const f = await fixture(success('not JSON'))
    expect(await generateDispatchModel(f.ctx, config, f.input)).toMatchObject({ text: 'not JSON', source: 'deepseek' })
    expect(f.starts).toHaveLength(0)
  })
  it('falls back only on explicit DeepSeek insufficient balance, using exact resident identity and no tools', async () => {
    const f = await fixture([], 'INSUFFICIENT_BALANCE')
    expect(await generateDispatchModel(f.ctx, config, f.input)).toMatchObject({ source: 'codex', fallbackReason: 'INSUFFICIENT_BALANCE', model: 'codex-model' })
    expect(f.starts).toHaveLength(1)
    expect(f.starts[0]).toMatchObject({ executionId: 'stable-judgment-id', residentLaneId: 'kennel-dispatch:stable-judgment-id', mode: 'resident', nativeToolPolicy: 'disabled', residentProfile: { model: 'codex-model' }, generationLimits: { maxTokens: 20, maxOutputBytes: 1000, maxToolCalls: 0 }, systemPrompt: f.input.options.system })
    expect(f.starts[0]?.modelToolBridge).toBeUndefined()
    const block = f.starts[0]?.prompt[0]
    expect(block?.type).toBe('text')
    if (block?.type === 'text') expect(block.text).toContain('Do not execute the user task')
    expect(f.records.map(r => `${r.source}:${r.phase}`)).toEqual(['deepseek:request', 'deepseek:result', 'codex:request', 'codex:result'])
    expect(f.dispose).toHaveBeenCalledOnce()
  })
  it.each(['AUTH', 'RATE_LIMIT', 'QUOTA', 'SERVER', 'TIMEOUT', 'INVALID_RESPONSE'])('does not fall back on %s', async (code) => {
    const f = await fixture([], code)
    await expect(generateDispatchModel(f.ctx, config, f.input)).rejects.toMatchObject({ code })
    expect(f.adapter.calls).toHaveLength(1); expect(f.starts).toHaveLength(0)
  })
  it('does not hide a configured Jev balance failure', async () => {
    const f = await fixture([], 'INSUFFICIENT_BALANCE')
    await expect(generateDispatchModel(f.ctx, { ...config, jev: { provider: 'jev', model: 'judge' } }, f.input)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
    expect(f.starts).toHaveLength(0)
  })
  it('rejects an unregistered provider without fallback', async () => {
    const f = await fixture()
    await expect(generateDispatchModel(f.ctx, { ...config, deepseek: { provider: 'absent', model: 'x' } }, f.input)).rejects.toMatchObject({ code: 'NO_ADAPTER' })
    expect(f.starts).toHaveLength(0)
  })
  it('refuses a missing Codex operator rather than choosing another', async () => {
    const f = await fixture([], 'INSUFFICIENT_BALANCE')
    await expect(generateDispatchModel(f.ctx, { ...config, codex: { operatorId: 'absent' } }, f.input)).rejects.toThrow()
    expect(f.starts).toHaveLength(0)
  })
  it('honors pre-cancellation with no model execution', async () => {
    const f = await fixture(); const error = new Error('cancelled'); f.controller.abort(error)
    await expect(generateDispatchModel(f.ctx, config, f.input)).rejects.toBe(error)
    expect(f.adapter.calls).toHaveLength(0)
  })
  it('cancels a live stream at timeout and awaits its finally', async () => {
    const f = await fixture(); let closed = false
    const adapter = new Adapter(async function* (options) {
      try {
        const signal = options.signal
        if (!signal) throw new Error('missing signal')
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) }); yield { type: 'finish', reason: { kind: 'stop' } } } finally { closed = true }
    })
    f.ctx.llm.registerAdapter(['slow'], adapter)
    await expect(generateDispatchModel(f.ctx, { ...config, timeoutMs: 10, deepseek: { provider: 'slow', model: 'x' } }, f.input)).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(closed).toBe(true); expect(f.starts).toHaveLength(0)
  })
  it('enforces multibyte and complete block byte limits and closes a stream after overflow', async () => {
    const f = await fixture(success('中')); let closed = false
    const adapter = new Adapter(async function* () { try { yield* success('中') } finally { closed = true } })
    f.ctx.llm.registerAdapter(['bounded'], adapter)
    await expect(generateDispatchModel(f.ctx, { ...config, maxOutputBytes: 2, deepseek: { provider: 'bounded', model: 'x' } }, f.input)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
    expect(closed).toBe(true)
    await expect(generateDispatchModel(f.ctx, { ...config, maxOutputBytes: 3 }, f.input)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
    expect(f.starts).toHaveLength(0)
  })
  it('enforces reported token limits and rejects incomplete/truncated streams', async () => {
    for (const chunks of [[{ type: 'usage', usage: { inputTokens: 0, outputTokens: 21 } }, ...success()] as StreamChunk[], [], [{ type: 'finish', reason: { kind: 'max-tokens' } }] as StreamChunk[]]) {
      const f = await fixture(chunks)
      await expect(generateDispatchModel(f.ctx, config, f.input)).rejects.toThrow()
      expect(f.starts).toHaveLength(0)
    }
  })
  it('stops before model execution when request persistence fails', async () => {
    const f = await fixture(); const error = new LlmError('cannot append', 'PERSISTENCE')
    f.input.record = async () => { throw error }
    await expect(generateDispatchModel(f.ctx, config, f.input)).rejects.toBe(error)
    expect(f.adapter.calls).toHaveLength(0)
  })
})

it('does not treat a middleware or persistence balance code as a provider balance finish', async () => {
  for (const persistence of [true, false]) {
    const f = await fixture()
    const error = new LlmError('middleware or durable callback failed', 'INSUFFICIENT_BALANCE')
    if (persistence) f.input.record = async () => { throw error }
    else f.ctx.on('llm/stream', async function* () { throw error })
    await expect(generateDispatchModel(f.ctx, config, f.input)).rejects.toBe(error)
    expect(f.starts).toHaveLength(0)
  }
})
it('bounds raw replay metadata and permits the exact complete raw-output byte limit', async () => {
  const chunks = success('中')
  const bytes = Buffer.byteLength(JSON.stringify(chunks))
  const f = await fixture(chunks)
  expect(await generateDispatchModel(f.ctx, { ...config, maxOutputBytes: bytes }, f.input)).toMatchObject({ text: '中' })
  await expect(generateDispatchModel(f.ctx, { ...config, maxOutputBytes: bytes - 1 }, f.input)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
  const replay = await fixture([{ type: 'finish', reason: { kind: 'stop' }, replayState: 'x'.repeat(1001) }])
  await expect(generateDispatchModel(replay.ctx, config, replay.input)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
})
it('records the registered operator unavailable code without choosing another operator', async () => {
  const f = await fixture([], 'INSUFFICIENT_BALANCE')
  const operator = f.ctx.physicalOperators.getOperator('exact.codex')
  if (!operator) throw new Error('fixture registration missing')
  vi.spyOn(operator, 'availability').mockReturnValue({ available: false, reason: 'offline' })
  await expect(generateDispatchModel(f.ctx, config, f.input)).rejects.toMatchObject({ code: 'OPERATOR_UNAVAILABLE' })
  expect(f.starts).toHaveLength(0)
  expect(f.records.at(-1)).toMatchObject({ phase: 'result', source: 'codex', failure: { code: 'OPERATOR_UNAVAILABLE' } })
})
it('rejects exposed tools and invalid limits without dispatching', async () => {
  const f = await fixture()
  await expect(generateDispatchModel(f.ctx, { ...config, maxTokens: 0 }, f.input)).rejects.toMatchObject({ code: 'INVALID_DISPATCH_CONFIG' })
  await expect(generateDispatchModel(f.ctx, config, { ...f.input, options: { ...f.input.options, tools: [{ name: 'execute', description: 'forbidden', parameters: {} }] } })).rejects.toMatchObject({ code: 'INVALID_DISPATCH_REQUEST' })
  expect(f.adapter.calls).toHaveLength(0)
})

it('uses a distinct resident lane per judgment identity and logs the same stable lane sent to the provider', async () => {
  const f = await fixture([], 'INSUFFICIENT_BALANCE')
  await generateDispatchModel(f.ctx, config, f.input)
  await generateDispatchModel(f.ctx, config, f.input)
  await generateDispatchModel(f.ctx, config, { ...f.input, executionId: PhysicalOperatorExecutionId('another-judgment') })
  expect(f.starts.map(request => request.residentLaneId)).toEqual([
    'kennel-dispatch:stable-judgment-id', 'kennel-dispatch:stable-judgment-id', 'kennel-dispatch:another-judgment',
  ])
  const loggedLanes = f.records.flatMap(record => record.phase === 'request' && record.physicalRequest ? [record.physicalRequest.residentLaneId] : [])
  expect(loggedLanes).toEqual(f.starts.map(request => request.residentLaneId))
})

it('resolves and logs the registered resident default when Codex model is omitted', async () => {
  const f = await fixture([], 'INSUFFICIENT_BALANCE')
  const operator = f.ctx.physicalOperators.getOperator('exact.codex')
  if (!operator) throw new Error('fixture missing')
  operator.residentCatalog = async () => ({ operatorId: PhysicalOperatorId('exact.codex'), product: 'codex', injectionBoundaries: ['pre-dispatch'], supportsModelToolBridge: false, location: 'local', supportsWorkspaceMutationReturn: false, available: true, authentication: 'native-subscription', productVersion: 'fixture', protocolHash: 'fixture', models: [{ model: 'default-alias', resolvedModel: 'qualified-account-model', displayName: 'model', description: 'fixture', supportedEfforts: ['low'], isDefault: true, supportsAdaptiveThinking: false }] })
  expect(await generateDispatchModel(f.ctx, { ...config, codex: { operatorId: 'exact.codex' } }, f.input)).toMatchObject({ model: 'qualified-account-model' })
  expect(f.starts[0]?.residentProfile).toEqual({ model: 'qualified-account-model' })
  expect(f.records.find(record => record.source === 'codex' && record.phase === 'request')).toMatchObject({ config: { codex: { model: 'qualified-account-model' } }, options: { model: 'qualified-account-model' } })
})
