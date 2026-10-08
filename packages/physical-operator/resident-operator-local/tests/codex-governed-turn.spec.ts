import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { generateCodexModelCall as GenerateCodexModelCall } from '../src/codex-judgment.ts'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResidentOperatorError, ResidentOperatorCommandId, type ResidentDriverExecuteRequest } from '@deepseek-ai/dsh-resident-operator'
import { generateCodexGovernedTurn } from '../src/codex-governed-turn.ts'
import { CodexResidentDriver } from '../src/drivers.ts'
import * as modelToolBridge from '../src/model-tool-bridge.ts'
const { generate } = vi.hoisted(() => ({ generate: vi.fn<typeof GenerateCodexModelCall>() }))
vi.mock('../src/codex-judgment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/codex-judgment.ts')>(),
  generateCodexModelCall: generate, generateCodexJudgment: vi.fn(),
}))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks(); generate.mockReset()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return { role: 'assistant', api: 'openai-codex-responses', provider: 'openai-codex', model: 'selected-model', content, stopReason, timestamp: 0,
    responseId: 'actual-provider-response', usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
async function fixture(): Promise<ResidentDriverExecuteRequest> {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-governed-codex-'))
  const runtime = await mkdtemp(join(tmpdir(), 'dsh-governed-runtime-'))
  roots.push(workspace, runtime)
  await writeFile(join(workspace, 'input.txt'), 'approved input')
  return { commandId: ResidentOperatorCommandId('taskgraph-node'), workspace, profile: { model: 'selected-model', effort: 'high' },
    prompt: [{ type: 'text', text: 'Read input.txt and write output.txt' }], nativeToolPolicy: 'dsh-tools-authoritative',
    governedToolRoot: runtime, generationLimits: { maxTokens: 100, maxOutputBytes: 20000, maxToolCalls: 4 },
    governedWorkspacePolicy: { version: 1, sourceWorkspace: '/original/source', readScopes: ['input.txt'], writeScopes: ['output.txt'], forbiddenScopes: [],
      limits: { maxToolCalls: 4, maxFileBytes: 4096, maxOutputBytes: 5000, maxSearchFiles: 20 } },
    signal: new AbortController().signal, onRunning: vi.fn(), onProgress: vi.fn(), onObservation: vi.fn() }
}

describe('governed Codex direct-model workspace execution', () => {
  it('executes real scoped reads/writes through the driver without native qualification and retains actual API provenance', async () => {
    const request = await fixture()
    generate.mockResolvedValueOnce(assistant([{ type: 'toolCall', id: 'read-1', name: 'workspace_files', arguments: { operation: 'read', path: 'input.txt' } }], 'toolUse'))
    generate.mockImplementationOnce(async (input) => {
      const result = input.messages.at(-1)
      expect(result?.role).toBe('toolResult')
      if (result?.role !== 'toolResult') throw new Error('fixture tool result missing')
      const block = result.content[0]
      expect(block?.type).toBe('text')
      if (block?.type === 'text') expect(block.text).toContain('approved input')
      return assistant([{ type: 'toolCall', id: 'write-1', name: 'workspace_files', arguments: { operation: 'write', path: 'output.txt', content: 'derived output' } }], 'toolUse')
    })
    generate.mockResolvedValueOnce(assistant([{ type: 'text', text: 'File written.' }], 'stop'))
    const driver = new CodexResidentDriver()
    const qualify = vi.spyOn(driver, 'qualify')
    const result = await driver.execute(request)
    expect(await readFile(join(request.workspace, 'output.txt'), 'utf8')).toBe('derived output')
    expect(result).toMatchObject({ output: [{ type: 'text', text: 'File written.' }], usage: { inputTokens: 30, outputTokens: 15 }, providerResponse: { provider: 'openai-codex', model: 'selected-model', responseId: 'actual-provider-response' } })
    expect(result).not.toHaveProperty('nativeSessionId')
    expect(qualify).not.toHaveBeenCalled()
    expect(request.onRunning).toHaveBeenCalledWith()
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ model: 'selected-model', effort: 'high', tools: [{ name: 'workspace_files' }] })
    expect(generate.mock.calls[1]?.[0].generationLimits?.maxTokens).toBe(95)
    const tracePath = join(request.governedToolRoot!, createHash('sha256').update(String(request.commandId)).digest('hex'), 'model-transcript.jsonl')
    const trace = (await readFile(tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { kind: string; state?: string; input?: unknown })
    expect(trace.map(value => value.kind)).toEqual(['model-input', 'model-output', 'tool-call', 'tool-result', 'model-input', 'model-output', 'tool-call', 'tool-result', 'model-input', 'model-output'])
    expect(trace[2]).toMatchObject({ state: 'executing' })
    expect(trace[3]).toMatchObject({ state: 'settled' })
    expect(trace[0]?.input).not.toHaveProperty('apiKey')
  })

  it('returns actual executor denial to the model while leaving an undeclared file unchanged', async () => {
    const request = await fixture()
    generate.mockResolvedValueOnce(assistant([{ type: 'toolCall', id: 'write-denied', name: 'workspace_files', arguments: { operation: 'write', path: 'input.txt', content: 'unauthorized' } }], 'toolUse'))
    generate.mockImplementationOnce(async (input) => {
      const result = input.messages.at(-1)
      expect(result).toMatchObject({ role: 'toolResult', isError: true })
      if (result?.role !== 'toolResult') throw new Error('fixture tool result missing')
      const block = result.content[0]
      expect(block?.type).toBe('text')
      if (block?.type === 'text') expect(block.text).toContain('approved scopes')
      return assistant([{ type: 'text', text: 'Requested write was denied.' }], 'stop')
    })
    await generateCodexGovernedTurn(request)
    expect(await readFile(join(request.workspace, 'input.txt'), 'utf8')).toBe('approved input')
  })

  it('refuses shell/network tools and oversized tool batches before any effect', async () => {
    const request = await fixture()
    generate.mockResolvedValueOnce(assistant([{ type: 'toolCall', id: 'native-shell', name: 'shell', arguments: { command: 'touch output.txt' } }], 'toolUse'))
    await expect(generateCodexGovernedTurn(request)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    generate.mockResolvedValueOnce(assistant([
      { type: 'toolCall', id: 'write-1', name: 'workspace_files', arguments: { operation: 'write', path: 'output.txt', content: 'first' } },
      { type: 'toolCall', id: 'write-2', name: 'workspace_files', arguments: { operation: 'write', path: 'output.txt', content: 'second' } },
    ], 'toolUse'))
    await expect(generateCodexGovernedTurn({ ...request, generationLimits: { ...request.generationLimits!, maxToolCalls: 1 } })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
    await expect(readFile(join(request.workspace, 'output.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })


  it('stops after an unknown tool outcome without a second model call or a fresh duplicate effect', async () => {
    const request = await fixture()
    generate.mockResolvedValueOnce(assistant([{ type: 'toolCall', id: 'uncertain-write', name: 'workspace_files', arguments: { operation: 'write', path: 'output.txt', content: 'once' } }], 'toolUse'))
    const effect = vi.spyOn(modelToolBridge, 'callModelToolBridge').mockImplementationOnce(async () => {
      await writeFile(join(request.workspace, 'output.txt'), 'effect occurred once')
      throw new ResidentOperatorError('JSON-RPC input closed after file execution', 'RUNTIME_UNAVAILABLE')
    })
    await expect(generateCodexGovernedTurn(request)).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(await readFile(join(request.workspace, 'output.txt'), 'utf8')).toBe('effect occurred once')
  })
  it('never admits an external bridge or missing generation budgets', async () => {
    const request = await fixture()
    await expect(generateCodexGovernedTurn({ ...request, modelToolBridge: { version: 1, sessionId: 'external', socketPath: '/not-opened', tools: [] } })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    const { generationLimits: _limits, ...withoutLimits } = request
    await expect(generateCodexGovernedTurn(withoutLimits)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(generate).not.toHaveBeenCalled()
  })
})
