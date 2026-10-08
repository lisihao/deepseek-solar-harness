/** Tool-free Codex subscription requests; no native runtime or user configuration is loaded. */
import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, Context as PiContext, Tool } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { stream } from '@earendil-works/pi-ai/api/openai-codex-responses'
import type {
  PhysicalOperatorGenerationLimits, PhysicalOperatorModelToolBridgeV1, PhysicalOperatorModelToolV1, PhysicalOperatorReasoningEffort,
} from '@deepseek-ai/dsh-physical-operator'
import { ResidentOperatorError, type ResidentDriverExecuteRequest, type ResidentTurnResult } from '@deepseek-ai/dsh-resident-operator'
import { validateResidentModelToolBridge } from './model-tool-bridge.ts'
import { canonicalNativeToolCatalogHash } from './store.ts'

/** Explicit caller bounds, or the provider defaults retained for legacy tool-free requests. */
export type CodexGenerationPolicy =
  | { readonly kind: 'bounded'; readonly limits: PhysicalOperatorGenerationLimits }
  | { readonly kind: 'provider-default'; readonly toolPolicy?: 'legacy-repl-bridge' }

/** Complete model context and public options; credentials and transport headers are excluded. */
export type CodexModelRecord =
  | {
    readonly kind: 'model-input'
    readonly generationPolicy: CodexGenerationPolicy
    readonly input: {
      readonly model: string
      readonly systemPrompt?: string
      readonly messages: PiContext['messages']
      readonly tools: readonly PhysicalOperatorModelToolV1[]
      readonly options: {
        readonly transport: 'sse'
        readonly maxRetries: 0
        readonly cacheRetention: 'none'
        readonly toolChoice: 'none' | 'auto'
        readonly maxTokens?: number
        readonly reasoningEffort?: PhysicalOperatorReasoningEffort
      }
    } }
  | { readonly kind: 'model-output'; readonly generationPolicy: CodexGenerationPolicy; readonly message: AssistantMessage }
  | { readonly kind: 'tool-call'; readonly callId: string; readonly toolCommandId: string; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly kind: 'tool-result'; readonly callId: string; readonly toolCommandId: string; readonly name: string; readonly value: unknown }

