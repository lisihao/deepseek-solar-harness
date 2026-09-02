/** Native subscription resident drivers for Claude Code and Codex. @module @deepseek-ai/dsh-resident-operator-local/drivers */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  createSdkMcpServer,
  query as claudeQuery,
  tool as claudeTool,
  type CanUseTool,
  type ModelInfo,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  PhysicalOperatorNativeToolPolicy,
  PhysicalOperatorReasoningEffort,
} from '@deepseek-ai/dsh-physical-operator'
import type {
  ResidentDriverExecuteRequest,
  ResidentDriverCompactRequest,
  ResidentModelOption,
  ResidentObservation,
  ResidentProductDriver,
  ResidentProviderStatus,
  ResidentQuotaPool,
  ResidentQuotaWindow,
  ResidentStopReason,
  ResidentTurnResult,
} from '@deepseek-ai/dsh-resident-operator'
import { ResidentOperatorError } from '@deepseek-ai/dsh-resident-operator'
import {
  CodexApprovalRequiredError,
  CodexAppServerWire,
  type CodexDynamicToolCall,
  type CodexDynamicToolResult,
  type CodexDynamicToolSpec,
  type CodexAppServerExecutionBoundary,
  type CodexAppServerModel,
  type CodexAppServerRateLimit,
} from '@deepseek-ai/dsh-subagent-codex'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { openCodexDaemonStream } from './codex-transport.ts'
import { callModelToolBridge, claudeMcpRequestId, modelToolCommandId } from './model-tool-bridge.ts'

const execFileAsync = promisify(execFile)
const CLAUDE_AUTH_LOGIN_TIMEOUT_MS = 10 * 60_000

/** Stable Claude subscription-login failure codes carried over Resident IPC. */
export type ClaudeAuthenticationFailureCode =
  | 'AUTH_REQUIRED'
  | 'NETWORK_UNAVAILABLE'
  | 'CALLBACK_LISTENER_MISSING'

/** Qualified Claude Code CLI version for this Resident build. */
export const EXPECTED_CLAUDE_CLI_VERSION = '2.1.239 (Claude Code)'
/** Official Claude Agent SDK version compiled into this Resident build. */
export const EXPECTED_CLAUDE_SDK_VERSION = '0.3.220'
/** Qualified Codex CLI version for this Resident build. */
export const EXPECTED_CODEX_CLI_VERSION = 'codex-cli 0.151.0'
/** SHA-256 of the qualified Codex app-server v2 JSON Schema. */
export const EXPECTED_CODEX_SCHEMA_SHA256 = '2442b15801bc019ad55987ad03e0f0ae60c51417825b9b6d708db640e6c2651c'

const EFFORTS = new Set<PhysicalOperatorReasoningEffort>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

/**
 * Build the credential-scrubbed Claude subprocess environment.
 *
 * Claude Code's standalone macOS runtime otherwise uses only its bundled CA
 * set. Native subscription traffic must honor certificates trusted by the
 * owner's macOS system store, while preserving an explicit caller override.
 *
 * @param parent Credential-scrubbed parent environment to extend.
 * @param platform Platform whose native trust behavior should be selected.
 * @returns A new subprocess environment without mutating the supplied parent.
 */
export function claudeEnvironment(
  parent: NodeJS.ProcessEnv = scrubbedParentEnv(),
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment = { ...parent }
  if (platform === 'darwin' && environment.NODE_USE_SYSTEM_CA === undefined) {
    environment.NODE_USE_SYSTEM_CA = '1'
  }
  return environment
}

/**
 * Build Claude Code's native slash command without persisting its optional guidance.
 * @param instructions - optional native compaction guidance.
 * @returns the bounded Claude Code slash command.
 */
export function claudeCompactPrompt(instructions?: string): string {
  return instructions === undefined ? '/compact' : `/compact ${instructions}`
}

/**
 * Decide whether Claude Code proved a first-party claude.ai login.
 *
 * Claude Code 2.1.239 may report `subscriptionType: null` for a valid
 * claude.ai session, so that advisory field is not part of the authentication
 * boundary. API-key-shaped environment values are already removed before the
 * command runs by {@link scrubbedParentEnv}.
 *
 * @param status Parsed output from `claude auth status --json`.
 * @returns Whether the native product attested a first-party claude.ai login.
 */
export function isClaudeNativeSubscription(status: Readonly<Record<string, unknown>>): boolean {
  return status.loggedIn === true
    && status.authMethod === 'claude.ai'
    && status.apiProvider === 'firstParty'
}

/**
 * Classify one failed explicit Claude subscription-login attempt.
 *
 * The native CLI owns OAuth and its loopback callback listener. DSH only
 * reports the observed terminal failure and never starts a replacement login
 * attempt on behalf of polling or qualification.
 *
 * @param error Failure emitted by `claude auth login`.
 * @returns Stable failure code for the owner-local UI.
 */
export function claudeAuthenticationFailureCode(error: unknown): ClaudeAuthenticationFailureCode {
  const detail = error instanceof Error ? error.message : String(error)
  if (
    /(?:callback|redirect(?:_uri| uri)?|loopback)/iu.test(detail)
    || /(?:localhost|127\.0\.0\.1)(?::\d+)?[^\n]*(?:ECONNREFUSED|connection refused|refused to connect)/iu.test(detail)
    || /(?:ECONNREFUSED|connection refused|refused to connect)[^\n]*(?:localhost|127\.0\.0\.1)(?::\d+)?/iu.test(detail)
  ) return 'CALLBACK_LISTENER_MISSING'
  if (
    /\b(?:EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|EPIPE)\b/iu.test(detail)
    || /(?:network (?:is )?unavailable|unable to connect|connection timed out|certificate verification|fetch failed)/iu.test(detail)
  ) return 'NETWORK_UNAVAILABLE'
  return 'AUTH_REQUIRED'
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const exact = environment[name]
  if (exact !== undefined || process.platform !== 'win32') return exact
  const entry = Object.entries(environment).find(([key]) => key.toUpperCase() === name)
  return entry?.[1]
}

