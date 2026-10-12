/** Legacy disabled REPL bridge compatibility through the real JSON-RPC IPC executor and mocked model wire. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from '@earendil-works/pi-ai'
import type { stream as CodexStream } from '@earendil-works/pi-ai/api/openai-codex-responses'
import type { openaiCodexProvider as CodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { localIpcAddress, localIpcUsesFilesystem } from '@deepseek-ai/dsh-home-paths'
import { LocalJsonRpcRequestServer } from '@deepseek-ai/dsh-sdk-protocol'
import type { PhysicalOperatorModelToolBridgeV1 } from '@deepseek-ai/dsh-physical-operator'
import { ResidentOperatorCommandId, type ResidentDriverExecuteRequest } from '@deepseek-ai/dsh-resident-operator'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generateCodexBridgeTurn } from '../src/codex-bridge-turn.ts'
import type { CodexModelRecord } from '../src/codex-judgment.ts'
const { streamMock, providerMock } = vi.hoisted(() => ({
  streamMock: vi.fn<typeof CodexStream>(), providerMock: vi.fn<typeof CodexProvider>(),
}))
vi.mock('@earendil-works/pi-ai/api/openai-codex-responses', () => ({ stream: streamMock }))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({ openaiCodexProvider: providerMock }))
const template: Model<'openai-codex-responses'> = {
  id: 'selected-model', name: 'Selected', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api',
  reasoning: true, input: ['text'], contextWindow: 1000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return { role: 'assistant', api: 'openai-codex-responses', provider: 'openai-codex', model: 'selected-model', content, stopReason, timestamp: 0,
    responseId: 'actual-api-response', usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
}
function events(result: AssistantMessage) {
  const value = createAssistantMessageEventStream()
  if (result.stopReason === 'error' || result.stopReason === 'aborted') value.push({ type: 'error', reason: result.stopReason, error: result })
  else value.push({ type: 'done', reason: result.stopReason, message: result })
  value.end(result)
  return value
}
function call(id = 'cell-1', name = 'typescript_repl'): AssistantMessage {
  return assistant([{ type: 'toolCall', id, name, arguments: { code: '1 + 1' } }], 'toolUse')
}
let root = ''
const servers: LocalJsonRpcRequestServer[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-legacy-codex-repl-'))
  vi.stubEnv('CODEX_HOME', root)
  const access = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`
  await writeFile(join(root, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: access } }), { mode: 0o600 })
  streamMock.mockReset(); providerMock.mockReset()
  providerMock.mockReturnValue({ id: 'openai-codex', name: 'fixture', auth: {}, getModels: () => [template], stream: streamMock, streamSimple: streamMock })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const server of servers.splice(0)) await server.dispose()
  await rm(root, { recursive: true, force: true })
})
async function bridge(label = 'owner', handler?: (params: Record<string, unknown>) => Promise<unknown>) {
  const socketPath = localIpcAddress(root, `${label}.sock`)
  const calls: Record<string, unknown>[] = []
  const methods: string[] = []
  const endpoint = { path: socketPath, ...localIpcUsesFilesystem() ? { directory: root } : {} }
  const server = new LocalJsonRpcRequestServer(endpoint, async (method, params) => {
    methods.push(method)
    if (method !== 'tool.call') throw new Error('Legacy RLM implements tool.call only')
    calls.push(params)
    return handler === undefined ? { value: 2 } : handler(params)
  })
  await server.start(); servers.push(server)
  const descriptor: PhysicalOperatorModelToolBridgeV1 = { version: 1, socketPath, sessionId: label,
    tools: [{ name: 'typescript_repl', description: 'Existing REPL', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }] }
  return { descriptor, calls, methods }
}
function request(descriptor: PhysicalOperatorModelToolBridgeV1): ResidentDriverExecuteRequest {
  return { commandId: ResidentOperatorCommandId('existing-rlm-command'), workspace: '/never-read-workspace', profile: { model: 'selected-model', effort: 'high' },
    prompt: [{ type: 'text', text: 'Use the sealed REPL to calculate two.' }], systemPrompt: 'Use only the declared REPL.', nativeToolPolicy: 'disabled',
    modelToolBridge: descriptor, modelToolBridgeAdmissionTimeoutMs: 1000, governedToolRoot: join(root, 'model-tools'),
    signal: new AbortController().signal, onRunning: vi.fn(), onProgress: vi.fn(), onObservation: vi.fn() }
}
it('preserves an old tool-free-native RLM request with omitted limits using only the existing REPL IPC tool', async () => {
  const binding = await bridge()
  streamMock.mockReturnValueOnce(events(call()))
  streamMock.mockImplementationOnce((_model, context) => {
    expect(context.messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'cell-1', toolName: 'typescript_repl', content: [{ type: 'text', text: '{"value":2}' }] })
    return events(assistant([{ type: 'text', text: '2' }], 'stop'))
  })
  const input = request(binding.descriptor)
  const result = await generateCodexBridgeTurn(input)
  expect(result).toMatchObject({ output: [{ type: 'text', text: '2' }], usage: { inputTokens: 20, outputTokens: 10 }, providerResponse: { responseId: 'actual-api-response' } })
  expect(result).not.toHaveProperty('nativeSessionId')
  expect(streamMock).toHaveBeenCalledTimes(2)
  expect(streamMock.mock.calls[0]?.[1].tools?.map(tool => tool.name)).toEqual(['typescript_repl'])
  expect(streamMock.mock.calls[0]?.[2]).toMatchObject({ toolChoice: 'auto', reasoningEffort: 'high', maxRetries: 0 })
  expect(streamMock.mock.calls[0]?.[2]).not.toHaveProperty('maxTokens')
  expect(binding.methods).toEqual(['tool.call'])
  expect(binding.calls).toEqual([{ session_id: 'owner', command_id: 'existing-rlm-command:codex-tool:cell-1', tool: 'typescript_repl', arguments: { code: '1 + 1' } }])
  const tracePath = join(input.governedToolRoot as string, createHash('sha256').update(String(input.commandId)).digest('hex'), 'model-transcript.jsonl')
  const records = (await readFile(tracePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as CodexModelRecord)
  expect(records.map(value => value.kind)).toEqual(['model-input', 'model-output', 'tool-call', 'tool-result', 'model-input', 'model-output'])
  expect(records[0]).toMatchObject({ generationPolicy: { kind: 'provider-default', toolPolicy: 'legacy-repl-bridge' } })
})
it('reads the current getter endpoint for every tool invocation while keeping the sealed definitions', async () => {
  const original = await bridge('original'); const replacement = await bridge('reattached')
  let current = original.descriptor
  const input = { ...request(current), get modelToolBridge() { return current } }
  streamMock.mockImplementationOnce(() => { current = replacement.descriptor; return events(call()) })
  streamMock.mockReturnValueOnce(events(assistant([{ type: 'text', text: 'done' }], 'stop')))
  await generateCodexBridgeTurn(input)
  expect(original.calls).toHaveLength(0)
  expect(replacement.calls[0]).toMatchObject({ session_id: 'reattached', command_id: 'existing-rlm-command:codex-tool:cell-1' })
})
it('stops after a lost tool callback with the original effect identity and no second model or duplicate effect', async () => {
  const effectFile = join(root, 'effect-receipt')
  const binding = await bridge('uncertain', async () => { await writeFile(effectFile, 'executed once'); throw new Error('callback failed after execution') })
  streamMock.mockReturnValueOnce(events(call()))
  await expect(generateCodexBridgeTurn(request(binding.descriptor))).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
  expect(binding.calls).toHaveLength(1)
  expect(streamMock).toHaveBeenCalledOnce()
  expect(await readFile(effectFile, 'utf8')).toBe('executed once')
})
it('rejects any non-REPL bridge before model generation and any non-sealed model tool before IPC execution', async () => {
  const binding = await bridge()
  const bad = { ...binding.descriptor, tools: [{ ...binding.descriptor.tools[0], name: 'shell', description: 'bad', inputSchema: {} }] }
  await expect(generateCodexBridgeTurn(request(bad))).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  expect(streamMock).not.toHaveBeenCalled()
  streamMock.mockReturnValueOnce(events(call('shell-1', 'shell')))
  await expect(generateCodexBridgeTurn(request(binding.descriptor))).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  expect(binding.calls).toHaveLength(0)
})
it('honors explicit aggregate token and tool-call caps before starting another model or any oversized batch', async () => {
  const binding = await bridge()
  const input = { ...request(binding.descriptor), generationLimits: { maxTokens: 5, maxOutputBytes: 20000, maxToolCalls: 3 } }
  streamMock.mockReturnValueOnce(events(call()))
  await expect(generateCodexBridgeTurn(input)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
  expect(binding.calls).toHaveLength(1)
  expect(streamMock).toHaveBeenCalledOnce()
  streamMock.mockReturnValueOnce(events(assistant([{ type: 'toolCall', id: 'a', name: 'typescript_repl', arguments: { code: '1' } }, { type: 'toolCall', id: 'b', name: 'typescript_repl', arguments: { code: '2' } }], 'toolUse')))
  await expect(generateCodexBridgeTurn({ ...input, generationLimits: { ...input.generationLimits, maxTokens: 30, maxToolCalls: 1 } })).rejects.toMatchObject({ code: 'OUTPUT_LIMIT' })
  expect(binding.calls).toHaveLength(1)
})
it('rejects changed catalogs and repeated provider call identities without repeating a settled callback', async () => {
  const binding = await bridge()
  let current = binding.descriptor
  streamMock.mockImplementationOnce(() => { current = { ...current, tools: [{ name: 'typescript_repl', description: 'changed', inputSchema: {} }] }; return events(call()) })
  await expect(generateCodexBridgeTurn({ ...request(binding.descriptor), get modelToolBridge() { return current } })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  expect(binding.calls).toHaveLength(0)
  streamMock.mockReturnValueOnce(events(call())).mockReturnValueOnce(events(call()))
  await expect(generateCodexBridgeTurn(request(binding.descriptor))).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
  expect(binding.calls).toHaveLength(1)
})
it('honors cancellation without model generation or tool execution', async () => {
  const binding = await bridge(); const controller = new AbortController(); const error = new Error('cancelled'); controller.abort(error)
  await expect(generateCodexBridgeTurn({ ...request(binding.descriptor), signal: controller.signal })).rejects.toBe(error)
  expect(streamMock).not.toHaveBeenCalled(); expect(binding.calls).toHaveLength(0)
})
