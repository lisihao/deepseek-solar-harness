/** Direct Codex model turns preserving the existing disabled-tool TypeScript REPL bridge. */
import { createConnection } from 'node:net'
import type { Context as PiContext } from '@earendil-works/pi-ai'
import type { PhysicalOperatorModelToolBridgeV1 } from '@deepseek-ai/dsh-physical-operator'
import { ResidentOperatorError, type ResidentDriverExecuteRequest, type ResidentTurnResult } from '@deepseek-ai/dsh-resident-operator'
import { codexTurnResult, generateCodexModelCall, withCodexModelTranscript } from './codex-judgment.ts'
import { callModelToolBridge, modelToolCommandId, validateResidentModelToolBridge } from './model-tool-bridge.ts'
import { canonicalNativeToolCatalogHash } from './store.ts'

async function connectBridge(bridge: PhysicalOperatorModelToolBridgeV1, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const socket = createConnection(bridge.socketPath)
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  const abort = (): void => { socket.destroy(signal.reason instanceof Error ? signal.reason : new Error('REPL bridge admission aborted')) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
      socket.once('close', () => { reject(new ResidentOperatorError('REPL bridge closed before admission', 'RUNTIME_UNAVAILABLE')) })
      if (signal.aborted) abort()
    })
  } catch (error) {
    if (signal.aborted) throw signal.reason
    throw new ResidentOperatorError(`Legacy REPL bridge is unavailable: ${error instanceof Error ? error.message : String(error)}`, 'RUNTIME_UNAVAILABLE')
  } finally {
    signal.removeEventListener('abort', abort)
    socket.destroy()
    await closed
  }
}

/**
 * Run only the sealed, existing TypeScript REPL bridge through the direct model API.
 * Legacy omitted limits retain the provider defaults and existing REPL governance.
 * Each tool invocation reads the current endpoint; unknown outcomes stop without retry.
 * @param request - disabled native tools, sealed REPL bridge, model profile, optional limits and owner-private transcript root.
 * @returns canonical final output, aggregate usage and actual API response identity without a native session.
 */
