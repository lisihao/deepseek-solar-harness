import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ResidentDriverExecuteRequest,
  ResidentDriverCompactRequest,
  ResidentProductDriver,
  ResidentProviderStatus,
} from '@deepseek-ai/dsh-resident-operator'
import { ResidentOperatorError } from '@deepseek-ai/dsh-resident-operator'
import { ResidentDaemonClient } from '../src/client.ts'
import { normalizeResidentDriverError, ResidentDaemon } from '../src/daemon.ts'
import { residentDriverManifestSha256 } from '../src/driver-modules.ts'
import {
  EXPECTED_CODEX_CLI_VERSION,
  EXPECTED_CODEX_SCHEMA_SHA256,
} from '../src/drivers.ts'

const roots: string[] = []
const MODELS = [{
  model: 'gpt-test',
  displayName: 'GPT Test',
  description: 'Balanced everyday test model',
  supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  defaultEffort: 'medium' as const,
  isDefault: true,
  supportsAdaptiveThinking: false,
}]
const temporaryRoot = (): string => {
  const value = mkdtempSync(join(tmpdir(), 'dsh-resident-daemon-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('Resident daemon Driver error boundary', () => {
  it('preserves actionable Claude subscription expiry across the daemon boundary', () => {
    const error = new Error('Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.')
    expect(normalizeResidentDriverError(error, false)).toMatchObject({
      code: 'AUTH_MODE_MISMATCH',
      message: 'Claude Code subscription authentication expired; run `claude auth login` and retry the node.',
    })
  })

  it('classifies a disconnected Codex response stream as runtime unavailability', () => {
    const error = new Error('subagent-codex: Codex turn ended with status failed: {"message":"stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)"}')
    expect(normalizeResidentDriverError(error, false)).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })
})

describe('Resident daemon lifecycle', () => {
  it('closes accepted control sockets before shutdown settles', async () => {
    const root = temporaryRoot()
    const daemon = new ResidentDaemon({ root, drivers: [new MemoryDriver()] })
    await daemon.start()
    const socket = createConnection(daemon.socketPath)
    await once(socket, 'connect')

    await daemon.close()

    expect(socket.destroyed).toBe(true)
  })
})

class MemoryDriver implements ResidentProductDriver {
  readonly operatorId = 'codex' as const
  readonly profiles: ResidentDriverExecuteRequest['profile'][] = []
  readonly systemPrompts: Array<string | undefined> = []
  readonly nativeToolPolicies: Array<ResidentDriverExecuteRequest['nativeToolPolicy']> = []
  readonly commandIds: string[] = []
  readonly compactions: ResidentDriverCompactRequest[] = []
  constructor(readonly counts = new Map<string, number>()) {}

  qualify(): Promise<ResidentProviderStatus> {
    return Promise.resolve({
      operatorId: 'codex',
      product: 'codex',
      displayName: 'Codex',
      description: 'Test Resident Provider.',
      tags: ['coding'],
      maxConcurrency: 4,
      injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true,
      authentication: 'native-subscription',
      productVersion: 'test',
      protocolHash: 'test',
      models: MODELS,
    })
  }

  async execute(request: ResidentDriverExecuteRequest) {
    this.commandIds.push(String(request.commandId))
    this.profiles.push(request.profile)
    this.systemPrompts.push(request.systemPrompt)
    this.nativeToolPolicies.push(request.nativeToolPolicy)
    request.onProgress('connecting')
    const session = request.nativeSessionId ?? `native-${this.counts.size + 1}`
    const count = (this.counts.get(session) ?? 0) + 1
    this.counts.set(session, count)
    request.onRunning(session, `turn-${count}`)
    request.onProgress('reasoning')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5)
      request.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }, { once: true })
    })
    return {
      output: [{ type: 'text' as const, text: `session=${session};count=${count}` }],
      stopReason: 'completed' as const,
      nativeSessionId: session,
    }
  }

  compact(request: ResidentDriverCompactRequest): Promise<{ nativeSessionId: string }> {
    this.compactions.push(request)
    return Promise.resolve({ nativeSessionId: request.nativeSessionId })
  }
}

