import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { localIpcAddress } from '@deepseek-ai/dsh-home-paths'
import LlmRuntime, { CallId, LlmAdapter, LlmError, ReasoningEffortId,
  type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ModelWorkerRuntime, { type ModelWorkerExecuteRequest } from '@deepseek-ai/dsh-model-worker'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { describe, expect, it } from 'vitest'
import apply, { DEEPSEEK_WORKER_ID } from '../src/index.ts'

class PolicyFixture extends LlmAdapter {
  override readonly enforcesAdmission = true
  readonly requests: GenerateOptions[] = []
  dispatched = 0
  constructor(private readonly mode: 'normal' | 'always-tool' | 'unknown' = 'normal') { super() }
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, reasoning: {
      efforts: [{ id: ReasoningEffortId('high'), name: 'high' }] } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ ...options, messages: structuredClone(options.messages) })
    const body = JSON.stringify({ model: options.model, messages: options.messages, tools: options.tools })
    const ticket = options.admission?.({ model: options.model, bodyBytes: Buffer.byteLength(body),
      bodySha256: createHash('sha256').update(body).digest('hex'), maxOutputTokens: options.maxTokens,
      thinking: 'enabled', reasoningEffort: 'high', hasNonTextContent: false })
    this.dispatched++
    if (this.mode === 'unknown') {
      ticket?.abandon()
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'fixture outcome unknown', code: 'ABORTED' } } }
      return
    }
    if (this.mode === 'always-tool' || this.requests.length === 1) {
      const id = CallId('policy-call-' + String(this.requests.length))
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'typescript_repl', arguments: '{"code":"1 + 1"}' } }
      ticket?.settle({ inputTokens: 9, outputTokens: 2 })
      yield { type: 'usage', usage: { inputTokens: 9, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '2' } }
    ticket?.settle({ inputTokens: 12, outputTokens: 3 })
    yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture(mode: 'normal' | 'always-tool' | 'unknown' = 'normal') {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ModelWorkerRuntime)
  const adapter = new PolicyFixture(mode)
  ctx.llm.registerAdapter(['deepseek-official'], adapter)
  await ctx.plugin(apply)
  const root = await mkdtemp(join(tmpdir(), 'dsh-worker-policy-'))
  const socketPath = localIpcAddress(root, 'bridge')
  const calls: unknown[] = []
  const server = createServer((socket) => {
    const transport = new JsonRpcLineTransport(socket, socket)
    transport.onRequest((method, params) => { calls.push({ method, params }); return Promise.resolve({ value: 2 }) })
    transport.start()
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  const labels: string[] = []
  const events: string[][] = []
  const request: ModelWorkerExecuteRequest = {
    commandId: 'policy-command', workerId: DEEPSEEK_WORKER_ID, model: 'allocation-model',
    prompt: [{ type: 'text', text: 'identical fixture question' }], signal: new AbortController().signal,
    toolExecution: { version: 1, maxToolRounds: 4 },
    modelToolBridge: { version: 1, socketPath, sessionId: 'policy-session',
      tools: [{ name: 'typescript_repl', description: 'execute TypeScript', inputSchema: { type: 'object' } }] },
    evaluation: { model: 'fixture-model', maxOutputTokens: 20, reasoningEffort: 'high', remainingOutputTokens: () => 100,
      admission: (label) => { labels.push(label); return () => ({ settle: () => {}, abandon: () => {} }) } },
    physicalRequestObserver: () => {
      const record: string[] = []
      events.push(record)
      return { dispatching: () => record.push('dispatching'), notSent: () => record.push('not-sent'),
        terminalResponse: () => record.push('terminal'), unknown: () => record.push('unknown') }
    },
  }
  return { ctx, adapter, request, labels, events, calls, close: async () => {
    await ctx.root.fiber.dispose()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(root, { recursive: true, force: true })
  } }
}

const legacyPlan = { version: 1 as const, enabled: true as const, fidelity: 'dsh-optimized' as const,
  strategyId: 'fixture', strategyVersion: '1', reason: 'fixture', instruction: 'fixture',
  maxDepth: 1, maxChildren: 1, maxTurns: 1, planSha256: 'fixture' }

function capturedRequests(requests: GenerateOptions[]) {
  return requests.map(request => ({ model: request.model, effort: request.reasoningEffort, maxTokens: request.maxTokens,
    tools: request.tools, messages: request.messages.map(message => ({
      role: message.role, content: message.content, source: message.source,
    })) }))
}

describe('explicit worker tool execution independent of RLM selection', () => {
  it('uses identical actual IPC, request parameters and semantic history for the same prompt on both paths', async () => {
    const captures: unknown[] = []
    for (const kind of ['explicit', 'legacy'] as const) {
      const f = await fixture()
      try {
        const { toolExecution: _policy, ...base } = f.request
        const request = kind === 'explicit' ? f.request : { ...base, rlmPlan: legacyPlan }
        const result = await f.ctx.modelWorkers.execute(request)
        expect(result.stopReason).toBe('completed')
        expect(f.adapter.dispatched).toBe(2)
        expect(f.calls).toHaveLength(1)
        expect(f.events).toEqual([['dispatching', 'terminal'], ['dispatching', 'terminal']])
        expect(f.labels).toEqual(['policy-command#round0@policy-session', 'policy-command#round1@policy-session'])
        expect(f.adapter.requests.map(x => x.messages.map(m => m.role))).toEqual([['user'], ['user', 'assistant', 'user']])
        captures.push({ requests: capturedRequests(f.adapter.requests), bridgeCalls: f.calls, result })
      } finally { await f.close() }
    }
    // Generated message identity/time fields are not model request content; all semantic fields are captured above.
    expect(captures[0]).toEqual(captures[1])
  })

  it('honors the explicit bound over a legacy RLM limit and does not execute the last returned tool call', async () => {
    const f = await fixture('always-tool')
    try {
      await expect(f.ctx.modelWorkers.execute({ ...f.request, rlmPlan: legacyPlan,
        toolExecution: { version: 1, maxToolRounds: 1 } })).rejects.toThrow('round limit')
      expect(f.adapter.dispatched).toBe(2)
      expect(f.calls).toHaveLength(1)
      expect(f.events).toEqual([['dispatching', 'terminal'], ['dispatching', 'terminal']])
    } finally { await f.close() }
  })

  it('refuses missing or incompatible bridges before any model request', async () => {
    const f = await fixture()
    try {
      const { modelToolBridge: _bridge, ...withoutBridge } = f.request
      await expect(f.ctx.modelWorkers.execute(withoutBridge)).rejects.toThrow('requires a genuine model-tool bridge')
      await expect(f.ctx.modelWorkers.execute({ ...f.request,
        modelToolBridge: { ...f.request.modelToolBridge!, tools: [] } })).rejects.toThrow('single qualified typescript_repl')
      expect(f.adapter.requests).toHaveLength(0)
      expect(f.calls).toHaveLength(0)
    } finally { await f.close() }
  })

  it('rejects unsupported Providers before invoking them', async () => {
    const ctx = new Context()
    await ctx.plugin(ModelWorkerRuntime)
    let executions = 0
    ctx.modelWorkers.register({ id: 'unsupported', offers: () => Promise.resolve([]), execute: () => {
      executions++; return Promise.resolve({ stopReason: 'completed', output: [] })
    } })
    try {
      expect(() => ctx.modelWorkers.execute({ commandId: 'unsupported', workerId: 'unsupported', model: 'fixture',
        prompt: [], toolExecution: { version: 1, maxToolRounds: 1 }, signal: new AbortController().signal }))
        .toThrow('cannot honor explicit tool execution')
      expect(executions).toBe(0)
    } finally { await ctx.root.fiber.dispose() }
  })

  it('retains later-round admission refusal without another dispatch or command replay', async () => {
    const f = await fixture()
    try {
      const result = await f.ctx.modelWorkers.execute({ ...f.request, evaluation: { ...f.request.evaluation!,
        admission: (label) => { f.labels.push(label); return () => {
          if (f.labels.length > 1) throw new LlmError('fixture later admission refused', 'ADMISSION_REFUSED')
          return { settle: () => {}, abandon: () => {} }
        } } } })
      expect(result.stopReason).toBe('error')
      expect(f.adapter.requests).toHaveLength(2)
      expect(f.adapter.dispatched).toBe(1)
      expect(f.calls).toHaveLength(1)
      expect(f.events).toEqual([['dispatching', 'terminal'], ['not-sent']])
      expect(f.labels).toHaveLength(2)
    } finally { await f.close() }
  })

  it('keeps dispatched unknown usage absent and does not replay the tool command', async () => {
    const f = await fixture('unknown')
    try {
      const result = await f.ctx.modelWorkers.execute(f.request)
      expect(result.stopReason).toBe('aborted')
      expect(result.usage).toBeUndefined()
      expect(f.adapter.dispatched).toBe(1)
      expect(f.calls).toHaveLength(0)
      expect(f.events).toEqual([['dispatching', 'unknown']])
    } finally { await f.close() }
  })
})
