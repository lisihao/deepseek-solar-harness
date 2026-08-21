/**
 * Prime Agent 0.7.4 JSONL-RPC Resident Driver.
 *
 * DSH owns global TaskGraph scheduling, receipts, and acceptance. Prime Agent
 * owns only one node-local persistent RLM session and its recursive children.
 *
 * @module @deepseek-ai/dsh-resident-operator-prime-agent
 */

import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PhysicalOperatorReasoningEffort } from '@deepseek-ai/dsh-physical-operator'
import {
  ResidentOperatorError,
  type ResidentDriverExecuteRequest,
  type ResidentModelOption,
  type ResidentProductDriver,
  type ResidentProductDriverFactoryOptions,
  type ResidentProviderStatus,
  type ResidentTurnResult,
} from '@deepseek-ai/dsh-resident-operator'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

const execFileAsync = promisify(execFile)
const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

/** Exact Prime Agent release qualified by this Driver. */
export const EXPECTED_PRIME_AGENT_VERSION = '0.7.4'
/** Subscription-only Prime provider used by the first DSH integration. */
export const PRIME_SUBSCRIPTION_PROVIDER = 'openai-codex'
/** Stable digest of the RPC commands and terminal events consumed by this Driver. */
export const EXPECTED_PRIME_RPC_SHA256 = createHash('sha256')
  .update('prime-agent@0.7.4:prompt,abort,get_state,get_available_models,get_last_assistant_text:agent_end')
  .digest('hex')

const PRIME_EFFORTS = [
  'low', 'medium', 'high', 'xhigh', 'max',
] as const satisfies readonly PhysicalOperatorReasoningEffort[]

interface PrimeRpcResponse {
  readonly id?: string
  readonly type: 'response'
  readonly command: string
  readonly success: boolean
  readonly data?: unknown
  readonly error?: string
}

interface PrimeRpcState {
  readonly sessionId: string
  readonly sessionFile?: string
  readonly isStreaming: boolean
}

interface PrimeRpcModel {
  readonly id: string
  readonly name?: string
  readonly provider: string
  readonly reasoning?: boolean
  readonly contextWindow?: number
}

/** Testable construction inputs; normal deployments use the exported factory. */
export interface PrimeAgentResidentDriverOptions {
  readonly stateRoot: string
  readonly cliPath?: string
  readonly authPath?: string
  readonly requestTimeoutMs?: number
}

function defaultPrimeCliPath(): string {
  const require = createRequire(import.meta.url)
  const cliPath = (require.resolve.paths('prime-agent') ?? [])
    .map(root => join(root, 'prime-agent', 'dist', 'bundle', 'cli.js'))
    .find(path => existsSync(path))
  if (cliPath === undefined) {
    throw new ResidentOperatorError('Pinned Prime Agent CLI is not installed', 'RUNTIME_UNAVAILABLE')
  }
  return cliPath
}

function baseStatus(overrides: Partial<ResidentProviderStatus>): ResidentProviderStatus {
  return {
    operatorId: 'prime-agent',
    product: 'prime-agent',
    displayName: 'Prime Agent',
    description: 'Persistent node-local RLM recursion and synthesis through the user\'s ChatGPT subscription.',
    tags: ['recursive', 'rlm', 'multi-agent', 'research', 'synthesis', 'long-horizon', 'subscription'],
    maxConcurrency: 2,
    injectionBoundaries: ['pre-dispatch', 'next-turn'],
    available: false,
    authentication: 'unqualified',
    productVersion: 'unavailable',
    protocolHash: EXPECTED_PRIME_RPC_SHA256,
    models: [],
    ...overrides,
  }
}

/**
 * Build the credential-scrubbed environment used to execute the bundled Prime CLI.
 * @param electronVersion - Electron host version requiring RunAsNode, or undefined for Node.
 * @returns a fresh child-only environment with the correct Electron execution mode.
 */
