/** Direct Codex model turns whose only file effects run through the scoped DSH workspace executor. */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, open, type FileHandle } from 'node:fs/promises'
import type { Context as PiContext } from '@earendil-works/pi-ai'
import { ResidentOperatorError, type ResidentDriverExecuteRequest, type ResidentTurnResult } from '@deepseek-ai/dsh-resident-operator'
import { generateCodexModelCall } from './codex-judgment.ts'
import { callModelToolBridge } from './model-tool-bridge.ts'
import { WorkspaceModelToolBridge } from './workspace-model-tool-bridge.ts'

/**
 * Execute a bounded model/tool loop using explicit file tools and the actual driver workspace.
 * The model API creates no native session and never starts a CLI, MCP server or host skill.
 * @param request - sealed workspace policy, generation limits, execution directory and daemon-owned endpoint root.
 * @returns canonical final output, aggregate usage and actual last provider response identity.
 */
export async function generateCodexGovernedTurn(request: ResidentDriverExecuteRequest): Promise<ResidentTurnResult> {
  const policy = request.governedWorkspacePolicy
  const limits = request.generationLimits
  if (request.nativeToolPolicy !== 'dsh-tools-authoritative' || policy === undefined || limits === undefined || request.governedToolRoot === undefined) {
    throw new ResidentOperatorError('Governed Codex requires a workspace policy, explicit generation limits and a private tool root', 'INVALID_RESULT')
  }
  if (request.modelToolBridge !== undefined) throw new ResidentOperatorError('Governed workspace execution cannot inherit an external model tool bridge', 'INVALID_RESULT')
  const prompt: string[] = []
  for (const block of request.prompt) {
    if (block.type !== 'text') throw new ResidentOperatorError('Governed Codex accepts text prompt blocks only', 'INVALID_RESULT')
    prompt.push(block.text)
  }
  const maxCalls = Math.min(policy.limits.maxToolCalls, limits.maxToolCalls ?? policy.limits.maxToolCalls)
  const root = join(request.governedToolRoot, createHash('sha256').update(String(request.commandId)).digest('hex'))
  await mkdir(root, { recursive: true, mode: 0o700 })
  const bridge = new WorkspaceModelToolBridge(root)
  const binding = await bridge.bind(String(request.commandId), { workspace: request.workspace, policy }, request.signal)
    .catch((error: unknown) => {
      if (error instanceof Error && error.message.includes('COMMAND_INDETERMINATE:')) {
        throw new ResidentOperatorError(error.message, 'COMMAND_INDETERMINATE')
      }
      throw error
    })
  let transcript: FileHandle | undefined

  const messages: PiContext['messages'] = [{ role: 'user', content: prompt.join('\n'), timestamp: Date.now() }]
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }
  let calls = 0
  let outputBytes = 0
  request.onProgress('connecting')
  request.onRunning()
  try {
    transcript = await open(join(root, 'model-transcript.jsonl'), 'a', 0o600)
    const journal = transcript
    const record = async (value: Record<string, unknown>): Promise<void> => {
      await journal.writeFile(`${JSON.stringify({ observedAt: new Date().toISOString(), commandId: String(request.commandId), ...value })}\n`)
      await journal.sync()
    }
    for (;;) {
      request.signal.throwIfAborted()
      const remainingTokens = limits.maxTokens - usage.outputTokens
      const remainingBytes = limits.maxOutputBytes - outputBytes
      if (remainingTokens <= 0 || remainingBytes <= 0) throw new ResidentOperatorError('Governed Codex exhausted its aggregate generation limits', 'OUTPUT_LIMIT')
      request.onProgress('reasoning')
      const modelInput = {
        model: request.profile.model,
        ...request.profile.effort === undefined ? {} : { effort: request.profile.effort },
        ...request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt },
        messages, tools: calls < maxCalls ? binding.descriptor.tools : [],
        generationLimits: { ...limits, maxTokens: remainingTokens, maxOutputBytes: remainingBytes },
      }
      await record({ kind: 'model-input', input: modelInput })
      const result = await generateCodexModelCall({ ...modelInput, signal: request.signal })
      await record({ kind: 'model-output', message: result })
      usage.inputTokens += result.usage.input
      usage.outputTokens += result.usage.output
      usage.cacheReadInputTokens += result.usage.cacheRead
      usage.cacheWriteInputTokens += result.usage.cacheWrite
      outputBytes += Buffer.byteLength(JSON.stringify(result))
      if (usage.outputTokens > limits.maxTokens || outputBytes > limits.maxOutputBytes) throw new ResidentOperatorError('Governed Codex exceeded its aggregate generation limits', 'OUTPUT_LIMIT')
      const toolCalls = result.content.filter(block => block.type === 'toolCall')
      if (toolCalls.length === 0) {
        if (result.stopReason !== 'stop') throw new ResidentOperatorError(`Governed Codex stopped with ${result.stopReason}`, 'INVALID_RESULT')
        request.onProgress('finalizing')
        return {
          output: result.content.flatMap<ResidentTurnResult['output'][number]>(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : block.type === 'thinking' ? [{ type: 'reasoning' as const, text: block.thinking }] : []),
          stopReason: 'completed', usage,
          providerResponse: { provider: 'openai-codex', model: result.responseModel ?? result.model, ...result.responseId === undefined ? {} : { responseId: result.responseId } },
        }
      }
      if (calls + toolCalls.length > maxCalls) throw new ResidentOperatorError('Governed Codex exceeded maxToolCalls before executing tools', 'OUTPUT_LIMIT')
      if (result.stopReason !== 'toolUse') throw new ResidentOperatorError('Governed Codex tool calls require a tool-use stop reason', 'INVALID_RESULT')
      messages.push(result)
      for (const tool of toolCalls) {
        if (tool.name !== 'workspace_files') throw new ResidentOperatorError('Governed Codex requested an undeclared tool', 'INVALID_RESULT')
        ++calls
        await record({ kind: 'tool-call', state: 'executing', callId: tool.id, name: tool.name, arguments: tool.arguments })
        request.onObservation({ kind: 'tool-started', toolName: tool.name })
        let value: unknown
        let isError = false
        try {
          value = await callModelToolBridge(binding.descriptor, tool.name, tool.arguments,
            `${String(request.commandId)}:workspace-tool:${tool.id}`, request.signal)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!message.includes('WORKSPACE_TOOL_DENIED:')) {
            throw new ResidentOperatorError('Governed workspace tool outcome is unknown; inspect the existing command before retrying', 'COMMAND_INDETERMINATE')
          }
          if (request.signal.aborted) throw request.signal.reason
          isError = true
          value = { error: error instanceof Error ? error.message : String(error) }
        }
        try {
          await record({ kind: 'tool-result', state: 'settled', callId: tool.id, name: tool.name, isError, value })
        } catch {
          throw new ResidentOperatorError('Governed tool result persistence failed after execution; inspect the existing command before retrying', 'COMMAND_INDETERMINATE')
        }
        const text = JSON.stringify(value)
        if (Buffer.byteLength(text) > policy.limits.maxOutputBytes) throw new ResidentOperatorError('Governed tool result exceeded maxOutputBytes', 'OUTPUT_LIMIT')
        messages.push({ role: 'toolResult', toolCallId: tool.id, toolName: tool.name, content: [{ type: 'text', text }], isError, timestamp: Date.now() })
        request.onObservation({ kind: 'tool-completed', toolName: tool.name })
      }
    }
  } finally {
    await binding.release()
    await bridge.dispose()
    await transcript?.close()
  }
}
