/** Native subscription resident drivers for Claude Code and Codex. @module @deepseek-ai/dsh-resident-operator-local/drivers */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  query as claudeQuery,
  type CanUseTool,
  type ModelInfo,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PhysicalOperatorReasoningEffort } from '@deepseek-ai/dsh-physical-operator'
import type {
  ResidentDriverExecuteRequest,
  ResidentModelOption,
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
  type CodexAppServerModel,
  type CodexAppServerRateLimit,
} from '@deepseek-ai/dsh-subagent-codex'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { openCodexDaemonStream } from './codex-transport.ts'

const execFileAsync = promisify(execFile)

/** Qualified Claude Code CLI version for this Resident build. */
export const EXPECTED_CLAUDE_CLI_VERSION = '2.1.239 (Claude Code)'
/** Official Claude Agent SDK version compiled into this Resident build. */
export const EXPECTED_CLAUDE_SDK_VERSION = '0.3.220'
/** Qualified Codex CLI version for this Resident build. */
export const EXPECTED_CODEX_CLI_VERSION = 'codex-cli 0.147.0'
/** SHA-256 of the qualified Codex app-server v2 JSON Schema. */
export const EXPECTED_CODEX_SCHEMA_SHA256 = 'f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2'

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
  const unavailable = /stream disconnected before completion/iu.test(message)
    || /error sending request for url/iu.test(message)
    || /app-server protocol stream closed/iu.test(message)
    || /\b(?:ECONNRESET|ETIMEDOUT|EPIPE)\b/iu.test(message)
  return new ResidentOperatorError(message, unavailable ? 'RUNTIME_UNAVAILABLE' : 'INVALID_RESULT')
}

/** Claude Code Agent SDK Driver using persisted native subscription Sessions. */
export class ClaudeCodeResidentDriver implements ResidentProductDriver {
  readonly operatorId = 'claude-code' as const

  async qualify(): Promise<ResidentProviderStatus> {
    try {
      const { stdout: version, executable } = await command('claude', ['--version'])
      const { stdout: auth } = await command(executable, ['auth', 'status', '--json'])
      const parsed = JSON.parse(auth) as Record<string, unknown>
      const subscription = isClaudeNativeSubscription(parsed)
      const exactVersion = version.trim() === EXPECTED_CLAUDE_CLI_VERSION
      const models = subscription && exactVersion ? await claudeModels(executable) : []
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
    const canUseTool: CanUseTool = (toolName, _input, options) => {
      approvalRequired = options.title ?? options.displayName ?? toolName
      return Promise.resolve({
        behavior: 'deny',
        message: `Resident execution requires out-of-band approval for ${toolName}`,
        interrupt: true,
      })
    }
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
        disallowedTools: ['AskUserQuestion'],
        canUseTool,
      },
    })
    try {
      for await (const message of query) {
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
    return { output, stopReason, nativeSessionId }
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
    const qualification = await this.qualify()
    if (!qualification.available) {
      const code = qualification.authentication !== 'native-subscription'
        ? 'AUTH_MODE_MISMATCH'
        : qualification.productVersion !== EXPECTED_CODEX_CLI_VERSION
          || qualification.protocolHash !== EXPECTED_CODEX_SCHEMA_SHA256
          ? 'PROVIDER_VERSION_MISMATCH'
          : 'RUNTIME_UNAVAILABLE'
      throw new ResidentOperatorError(qualification.unavailableReason ?? 'Codex unavailable', code)
    }
    const texts = textPrompt(request.prompt, 'Codex')
    request.onProgress('connecting')
    const socketPath = join(homedir(), '.codex', 'app-server-control', 'app-server-control.sock')
    if (!existsSync(socketPath)) {
      throw new ResidentOperatorError('Codex app-server control socket is unavailable', 'RUNTIME_UNAVAILABLE')
    }
    const stream = await openCodexDaemonStream(socketPath, request.signal).catch((error: unknown) => {
      throw new ResidentOperatorError(
        `Codex app-server WebSocket unavailable: ${error instanceof Error ? error.message : String(error)}`,
        'RUNTIME_UNAVAILABLE',
      )
    })
    const wire = new CodexAppServerWire(stream, stream, 'require')
    const abort = (): void => { wire.interrupt() }
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })
    try {
      wire.start()
      await wire.initialize(request.signal)
      if (request.nativeSessionId === undefined) {
        await wire.startThread(request.workspace, request.signal, false, request.profile)
      } else {
        await wire.resumeThread(request.nativeSessionId, request.workspace, request.signal, request.profile)
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
      }, request.profile)
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
