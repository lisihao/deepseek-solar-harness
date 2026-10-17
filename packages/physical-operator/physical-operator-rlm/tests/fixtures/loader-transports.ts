/** Synthetic external transports for the runnable keyless standalone example. */
import { createHash } from 'node:crypto'
import { LlmAdapter, CallId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { OrchestrationDaemon } from '@deepseek-ai/dsh-orchestration-local'

export const state: {
  driver: 'api' | 'codex'
  daemon?: OrchestrationDaemon
  outerRequests: number
  apiRequests: number
  residentRequests: number
  wrapperUsageAbsent: boolean
  innerToolResultObserved: boolean
  firstApiTextBlocks: string[]
  residentMaterialized?: { prompt: unknown; systemPrompt?: string }
} = {
  driver: process.env.DSH_RLM_FIXTURE_DRIVER === 'codex' ? 'codex' : 'api',
  outerRequests: 0, apiRequests: 0, residentRequests: 0,
  wrapperUsageAbsent: false, innerToolResultObserved: false,
  firstApiTextBlocks: [],
}

export class OuterAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    state.outerRequests++
    const result = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (result === undefined) {
      const id = CallId('standalone-fixture-analysis')
      const argumentsText = JSON.stringify({
        action: 'run', operator_id: 'standalone', description: 'Analyze both original parts',
        prompt: 'first original part\nsecond original part',
      })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'physical_operator', argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'physical_operator', arguments: argumentsText } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    if (result.isError || !text.includes('RLM_FULL_ANSWER')) throw new Error('actual standalone tool failed: ' + text)
    const answer = 'Standalone RLM completed: first original part; second original part; result=2.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export class InnerAdapter extends LlmAdapter {
  override readonly enforcesAdmission = true

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    state.apiRequests++
    if (state.apiRequests === 1) state.firstApiTextBlocks = options.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text)
    if (options.admission === undefined) throw new Error('actual physical API request has no admission observer')
    const body = JSON.stringify({ model: options.model, messages: options.messages })
    const ticket = options.admission({
      model: options.model, bodyBytes: Buffer.byteLength(body),
      bodySha256: createHash('sha256').update(body).digest('hex'),
      maxOutputTokens: options.maxTokens, thinking: undefined, reasoningEffort: undefined, hasNonTextContent: false,
    })
    if (state.apiRequests === 1) {
      const prompt = options.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (!prompt.includes('first original part') || !prompt.includes('second original part')) throw new Error('original task parts lost')
      const id = CallId('standalone-fixture-repl')
      const argumentsText = '{"code":"1 + 1"}'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'typescript_repl', argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'typescript_repl', arguments: argumentsText } }
      ticket.settle({ inputTokens: 8, outputTokens: 1 })
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const result = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    state.innerToolResultObserved = result !== undefined && !result.isError
      && result.content.some(block => block.type === 'text' && block.text.includes('2'))
    if (!state.innerToolResultObserved) throw new Error('actual REPL result did not return to DeepSeek tool loop')
    const answer = 'RLM_FULL_ANSWER first original part; second original part; result=2'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: answer }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
    ticket.settle({ inputTokens: 10, outputTokens: 2 })
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
