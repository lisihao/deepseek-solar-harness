import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  ADMISSION_REFUSED_CODE,
  createUserMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { EvaluationLedger, parseEvaluationScope } from '../src/evaluation-ledger.ts'
import { refuseNonLoopbackFetch, startFakeDeepSeekHttp, type FakeDeepSeekHttp } from './fake-deepseek-http.ts'

let directory: string
let fake: FakeDeepSeekHttp | undefined
let guard: ReturnType<typeof refuseNonLoopbackFetch> | undefined

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-evaluation-adapter-'))
  vi.stubEnv('DSH_HOME', directory)
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-not-a-key')
})

afterEach(async () => {
  guard?.restore()
  await fake?.close()
  fake = undefined
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

const scopeText = JSON.stringify({
  version: 1, scopeId: 'adapter', model: 'deepseek-v4-flash', inputBound: 'request-bytes-audited',
  limits: { inputTokens: 1_000_000, outputTokens: 100_000, httpAttempts: 5, concurrentRequests: 1, maxOutputTokensPerRequest: 100 },
  generation: { thinking: 'enabled', reasoningEffort: 'high' },
})

describe('the ledger behind the real DeepSeek adapter and a loopback endpoint', () => {
  it('lets only one of two concurrent requests take the last concurrency slot, and only that one reaches the endpoint', async () => {
    guard = refuseNonLoopbackFetch()
    fake = await startFakeDeepSeekHttp(() => ({ kind: 'hold' }))
    const { scope, sha256 } = parseEvaluationScope(scopeText)
    const ledger = EvaluationLedger.open(join(directory, 'ledger.json'), scope, sha256)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { baseURL: fake.baseURL })
    const request = (label: string) => ({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({ content: [{ type: 'text', text: label }], source: { kind: 'plugin', plugin: 'test' } })],
      maxTokens: 100,
      reasoningEffort: ReasoningEffortId('high'),
      admission: ledger.admission(label),
    })
    const finishes = async (label: string): Promise<string[]> => {
      const kinds: string[] = []
      for await (const chunk of ctx.llm.stream(request(label))) {
        if (chunk.type === 'finish') kinds.push(chunk.reason.kind === 'error' ? (chunk.reason.failure.code ?? 'error') : chunk.reason.kind)
      }
      return kinds
    }
    // Both calls ask in the same tick. The first to reach admission holds the only slot while its response is not finished.
    const both = Promise.all([finishes('first'), finishes('second')])
    await vi.waitFor(() => { expect(fake?.received.length).toBe(1) })
    await vi.waitFor(() => { expect(ledger.snapshot().state.attempts.length).toBe(2) })
    fake.release()
    const outcomes = (await both).flat().sort()
    expect(outcomes).toEqual([ADMISSION_REFUSED_CODE, 'stop'].sort())
    expect(fake.received).toHaveLength(1)
    const { state, totals } = ledger.snapshot()
    expect(state.attempts.map(attempt => attempt.state).sort()).toEqual(['refused', 'settled'])
    expect(totals).toMatchObject({ attempts: 1, refused: 1, inFlight: 0, unknown: 0 })
    expect(state.attempts.find(attempt => attempt.state === 'refused')?.refusal).toBe('concurrency-exhausted')
    expect(guard.refused).toBe(0)
    ledger.close()
  })
})