/** One model turn; tool definitions never execute here and require explicit generation limits. */
export interface CodexModelCallInput {
  readonly model: string
  readonly systemPrompt?: string
  readonly messages: PiContext['messages']
  readonly tools?: readonly PhysicalOperatorModelToolV1[]
  readonly generationLimits?: PhysicalOperatorGenerationLimits
  /** Internal legacy exception: the disabled REPL descriptor must match every exposed tool definition. */
  readonly legacyReplBridge?: PhysicalOperatorModelToolBridgeV1
  readonly signal: AbortSignal
  readonly effort?: PhysicalOperatorReasoningEffort
  /** Persist the complete request before dispatch and the provider output after settlement. */
  readonly record?: (entry: CodexModelRecord) => Promise<void>
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
async function subscriptionToken(signal: AbortSignal): Promise<string> {
  const configuredHome = process.env.CODEX_HOME
  if (configuredHome !== undefined && !isAbsolute(configuredHome)) {
    throw new ResidentOperatorError('CODEX_HOME must be an absolute account directory', 'AUTH_MODE_MISMATCH')
  }
  const authPath = join(configuredHome ?? join(homedir(), '.codex'), 'auth.json')
  let value: unknown
  try {
    value = JSON.parse(await readFile(authPath, { encoding: 'utf8', signal }))
  } catch {
    if (signal.aborted) throw signal.reason
    throw new ResidentOperatorError('Codex account authentication is unavailable or invalid', 'AUTH_MODE_MISMATCH')
  }
  const account = object(value)
  const tokens = object(account?.tokens)
  const access = tokens?.access_token
  if (account?.auth_mode !== 'chatgpt' || typeof access !== 'string' || access.length === 0) {
    throw new ResidentOperatorError('Codex requires an existing ChatGPT subscription authentication', 'AUTH_MODE_MISMATCH')
  }
  let claims: Record<string, unknown> | undefined
  try { claims = object(JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8'))) } catch {
    throw new ResidentOperatorError('Codex subscription access token is invalid', 'AUTH_MODE_MISMATCH')
  }
  if (typeof claims?.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new ResidentOperatorError('Codex subscription access token has no valid expiry', 'AUTH_MODE_MISMATCH')
  }
  if (claims.exp * 1000 <= Date.now()) {
    throw new ResidentOperatorError('Codex subscription authentication has expired; refresh the existing product login', 'AUTH_EXPIRED')
  }
  return access
}
function resolveGenerationPolicy(input: CodexModelCallInput): CodexGenerationPolicy {
  if (input.model.trim().length === 0) throw new ResidentOperatorError('Codex requires a resolved model identity', 'INVALID_RESULT')
  const legacyBridge = validateResidentModelToolBridge(input.legacyReplBridge, 'disabled')
  if (legacyBridge !== undefined && canonicalNativeToolCatalogHash('disabled', legacyBridge)
    !== canonicalNativeToolCatalogHash('disabled', { ...legacyBridge, tools: input.tools ?? [] })) {
    throw new ResidentOperatorError('Codex legacy REPL tool definitions differ from the sealed catalog', 'PROTOCOL_MISMATCH')
  }
  const limits = input.generationLimits
  if (limits === undefined) {
    if (input.tools?.length && legacyBridge === undefined) throw new ResidentOperatorError('Codex tool-enabled requests require generation limits', 'INVALID_RESULT')
    return { kind: 'provider-default', ...legacyBridge === undefined ? {} : { toolPolicy: 'legacy-repl-bridge' } }
  }
  for (const limit of [limits.maxTokens, limits.maxOutputBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new ResidentOperatorError('Codex generation limits must be positive integers', 'INVALID_RESULT')
  }
  if (limits.maxToolCalls !== undefined && (!Number.isSafeInteger(limits.maxToolCalls) || limits.maxToolCalls < 0)) {
    throw new ResidentOperatorError('Codex tool-call limit must be a nonnegative integer', 'INVALID_RESULT')
  }
  return { kind: 'bounded', limits }
}
function checkOutput(message: AssistantMessage, limits: PhysicalOperatorGenerationLimits): void {
  if (Buffer.byteLength(JSON.stringify(message)) > limits.maxOutputBytes || message.usage.output > limits.maxTokens) {
    throw new ResidentOperatorError('Codex model output exceeded the generation limit', 'OUTPUT_LIMIT')
  }
}

/**
 * Call the subscription responses API once using only the authorized account token.
 * Native model identity is supplied by the caller's resolved profile. No native session is created.
 * The SDK accepts maxTokens; this Codex protocol does not send a server-side output token cap.
 * Tool-free and validated legacy REPL requests may retain provider defaults; all other tool-enabled requests require limits.
 * @param input - complete context, tool definitions, optional limits, cancellation and persistence callback.
 * @returns the provider's assistant message, including usage and an optional response id.
 */
export async function generateCodexModelCall(input: CodexModelCallInput): Promise<AssistantMessage> {
  const generationPolicy = resolveGenerationPolicy(input)
  const effort = input.effort
  if (effort === 'ultra') throw new ResidentOperatorError('Codex responses API does not support ultra effort', 'INVALID_RESULT')
  input.signal.throwIfAborted()
  const accessToken = await subscriptionToken(input.signal)
  const catalog = openaiCodexProvider().getModels()
  const template = catalog.find(model => model.id === input.model) ?? catalog[0]
  if (template === undefined) throw new ResidentOperatorError('Codex responses protocol catalog is unavailable', 'RUNTIME_UNAVAILABLE')
  // The descriptor supplies protocol metadata; its template capacities and prices are not native-model measurements.
  const model = { ...template, id: input.model, name: input.model }
  const tools: Tool[] = (input.tools ?? []).map(tool => ({
    name: tool.name, description: tool.description,
    // DSH validates JSON Schema before sealing the bridge; pi-ai's TypeBox marker has no wire representation.
    parameters: tool.inputSchema as Tool['parameters'],
  }))
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  let status: number | undefined
  const context = {
    ...input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt },
    messages: structuredClone(input.messages), tools,
  }
  const publicOptions = {
    transport: 'sse' as const, maxRetries: 0 as const, cacheRetention: 'none' as const,
    toolChoice: tools.length === 0 ? 'none' as const : 'auto' as const,
    ...generationPolicy.kind === 'provider-default' ? {} : { maxTokens: generationPolicy.limits.maxTokens },
    ...effort === undefined ? {} : { reasoningEffort: effort },
  }
  await input.record?.({ kind: 'model-input', generationPolicy, input: {
    model: model.id, ...input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt },
    messages: context.messages, tools: input.tools ?? [], options: publicOptions,
  } })
  input.signal.throwIfAborted()
  const events = stream(model, context, {
    apiKey: accessToken, signal, ...publicOptions,
    onResponse: (response) => { status = response.status },
  })
  let settled = false
  try {
    for await (const event of events) {
      input.signal.throwIfAborted()
      const partial = 'partial' in event ? event.partial : event.type === 'done' ? event.message : event.error
      if (generationPolicy.kind === 'bounded') checkOutput(partial, generationPolicy.limits)
    }
    const result = await events.result()
    settled = true
    input.signal.throwIfAborted()
    await input.record?.({ kind: 'model-output', generationPolicy, message: scrubCredential(result, accessToken) })
    if (generationPolicy.kind === 'bounded') checkOutput(result, generationPolicy.limits)
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
      const code = status === 401 || status === 403 ? 'AUTH_MODE_MISMATCH'
        : status === 429 ? 'QUOTA_EXHAUSTED' : status === 400 ? 'INVALID_RESULT' : 'RUNTIME_UNAVAILABLE'
      const message = (result.errorMessage ?? 'Codex responses API request failed').split(accessToken).join('[redacted]')
      throw new ResidentOperatorError(message, code)
    }
    if (tools.length === 0 && result.content.some(block => block.type === 'toolCall')) {
      throw new ResidentOperatorError('Codex returned a tool call with no tools exposed', 'INVALID_RESULT')
    }
    return result
  } finally {
    if (!settled) {
      controller.abort('Codex model consumer stopped')
      const partial = await events.result()
      await input.record?.({ kind: 'model-output', generationPolicy, message: scrubCredential(partial, accessToken) })
    }
  }
}

