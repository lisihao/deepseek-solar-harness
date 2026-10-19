/** Fixed in-process transport for the real offline Worker/Runtime Loader scenario. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { LlmAdapter, CallId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export const state = { current: undefined }

class ScriptedAdapter extends LlmAdapter {
  enforcesAdmission = true
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'high' }] } }
  }
  async *stream(options) {
    const trial = state.current
    assert(trial, 'a trial must own every scripted request')
    const request = { model: options.model, maxTokens: options.maxTokens, reasoningEffort: options.reasoningEffort,
      messages: structuredClone(options.messages), tools: structuredClone(options.tools) }
    const body = JSON.stringify(request)
    const bodySha256 = createHash('sha256').update(body).digest('hex')
    const entry = { request, body, bodySha256, admitted: false }
    trial.entries.push(entry)
    const ticket = options.admission({ model: options.model, bodyBytes: Buffer.byteLength(body), bodySha256,
      maxOutputTokens: options.maxTokens, thinking: 'enabled', reasoningEffort: 'high', hasNonTextContent: false })
    entry.admitted = true
    // The label/attempt association is captured by the admission owner before this independent send record is appended.
    const send = { ordinal: trial.sends.length + 1, attemptId: trial.lastAdmittedId, bodySha256, request }
    trial.sends.push(send)
    const script = trial.script(options)
    if (script.kind === 'unknown') {
      ticket.abandon()
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'scripted unknown outcome', code: 'ABORTED' } } }
      return
    }
    const usage = { inputTokens: 9, outputTokens: script.kind === 'over-output' ? options.maxTokens + 1 : 5, reasoningTokens: 3 }
    send.usage = usage
    ticket.settle(usage)
    yield { type: 'usage', usage }
    if (script.kind === 'tool') {
      const id = CallId('offline-cell-' + String(send.ordinal))
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'typescript_repl', arguments: JSON.stringify({ code: script.code }) } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'offline result' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'offline-rlm-scripted-transport'
export const inject = ['llm']
/** Register only the fake adapter, without any HTTP provider or credential lookup. */
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter(['deepseek-official'], new ScriptedAdapter()))
}