/**
 * Resolve the exact native product executable that qualification and SDK execution must share.
 *
 * @param command Absolute executable or bare product command.
 * @param environment Child environment whose PATH owns command selection.
 * @param platform Platform used for PATH extension rules.
 * @returns An absolute executable path.
 */
export function resolveProductExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = scrubbedParentEnv(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (command.length === 0) throw new Error('resident product executable must be non-empty')
  const absolute = isAbsolute(command)
  if (!absolute && (command.includes('/') || (platform === 'win32' && command.includes('\\')))) {
    throw new Error(`resident product executable ${JSON.stringify(command)} must be absolute or a bare PATH name`)
  }
  const extensions = platform === 'win32' && extname(command) === ''
    ? (environmentValue(environment, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  const candidates = absolute
    ? [command]
    : (environmentValue(environment, 'PATH') ?? '').split(platform === 'win32' ? ';' : ':').flatMap(directory =>
      extensions.map(extension => resolve(process.cwd(), directory, command + extension)))
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Try the next PATH candidate; the final miss receives one stable error.
    }
  }
  throw new Error(`resident product executable ${JSON.stringify(command)} was not found`)
}

function reasoningEffort(value: string | undefined): PhysicalOperatorReasoningEffort | undefined {
  return value !== undefined && EFFORTS.has(value as PhysicalOperatorReasoningEffort)
    ? value as PhysicalOperatorReasoningEffort
    : undefined
}

function observationRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Normalize only Claude Agent SDK public text and tool lifecycle messages.
 * Thinking blocks, user prompt text, tool inputs, tool outputs, stderr, and
 * all unrecognized SDK envelopes intentionally produce no observation.
 *
 * @param message - one SDK stream message.
 * @param toolNames - turn-local tool-use identity to display-name mapping.
 * @returns safe, provider-neutral trace observations.
 */
export function residentClaudeObservations(
  message: unknown,
  toolNames: Map<string, string>,
): readonly ResidentObservation[] {
  const record = observationRecord(message)
  if (record?.type === 'assistant') {
    const assistant = observationRecord(record.message)
    const content = assistant?.content
    if (!Array.isArray(content)) return []
    const observations: ResidentObservation[] = []
    for (const block of content) {
      const value = observationRecord(block)
      if (value?.type === 'text' && typeof value.text === 'string') {
        observations.push({ kind: 'public-output', preview: value.text })
      }
      if (value?.type === 'tool_use' && typeof value.id === 'string' && typeof value.name === 'string') {
        toolNames.set(value.id, value.name)
        observations.push({ kind: 'tool-started', toolName: value.name })
      }
    }
    return observations
  }
  if (record?.type === 'user' && typeof record.parent_tool_use_id === 'string') {
    const user = observationRecord(record.message)
    const content = user?.content
    if (!Array.isArray(content) || !content.some(block => observationRecord(block)?.type === 'tool_result')) return []
    const toolName = toolNames.get(record.parent_tool_use_id)
    return toolName === undefined ? [] : [{ kind: 'tool-completed', toolName }]
  }
  if (record?.type === 'system' && record.subtype === 'permission_denied' && typeof record.tool_name === 'string') {
    return [{ kind: 'approval-required', approvalKind: record.tool_name }]
  }
  return []
}

function ensureModelToolBridge(request: ResidentDriverExecuteRequest): NonNullable<ResidentDriverExecuteRequest['modelToolBridge']> | undefined {
  const bridge = request.modelToolBridge
  if (bridge === undefined) return undefined
  if (bridge.tools.length === 0 || new Set(bridge.tools.map(tool => tool.name)).size !== bridge.tools.length) {
    throw new ResidentOperatorError('Resident model tool bridge must contain unique tools', 'PROTOCOL_MISMATCH')
  }
  return bridge
}

function isRlmOnlyBridge(bridge: NonNullable<ResidentDriverExecuteRequest['modelToolBridge']>): boolean {
  return bridge.tools.length === 1 && bridge.tools[0]?.name === 'typescript_repl'
}

function codexDynamicTools(request: ResidentDriverExecuteRequest): readonly CodexDynamicToolSpec[] {
  const bridge = ensureModelToolBridge(request)
  if (bridge === undefined) return []
  return bridge.tools.map(spec => ({
    type: 'function', name: spec.name, description: spec.description, inputSchema: spec.inputSchema, deferLoading: false,
  }))
}

/**
 * Build the in-process Claude Agent SDK MCP adapter for one sealed RLM turn.
 * @param executionId - outer Physical Operator execution identity.
 * @param bridge - sealed owner-local model tool bridge.
 * @param signal - turn cancellation signal.
 * @returns the configured Claude Agent SDK MCP server.
 */
export function createClaudeRlmMcpServer(
  executionId: string,
  bridge: NonNullable<ResidentDriverExecuteRequest['modelToolBridge']>,
  signal: AbortSignal,
): ReturnType<typeof createSdkMcpServer> {
  const name = claudeBridgeName(bridge)
  return createSdkMcpServer({
    name,
    version: '1.0.0',
    instructions: isRlmOnlyBridge(bridge)
      ? 'Use typescript_repl as the persistent programming surface. Calls to rlm(...) return admission handles, never child answers; read explicit messages or artifacts for results.'
      : 'These are the current DSH Agent tools. Their calls execute through DSH scope, guard, approval, logging, and plugin ownership; use them as the task requires.',
    alwaysLoad: true,
    tools: bridge.tools.map(toolSpec => claudeTool(
      toolSpec.name,
      toolSpec.description,
      zodShape(toolSpec.inputSchema),
      async (args, extra) => {
        const commandId = modelToolCommandId(executionId, 'claude', claudeMcpRequestId(extra))
        const result = bridgeToolResult(await callModelToolBridge(
          bridge,
          toolSpec.name,
          args,
          commandId,
          signal,
        ))
        return {
          content: [{ type: 'text', text: bridgeToolText(result) }],
          ...result.isError ? { isError: true } : {},
        }
      },
      { alwaysLoad: true },
    )),
  })
}

