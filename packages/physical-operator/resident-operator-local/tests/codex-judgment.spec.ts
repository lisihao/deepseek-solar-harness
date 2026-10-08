/** Subscription-only model calls use real account-file parsing and a mocked external responses stream. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { stream as CodexStream } from '@earendil-works/pi-ai/api/openai-codex-responses'
import type { openaiCodexProvider as CodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import type { ResidentDriverExecuteRequest } from '@deepseek-ai/dsh-resident-operator'
import { ResidentOperatorCommandId } from '@deepseek-ai/dsh-resident-operator'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { generateCodexJudgment, generateCodexModelCall, type CodexModelRecord } from '../src/codex-judgment.ts'
import { decodeGenerationLimits, decodeGovernedWorkspacePolicy } from '../src/protocol.ts'
const { streamMock, providerMock } = vi.hoisted(() => ({
  streamMock: vi.fn<typeof CodexStream>(), providerMock: vi.fn<typeof CodexProvider>(),
}))
vi.mock('@earendil-works/pi-ai/api/openai-codex-responses', () => ({ stream: streamMock }))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({ openaiCodexProvider: providerMock }))
const limits = { maxTokens: 20, maxOutputBytes: 3000, maxToolCalls: 0 }
const template: Model<'openai-codex-responses'> = { id: 'catalog-model', name: 'Catalog', api: 'openai-codex-responses', provider: 'openai-codex', baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text'], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: 'assistant', api: 'openai-codex-responses', provider: 'openai-codex', model: 'resolved-native-model', content: [{ type: 'text', text: '{"candidateId":"chat"}' }], stopReason: 'stop', usage: { input: 3, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0, responseId: 'provider-response', ...overrides }
}
function messageEvents(result: AssistantMessage) {
  const events = createAssistantMessageEventStream()
  if (result.stopReason === 'error' || result.stopReason === 'aborted') events.push({ type: 'error', reason: result.stopReason, error: result })
  else events.push({ type: 'done', reason: result.stopReason, message: result })
  events.end(result)
  return events
}
function mockResult(result: AssistantMessage) { streamMock.mockReturnValue(messageEvents(result)) }
function request(): ResidentDriverExecuteRequest {
  return { commandId: ResidentOperatorCommandId('stable-physical-execution'), workspace: '/project-not-read', prompt: [{ type: 'text', text: 'Choose candidate chat' }], systemPrompt: 'Only select an existing candidate.', profile: { model: 'resolved-native-model', effort: 'low' }, nativeToolPolicy: 'disabled', generationLimits: limits, signal: new AbortController().signal, onRunning: vi.fn(), onProgress: vi.fn(), onObservation: vi.fn() }
}
let authHome = ''
function accessToken(expiry = Math.floor(Date.now() / 1000) + 3600): string {
  return `fixture.${Buffer.from(JSON.stringify({ exp: expiry, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`
}
beforeEach(async () => {
  authHome = await mkdtemp(join(tmpdir(), 'dsh-codex-account-test-'))
  vi.stubEnv('CODEX_HOME', authHome)
  await writeFile(join(authHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: accessToken() } }), { mode: 0o600 })
  streamMock.mockReset(); providerMock.mockReset(); providerMock.mockReturnValue({ id: 'openai-codex', name: 'fixture', auth: {}, getModels: () => [template], stream: streamMock, streamSimple: streamMock })
  mockResult(assistant())
})
afterEach(async () => { vi.unstubAllEnvs(); await rm(authHome, { recursive: true, force: true }) })
it('uses only the exact subscription account with no native session/tools, no retries and bounded options', async () => {
  const input = request()
  const result = await generateCodexJudgment(input)
  expect(result).toMatchObject({ output: [{ type: 'text', text: '{"candidateId":"chat"}' }], stopReason: 'completed', usage: { inputTokens: 3, outputTokens: 5, cacheReadInputTokens: 2 } })
  expect('nativeSessionId' in result).toBe(false)
  expect(input.onRunning).toHaveBeenCalledWith()
  const call = streamMock.mock.calls[0]
  if (!call) throw new Error('fixture stream was not called')
  const [model, context, options] = call
  expect(model).toMatchObject({ id: 'resolved-native-model', api: 'openai-codex-responses' })
  expect(context).toMatchObject({ systemPrompt: input.systemPrompt, messages: [{ role: 'user', content: 'Choose candidate chat' }], tools: [] })
  expect(typeof context.messages[0]?.timestamp).toBe('number')
  expect(options).toMatchObject({ toolChoice: 'none', transport: 'sse', maxRetries: 0, maxTokens: 20, cacheRetention: 'none', reasoningEffort: 'low' })
})
it('refuses expired, missing, wrong-mode and malformed account authentication without a model call', async () => {
  for (const [contents, code] of [[JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: accessToken(1) } }), 'AUTH_EXPIRED'], ['{}', 'AUTH_MODE_MISMATCH'], ['invalid private data', 'AUTH_MODE_MISMATCH']] as const) {
    await writeFile(join(authHome, 'auth.json'), contents)
    await expect(generateCodexJudgment(request())).rejects.toMatchObject({ code })
  }
  await rm(join(authHome, 'auth.json'))
  await expect(generateCodexJudgment(request())).rejects.toMatchObject({ code: 'AUTH_MODE_MISMATCH' })
  expect(streamMock).not.toHaveBeenCalled()
})
it('refuses a bridge on model-only execution', async () => {
  const input = request()
  await expect(generateCodexJudgment({ ...input, modelToolBridge: { version: 1, socketPath: '/must-not-open', sessionId: 's', tools: [] } })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  expect(streamMock).not.toHaveBeenCalled()
})
it('supports explicitly supplied tool definitions for the separate governed executor without running them', async () => {
  const input = request()
  const message = assistant({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call-1', name: 'workspace_files', arguments: { action: 'read', path: 'README.md' } }] })
  mockResult(message)
  expect(await generateCodexModelCall({ model: input.profile.model, messages: [], tools: [{ name: 'workspace_files', description: 'governed', inputSchema: { type: 'object' } }], generationLimits: { ...limits, maxToolCalls: 1 }, signal: input.signal })).toEqual(message)
  expect(streamMock.mock.calls[0]?.[1]).toMatchObject({ tools: [{ name: 'workspace_files', parameters: { type: 'object' } }] })
  expect(streamMock.mock.calls[0]?.[2]).toMatchObject({ toolChoice: 'auto' })
})
it('rejects unsolicited tools, excessive bytes and reported token overflow', async () => {
  const oversized = assistant({ content: [{ type: 'text', text: '中'.repeat(3000) }] })
  const tokens = assistant({ usage: { ...assistant().usage, output: 21 } })
  const tool = assistant({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c', name: 'unknown', arguments: {} }] })
  for (const [result, code] of [[oversized, 'OUTPUT_LIMIT'], [tokens, 'OUTPUT_LIMIT'], [tool, 'INVALID_RESULT']] as const) {
    mockResult(result)
    await expect(generateCodexJudgment(request())).rejects.toMatchObject({ code })
  }
})
it('redacts the exact access token from a provider error and preserves authentication classification', async () => {
  const token = accessToken()
  streamMock.mockImplementation((_model, _context, options) => {
    if (!options?.onResponse) throw new Error('fixture onResponse missing')
    void options.onResponse({ status: 401, headers: {} }, _model)
    const result = assistant({ stopReason: 'error', errorMessage: `rejected ${token}` })
    return messageEvents(result)
  })
  await expect(generateCodexJudgment(request())).rejects.toMatchObject({ code: 'AUTH_MODE_MISMATCH', message: 'rejected [redacted]' })
})
it('honors cancellation before credential reading or provider dispatch', async () => {
  const input = request(); const controller = new AbortController(); const error = new Error('cancelled'); controller.abort(error)
  await expect(generateCodexJudgment({ ...input, signal: controller.signal })).rejects.toBe(error)
  expect(streamMock).not.toHaveBeenCalled()
})
it('strictly decodes typed generation limits and rejects malformed wire fields', () => {
  expect(decodeGenerationLimits(limits)).toEqual(limits)
  expect(decodeGenerationLimits(undefined)).toBeUndefined()
  for (const invalid of [null, {}, { ...limits, maxTokens: 0 }, { ...limits, maxToolCalls: -1 }, { ...limits, unexpected: true }]) {
    expect(() => decodeGenerationLimits(invalid)).toThrow()
  }
})
it('strictly decodes sealed workspace policy without modifying its scope paths', () => {
  const policy = { version: 1, sourceWorkspace: '/source', readScopes: ['README.md'], writeScopes: [], forbiddenScopes: ['secret'], limits: { maxToolCalls: 2, maxFileBytes: 100, maxOutputBytes: 200, maxSearchFiles: 3 } }
  expect(decodeGovernedWorkspacePolicy(policy)).toEqual(policy)
  expect(decodeGovernedWorkspacePolicy(undefined)).toBeUndefined()
  for (const invalid of [null, {}, { ...policy, sourceWorkspace: 'relative' }, { ...policy, readScopes: [null] }, { ...policy, limits: { ...policy.limits, maxSearchFiles: 0 } }]) expect(() => decodeGovernedWorkspacePolicy(invalid)).toThrow()
})

it('preserves emitted reasoning and the actual API response id without creating a native Session', async () => {
  mockResult(assistant({ content: [{ type: 'thinking', thinking: 'Provider summary.' }, { type: 'text', text: 'chat' }] }))
  const result = await generateCodexJudgment(request())
  expect(result.output).toEqual([{ type: 'reasoning', text: 'Provider summary.' }, { type: 'text', text: 'chat' }])
  expect(result.providerResponse).toEqual({ provider: 'openai-codex', model: 'resolved-native-model', responseId: 'provider-response' })
  expect('nativeSessionId' in result).toBe(false)
})

it('retains provider defaults for legacy tool-free requests without exposing tools or changing model and effort', async () => {
  const { generationLimits: _limits, ...input } = request()
  mockResult(assistant({ usage: { ...assistant().usage, output: 200 } }))
  const result = await generateCodexJudgment(input)
  expect(result.stopReason).toBe('completed')
  expect(streamMock).toHaveBeenCalledOnce()
  expect(streamMock.mock.calls[0]?.[0].id).toBe(input.profile.model)
  expect(streamMock.mock.calls[0]?.[1].tools).toEqual([])
  const options = streamMock.mock.calls[0]?.[2]
  expect(options).not.toHaveProperty('maxTokens')
  expect(options).toMatchObject({ toolChoice: 'none', reasoningEffort: input.profile.effort, maxRetries: 0 })
})
it('rejects unsolicited tools under the legacy provider-default policy', async () => {
  const { generationLimits: _limits, ...input } = request()
  mockResult(assistant({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'c', name: 'unexpected', arguments: {} }] }))
  await expect(generateCodexJudgment(input)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  expect(streamMock).toHaveBeenCalledOnce()
})
it('rejects tool-enabled model calls without explicit limits before dispatch', async () => {
  await expect(generateCodexModelCall({ model: 'resolved-native-model', messages: [], signal: request().signal,
    tools: [{ name: 'workspace_files', description: 'governed', inputSchema: { type: 'object' } }] })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  expect(streamMock).not.toHaveBeenCalled()
})
it('fsyncs the complete model context and actual output with the declared policy under the daemon-owned root', async () => {
  for (const bounded of [false, true]) {
    const original = request()
    const { generationLimits: _limits, ...legacy } = original
    const input = bounded ? original : legacy
    const commandId = ResidentOperatorCommandId(bounded ? 'bounded' : 'legacy')
    await generateCodexJudgment({ ...input, commandId, governedToolRoot: join(authHome, 'daemon-io') })
    const path = join(authHome, 'daemon-io', createHash('sha256').update(String(commandId)).digest('hex'), 'model-transcript.jsonl')
    const content = await readFile(path, 'utf8')
    const records = content.trim().split('\n').map(line => JSON.parse(line) as CodexModelRecord)
    const modelInput = records.find(entry => entry.kind === 'model-input')
    const modelOutput = records.find(entry => entry.kind === 'model-output')
    expect(records.map(entry => entry.kind)).toEqual(['model-input', 'model-output'])
    expect(modelInput?.generationPolicy.kind).toBe(bounded ? 'bounded' : 'provider-default')
    expect(modelInput?.input).toMatchObject({ model: input.profile.model, systemPrompt: input.systemPrompt,
      messages: [{ role: 'user', content: 'Choose candidate chat' }], options: { transport: 'sse', maxRetries: 0, toolChoice: 'none' } })
    if (bounded) expect(modelInput?.input.options.maxTokens).toBe(limits.maxTokens)
    else expect(modelInput?.input.options).not.toHaveProperty('maxTokens')
    expect(modelOutput?.message.responseId).toBe('provider-response')
    expect(content).not.toContain(accessToken())
    expect(content).not.toContain('apiKey')
  }
})

it('stops before provider dispatch when the daemon-owned transcript cannot be created', async () => {
  await expect(generateCodexJudgment({ ...request(), governedToolRoot: join(authHome, 'auth.json') })).rejects.toThrow()
  expect(streamMock).not.toHaveBeenCalled()
})

it('allows provider defaults only for the exact validated legacy REPL descriptor and rejects changed definitions', async () => {
  const input = request()
  const bridge = { version: 1 as const, sessionId: 'legacy', socketPath: '/not-used-by-model-utility', tools: [
    { name: 'typescript_repl', description: 'sealed', inputSchema: { type: 'object', properties: { code: { type: 'string' } } } },
  ] }
  const record = vi.fn()
  const message = assistant({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'legacy-cell', name: 'typescript_repl', arguments: { code: '1' } }] })
  mockResult(message)
  await expect(generateCodexModelCall({ model: input.profile.model, messages: [], tools: bridge.tools, legacyReplBridge: bridge,
    signal: input.signal, record })).resolves.toEqual(message)
  expect(record.mock.calls[0]?.[0]).toMatchObject({ generationPolicy: { kind: 'provider-default', toolPolicy: 'legacy-repl-bridge' } })
  expect(streamMock.mock.calls[0]?.[2]).not.toHaveProperty('maxTokens')
  const changed = [{ name: 'typescript_repl', description: 'changed', inputSchema: {} }]
  await expect(generateCodexModelCall({ model: input.profile.model, messages: [], tools: changed, legacyReplBridge: bridge,
    signal: input.signal })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  const shellBridge = { ...bridge, tools: [{ name: 'shell', description: 'forbidden', inputSchema: {} }] }
  await expect(generateCodexModelCall({ model: input.profile.model, messages: [], tools: shellBridge.tools, legacyReplBridge: shellBridge,
    signal: input.signal })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
  expect(streamMock).toHaveBeenCalledOnce()
})
