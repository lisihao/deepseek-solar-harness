/** Native subscription resident drivers for Claude Code and Codex. @module @deepseek-ai/dsh-resident-operator-local/drivers */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  query as claudeQuery,
  type CanUseTool,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  ResidentProviderStatus,
  ResidentStopReason,
  ResidentTurnResult,
} from '@deepseek-ai/dsh-resident-operator'
import { ResidentOperatorError } from '@deepseek-ai/dsh-resident-operator'
import { CodexApprovalRequiredError, CodexAppServerWire } from '@deepseek-ai/dsh-subagent-codex'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { openCodexDaemonStream } from './codex-transport.ts'

const execFileAsync = promisify(execFile)

/** Qualified Claude Code CLI version for this Resident build. */
export const EXPECTED_CLAUDE_CLI_VERSION = '2.1.233 (Claude Code)'
/** Official Claude Agent SDK version compiled into this Resident build. */
export const EXPECTED_CLAUDE_SDK_VERSION = '0.3.220'
/** Qualified Codex CLI version for this Resident build. */
export const EXPECTED_CODEX_CLI_VERSION = 'codex-cli 0.147.0'
/** SHA-256 of the qualified Codex app-server v2 JSON Schema. */
export const EXPECTED_CODEX_SCHEMA_SHA256 = 'f3dec1e031d99a420b137b903f02196d4325eece57620c925bb7130b25f168d2'

/** One native product invocation after durable daemon admission. */
export interface DriverExecuteRequest {
  readonly workspace: string
  readonly prompt: readonly ContentBlock[]
  readonly nativeSessionId?: string
  readonly signal: AbortSignal
  readonly onRunning: (nativeSessionId?: string, nativeTurnId?: string) => void
}

/** Native product qualification and resumable turn adapter. */
export interface ResidentProductDriver {
  /** Stable physical product identity. */
  readonly operatorId: 'claude-code' | 'codex'
  /** @returns current version, protocol, and native-subscription qualification. */
  qualify(): Promise<ResidentProviderStatus>
  /**
   * Execute or resume one native product turn.
   * @param request - canonical workspace, prompt, prior native Session, signal, and running callback.
   * @returns bounded final result and authoritative native Session identity.
   */
  execute(request: DriverExecuteRequest): Promise<ResidentTurnResult & { readonly nativeSessionId: string }>
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

async function command(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args, {
      encoding: 'utf8',
      env: scrubbedParentEnv(),
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    })
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

/** Claude Code Agent SDK Driver using persisted native subscription Sessions. */
export class ClaudeCodeResidentDriver implements ResidentProductDriver {
  readonly operatorId = 'claude-code' as const

  async qualify(): Promise<ResidentProviderStatus> {
    try {
      const [{ stdout: version }, { stdout: auth }] = await Promise.all([
        command('claude', ['--version']),
        command('claude', ['auth', 'status', '--json']),
      ])
      const parsed = JSON.parse(auth) as Record<string, unknown>
      const subscription = parsed.loggedIn === true
        && parsed.authMethod === 'claude.ai'
        && typeof parsed.subscriptionType === 'string'
        && parsed.subscriptionType.length > 0
      const exactVersion = version.trim() === EXPECTED_CLAUDE_CLI_VERSION
      return {
        operatorId: this.operatorId,
        product: this.operatorId,
        available: subscription && exactVersion,
        ...subscription && exactVersion ? {} : {
          unavailableReason: !subscription
            ? 'Claude Code is not authenticated with a claude.ai subscription'
            : `Claude Code version ${version.trim()} does not match ${EXPECTED_CLAUDE_CLI_VERSION}`,
        },
        authentication: subscription ? 'native-subscription' : 'unqualified',
        productVersion: version.trim(),
        protocolHash: createHash('sha256').update(`claude-agent-sdk@${EXPECTED_CLAUDE_SDK_VERSION}`).digest('hex'),
      }
    } catch (error) {
      return unavailable(this.operatorId, error)
    }
  }

  async execute(request: DriverExecuteRequest): Promise<ResidentTurnResult & { nativeSessionId: string }> {
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
    const controller = new AbortController()
    const abort = (): void => { controller.abort(request.signal.reason) }
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })
    let nativeSessionId = request.nativeSessionId
    let final: SDKResultMessage | undefined
    let approvalRequired: string | undefined
    const running = new Set<string>()
    const canUseTool: CanUseTool = async (toolName, _input, options) => {
      approvalRequired = options.title ?? options.displayName ?? toolName
      return {
        behavior: 'deny',
        message: `Resident execution requires out-of-band approval for ${toolName}`,
        interrupt: true,
      }
    }
    const query = claudeQuery({
      prompt: texts.join(''),
      options: {
        abortController: controller,
        cwd: request.workspace,
        env: scrubbedParentEnv(),
        persistSession: true,
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
          }
        }
        if (message.type === 'result') final = message
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
      const available = subscription && exactVersion && exactSchema && transportReady
      return {
        operatorId: this.operatorId,
        product: this.operatorId,
        available,
        ...available ? {} : {
          unavailableReason: !subscription
            ? 'Codex is not authenticated with a ChatGPT subscription'
            : !exactVersion
              ? `Codex version ${version.trim()} does not match ${EXPECTED_CODEX_CLI_VERSION}`
              : !exactSchema
                ? `Codex app-server schema ${schemaHash} does not match ${EXPECTED_CODEX_SCHEMA_SHA256}`
                : `Codex app-server daemon unavailable: ${transportError instanceof Error ? transportError.message : String(transportError)}`,
        },
        authentication: subscription ? 'native-subscription' : 'unqualified',
        productVersion: version.trim(),
        protocolHash: schemaHash,
      }
    } catch (error) {
      return unavailable(this.operatorId, error)
    }
  }

  async execute(request: DriverExecuteRequest): Promise<ResidentTurnResult & { nativeSessionId: string }> {
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
        await wire.startThread(request.workspace, request.signal, false)
      } else {
        await wire.resumeThread(request.nativeSessionId, request.workspace, request.signal)
      }
      const threadId = wire.currentThreadId
      if (threadId === undefined) {
        throw new ResidentOperatorError('Codex returned no persistent thread id', 'INVALID_RESULT')
      }
      request.onRunning(threadId)
      const result = await wire.runTurn(texts, request.signal, (turnId) => {
        request.onRunning(threadId, turnId)
      }).catch((error: unknown) => {
        if (error instanceof CodexApprovalRequiredError) {
          throw new ResidentOperatorError(error.message, 'APPROVAL_REQUIRED')
        }
        throw error
      })
      return { ...result, nativeSessionId: threadId }
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

function unavailable(
  product: 'claude-code' | 'codex',
  error: unknown,
): ResidentProviderStatus {
  return {
    operatorId: product,
    product,
    available: false,
    unavailableReason: error instanceof Error ? error.message : String(error),
    authentication: 'unqualified',
    productVersion: 'unavailable',
    protocolHash: 'unavailable',
  }
}