export function primeAgentChildEnvironment(
  electronVersion: string | undefined = process.versions.electron,
): Record<string, string> {
  const environment = scrubbedParentEnv()
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === ELECTRON_RUN_AS_NODE) Reflect.deleteProperty(environment, key)
  }
  if (electronVersion !== undefined && electronVersion.length > 0) {
    environment[ELECTRON_RUN_AS_NODE] = '1'
  }
  return environment
}

function textPrompt(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) throw new ResidentOperatorError('Prime Agent prompt must not be empty', 'INVALID_RESULT')
  const texts = prompt.map((block) => {
    if (block.type !== 'text') {
      throw new ResidentOperatorError('Prime Agent resident execution accepts text blocks only', 'INVALID_RESULT')
    }
    return block.text
  })
  if (texts.every(value => value.trim().length === 0)) {
    throw new ResidentOperatorError('Prime Agent prompt must not be blank', 'INVALID_RESULT')
  }
  return [
    'DSH owns the global TaskGraph, permissions, retries, and final acceptance. Work only on this sealed node task. You may use Prime RLM recursion for bounded node-local decomposition, but do not create or claim completion of a separate global workflow. Do not run /refine or mutate global Prime harness state.',
    texts.join('\n\n'),
  ].join('\n\n')
}

function oauthQualified(authPath: string): boolean {
  if (!existsSync(authPath)) return false
  const parsed = JSON.parse(readFileSync(authPath, 'utf8')) as Record<string, { type?: unknown }>
  return parsed[PRIME_SUBSCRIPTION_PROVIDER]?.type === 'oauth'
}

function modelOption(model: PrimeRpcModel, index: number): ResidentModelOption {
  const efforts = model.reasoning === false ? [] : [...PRIME_EFFORTS]
  return {
    model: model.id,
    displayName: model.name ?? model.id,
    description: model.contextWindow === undefined
      ? `${model.provider} subscription model for Prime RLM execution`
      : `${model.provider} subscription model · ${String(model.contextWindow)} token context`,
    supportedEfforts: efforts,
    ...efforts.includes('high') ? { defaultEffort: 'high' as const } : {},
    isDefault: index === 0,
    supportsAdaptiveThinking: false,
  }
}

class PrimeRpcProcess {
  private readonly child
  private readonly pending = new Map<string, ReturnType<typeof Promise.withResolvers<PrimeRpcResponse>>>()
  private readonly terminal = Promise.withResolvers<void>()
  private readonly exit = Promise.withResolvers<void>()
  private nextId = 0
  private stdoutBuffer = ''
  private stderrTail = ''
  private closed = false