function scrubCredential(message: AssistantMessage, accessToken: string): AssistantMessage {
  return JSON.parse(JSON.stringify(message).split(accessToken).join('[redacted]')) as AssistantMessage
}

/**
 * Generate a text-only, tool-free Resident outcome without starting a native product session.
 * Requests without generation limits use the provider defaults for legacy tool-free callers.
 * @param request - sealed disabled-tool request with optional caller limits and daemon-owned transcript root.
 * @returns canonical text and reported usage; no fabricated native session identity.
 */
export async function generateCodexJudgment(request: ResidentDriverExecuteRequest): Promise<ResidentTurnResult> {
  if (request.nativeToolPolicy !== 'disabled' || request.modelToolBridge !== undefined) {
    throw new ResidentOperatorError('Model-only Codex execution requires disabled native tools and no bridge', 'INVALID_RESULT')
  }
  const text: string[] = []
  for (const block of request.prompt) {
    if (block.type !== 'text') throw new ResidentOperatorError('Model-only Codex accepts text prompt blocks only', 'INVALID_RESULT')
    text.push(block.text)
  }
  request.onProgress('connecting')
  request.onRunning()
  request.onProgress('reasoning')
  const result = await withCodexModelTranscript(request, record => generateCodexModelCall({
    model: request.profile.model, ...request.profile.effort === undefined ? {} : { effort: request.profile.effort },
    ...request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt },
    messages: [{ role: 'user', content: text.join('\n'), timestamp: Date.now() }],
    ...request.generationLimits === undefined ? {} : { generationLimits: request.generationLimits },
    ...record === undefined ? {} : { record }, signal: request.signal,
  }))
  if (result.stopReason !== 'stop') throw new ResidentOperatorError(`Codex model stopped with ${result.stopReason}`, 'INVALID_RESULT')
  request.onProgress('finalizing')
  return {
    output: result.content.flatMap<ContentBlock>(block => block.type === 'text'
      ? [{ type: 'text' as const, text: block.text }]
      : block.type === 'thinking' ? [{ type: 'reasoning' as const, text: block.thinking }] : []),
    providerResponse: { provider: 'openai-codex', model: result.responseModel ?? result.model,
      ...result.responseId === undefined ? {} : { responseId: result.responseId } },
    stopReason: 'completed', usage: { inputTokens: result.usage.input, outputTokens: result.usage.output,
      cacheReadInputTokens: result.usage.cacheRead, cacheWriteInputTokens: result.usage.cacheWrite },
  }
}

/**
 * Share one daemon-private, fsynced model/tool transcript across an execution.
 * @param request - command identity and optional daemon-owned transcript directory.
 * @param run - operation receiving a credential-free transcript writer, or undefined for older direct callers.
 * @returns the operation result after closing the owned transcript.
 */
export async function withCodexModelTranscript<T>(
  request: Pick<ResidentDriverExecuteRequest, 'commandId' | 'governedToolRoot'>,
  run: (record: CodexModelCallInput['record']) => Promise<T>,
): Promise<T> {
  if (request.governedToolRoot === undefined) return run(undefined)
  const directory = join(request.governedToolRoot, createHash('sha256').update(String(request.commandId)).digest('hex'))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = await open(join(directory, 'model-transcript.jsonl'), 'a', 0o600)
  try {
    return await run(async (entry) => {
      await file.writeFile(`${JSON.stringify({ observedAt: new Date().toISOString(), commandId: String(request.commandId), ...entry })}\n`)
      await file.sync()
    })
  } finally { await file.close() }
}