/**
 * Build the Codex app-server callback for one sealed RLM turn.
 * @param executionId - outer Physical Operator execution identity.
 * @param bridge - sealed owner-local model tool bridge.
 * @param signal - turn cancellation signal.
 * @returns a callback that settles Codex dynamic tool calls through the bridge.
 */
export function createCodexRlmToolHandler(
  executionId: string,
  bridge: NonNullable<ResidentDriverExecuteRequest['modelToolBridge']>,
  signal: AbortSignal,
): (call: CodexDynamicToolCall) => Promise<CodexDynamicToolResult> {
  return async (call) => {
    const commandId = modelToolCommandId(executionId, 'codex', call.callId)
    const result = bridgeToolResult(await callModelToolBridge(bridge, call.tool, call.arguments, commandId, signal))
    return { success: !result.isError, text: bridgeToolText(result) }
  }
}

interface BridgeToolResult {
  readonly isError: boolean
  readonly content: readonly ContentBlock[]
  readonly value?: unknown
  readonly error?: unknown
  readonly additionalContexts?: unknown
  readonly concludesTurn?: boolean
}

function bridgeToolResult(value: unknown): BridgeToolResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResidentOperatorError('DSH model tool bridge returned a non-object result', 'INVALID_RESULT')
  }
  const result = value as Record<string, unknown>
  if (typeof result.isError === 'boolean' && Array.isArray(result.content)) {
    return result as unknown as BridgeToolResult
  }
  // Protocol v1 RLM bridges returned the evaluator value directly. Preserve
  // that stable Prime surface while the generic DSH bridge returns the richer
  // tool-runtime envelope above.
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(value) }],
  }
}

function bridgeToolText(result: BridgeToolResult): string {
  const text = result.content.map(block => block.type === 'text' || block.type === 'reasoning'
    ? block.text
    : JSON.stringify(block)).join('\n')
  const details = {
    ...result.value === undefined ? {} : { value: result.value },
    ...result.error === undefined ? {} : { error: result.error },
    ...result.additionalContexts === undefined ? {} : { additionalContexts: result.additionalContexts },
    ...result.concludesTurn === true ? { concludesTurn: true } : {},
  }
  const encoded = Object.keys(details).length === 0 ? '' : JSON.stringify(details)
  return [text, encoded].filter(value => value.length > 0).join('\n') || (result.isError ? 'DSH tool failed' : 'DSH tool completed')
}

function zodShape(schema: Readonly<Record<string, unknown>>): z.ZodRawShape {
  const parsed = z.fromJSONSchema(schema)
  if (!(parsed instanceof z.ZodObject)) {
    throw new ResidentOperatorError('Claude model tool input schema must describe an object', 'PROTOCOL_MISMATCH')
  }
  return parsed.shape
}

function claudeBridgeName(bridge: NonNullable<ResidentDriverExecuteRequest['modelToolBridge']>): 'dsh_rlm' | 'dsh_tools' {
  return isRlmOnlyBridge(bridge) ? 'dsh_rlm' : 'dsh_tools'
}

function claudeQualifiedToolNames(bridge: NonNullable<ResidentDriverExecuteRequest['modelToolBridge']>): string[] {
  const prefix = `mcp__${claudeBridgeName(bridge)}__`
  return bridge.tools.map(tool => `${prefix}${tool.name}`)
}

/**
 * Map bare DSH tool names used by shared Skills onto the qualified Claude MCP surface.
 *
 * @param bridge DSH model-tool bridge whose tools are exposed through Claude MCP.
 * @returns Bare tool names mapped to their qualified Claude MCP names.
 */
export function claudeToolAliases(
  bridge: NonNullable<ResidentDriverExecuteRequest['modelToolBridge']>,
): Record<string, string> {
  const qualified = claudeQualifiedToolNames(bridge)
  return Object.fromEntries(bridge.tools.map((tool, index) => [tool.name, qualified[index] as string]))
}

function claudeModelOption(model: ModelInfo, index: number): ResidentModelOption {
  const efforts: PhysicalOperatorReasoningEffort[] = [...(model.supportedEffortLevels ?? [])]
  return {
    model: model.value,
    ...model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel },
    displayName: model.displayName,
    description: model.description,
    supportedEfforts: efforts,
    ...efforts.includes('high') ? { defaultEffort: 'high' as const } : {},
    isDefault: model.value === 'default' || index === 0,
    supportsAdaptiveThinking: model.supportsAdaptiveThinking === true,
  }
}

function codexModelOption(model: CodexAppServerModel): ResidentModelOption {
  const efforts = model.supportedReasoningEfforts
    .map(option => reasoningEffort(option.reasoningEffort))
    .filter((value): value is PhysicalOperatorReasoningEffort => value !== undefined)
  const defaultEffort = reasoningEffort(model.defaultReasoningEffort)
  return {
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    supportedEfforts: efforts,
    ...defaultEffort === undefined ? {} : { defaultEffort },
    isDefault: model.isDefault,
    supportsAdaptiveThinking: false,
  }
}