class BlockingQualificationDriver extends MemoryDriver {
  qualificationCount = 0
  activeQualifications = 0
  maximumActiveQualifications = 0
  readonly blockingQualificationEntered: Promise<void>
  readonly releaseQualification: () => void
  private readonly markBlockingQualificationEntered: () => void
  private readonly qualificationReleased: Promise<void>
  private blockQualifications = false

  constructor() {
    super()
    let markBlockingQualificationEntered = (): void => {}
    let releaseQualification = (): void => {}
    this.blockingQualificationEntered = new Promise<void>((resolve) => { markBlockingQualificationEntered = resolve })
    this.qualificationReleased = new Promise<void>((resolve) => { releaseQualification = resolve })
    this.markBlockingQualificationEntered = markBlockingQualificationEntered
    this.releaseQualification = releaseQualification
  }

  beginBlocking(): void {
    this.blockQualifications = true
  }

  override async qualify(): Promise<ResidentProviderStatus> {
    this.qualificationCount += 1
    this.activeQualifications += 1
    this.maximumActiveQualifications = Math.max(this.maximumActiveQualifications, this.activeQualifications)
    try {
      if (this.blockQualifications) {
        this.markBlockingQualificationEntered()
        await this.qualificationReleased
      }
      return await super.qualify()
    } finally {
      this.activeQualifications -= 1
    }
  }
}

class BlockingAuthenticationDriver extends MemoryDriver {
  authenticationCount = 0
  readonly authenticationEntered: Promise<void>
  readonly releaseAuthentication: () => void
  private readonly markAuthenticationEntered: () => void
  private readonly authenticationReleased: Promise<void>
  private authenticated = false

  constructor() {
    super()
    let markAuthenticationEntered = (): void => {}
    let releaseAuthentication = (): void => {}
    this.authenticationEntered = new Promise<void>((resolve) => { markAuthenticationEntered = resolve })
    this.authenticationReleased = new Promise<void>((resolve) => { releaseAuthentication = resolve })
    this.markAuthenticationEntered = markAuthenticationEntered
    this.releaseAuthentication = releaseAuthentication
  }

  override async qualify(): Promise<ResidentProviderStatus> {
    const status = await super.qualify()
    return this.authenticated
      ? status
      : {
        ...status,
        available: false,
        authentication: 'unqualified',
        unavailableReason: 'subscription login required',
        models: [],
      }
  }

  async authenticate(): Promise<ResidentProviderStatus> {
    this.authenticationCount += 1
    this.markAuthenticationEntered()
    await this.authenticationReleased
    this.authenticated = true
    return this.qualify()
  }
}

class FailingAuthenticationDriver extends MemoryDriver {
  authenticationCount = 0

  override qualify(): Promise<ResidentProviderStatus> {
    return Promise.resolve({
      operatorId: this.operatorId,
      product: 'codex',
      displayName: 'Codex',
      description: 'Test Resident Provider.',
      tags: ['coding'],
      maxConcurrency: 4,
      injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: false,
      unavailableReason: 'subscription login required',
      authentication: 'unqualified',
      productVersion: EXPECTED_CODEX_CLI_VERSION,
      protocolHash: EXPECTED_CODEX_SCHEMA_SHA256,
      models: [],
    })
  }

  authenticate(): Promise<ResidentProviderStatus> {
    this.authenticationCount += 1
    return Promise.reject(new ResidentOperatorError(
      'native callback listener is unavailable',
      'CALLBACK_LISTENER_MISSING',
    ))
  }
}

class NetworkUnavailableClaudeDriver implements ResidentProductDriver {
  readonly operatorId = 'claude-code'
  authenticationCount = 0