export async function generateCodexBridgeTurn(request: ResidentDriverExecuteRequest): Promise<ResidentTurnResult> {
  if (request.nativeToolPolicy !== 'disabled') throw new ResidentOperatorError('Legacy REPL execution requires disabled native tools', 'INVALID_RESULT')
  const sealed = validateResidentModelToolBridge(request.modelToolBridge, 'disabled')
  if (sealed === undefined) throw new ResidentOperatorError('Legacy REPL execution requires its sealed model tool bridge', 'INVALID_RESULT')
  const catalogHash = canonicalNativeToolCatalogHash('disabled', sealed)
  const currentBridge = (): PhysicalOperatorModelToolBridgeV1 => {
    const attached = validateResidentModelToolBridge(request.modelToolBridge, 'disabled')
    if (attached === undefined) throw new ResidentOperatorError('Legacy REPL bridge owner is detached', 'RUNTIME_UNAVAILABLE')
    if (canonicalNativeToolCatalogHash('disabled', attached) !== catalogHash) {
      throw new ResidentOperatorError('Legacy REPL bridge changed its sealed tool catalog', 'PROTOCOL_MISMATCH')
    }
    return attached
  }
  const admissionSignal = request.modelToolBridgeAdmissionTimeoutMs === undefined ? request.signal
    : AbortSignal.any([request.signal, AbortSignal.timeout(request.modelToolBridgeAdmissionTimeoutMs)])
  // Legacy RLM endpoints implement tool.call only; connectivity admission sends no additional RPC method.
  await connectBridge(currentBridge(), admissionSignal)
  const text: string[] = []
  for (const block of request.prompt) {
    if (block.type !== 'text') throw new ResidentOperatorError('Legacy REPL Codex accepts text prompt blocks only', 'INVALID_RESULT')
    text.push(block.text)
  }
  const messages: PiContext['messages'] = [{ role: 'user', content: text.join('\n'), timestamp: Date.now() }]
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
  const limits = request.generationLimits
  const seenCalls = new Set<string>()
  let calls = 0
  let bytes = 0
  request.onProgress('connecting')
  request.onRunning()
  return withCodexModelTranscript(request, async (record) => {
    for (;;) {
      request.signal.throwIfAborted()
      const remaining = limits === undefined ? undefined
        : { ...limits, maxTokens: limits.maxTokens - usage.outputTokens, maxOutputBytes: limits.maxOutputBytes - bytes }
      if (remaining !== undefined && (remaining.maxTokens <= 0 || remaining.maxOutputBytes <= 0)) {
        throw new ResidentOperatorError('Legacy REPL exhausted its explicit aggregate generation limits', 'OUTPUT_LIMIT')
      }
      const tools = limits?.maxToolCalls !== undefined && calls >= limits.maxToolCalls ? [] : sealed.tools
      request.onProgress('reasoning')
      const result = await generateCodexModelCall({
        model: request.profile.model, ...request.profile.effort === undefined ? {} : { effort: request.profile.effort },
        ...request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }, messages, tools,
        ...tools.length === 0 ? {} : { legacyReplBridge: sealed },
        ...remaining === undefined ? {} : { generationLimits: remaining },
        ...record === undefined ? {} : { record }, signal: request.signal,
      })
      usage.inputTokens += result.usage.input
      usage.outputTokens += result.usage.output
      usage.cacheReadInputTokens += result.usage.cacheRead
      usage.cacheWriteInputTokens += result.usage.cacheWrite
      bytes += Buffer.byteLength(JSON.stringify(result))
      if (limits !== undefined && (usage.outputTokens > limits.maxTokens || bytes > limits.maxOutputBytes)) {
        throw new ResidentOperatorError('Legacy REPL exceeded its explicit aggregate generation limits', 'OUTPUT_LIMIT')
      }
      const toolCalls = result.content.filter(block => block.type === 'toolCall')
      if (toolCalls.length === 0) {
        if (result.stopReason !== 'stop') throw new ResidentOperatorError(`Legacy REPL model stopped with ${result.stopReason}`, 'INVALID_RESULT')
        request.onProgress('finalizing')
        return codexTurnResult(result, usage)
      }
      if (result.stopReason !== 'toolUse') throw new ResidentOperatorError('Legacy REPL tool calls require a tool-use stop reason', 'INVALID_RESULT')
      if (limits?.maxToolCalls !== undefined && calls + toolCalls.length > limits.maxToolCalls) {
        throw new ResidentOperatorError('Legacy REPL exceeded its explicit tool-call limit before execution', 'OUTPUT_LIMIT')
      }
      const batchCalls = new Set<string>()
      for (const tool of toolCalls) {
        if (!sealed.tools.some(allowed => allowed.name === tool.name)) throw new ResidentOperatorError('Legacy REPL requested an undeclared tool', 'INVALID_RESULT')
        if (seenCalls.has(tool.id)) throw new ResidentOperatorError('Legacy REPL repeated a tool identity with an existing effect', 'COMMAND_INDETERMINATE')
        if (tool.id.length === 0 || batchCalls.has(tool.id)) throw new ResidentOperatorError('Legacy REPL returned duplicate or empty tool identities', 'INVALID_RESULT')
        batchCalls.add(tool.id)
      }
      messages.push(result)
      for (const tool of toolCalls) {
        request.signal.throwIfAborted()
        const attached = currentBridge()
        const toolCommandId = modelToolCommandId(String(request.commandId), 'codex', tool.id)
        await record?.({ kind: 'tool-call', callId: tool.id, toolCommandId, name: tool.name, arguments: tool.arguments })
        seenCalls.add(tool.id)
        calls++
        request.onObservation({ kind: 'tool-started', toolName: tool.name })
        let value: unknown
        try { value = await callModelToolBridge(attached, tool.name, tool.arguments, toolCommandId, request.signal) } catch {
          throw new ResidentOperatorError('Legacy REPL tool outcome is unknown; inspect the existing command before retrying', 'COMMAND_INDETERMINATE')
        }
        try { await record?.({ kind: 'tool-result', callId: tool.id, toolCommandId, name: tool.name, value }) } catch {
          throw new ResidentOperatorError('Legacy REPL result persistence failed after execution; inspect the existing command before retrying', 'COMMAND_INDETERMINATE')
        }
        const content = JSON.stringify(value)
        bytes += Buffer.byteLength(content)
        if (limits !== undefined && bytes > limits.maxOutputBytes) throw new ResidentOperatorError('Legacy REPL result exceeded its explicit byte limit', 'OUTPUT_LIMIT')
        const isError = value !== null && typeof value === 'object' && 'isError' in value && value.isError === true
        messages.push({ role: 'toolResult', toolCallId: tool.id, toolName: tool.name,
          content: [{ type: 'text', text: content }], isError, timestamp: Date.now() })
        request.onObservation({ kind: 'tool-completed', toolName: tool.name })
      }
    }
  })
}