async function claudeModels(claudeExecutable: string): Promise<ResidentModelOption[]> {
  async function* idleInput(): AsyncGenerator<never> {
    await new Promise<never>(() => {})
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort(new Error('Claude model catalog timed out')) }, 15_000)
  const query = claudeQuery({
    prompt: idleInput(),
    options: {
      abortController: controller,
      cwd: process.cwd(),
      env: claudeEnvironment(),
      pathToClaudeCodeExecutable: claudeExecutable,
      persistSession: false,
      // Qualification is a DSH-owned read-only probe. Loading the owner's
      // Claude settings here would start every user MCP server on each status
      // poll and can orphan those subprocesses when the short-lived probe
      // closes. Product turns may still opt into their explicit tool surface.
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      tools: [],
      allowedTools: [],
      disallowedTools: ['AskUserQuestion'],
    },
  })
  try {
    return (await query.supportedModels()).map(claudeModelOption)
  } finally {
    clearTimeout(timeout)
    query.close()
  }
}

function codexQuotaPool(
  limit: CodexAppServerRateLimit,
  models: readonly ResidentModelOption[],
  observedAt: string,
): ResidentQuotaPool {
  const label = limit.limitName ?? limit.limitId
  const spark = /spark|bengalfox/iu.test(`${limit.limitId} ${label}`)
  const mappedModels = models
    .filter(model => /spark/iu.test(`${model.model} ${model.displayName}`) === spark)
    .map(model => model.model)
  const window = (value: NonNullable<CodexAppServerRateLimit['primary']>): ResidentQuotaWindow => ({
    usedPercent: value.usedPercent,
    ...value.resetsAt === undefined ? {} : { resetsAt: value.resetsAt },
    ...value.windowDurationMins === undefined ? {} : { windowDurationMinutes: value.windowDurationMins },
  })
  return {
    poolId: limit.limitId,
    displayName: label,
    models: mappedModels,
    meter: 'native-subscription',
    ...limit.primary === undefined ? {} : { primary: window(limit.primary) },
    ...limit.secondary === undefined ? {} : { secondary: window(limit.secondary) },
    observedAt,
  }
}

/**
 * Read the required Codex model catalog and optional subscription quota snapshot.
 *
 * @param listModels Reads the native product model catalog and rejects when it is unavailable.
 * @param readRateLimits Reads advisory quota telemetry; failures leave quota pools unknown.
 * @param observedAt Timestamp attached to successfully observed quota pools.
 * @returns Qualified models plus either mapped quota pools or a non-fatal telemetry reason.
 */