  qualify(): Promise<ResidentProviderStatus> {
    return Promise.resolve({
      operatorId: this.operatorId,
      product: 'claude-code',
      displayName: 'Claude Code',
      description: 'Test Resident Provider.',
      tags: ['subscription'],
      maxConcurrency: 4,
      injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: false,
      unavailableReason: 'fetch failed: getaddrinfo EAI_AGAIN api.anthropic.com',
      authentication: 'unqualified',
      productVersion: 'unavailable',
      protocolHash: 'unavailable',
      models: [],
    })
  }

  authenticate(): Promise<ResidentProviderStatus> {
    this.authenticationCount += 1
    return this.qualify()
  }

  execute(): Promise<never> {
    return Promise.reject(new Error('not used'))
  }
}

class AuthRequiredClaudeDriver extends NetworkUnavailableClaudeDriver {
  private authenticated = false

  override qualify(): Promise<ResidentProviderStatus> {
    const available = this.authenticated
    return Promise.resolve({
      operatorId: this.operatorId,
      product: 'claude-code',
      displayName: 'Claude Code',
      description: 'Test Resident Provider.',
      tags: ['subscription'],
      maxConcurrency: 4,
      injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available,
      ...available ? {} : {
        unavailableReason: 'Claude Code is not authenticated with a claude.ai subscription',
      },
      authentication: available ? 'native-subscription' : 'unqualified',
      productVersion: 'test',
      protocolHash: 'test',
      models: available ? MODELS : [],
    })
  }

  override authenticate(): Promise<ResidentProviderStatus> {
    this.authenticationCount += 1
    this.authenticated = true
    return this.qualify()
  }
}

class BlockingDriver extends MemoryDriver {
  override async execute(request: ResidentDriverExecuteRequest) {
    const session = request.nativeSessionId ?? 'native-blocking'
    request.onRunning(session, 'turn-blocking')
    await new Promise<void>((resolve, reject) => {
      request.signal.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      setTimeout(resolve, 5_000)
    })
    return { output: [], stopReason: 'completed' as const, nativeSessionId: session }
  }
}

class ReconnectDriver extends MemoryDriver {
  readonly running: Promise<void>
  readonly release: () => void
  private readonly markRunning: () => void

  constructor() {
    super()
    let markRunning = (): void => {}
    let release = (): void => {}
    this.running = new Promise<void>((resolve) => { markRunning = resolve })
    this.release = () => { release() }
    this.markRunning = markRunning
    this.released = new Promise<void>((resolve) => { release = resolve })
  }

  private readonly released: Promise<void>

  override async execute(request: ResidentDriverExecuteRequest) {
    request.onProgress('connecting')
    request.onRunning('native-reconnect', 'turn-reconnect')
    request.onProgress('reasoning')
    this.markRunning()
    await this.released
    request.onProgress('finalizing')
    return {
      output: [{ type: 'text' as const, text: 'reconnected result' }],
      stopReason: 'completed' as const,
      nativeSessionId: 'native-reconnect',
    }
  }
}

class FailingDriver extends MemoryDriver {
  override async execute(request: ResidentDriverExecuteRequest): Promise<never> {
    const prompt = request.prompt[0]
    const text = prompt?.type === 'text' ? prompt.text : 'missing'
    throw new Error(`failure echoed ${text}; OPENAI_API_KEY=sk-test-secret-token-123456789`)
  }
}

class IndeterminateCompactionDriver extends MemoryDriver {
  compactAttempts = 0
  override compact(): Promise<never> {
    this.compactAttempts += 1
    return Promise.reject(new Error('native transport disappeared after compaction dispatch'))
  }
}

class IdentityChangingCompactionDriver extends MemoryDriver {
  override compact(): Promise<{ nativeSessionId: string }> {
    return Promise.resolve({ nativeSessionId: 'unexpected-replacement' })
  }
}

class UnavailableTransportDriver extends MemoryDriver {
  override qualify(): Promise<ResidentProviderStatus> {
    return Promise.resolve({
      operatorId: 'codex',
      product: 'codex',
      displayName: 'Codex',
      description: 'Test Resident Provider.',
      tags: ['coding'],
      maxConcurrency: 4,
      injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: false,
      unavailableReason: 'managed app-server daemon is unavailable',
      authentication: 'native-subscription',
      productVersion: EXPECTED_CODEX_CLI_VERSION,
      protocolHash: EXPECTED_CODEX_SCHEMA_SHA256,
      models: MODELS,
    })
  }
}