  constructor(
    cliPath: string,
    args: readonly string[],
    cwd: string,
    private readonly requestTimeoutMs: number,
    private readonly onEvent: (event: Readonly<Record<string, unknown>>) => void,
  ) {
    this.child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...primeAgentChildEnvironment(),
        RLM_MAX_DEPTH: '1',
      },
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => { this.consume(chunk) })
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_192)
    })
    this.child.once('error', (error) => { this.fail(error) })
    this.child.once('exit', (code, signal) => {
      if (!this.closed) {
        this.fail(new Error(
          `Prime Agent RPC exited with code ${String(code)} signal ${String(signal)}: ${this.stderrTail.trim()}`,
        ))
      }
      this.exit.resolve()
    })
  }

  request<T>(type: string, fields: Readonly<Record<string, unknown>> = {}): Promise<T> {
    if (this.closed || this.child.stdin.destroyed) {
      return Promise.reject(new ResidentOperatorError('Prime Agent RPC is closed', 'RUNTIME_UNAVAILABLE'))
    }
    const id = `dsh-${String(++this.nextId)}`
    const deferred = Promise.withResolvers<PrimeRpcResponse>()
    this.pending.set(id, deferred)
    this.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`)
    const timeout = setTimeout(() => {
      const current = this.pending.get(id)
      if (current !== deferred) return
      this.pending.delete(id)
      deferred.reject(new ResidentOperatorError(
        `Prime Agent RPC ${type} timed out after ${String(this.requestTimeoutMs)}ms`,
        'RUNTIME_UNAVAILABLE',
      ))
    }, this.requestTimeoutMs)
    return deferred.promise.finally(() => { clearTimeout(timeout) }).then((response) => {
      if (!response.success) {
        throw new ResidentOperatorError(
          `Prime Agent RPC ${response.command} failed: ${response.error ?? 'unknown error'}`,
          'INVALID_RESULT',
        )
      }
      return response.data as T
    })
  }

  waitForAgentEnd(): Promise<void> {
    return this.terminal.promise
  }

  async abort(): Promise<void> {
    if (this.closed) return
    await this.request('abort').catch(() => {})
  }

  async close(): Promise<void> {
    if (this.closed) return this.exit.promise
    this.closed = true
    this.child.stdin.end()
    const timer = setTimeout(() => { this.child.kill('SIGTERM') }, 3_000)
    try {
      await this.exit.promise
    } finally {
      clearTimeout(timer)
    }
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, '')
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line.length === 0) continue
      let message: Readonly<Record<string, unknown>>
      try {
        message = JSON.parse(line) as Readonly<Record<string, unknown>>
      } catch (error) {
        this.fail(new Error(`Prime Agent emitted invalid JSONL: ${error instanceof Error ? error.message : String(error)}`))
        return
      }
      if (message.type === 'response' && typeof message.id === 'string') {
        const deferred = this.pending.get(message.id)
        if (deferred !== undefined) {
          this.pending.delete(message.id)
          deferred.resolve(message as unknown as PrimeRpcResponse)
        }
        continue
      }
      this.onEvent(message)
      if (message.type === 'agent_end') this.terminal.resolve()
    }
  }

  private fail(error: Error): void {
    for (const deferred of this.pending.values()) deferred.reject(error)
    this.pending.clear()
    this.terminal.reject(error)
  }
}

/** Prime Agent Driver over its public JSONL RPC mode and OAuth subscription provider. */
export class PrimeAgentResidentDriver implements ResidentProductDriver {
  readonly operatorId = 'prime-agent'
  private readonly cliPath: string
  private readonly authPath: string
  private readonly requestTimeoutMs: number

  constructor(private readonly options: PrimeAgentResidentDriverOptions) {
    this.cliPath = options.cliPath ?? defaultPrimeCliPath()
    this.authPath = options.authPath ?? join(homedir(), '.prime', 'agent', 'auth.json')
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
    mkdirSync(options.stateRoot, { recursive: true, mode: 0o700 })
  }

  async qualify(): Promise<ResidentProviderStatus> {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [this.cliPath, '--version'], {
        encoding: 'utf8',
        env: primeAgentChildEnvironment(),
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      })
      const version = (stdout.trim() || stderr.trim())
      const exactVersion = version === EXPECTED_PRIME_AGENT_VERSION
        || version === `prime-agent ${EXPECTED_PRIME_AGENT_VERSION}`
      const subscription = oauthQualified(this.authPath)
      if (!exactVersion || !subscription) {
        return baseStatus({
          productVersion: version,
          authentication: subscription ? 'native-subscription' : 'unqualified',
          unavailableReason: !exactVersion
            ? `Prime Agent version ${version} does not match ${EXPECTED_PRIME_AGENT_VERSION}`
            : 'Prime Agent is not authenticated with openai-codex OAuth; run Prime Agent /login and select ChatGPT Plus/Pro.',
        })
      }
      const rpc = this.openRpc({
        workspace: this.options.stateRoot,
        sessionDir: join(this.options.stateRoot, 'qualification'),
        noSession: true,
      }, () => {})
      try {
        const data = await rpc.request<{ models?: PrimeRpcModel[] }>('get_available_models')
        const models = (data.models ?? [])
          .filter(model => model.provider === PRIME_SUBSCRIPTION_PROVIDER)
          .map(modelOption)
        const available = models.length > 0
        return baseStatus({
          available,
          authentication: 'native-subscription',
          productVersion: version,
          models,
          ...available ? {} : {
            unavailableReason: 'Prime Agent openai-codex OAuth reported no selectable subscription models.',
          },
        })
      } finally {
        await rpc.close()
      }
    } catch (error) {
      return baseStatus({
        unavailableReason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async execute(request: ResidentDriverExecuteRequest): Promise<ResidentTurnResult & { nativeSessionId: string }> {
    const qualification = await this.qualify()
    if (!qualification.available || qualification.authentication !== 'native-subscription') {
      throw new ResidentOperatorError(
        qualification.unavailableReason ?? 'Prime Agent subscription is unavailable',
        qualification.authentication === 'native-subscription'
          ? 'PROVIDER_VERSION_MISMATCH'
          : 'AUTH_MODE_MISMATCH',
      )
    }
    const prompt = textPrompt(request.prompt)
    request.onProgress('connecting')
    const rpc = this.openRpc({
      workspace: request.workspace,
      sessionDir: join(this.options.stateRoot, 'sessions'),
      model: request.profile.model,
      ...request.profile.effort === undefined ? {} : { effort: request.profile.effort },
      ...request.nativeSessionId === undefined ? {} : { nativeSessionId: request.nativeSessionId },
    }, (event) => {
      const type = typeof event.type === 'string' ? event.type : ''
      if (type.includes('tool')) request.onProgress('tool_activity')
      else if (type === 'agent_start' || type === 'turn_start' || type === 'message_start') request.onProgress('reasoning')
      else if (type === 'agent_end') request.onProgress('finalizing')
    })
    const abort = (): void => { void rpc.abort() }
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })
    try {
      const state = await rpc.request<PrimeRpcState>('get_state')
      if (typeof state.sessionId !== 'string' || state.sessionId.length === 0) {
        throw new ResidentOperatorError('Prime Agent returned no persistent session id', 'INVALID_RESULT')
      }
      request.onRunning(state.sessionId)
      request.onProgress('session_ready')
      await rpc.request('prompt', { message: prompt })
      await rpc.waitForAgentEnd()
      if (request.signal.aborted) {
        throw new ResidentOperatorError('Prime Agent turn was interrupted', 'RUNTIME_UNAVAILABLE')
      }
      const latest = await rpc.request<{ text?: string | null }>('get_last_assistant_text')
      if (typeof latest.text !== 'string' || latest.text.trim().length === 0) {
        throw new ResidentOperatorError('Prime Agent completed without assistant output', 'INVALID_RESULT')
      }
      const finalState = await rpc.request<PrimeRpcState>('get_state')
      return {
        output: [{ type: 'text', text: latest.text }],
        stopReason: 'completed',
        nativeSessionId: finalState.sessionId,
      }
    } finally {
      request.signal.removeEventListener('abort', abort)
      await rpc.close()
    }
  }

  private openRpc(
    options: {
      readonly workspace: string
      readonly sessionDir: string
      readonly model?: string
      readonly effort?: PhysicalOperatorReasoningEffort
      readonly nativeSessionId?: string
      readonly noSession?: boolean
    },
    onEvent: (event: Readonly<Record<string, unknown>>) => void,
  ): PrimeRpcProcess {
    mkdirSync(options.sessionDir, { recursive: true, mode: 0o700 })
    const args = [
      '--mode', 'rpc',
      '--provider', PRIME_SUBSCRIPTION_PROVIDER,
      '--session-dir', options.sessionDir,
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      ...options.noSession === true ? ['--no-session'] : [],
      ...options.model === undefined ? [] : ['--model', options.model],
      ...options.effort === undefined || options.effort === 'ultra' ? [] : ['--thinking', options.effort],
      ...options.nativeSessionId === undefined ? [] : ['--resume', options.nativeSessionId],
    ]
    return new PrimeRpcProcess(this.cliPath, args, options.workspace, this.requestTimeoutMs, onEvent)
  }
}

/**
 * Factory consumed by the generic detached Resident Driver loader.
 * @param options - daemon-owned state root allocated to this Driver module.
 * @returns Prime Agent Resident product Driver.
 */
export function createResidentProductDriver(
  options: ResidentProductDriverFactoryOptions,
): ResidentProductDriver {
  return new PrimeAgentResidentDriver({ stateRoot: join(options.stateRoot, 'prime-agent') })
}