export async function collectCodexModelsAndQuota(
  listModels: () => Promise<readonly CodexAppServerModel[]>,
  readRateLimits: () => Promise<readonly CodexAppServerRateLimit[]>,
  observedAt = new Date().toISOString(),
): Promise<{
  readonly models: ResidentModelOption[]
  readonly quotaPools: ResidentQuotaPool[]
  readonly quotaUnavailableReason?: string
}> {
  const models = (await listModels()).map(codexModelOption)
  try {
    const limits = await readRateLimits()
    return { models, quotaPools: limits.map(limit => codexQuotaPool(limit, models, observedAt)) }
  } catch (error) {
    return {
      models,
      quotaPools: [],
      quotaUnavailableReason: `Codex subscription quota telemetry unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function codexModelsAndQuota(): Promise<{
  readonly models: ResidentModelOption[]
  readonly quotaPools: ResidentQuotaPool[]
  readonly quotaUnavailableReason?: string
}> {
  const socketPath = join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock')
  if (!existsSync(socketPath)) throw new Error('Codex app-server control socket is unavailable')
  const signal = AbortSignal.timeout(15_000)
  const stream = await openCodexDaemonStream(socketPath, signal)
  const wire = new CodexAppServerWire(stream, stream, 'require')
  try {
    wire.start()
    await wire.initialize(signal)
    return await collectCodexModelsAndQuota(
      () => wire.listModels(signal),
      () => wire.readRateLimits(signal),
    )
  } finally {
    wire.close()
    stream.destroy()
  }
}

function textPrompt(prompt: readonly ContentBlock[], product: string): string[] {
  if (prompt.length === 0) throw new ResidentOperatorError(`${product} prompt must not be empty`, 'INVALID_RESULT')
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new ResidentOperatorError(`${product} resident execution accepts text blocks only`, 'INVALID_RESULT')
    }
    texts.push(block.text)
  }
  if (texts.every(value => value.trim().length === 0)) {
    throw new ResidentOperatorError(`${product} prompt must not be blank`, 'INVALID_RESULT')
  }
  return texts
}

/**
 * Append the sealed no-tool contract to the product-owned instruction channel.
 * @param systemPrompt - optional caller-owned instructions.
 * @param policy - sealed native product-tool authority.
 * @returns effective product system prompt, or undefined when no prompt is needed.
 */
export function nativeToolSystemPrompt(
  systemPrompt: string | undefined,
  policy?: PhysicalOperatorNativeToolPolicy,
): string | undefined {
  if (policy === 'inherit' || policy === undefined) return systemPrompt
  const authority = policy === 'disabled'
    ? [
      'This execution plan grants no native tool authority.',
      'Do not invoke shell, filesystem, network, browser, search, MCP, or other product tools.',
      'Reason only from the supplied prompt and return the requested text answer directly.',
    ].join(' ')
    : [
      'This execution plan grants tool authority only through the DSH model-tool bridge.',
      'Do not invoke product-native shell, filesystem, network, browser, search, other tools, or any MCP server except the DSH model-tool bridge.',
      'Use the DSH tools exposed for this turn; any product-native approval request will be declined.',
    ].join(' ')
  return systemPrompt === undefined ? authority : `${systemPrompt}\n\n${authority}`
}

/**
 * Build Agent SDK options that remove Claude Code's built-in tool surface for a sealed no-tool turn.
 * @param policy - sealed native product-tool authority.
 * @returns SDK tool selection options for the requested policy.
 */
export function claudeNativeToolOptions(policy?: PhysicalOperatorNativeToolPolicy): {
  readonly tools?: []
  readonly allowedTools?: string[]
} {
  return policy === 'disabled' || policy === 'dsh-tools-authoritative'
    ? { tools: [], allowedTools: [] }
    : {}
}

/**
 * Resolve how native Codex approval requests behave for the sealed tool authority.
 *
 * @param policy Sealed native product-tool authority for the turn.
 * @returns Whether native approval requests are declined or surfaced for settlement.
 */
export function codexApprovalBehavior(
  policy?: PhysicalOperatorNativeToolPolicy,
): 'decline' | 'require' {
  return policy === 'dsh-tools-authoritative' ? 'decline' : 'require'
}

/**
 * Seal a read-only, no-approval native Codex environment while DSH tools remain dynamic functions.
 *
 * @param policy Sealed native product-tool authority for the turn.
 * @returns Codex execution boundary for DSH-authoritative turns, otherwise undefined.
 */
export function codexExecutionBoundary(
  policy?: PhysicalOperatorNativeToolPolicy,
): CodexAppServerExecutionBoundary | undefined {
  return policy === 'dsh-tools-authoritative'
    ? { approval: 'never', nativeEffects: 'read-only', environmentAccess: 'disabled' }
    : undefined
}

async function command(command: string, args: string[]): Promise<{ stdout: string; stderr: string; executable: string }> {
  try {
    const executable = resolveProductExecutable(command)
    const result = await execFileAsync(executable, args, {
      encoding: 'utf8',
      env: scrubbedParentEnv(),
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return { ...result, executable }
  } catch (error) {
    throw new ResidentOperatorError(
      `${command} qualification failed: ${error instanceof Error ? error.message : String(error)}`,
      'AUTH_MODE_MISMATCH',
    )
  }
}

function claudeStopReason(result: SDKResultMessage): ResidentStopReason {
  if (result.subtype === 'success' && !result.is_error) return 'completed'
  if (result.subtype === 'error_max_turns' || result.subtype === 'error_max_budget_usd') return 'max-tokens'
  return 'error'
}

/**
 * Convert a terminal Claude API result into the stable Resident error taxonomy.
 *
 * @param result Terminal result emitted by the Claude Agent SDK.
 * @returns A classified Resident error, or undefined for a successful result.
 */
export function claudeResultFailure(result: SDKResultMessage): ResidentOperatorError | undefined {
  if (!result.is_error) return undefined
  const detail = 'result' in result && typeof result.result === 'string' && result.result.trim().length > 0
    ? result.result.trim()
    : 'Claude Code returned an unspecified error result'
  if (/(?:oauth access token has expired|re-authenticate to continue|\b401\b)/iu.test(detail)) {
    return new ResidentOperatorError(
      'Claude Code subscription authentication expired; run `claude auth login` and retry the node.',
      'AUTH_MODE_MISMATCH',
    )
  }
  if (/(?:usage limit|quota (?:is )?exhausted|rate limit)/iu.test(detail)) {
    return new ResidentOperatorError(`Claude Code subscription quota is exhausted: ${detail}`, 'QUOTA_EXHAUSTED')
  }
  if (/(?:certificate verification|unable to connect to api)/iu.test(detail)) {
    return new ResidentOperatorError(`Claude Code runtime is unavailable: ${detail}`, 'RUNTIME_UNAVAILABLE')
  }
  return new ResidentOperatorError(`Claude Code returned an error result: ${detail}`, 'INVALID_RESULT')
}

/**
 * Convert Codex transport and terminal failures into the stable Resident taxonomy.
 * @param error - product protocol or terminal failure.
 * @returns a retryable runtime failure for transient transport loss, otherwise an invalid result.
 */
export function codexExecutionFailure(error: unknown): ResidentOperatorError {
  if (error instanceof ResidentOperatorError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/(?:usageLimitExceeded|hit your usage limit|quota (?:is )?exhausted)/iu.test(message)) {
    return new ResidentOperatorError(message, 'QUOTA_EXHAUSTED')
  }
  const unavailable = /stream disconnected before completion/iu.test(message)
    || /error sending request for url/iu.test(message)
    || /app-server protocol stream closed/iu.test(message)
    || /\b(?:ECONNRESET|ETIMEDOUT|EPIPE)\b/iu.test(message)
  return new ResidentOperatorError(message, unavailable ? 'RUNTIME_UNAVAILABLE' : 'INVALID_RESULT')
}

/** Claude Code Agent SDK Driver using persisted native subscription Sessions. */
export class ClaudeCodeResidentDriver implements ResidentProductDriver {
  readonly operatorId = 'claude-code' as const
  private modelCatalog: { readonly executable: string; readonly promise: Promise<ResidentModelOption[]> } | undefined

  private models(executable: string): Promise<ResidentModelOption[]> {
    if (this.modelCatalog?.executable === executable) return this.modelCatalog.promise
    const catalog = { executable, promise: claudeModels(executable) }
    this.modelCatalog = catalog
    void catalog.promise.catch(() => {
      if (this.modelCatalog === catalog) this.modelCatalog = undefined
    })
    return catalog.promise
  }

  async authenticate(): Promise<ResidentProviderStatus> {
    const executable = resolveProductExecutable('claude')
    try {
      await execFileAsync(executable, ['auth', 'login'], {
        encoding: 'utf8',
        env: claudeEnvironment(),
        timeout: CLAUDE_AUTH_LOGIN_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      })
    } catch (error) {
      const code = claudeAuthenticationFailureCode(error)
      throw new ResidentOperatorError(
        `Claude Code subscription login failed: ${error instanceof Error ? error.message : String(error)}`,
        code,
        { cause: error },
      )
    }
    return this.qualify()
  }

  async qualify(): Promise<ResidentProviderStatus> {
    try {
      const { stdout: version, executable } = await command('claude', ['--version'])
      const { stdout: auth } = await command(executable, ['auth', 'status', '--json'])
      const parsed = JSON.parse(auth) as Record<string, unknown>
      const subscription = isClaudeNativeSubscription(parsed)
      const exactVersion = version.trim() === EXPECTED_CLAUDE_CLI_VERSION
      const models = subscription && exactVersion ? await this.models(executable) : []
      const catalogReady = models.length > 0
      return {
        operatorId: this.operatorId,
        product: this.operatorId,
        displayName: 'Claude Code',
        description: 'Persistent native Claude Code analysis, architecture, review, and implementation.',
        tags: ['analysis', 'architecture', 'review', 'long-context', 'coding', 'subscription'],
        maxConcurrency: 4,
        injectionBoundaries: ['pre-dispatch', 'next-turn'],
        available: subscription && exactVersion && catalogReady,
        ...subscription && exactVersion && catalogReady ? {} : {
          unavailableReason: !subscription
            ? 'Claude Code is not authenticated with a claude.ai subscription'
            : !exactVersion
              ? `Claude Code version ${version.trim()} does not match ${EXPECTED_CLAUDE_CLI_VERSION}`
              : 'Claude Code reported no selectable models',
        },
        authentication: subscription ? 'native-subscription' : 'unqualified',
        productVersion: version.trim(),
        protocolHash: createHash('sha256').update(`claude-agent-sdk@${EXPECTED_CLAUDE_SDK_VERSION}`).digest('hex'),
        models,
        quotaUnavailableReason: 'Claude Code does not expose machine-readable subscription quota telemetry; automatic scheduling remains behind the protected reserve guard',
      }
    } catch (error) {
      return unavailable(this.operatorId, error)
    }
  }

  async execute(request: ResidentDriverExecuteRequest): Promise<ResidentTurnResult & { nativeSessionId: string }> {
    const qualification = await this.qualify()
    if (!qualification.available) {
      throw new ResidentOperatorError(
        qualification.unavailableReason ?? 'Claude Code unavailable',
        qualification.authentication === 'native-subscription'
          ? 'PROVIDER_VERSION_MISMATCH'
          : 'AUTH_MODE_MISMATCH',
      )
    }
    const texts = textPrompt(request.prompt, 'Claude Code')
    const claudeExecutable = resolveProductExecutable('claude')
    request.onProgress('connecting')
    const controller = new AbortController()
    const abort = (): void => { controller.abort(request.signal.reason) }
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })
    let nativeSessionId = request.nativeSessionId
    let final: SDKResultMessage | undefined
    let approvalRequired: string | undefined
    const running = new Set<string>()
    const observedToolNames = new Map<string, string>()
    const modelToolBridge = ensureModelToolBridge(request)
    const effectiveSystemPrompt = nativeToolSystemPrompt(request.systemPrompt, request.nativeToolPolicy)
    const modelToolNames = new Set(modelToolBridge === undefined ? [] : claudeQualifiedToolNames(modelToolBridge))
    const canUseTool: CanUseTool = (toolName, _input, options) => {
      if (modelToolNames.has(toolName)) return Promise.resolve({ behavior: 'allow' })
      approvalRequired = options.title ?? options.displayName ?? toolName
      request.onObservation({ kind: 'approval-required', approvalKind: toolName, preview: approvalRequired })
      return Promise.resolve({
        behavior: 'deny',
        message: `Resident execution requires out-of-band approval for ${toolName}`,
        interrupt: true,
      })
    }
    const rlmServer = modelToolBridge === undefined
      ? undefined
      : createClaudeRlmMcpServer(String(request.commandId), modelToolBridge, controller.signal)
    const query = claudeQuery({
      prompt: texts.join(''),
      options: {
        abortController: controller,
        cwd: request.workspace,
        env: claudeEnvironment(),
        pathToClaudeCodeExecutable: claudeExecutable,
        persistSession: true,
        model: request.profile.model,
        ...request.profile.effort === undefined ? {} : {
          effort: request.profile.effort as Exclude<PhysicalOperatorReasoningEffort, 'ultra'>,
        },
        ...qualification.models.find(model => model.model === request.profile.model)?.supportsAdaptiveThinking === true
          ? { thinking: { type: 'adaptive' as const } }
          : {},
        ...nativeSessionId === undefined ? {} : { resume: nativeSessionId },
        ...effectiveSystemPrompt === undefined ? {} : {
          systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: effectiveSystemPrompt },
        },
        disallowedTools: ['AskUserQuestion'],
        ...claudeNativeToolOptions(request.nativeToolPolicy),
        ...modelToolBridge === undefined || rlmServer === undefined ? {} : {
          ...isRlmOnlyBridge(modelToolBridge) ? { tools: [] as const } : {},
          allowedTools: [...modelToolNames],
          mcpServers: { [claudeBridgeName(modelToolBridge)]: rlmServer },
          strictMcpConfig: true,
          toolAliases: claudeToolAliases(modelToolBridge),
        },
        canUseTool,
      },
    })
    try {
      for await (const message of query) {
        for (const observation of residentClaudeObservations(message, observedToolNames)) {
          request.onObservation(observation)
        }
        const session = message.session_id
        if (typeof session === 'string' && session.length > 0) {
          nativeSessionId = session
          if (!running.has(session)) {
            running.add(session)
            request.onRunning(session)
            request.onProgress('session_ready')
          }
        }
        if (message.type === 'assistant') request.onProgress('reasoning')
        if (message.type === 'user') request.onProgress('tool_activity')
        if (message.type === 'result') {
          request.onProgress('finalizing')
          final = message
        }
      }
    } catch (error) {
      if (approvalRequired !== undefined) {
        throw new ResidentOperatorError(
          `Claude Code requires interactive approval: ${approvalRequired}`,
          'APPROVAL_REQUIRED',
        )
      }
      throw error
    } finally {
      request.signal.removeEventListener('abort', abort)
      query.close()
    }
    if (nativeSessionId === undefined) {
      throw new ResidentOperatorError('Claude Code returned no persistent session id', 'INVALID_RESULT')
    }
    if (final === undefined) {
      throw new ResidentOperatorError('Claude Code ended without a result', 'INVALID_RESULT')
    }
    if (approvalRequired !== undefined) {
      throw new ResidentOperatorError(
        `Claude Code requires interactive approval: ${approvalRequired}`,
        'APPROVAL_REQUIRED',
      )
    }
    const resultFailure = claudeResultFailure(final)
    if (resultFailure !== undefined) throw resultFailure
    const stopReason = claudeStopReason(final)
    const output = final.subtype === 'success' && final.result.trim().length > 0
      ? [{ type: 'text' as const, text: final.result }]
      : []
    const usage = {
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      cacheReadInputTokens: final.usage.cache_read_input_tokens,
      cacheWriteInputTokens: final.usage.cache_creation_input_tokens,
      costUsd: final.total_cost_usd,
    }
    request.onObservation({ kind: 'usage-updated', usage })
    return {
      output,
      stopReason,
      nativeSessionId,
      usage,
    }
  }

  async compact(request: ResidentDriverCompactRequest): Promise<{ nativeSessionId: string }> {
    const qualification = await this.qualify()
    if (!qualification.available) {
      throw new ResidentOperatorError(
        qualification.unavailableReason ?? 'Claude Code unavailable',
        qualification.authentication === 'native-subscription'
          ? 'PROVIDER_VERSION_MISMATCH'
          : 'AUTH_MODE_MISMATCH',
      )
    }
    const controller = new AbortController()
    const abort = (): void => { controller.abort(request.signal.reason) }
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })
    let observedSessionId = request.nativeSessionId
    let final: SDKResultMessage | undefined
    const query = claudeQuery({
      prompt: claudeCompactPrompt(request.instructions),
      options: {
        abortController: controller,
        cwd: request.workspace,
        env: claudeEnvironment(),
        pathToClaudeCodeExecutable: resolveProductExecutable('claude'),
        persistSession: true,
        resume: request.nativeSessionId,
        tools: [],
        allowedTools: [],
        disallowedTools: ['AskUserQuestion'],
      },
    })
    try {
      for await (const message of query) {
        const session = message.session_id
        if (typeof session === 'string' && session.length > 0) {
          if (session !== request.nativeSessionId) {
            throw new ResidentOperatorError('Claude Code /compact replaced the native Session identity', 'INVALID_RESULT')
          }
          observedSessionId = session
        }
        if (message.type === 'result') final = message
      }
    } finally {
      request.signal.removeEventListener('abort', abort)
      query.close()
    }
    if (final === undefined) {
      throw new ResidentOperatorError('Claude Code /compact ended without a result', 'INVALID_RESULT')
    }
    const failure = claudeResultFailure(final)
    if (failure !== undefined) throw failure
    return { nativeSessionId: observedSessionId }
  }
}

/** Codex app-server Driver using non-ephemeral native subscription threads. */
export class CodexResidentDriver implements ResidentProductDriver {
  readonly operatorId = 'codex' as const

  async qualify(): Promise<ResidentProviderStatus> {
    try {
      const [{ stdout: version }, login, schemaHash] = await Promise.all([
        command('codex', ['--version']),
        command('codex', ['login', 'status']),
        this.schemaHash(),
      ])
      const subscription = `${login.stdout}\n${login.stderr}`.includes('Logged in using ChatGPT')
      const exactVersion = version.trim() === EXPECTED_CODEX_CLI_VERSION
      const exactSchema = schemaHash === EXPECTED_CODEX_SCHEMA_SHA256
      let transportError: unknown
      try {
        await command('codex', ['app-server', 'daemon', 'start'])
      } catch (error) {
        transportError = error
      }
      const transportReady = transportError === undefined
      const catalog = transportReady ? await codexModelsAndQuota().catch((error: unknown) => {
        transportError = error
        return { models: [], quotaPools: [], quotaUnavailableReason: undefined }
      }) : { models: [], quotaPools: [], quotaUnavailableReason: undefined }
      const { models, quotaPools, quotaUnavailableReason } = catalog
      const available = subscription && exactVersion && exactSchema && transportReady && models.length > 0
      return {
        operatorId: this.operatorId,
        product: this.operatorId,
        displayName: 'Codex',
        description: 'Persistent native Codex implementation, debugging, testing, and repository review.',
        tags: ['coding', 'implementation', 'debugging', 'testing', 'review', 'subscription'],
        maxConcurrency: 4,
        injectionBoundaries: ['pre-dispatch', 'next-turn'],
        available,
        ...available ? {} : {
          unavailableReason: !subscription
            ? 'Codex is not authenticated with a ChatGPT subscription'
            : !exactVersion
              ? `Codex version ${version.trim()} does not match ${EXPECTED_CODEX_CLI_VERSION}`
              : !exactSchema
                ? `Codex app-server schema ${schemaHash} does not match ${EXPECTED_CODEX_SCHEMA_SHA256}`
                : transportError !== undefined
                  ? `Codex app-server daemon unavailable: ${transportError instanceof Error ? transportError.message : 'unknown failure'}`
                  : 'Codex app-server reported no selectable models',
        },
        authentication: subscription ? 'native-subscription' : 'unqualified',
        productVersion: version.trim(),
        protocolHash: schemaHash,
        models,
        quotaPools,
        ...quotaUnavailableReason === undefined ? {} : { quotaUnavailableReason },
      }
    } catch (error) {
      return unavailable(this.operatorId, error)
    }
  }

  async execute(request: ResidentDriverExecuteRequest): Promise<ResidentTurnResult & { nativeSessionId: string }> {
    await this.requireAvailable()
    const texts = textPrompt(request.prompt, 'Codex')
    request.onProgress('connecting')
    const stream = await this.openStream(request.signal)
    const modelToolBridge = ensureModelToolBridge(request)
    const dynamicTools = codexDynamicTools(request)
    const executionBoundary = codexExecutionBoundary(request.nativeToolPolicy)
    const wire = new CodexAppServerWire(
      stream,
      stream,
      codexApprovalBehavior(request.nativeToolPolicy),
      dynamicTools,
      modelToolBridge === undefined
        ? undefined
        : createCodexRlmToolHandler(String(request.commandId), modelToolBridge, request.signal),
      (observation) => { request.onObservation(observation) },
    )
    const abort = (): void => { wire.interrupt() }
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })
    try {
      wire.start()
      await wire.initialize(request.signal)
      if (request.nativeSessionId === undefined) {
        await wire.startThread(
          request.workspace,
          request.signal,
          false,
          request.profile,
          nativeToolSystemPrompt(request.systemPrompt, request.nativeToolPolicy),
          executionBoundary,
        )
      } else {
        await wire.resumeThread(
          request.nativeSessionId,
          request.workspace,
          request.signal,
          request.profile,
          nativeToolSystemPrompt(request.systemPrompt, request.nativeToolPolicy),
          executionBoundary,
        )
      }
      const threadId = wire.currentThreadId
      if (threadId === undefined) {
        throw new ResidentOperatorError('Codex returned no persistent thread id', 'INVALID_RESULT')
      }
      request.onRunning(threadId)
      request.onProgress('session_ready')
      request.onProgress('reasoning')
      const result = await wire.runTurn(texts, request.signal, (turnId) => {
        request.onRunning(threadId, turnId)
      }, request.profile, executionBoundary)
      request.onProgress('finalizing')
      return { ...result, nativeSessionId: threadId }
    } catch (error) {
      if (error instanceof CodexApprovalRequiredError) {
        throw new ResidentOperatorError(error.message, 'APPROVAL_REQUIRED')
      }
      throw codexExecutionFailure(error)
    } finally {
      request.signal.removeEventListener('abort', abort)
      wire.close()
      stream.destroy()
    }
  }

  async compact(request: ResidentDriverCompactRequest): Promise<{ nativeSessionId: string }> {
    if (request.instructions !== undefined) {
      throw new ResidentOperatorError(
        'Codex app-server thread/compact/start does not support compaction instructions',
        'INVALID_RESULT',
      )
    }
    await this.requireAvailable()
    const stream = await this.openStream(request.signal)
    const wire = new CodexAppServerWire(stream, stream, 'require')
    try {
      wire.start()
      await wire.initialize(request.signal)
      await wire.resumeThread(request.nativeSessionId, request.workspace, request.signal)
      await wire.compactThread(request.signal)
      if (wire.currentThreadId !== request.nativeSessionId) {
        throw new ResidentOperatorError('Codex compaction replaced the native thread identity', 'INVALID_RESULT')
      }
      return { nativeSessionId: request.nativeSessionId }
    } catch (error) {
      throw codexExecutionFailure(error)
    } finally {
      wire.close()
      stream.destroy()
    }
  }

  private async requireAvailable(): Promise<void> {
    const qualification = await this.qualify()
    if (qualification.available) return
    const code = qualification.authentication !== 'native-subscription'
      ? 'AUTH_MODE_MISMATCH'
      : qualification.productVersion !== EXPECTED_CODEX_CLI_VERSION
        || qualification.protocolHash !== EXPECTED_CODEX_SCHEMA_SHA256
        ? 'PROVIDER_VERSION_MISMATCH'
        : 'RUNTIME_UNAVAILABLE'
    throw new ResidentOperatorError(qualification.unavailableReason ?? 'Codex unavailable', code)
  }

  private async openStream(signal: AbortSignal) {
    const socketPath = join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock')
    if (!existsSync(socketPath)) {
      throw new ResidentOperatorError('Codex app-server control socket is unavailable', 'RUNTIME_UNAVAILABLE')
    }
    return openCodexDaemonStream(socketPath, signal).catch((error: unknown) => {
      throw new ResidentOperatorError(
        `Codex app-server WebSocket unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'RUNTIME_UNAVAILABLE',
      )
    })
  }

  private async schemaHash(): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-schema-'))
    try {
      await command('codex', ['app-server', 'generate-json-schema', '--out', root])
      const content = readFileSync(join(root, 'codex_app_server_protocol.v2.schemas.json'))
      return createHash('sha256').update(content).digest('hex')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function unavailable(product: 'claude-code' | 'codex', error: unknown): ResidentProviderStatus {
  const claude = product === 'claude-code'
  return {
    operatorId: product,
    product,
    displayName: claude ? 'Claude Code' : 'Codex',
    description: claude
      ? 'Persistent native Claude Code analysis, architecture, review, and implementation.'
      : 'Persistent native Codex implementation, debugging, testing, and repository review.',
    tags: claude
      ? ['analysis', 'architecture', 'review', 'long-context', 'coding', 'subscription']
      : ['coding', 'implementation', 'debugging', 'testing', 'review', 'subscription'],
    maxConcurrency: 4,
    injectionBoundaries: ['pre-dispatch', 'next-turn'],
    available: false,
    unavailableReason: error instanceof Error ? error.message : String(error),
    authentication: 'unqualified',
    productVersion: 'unavailable',
    protocolHash: 'unavailable',
    models: [],
  }
}