function client(root: string): ResidentDaemonClient {
  return new ResidentDaemonClient({ root, autoStart: false, connectTimeoutMs: 2_000, pollIntervalMs: 5 })
}

describe('ResidentDaemon', () => {
  it('starts one Claude login only after read-only qualification proves auth is required', async () => {
    const root = temporaryRoot()
    const driver = new AuthRequiredClaudeDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    try {
      await connected.ready()
      expect(driver.authenticationCount).toBe(0)
      await expect(connected.authenticate('claude-code')).resolves.toMatchObject({
        available: true,
        authentication: 'native-subscription',
      })
      expect(driver.authenticationCount).toBe(1)
    } finally {
      await daemon.close()
    }
  })

  it('keeps qualification read-only when Claude is unavailable for a non-auth reason', async () => {
    const root = temporaryRoot()
    const driver = new NetworkUnavailableClaudeDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    try {
      await connected.ready()
      await expect(connected.authenticate('claude-code')).rejects.toMatchObject({
        code: 'NETWORK_UNAVAILABLE',
      })
      expect(driver.authenticationCount).toBe(0)
    } finally {
      await daemon.close()
    }
  })

  it('does not restart a failed login until the owner explicitly retries', async () => {
    const root = temporaryRoot()
    const driver = new FailingAuthenticationDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    try {
      await connected.ready()
      await expect(connected.authenticate('codex')).rejects.toMatchObject({
        code: 'CALLBACK_LISTENER_MISSING',
      })
      expect(driver.authenticationCount).toBe(1)

      await expect(connected.providers()).resolves.toEqual([
        expect.objectContaining({ operatorId: 'codex', available: false }),
      ])
      await expect(connected.list()).resolves.toEqual([])
      expect(driver.authenticationCount).toBe(1)

      await expect(connected.authenticate('codex')).rejects.toMatchObject({
        code: 'CALLBACK_LISTENER_MISSING',
      })
      expect(driver.authenticationCount).toBe(2)
    } finally {
      await daemon.close()
    }
  })

  it('coalesces concurrent explicit authentication for one native product', async () => {
    const root = temporaryRoot()
    const driver = new BlockingAuthenticationDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    await connected.ready()
    const first = connected.authenticate('codex')
    const second = connected.authenticate('codex')
    try {
      await driver.authenticationEntered
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      expect(driver.authenticationCount).toBe(1)
    } finally {
      driver.releaseAuthentication()
      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ operatorId: 'codex', available: true }),
        expect.objectContaining({ operatorId: 'codex', available: true }),
      ])
      await daemon.close()
    }
  })

  it('lists durable sessions without requalifying native subscription products', async () => {
    const root = temporaryRoot()
    const driver = new BlockingQualificationDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    try {
      await connected.ready()
      expect(driver.qualificationCount).toBe(1)
      expect(await connected.list()).toEqual([])
      expect(driver.qualificationCount).toBe(1)
    } finally {
      await daemon.close()
    }
  })

  it('coalesces concurrent qualification requests for the same native product', async () => {
    const root = temporaryRoot()
    const driver = new BlockingQualificationDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    await connected.ready()
    driver.beginBlocking()
    const first = connected.providers()
    const second = connected.providers()
    try {
      await driver.blockingQualificationEntered
      await new Promise<void>(resolve => setTimeout(resolve, 25))
      expect(driver.qualificationCount).toBe(2)
      expect(driver.maximumActiveQualifications).toBe(1)
    } finally {
      driver.releaseQualification()
      await Promise.all([first, second])
      await daemon.close()
    }
  })

  it('uses connectTimeout only for socket connection, not a qualified RPC response', async () => {
    const root = temporaryRoot()
    const driver = new BlockingQualificationDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = new ResidentDaemonClient({
      root,
      autoStart: false,
      connectTimeoutMs: 50,
      pollIntervalMs: 5,
    })
    await connected.ready()
    driver.beginBlocking()
    const result = connected.providers().then(
      providers => ({ providers }),
      (error: unknown) => ({ error }),
    )
    try {
      await driver.blockingQualificationEntered
      await new Promise<void>(resolve => setTimeout(resolve, 100))
      driver.releaseQualification()
      await expect(result).resolves.toMatchObject({ providers: [{ operatorId: 'codex' }] })
    } finally {
      driver.releaseQualification()
      await daemon.close()
    }
  })

  it('continues one operator+realpath workspace across client restart and isolates workspaces', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    const another = join(root, 'another')
    mkdirSync(workspace)
    mkdirSync(another)
    const driver = new MemoryDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const firstClient = client(root)
    const first = await firstClient.execute({
      commandId: 'command-1', operatorId: 'codex', workspace,
      taskLabel: '  Analyze\n 🐳 runtime\u0000  ',
      prompt: [{ type: 'text', text: 'first' }], systemPrompt: 'DSH assembled system', signal: new AbortController().signal,
    })
    expect(await first.result).toMatchObject({ output: [{ text: 'session=native-1;count=1' }] })
    expect(driver.commandIds).toEqual(['command-1'])
    expect(driver.profiles[0]).toEqual({ model: 'gpt-test', effort: 'medium' })
    expect(driver.systemPrompts[0]).toBe('DSH assembled system')
    const reconnected = await firstClient.inspect(first.sessionId)
    expect(reconnected).toMatchObject({
      executionProfile: { model: 'gpt-test', effort: 'medium' },
      executionProfileSource: 'smart-auto',
    })
    expect(reconnected.latestTurn).toMatchObject({
      turnId: first.turnId,
      state: 'settled',
      stopReason: 'completed',
      taskLabel: 'Analyze 🐳 runtime',
    })
    expect(reconnected.latestEvent).toMatchObject({ type: 'turn.settled' })
    expect(await firstClient.inspectTurn(first.turnId)).toMatchObject({
      commandId: 'command-1',
      sessionId: first.sessionId,
      state: 'settled',
      result: { stopReason: 'completed' },
    })
    const reasoning = (await firstClient.readEvents(first.sessionId)).events.find(event => (
      event.type === 'turn.progress' && event.data.phase === 'reasoning'
    ))
    expect(reasoning).toBeDefined()

    const restartedClient = client(root)
    const second = await restartedClient.execute({
      commandId: 'command-2', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'second' }], signal: new AbortController().signal,
    })
    expect(second.sessionId).toBe(first.sessionId)
    expect(await second.result).toMatchObject({ output: [{ text: 'session=native-1;count=2' }] })

    const isolated = await restartedClient.execute({
      commandId: 'command-3', operatorId: 'codex', workspace: another,
      prompt: [{ type: 'text', text: 'other' }], signal: new AbortController().signal,
    })
    expect(isolated.sessionId).not.toBe(first.sessionId)
    expect(await isolated.result).toMatchObject({ output: [{ text: 'session=native-2;count=1' }] })
    await daemon.close()
  })

  it('compacts an idle native Session once and replays the durable receipt without replacing history', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const driver = new MemoryDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    const turn = await connected.execute({
      commandId: 'compact-source', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'establish native history' }], signal: new AbortController().signal,
    })
    await turn.result
    const before = await connected.inspect(turn.sessionId)
    const request = {
      commandId: 'compact-command',
      sessionId: turn.sessionId,
      expectedStateRevision: before.stateRevision,
      instructions: 'retain architecture decisions',
    }
    const compacted = await connected.compact(request)
    expect(compacted).toMatchObject({
      nativeSessionId: 'native-1',
      session: {
        sessionId: turn.sessionId,
        nativeSessionId: 'native-1',
        lifecycle: 'idle',
        stateRevision: before.stateRevision + 2,
      },
    })
    expect(driver.compactions).toHaveLength(1)
    expect(driver.compactions[0]).toMatchObject({
      nativeSessionId: 'native-1',
      instructions: 'retain architecture decisions',
    })

    await expect(connected.compact(request)).resolves.toEqual(compacted)
    expect(driver.compactions).toHaveLength(1)
    await expect(connected.compact({ ...request, instructions: 'different guidance' }))
      .rejects.toMatchObject({ code: 'COMMAND_CONFLICT' })
    const events = await connected.readEvents(turn.sessionId)
    expect(events.events).toContainEqual(expect.objectContaining({
      type: 'session.compacted',
      data: { commandId: 'compact-command', instructionsProvided: true },
    }))
    expect(JSON.stringify(events)).not.toContain('retain architecture decisions')
    await daemon.close()
  })

  it('rejects native compaction while the Session has an active turn', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const daemon = new ResidentDaemon({ root, drivers: [new BlockingDriver()] })
    await daemon.start()
    const connected = client(root)
    const active = await connected.execute({
      commandId: 'compact-busy-source', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'stay active' }], signal: new AbortController().signal,
    })
    const running = await connected.inspect(active.sessionId)
    await expect(connected.compact({
      commandId: 'compact-while-busy',
      sessionId: active.sessionId,
      expectedStateRevision: running.stateRevision,
    })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    await connected.interrupt(active.sessionId, active.turnId)
    await expect(active.result).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    await daemon.close()
  })

  it('marks an unknown post-dispatch compaction failure indeterminate and does not retry it', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const driver = new IndeterminateCompactionDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    const turn = await connected.execute({
      commandId: 'compact-indeterminate-source', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'establish history' }], signal: new AbortController().signal,
    })
    await turn.result
    const before = await connected.inspect(turn.sessionId)
    const request = {
      commandId: 'compact-indeterminate',
      sessionId: turn.sessionId,
      expectedStateRevision: before.stateRevision,
    }
    await expect(connected.compact(request)).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    await expect(connected.compact(request)).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    expect(driver.compactAttempts).toBe(1)
    expect(await connected.inspect(turn.sessionId)).toMatchObject({
      lifecycle: 'idle', health: 'degraded', healthReason: 'process_crashed',
    })
    await daemon.close()
  })

  it('marks a post-product native identity mismatch indeterminate instead of leaving a running receipt', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const daemon = new ResidentDaemon({ root, drivers: [new IdentityChangingCompactionDriver()] })
    await daemon.start()
    const connected = client(root)
    const turn = await connected.execute({
      commandId: 'compact-identity-source', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'establish history' }], signal: new AbortController().signal,
    })
    await turn.result
    const before = await connected.inspect(turn.sessionId)
    const request = {
      commandId: 'compact-identity-mismatch',
      sessionId: turn.sessionId,
      expectedStateRevision: before.stateRevision,
    }
    await expect(connected.compact(request)).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    await expect(connected.compact(request)).rejects.toMatchObject({ code: 'COMMAND_INDETERMINATE' })
    expect(await connected.inspect(turn.sessionId)).toMatchObject({
      lifecycle: 'idle', health: 'degraded', nativeSessionId: 'native-1',
    })
    await daemon.close()
  })

  it('reattaches a fresh client to an active turn and observes durable progress through settlement', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const driver = new ReconnectDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const original = await client(root).execute({
      commandId: 'reconnect-active', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'keep running' }], signal: new AbortController().signal,
    })
    await driver.running

    const reattached = client(root)
    expect(await reattached.inspect(original.sessionId)).toMatchObject({
      lifecycle: 'running',
      activeTurnId: original.turnId,
      latestTurn: { turnId: original.turnId, state: 'running' },
      latestEvent: { type: 'turn.progress', data: { phase: 'reasoning' } },
    })
    expect(await reattached.inspectTurn(original.turnId)).toMatchObject({
      commandId: 'reconnect-active',
      state: 'running',
    })

    driver.release()
    await expect(original.result).resolves.toMatchObject({ output: [{ text: 'reconnected result' }] })
    expect(await reattached.inspectTurn(original.turnId)).toMatchObject({
      state: 'settled',
      result: { stopReason: 'completed' },
    })
    await daemon.close()
  })

  it('detaches an aborted caller without interrupting the daemon-owned turn', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const driver = new ReconnectDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const caller = new AbortController()
    const original = await client(root).execute({
      commandId: 'detach-active', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'keep running after the app exits' }], signal: caller.signal,
    })
    await driver.running

    caller.abort(new Error('desktop process stopped'))
    await expect(original.result).rejects.toThrow('desktop process stopped')
    expect(await client(root).inspectTurn(original.turnId)).toMatchObject({ state: 'running' })

    const reattached = await client(root).execute({
      commandId: 'detach-active', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'keep running after the app exits' }],
      signal: new AbortController().signal,
    })
    expect(reattached.turnId).toBe(original.turnId)
    driver.release()
    await expect(reattached.result).resolves.toMatchObject({ output: [{ text: 'reconnected result' }] })
    await daemon.close()
  })

  it('canonicalizes symlink workspaces and resumes the native session after daemon restart', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    const alias = join(root, 'workspace-alias')
    mkdirSync(workspace)
    symlinkSync(workspace, alias)
    const productState = new Map<string, number>()
    const firstDriver = new MemoryDriver(productState)
    const firstDaemon = new ResidentDaemon({ root, drivers: [firstDriver] })
    await firstDaemon.start()
    const first = await client(root).execute({
      commandId: 'restart-one', operatorId: 'codex', workspace: alias,
      prompt: [{ type: 'text', text: 'one' }], signal: new AbortController().signal,
    })
    await first.result
    await firstDaemon.close()

    const secondDriver = new MemoryDriver(productState)
    const secondDaemon = new ResidentDaemon({ root, drivers: [secondDriver] })
    await secondDaemon.start()
    const second = await client(root).execute({
      commandId: 'restart-two', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'two' }], signal: new AbortController().signal,
    })
    expect(second.sessionId).toBe(first.sessionId)
    expect(await second.result).toMatchObject({ output: [{ text: 'session=native-1;count=2' }] })
    await secondDaemon.close()
  })

  it('fails concurrent turns loud and leaves an interrupted session reusable', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const daemon = new ResidentDaemon({ root, drivers: [new BlockingDriver()] })
    await daemon.start()
    const connected = client(root)
    const active = await connected.execute({
      commandId: 'busy-one', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'wait' }], signal: new AbortController().signal,
    })
    await expect(connected.execute({
      commandId: 'busy-two', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'overlap' }], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'SESSION_BUSY' })
    const foreignWorkspace = join(root, 'foreign-workspace')
    mkdirSync(foreignWorkspace)
    const foreign = await client(root).execute({
      commandId: 'foreign', operatorId: 'codex', workspace: foreignWorkspace,
      prompt: [{ type: 'text', text: 'foreign' }], signal: new AbortController().signal,
    })
    await expect(connected.interrupt(foreign.sessionId, active.turnId))
      .rejects.toMatchObject({ code: 'SESSION_UNAVAILABLE' })
    await connected.interrupt(foreign.sessionId, foreign.turnId)
    await expect(foreign.result).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    await connected.interrupt(active.sessionId, active.turnId)
    await expect(active.result).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    expect(await connected.inspect(active.sessionId)).toMatchObject({ lifecycle: 'idle', health: 'ok' })
    await daemon.close()
  })

  it('rejects incompatible handshakes and malformed prompt blocks before product execution', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const driver = new MemoryDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    const raw = connected as unknown as {
      rawRequest<T>(method: string, params: object, signal?: AbortSignal): Promise<T>
    }
    await expect(raw.rawRequest('system.handshake', {
      protocol_version: 99,
      state_schema_version: 1,
      driver_manifest_sha256: residentDriverManifestSha256([]),
    })).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
    await expect(raw.rawRequest('turn.execute', {
      command_id: 'invalid-prompt',
      operator_id: 'codex',
      workspace,
      prompt: [{ type: 'text', text: 42 }],
    })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    await expect(raw.rawRequest('turn.execute', {
      command_id: 'invalid-label',
      operator_id: 'codex',
      workspace,
      task_label: { unsafe: true },
      prompt: [{ type: 'text', text: 'valid' }],
    })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    expect(driver.counts.size).toBe(0)
    await daemon.close()
  })

  it('rejects a daemon from a different build before exposing its services', async () => {
    const root = temporaryRoot()
    const daemon = new ResidentDaemon({ root, buildCommit: 'foreign-build', drivers: [new MemoryDriver()] })
    await daemon.start()
    await expect(client(root).ready()).rejects.toMatchObject({ code: 'PROVIDER_VERSION_MISMATCH' })
    await daemon.close()
  })

  it('reports a qualified subscription with an unavailable native transport as runtime unavailable', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const daemon = new ResidentDaemon({ root, drivers: [new UnavailableTransportDriver()] })
    await daemon.start()
    await expect(client(root).execute({
      commandId: 'transport-unavailable', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'never admitted' }], signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
    await daemon.close()
  })

  it('redacts prompt and credential-shaped values before persisting a failed receipt', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const daemon = new ResidentDaemon({ root, drivers: [new FailingDriver()] })
    await daemon.start()
    const connected = client(root)
    const turn = await connected.execute({
      commandId: 'redacted', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'private prompt nonce' }], signal: new AbortController().signal,
    })
    await expect(turn.result).rejects.toThrow('[REDACTED_PROMPT]')
    const persisted = daemon.store.inspectTurn(turn.turnId)
    expect(JSON.stringify(persisted)).not.toContain('private prompt nonce')
    expect(JSON.stringify(persisted)).not.toContain('sk-test-secret-token')
    await daemon.close()
  })

  it('returns a settled receipt for an identical command and conflicts on a changed request', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const driver = new MemoryDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    const modelToolBridge = {
      version: 1 as const,
      socketPath: join(root, 'bridge.sock'),
      sessionId: 'rlm-session',
      tools: [{ name: 'typescript_repl', description: 'Execute TypeScript.', inputSchema: { type: 'object' } }],
    }
    const first = await connected.execute({
      commandId: 'same', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'same' }], modelToolBridge, signal: new AbortController().signal,
    })
    await first.result
    const replay = await connected.execute({
      commandId: 'same', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'same' }], modelToolBridge, signal: new AbortController().signal,
    })
    expect(replay.turnId).toBe(first.turnId)
    await replay.result
    expect(driver.counts.get('native-1')).toBe(1)
    await expect(connected.execute({
      commandId: 'same', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'same' }],
      modelToolBridge: { ...modelToolBridge, sessionId: 'another-rlm-session' },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' })
    await daemon.close()
  })

  it('seals native tool authority into the receipt and forwards it to the Driver', async () => {
    const root = temporaryRoot()
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const driver = new MemoryDriver()
    const daemon = new ResidentDaemon({ root, drivers: [driver] })
    await daemon.start()
    const connected = client(root)
    const first = await connected.execute({
      commandId: 'no-tools', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'reason only' }], nativeToolPolicy: 'disabled',
      signal: new AbortController().signal,
    })
    await first.result
    expect(driver.nativeToolPolicies).toEqual(['disabled'])
    await expect(connected.execute({
      commandId: 'no-tools', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'reason only' }], nativeToolPolicy: 'inherit',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' })
    await expect(connected.execute({
      commandId: 'contradictory-tools', operatorId: 'codex', workspace,
      prompt: [{ type: 'text', text: 'reason only' }], nativeToolPolicy: 'disabled',
      modelToolBridge: {
        version: 1, socketPath: join(root, 'bridge.sock'), sessionId: 'bridge-session',
        tools: [{ name: 'echo', description: 'Echo.', inputSchema: { type: 'object' } }],
      },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    await daemon.close()
  })
})
