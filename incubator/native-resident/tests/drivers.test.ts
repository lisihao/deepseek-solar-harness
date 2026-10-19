import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'

import type { Options as ClaudeOptions, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

import { ResidentError, type DriverRequest, type NativeToolBridge } from '../src/contracts.js'
import { ClaudeNativeDriver, type ClaudeMcpFactory } from '../src/drivers/claude.js'
import type { CodexChildProcess } from '../src/drivers/codex.js'
import { CodexNativeDriver } from '../src/drivers/codex.js'
import { DRIVER_ERROR_CODE } from '../src/drivers/errors.js'

type JsonMessage = Record<string, unknown> & { id?: number; method?: string; params?: Record<string, unknown> }

class FakeCodexChild extends EventEmitter implements CodexChildProcess {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly requests: JsonMessage[] = []
  readonly killCalls: Array<NodeJS.Signals | undefined> = []
  #buffer = ''

  constructor(readonly handle: (message: JsonMessage, child: FakeCodexChild) => void) {
    super()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (chunk: string) => {
      this.#buffer += chunk
      for (;;) {
        const end = this.#buffer.indexOf('\n')
        if (end < 0) return
        const line = this.#buffer.slice(0, end)
        this.#buffer = this.#buffer.slice(end + 1)
        if (!line) continue
        const message = JSON.parse(line) as JsonMessage
        this.requests.push(message)
        this.handle(message, this)
      }
    })
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal)
    return true
  }

  respond(id: number | undefined, result: unknown): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  }

  reject(id: number | undefined, message: string): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })}\n`)
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  request(id: number, method: string, params: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  }

  malformed(): void {
    this.stdout.write('{not-json}\n')
  }

  endStdout(): void {
    this.stdout.end()
  }
}

class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  readonly #messages: SDKMessage[]
  readonly #waiters: Array<(result: IteratorResult<SDKMessage>) => void> = []
  #ended = false
  readonly interrupt = vi.fn(async () => {
    this.onInterrupt?.()
    return undefined
  })
  readonly close = vi.fn(() => this.end())
  readonly supportedModels = vi.fn(async () => this.models)
  onInterrupt: (() => void) | undefined

  constructor(
    messages: readonly SDKMessage[] = [],
    readonly models: readonly { readonly value: string; readonly displayName: string; readonly supportedEffortLevels?: readonly string[] }[] = [],
  ) {
    this.#messages = [...messages]
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this
  }

  next(): Promise<IteratorResult<SDKMessage>> {
    const message = this.#messages.shift()
    if (message) return Promise.resolve({ done: false, value: message })
    if (this.#ended) return Promise.resolve({ done: true, value: undefined })
    return new Promise<IteratorResult<SDKMessage>>((resolve) => this.#waiters.push(resolve))
  }

  push(message: SDKMessage): void {
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ done: false, value: message })
    else this.#messages.push(message)
  }

  end(): void {
    if (this.#ended) return
    this.#ended = true
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined })
  }
}

function requestFixture(overrides: Partial<Omit<DriverRequest, 'signal' | 'onSession'>> = {}): {
  readonly request: DriverRequest
  readonly controller: AbortController
  readonly sessions: string[]
} {
  const controller = new AbortController()
  const sessions: string[] = []
  return {
    controller,
    sessions,
    request: {
      commandId: 'command-1',
      cwd: '/tmp/dsh-native-driver-workspace',
      prompt: 'inspect the workspace',
      signal: controller.signal,
      onSession: (sessionId) => sessions.push(sessionId),
      ...overrides,
    },
  }
}

function initMessage(sessionId: string, cwd = '/tmp/dsh-native-driver-workspace'): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId, cwd } as unknown as SDKMessage
}

function successMessage(sessionId: string, result = 'Claude completed'): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    session_id: sessionId,
  } as unknown as SDKMessage
}

function failureMessage(sessionId: string, error = 'Claude failed'): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [error],
    session_id: sessionId,
  } as unknown as SDKMessage
}

function codexCatalogResponse(): Record<string, unknown> {
  return {
    data: [
      {
        id: 'catalog-internal-id',
        model: 'gpt-test',
        displayName: 'GPT Test',
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
      },
    ],
    nextCursor: null,
  }
}

function bridgeFixture(): NativeToolBridge {
  return {
    tools: [
      {
        name: 'workspace_lookup',
        description: 'Reads an approved workspace value.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false,
        },
      },
    ],
    call: vi.fn(async () => ({ content: 'bridge answer', isError: false })),
  }
}

async function withPinnedCodexSchema<T>(inspect: (schemaDir: string) => Promise<T>): Promise<T> {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('@openai/codex/package.json')
  const manifest = require(manifestPath) as { readonly version?: string; readonly bin?: string | Record<string, string> }
  expect(manifest.version).toBe('0.153.4')
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.codex
  if (!bin) throw new Error('Pinned @openai/codex package does not declare a codex bin')

  const schemaDir = await mkdtemp(join(tmpdir(), 'dsh-codex-app-server-schema-'))
  try {
    execFileSync(process.execPath, [resolve(dirname(manifestPath), bin), 'app-server', 'generate-json-schema', '--experimental', '--out', schemaDir], {
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return await inspect(schemaDir)
  } finally {
    await rm(schemaDir, { recursive: true, force: true })
  }
}

async function schemaProperties(schemaDir: string, name: string): Promise<readonly string[]> {
  const raw = await readFile(join(schemaDir, 'v2', `${name}.json`), 'utf8')
  const parsed = JSON.parse(raw) as { readonly properties?: Record<string, unknown> }
  return Object.keys(parsed.properties ?? {}).sort()
}

describe('CodexNativeDriver', () => {
  it('uses the public app-server lifecycle for a persistent new thread', async () => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const child = new FakeCodexChild((message, fake) => {
      switch (message.method) {
        case 'initialize':
          fake.respond(message.id, {})
          return
        case 'initialized':
          return
        case 'thread/start':
          expect(message.params).toMatchObject({ cwd, ephemeral: false, approvalPolicy: 'never' })
          expect(message.params).not.toHaveProperty('sandbox')
          fake.respond(message.id, { thread: { id: 'codex-thread-1' }, cwd })
          return
        case 'turn/start':
          expect(message.params).toEqual({
            threadId: 'codex-thread-1',
            input: [{ type: 'text', text: 'inspect the workspace' }],
          })
          fake.respond(message.id, { turn: { id: 'codex-turn-1' } })
          fake.notify('item/agentMessage/delta', {
            threadId: 'codex-thread-1',
            turnId: 'codex-turn-1',
            delta: 'done',
          })
          fake.notify('turn/completed', {
            threadId: 'codex-thread-1',
            turn: { id: 'codex-turn-1', status: 'completed' },
          })
          return
        default:
          throw new Error(`Unexpected Codex protocol method ${message.method}`)
      }
    })
    const spawn = vi.fn(() => child)
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn })
    const fixture = requestFixture()

    await expect(driver.execute(fixture.request)).resolves.toEqual({ output: 'done', nativeSessionId: 'codex-thread-1' })
    expect(fixture.sessions).toEqual(['codex-thread-1'])
    expect(spawn).toHaveBeenCalledWith('/fake/codex', ['app-server'], { cwd, stdio: 'pipe' })
    expect(child.requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start'])
    expect(child.killCalls).toEqual(['SIGTERM'])
  })

  it('resumes the supplied native session without replacing it', async () => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') return fake.respond(message.id, {})
      if (message.method === 'thread/resume') {
        expect(message.params).toEqual({
          threadId: 'codex-existing',
          cwd,
          approvalPolicy: 'never',
          excludeTurns: true,
        })
        return fake.respond(message.id, { thread: { id: 'codex-existing' }, cwd })
      }
      if (message.method === 'turn/start') {
        fake.respond(message.id, { turn: { id: 'codex-turn-2' } })
        fake.notify('turn/completed', {
          threadId: 'codex-existing',
          turn: { id: 'codex-turn-2', status: 'completed' },
        })
      }
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })
    const fixture = requestFixture({ nativeSessionId: 'codex-existing' })

    await expect(driver.execute(fixture.request)).resolves.toEqual({ output: '', nativeSessionId: 'codex-existing' })
    expect(fixture.sessions).toEqual([])
  })

  it.each([
    ['malformed JSONL', (child: FakeCodexChild) => child.malformed()],
    ['stdout EOF', (child: FakeCodexChild) => child.endStdout()],
  ])('marks %s after turn dispatch as indeterminate', async (_label, endTransport) => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') return fake.respond(message.id, {})
      if (message.method === 'thread/start') return fake.respond(message.id, { thread: { id: 'codex-thread-3' }, cwd })
      if (message.method === 'turn/start') {
        fake.respond(message.id, { turn: { id: 'codex-turn-3' } })
        endTransport(fake)
      }
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })

    await expect(driver.execute(requestFixture().request)).rejects.toMatchObject({
      code: DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
    })
  })

  it('marks a lost thread-start response as indeterminate because native session creation is durable', async () => {
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') return fake.respond(message.id, {})
      if (message.method === 'thread/start') fake.endStdout()
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })

    await expect(driver.execute(requestFixture().request)).rejects.toMatchObject({
      code: DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
    })
  })

  it.each([
    ['initialize', DRIVER_ERROR_CODE.COMMAND_CANCELLED],
    ['thread/start', DRIVER_ERROR_CODE.COMMAND_INDETERMINATE],
  ])('settles cancellation while %s is waiting for a response', async (blockedMethod, expectedCode) => {
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize' && blockedMethod !== 'initialize') return fake.respond(message.id, {})
      // Intentionally do not answer the selected setup request.
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })
    const fixture = requestFixture()
    const execution = driver.execute(fixture.request)

    await vi.waitFor(() => expect(child.requests.some((request) => request.method === blockedMethod)).toBe(true))
    fixture.controller.abort()
    await expect(execution).rejects.toMatchObject({ code: expectedCode })
    expect(child.killCalls).toEqual(['SIGTERM'])
  })

  it('interrupts the confirmed turn and maps its interrupted terminal event to cancellation', async () => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') return fake.respond(message.id, {})
      if (message.method === 'thread/start') return fake.respond(message.id, { thread: { id: 'codex-thread-4' }, cwd })
      if (message.method === 'turn/start') return fake.respond(message.id, { turn: { id: 'codex-turn-4' } })
      if (message.method === 'turn/interrupt') {
        expect(message.params).toEqual({ threadId: 'codex-thread-4', turnId: 'codex-turn-4' })
        fake.respond(message.id, {})
        fake.notify('turn/completed', {
          threadId: 'codex-thread-4',
          turn: { id: 'codex-turn-4', status: 'interrupted' },
        })
      }
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })
    const fixture = requestFixture()
    const execution = driver.execute(fixture.request)

    await vi.waitFor(() => expect(child.requests.some((request) => request.method === 'turn/start')).toBe(true))
    fixture.controller.abort()
    await expect(execution).rejects.toMatchObject({ code: DRIVER_ERROR_CODE.COMMAND_CANCELLED })
    expect(child.requests.map((request) => request.method)).toContain('turn/interrupt')
  })

  it('declines an unsupported Codex server request and fences the turn instead of waiting for input', async () => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') return fake.respond(message.id, {})
      if (message.method === 'thread/start') return fake.respond(message.id, { thread: { id: 'codex-request-thread' }, cwd })
      if (message.method === 'turn/start') {
        fake.respond(message.id, { turn: { id: 'codex-request-turn' } })
        fake.request(73, 'item/tool/requestUserInput', {
          threadId: 'codex-request-thread',
          turnId: 'codex-request-turn',
          itemId: 'input-item',
          isBlocking: true,
          questions: [{ id: 'approval', header: 'Approval', question: 'Proceed?' }],
        })
        return
      }
      if (!message.method && message.id === 73) {
        expect(message).toMatchObject({
          jsonrpc: '2.0',
          id: 73,
          error: { code: -32000, message: expect.stringContaining('declines interactive approvals and input') },
        })
        return
      }
      if (message.method === 'turn/interrupt') {
        expect(message.params).toEqual({ threadId: 'codex-request-thread', turnId: 'codex-request-turn' })
        fake.respond(message.id, {})
        // A late successful terminal must not erase the protocol fence.
        fake.notify('turn/completed', {
          threadId: 'codex-request-thread',
          turn: { id: 'codex-request-turn', status: 'completed' },
        })
      }
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })

    await expect(driver.execute(requestFixture().request)).rejects.toMatchObject({ code: DRIVER_ERROR_CODE.COMMAND_INDETERMINATE })
    expect(child.requests.map((request) => request.method)).toContain('turn/interrupt')
  })

  it('fences a Codex attempt when a bridge effect is indeterminate even if the turn later reports success', async () => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const bridge: NativeToolBridge = {
      ...bridgeFixture(),
      call: vi.fn(async () => {
        throw new ResidentError(DRIVER_ERROR_CODE.COMMAND_INDETERMINATE, 'Host bridge outcome is unknown')
      }),
    }
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') return fake.respond(message.id, {})
      if (message.method === 'thread/start') return fake.respond(message.id, { thread: { id: 'codex-fence-thread' }, cwd })
      if (message.method === 'turn/start') {
        fake.respond(message.id, { turn: { id: 'codex-fence-turn' } })
        fake.request(94, 'item/tool/call', {
          threadId: 'codex-fence-thread',
          turnId: 'codex-fence-turn',
          callId: 'unknown-bridge-call',
          tool: 'workspace_lookup',
          arguments: { query: 'status' },
        })
        return
      }
      if (message.method === 'turn/interrupt') {
        fake.respond(message.id, {})
        fake.notify('turn/completed', {
          threadId: 'codex-fence-thread',
          turn: { id: 'codex-fence-turn', status: 'completed' },
        })
      }
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })

    await expect(driver.execute(requestFixture({ bridge }).request)).rejects.toMatchObject({
      code: DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
    })
    expect(bridge.call).toHaveBeenCalledTimes(1)
    expect(child.requests.map((request) => request.method)).toContain('turn/interrupt')
  })

  it('maps a failed terminal event to COMMAND_FAILED', async () => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') return fake.respond(message.id, {})
      if (message.method === 'thread/start') return fake.respond(message.id, { thread: { id: 'codex-thread-5' }, cwd })
      if (message.method === 'turn/start') {
        fake.respond(message.id, { turn: { id: 'codex-turn-5' } })
        fake.notify('turn/completed', {
          threadId: 'codex-thread-5',
          turn: { id: 'codex-turn-5', status: 'failed', error: { message: 'native failure' } },
        })
      }
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })

    await expect(driver.execute(requestFixture().request)).rejects.toMatchObject({ code: DRIVER_ERROR_CODE.COMMAND_FAILED })
  })

  it('reads the native model catalog without starting a thread or a turn', async () => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') return fake.respond(message.id, {})
      if (message.method === 'model/list') {
        expect(message.params).toEqual({ limit: 100, includeHidden: true })
        return fake.respond(message.id, codexCatalogResponse())
      }
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })

    await expect(driver.models(cwd)).resolves.toEqual([
      { id: 'gpt-test', name: 'GPT Test', isDefault: true, reasoningEfforts: ['low', 'high'] },
    ])
    expect(child.requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'model/list'])
    expect(child.requests.some((request) => request.method === 'thread/start' || request.method === 'turn/start')).toBe(false)
  })

  it('checks the pinned Codex 0.153.4 schema before placing profile effort on turn/start', async () => {
    await withPinnedCodexSchema(async (schemaDir) => {
      const [threadStart, threadResume, turnStart] = await Promise.all([
        schemaProperties(schemaDir, 'ThreadStartParams'),
        schemaProperties(schemaDir, 'ThreadResumeParams'),
        schemaProperties(schemaDir, 'TurnStartParams'),
      ])
      expect(threadStart).toContain('model')
      expect(threadStart).not.toContain('effort')
      expect(threadResume).toContain('model')
      expect(threadResume).not.toContain('effort')
      expect(turnStart).toEqual(expect.arrayContaining(['model', 'effort', 'threadId', 'input']))
    })
  })

  it('validates an explicit Codex profile against the native catalog and forwards it unchanged', async () => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') return fake.respond(message.id, {})
      if (message.method === 'model/list') return fake.respond(message.id, codexCatalogResponse())
      if (message.method === 'thread/start') {
        expect(message.params).toEqual({
          cwd,
          ephemeral: false,
          approvalPolicy: 'never',
          model: 'gpt-test',
        })
        return fake.respond(message.id, { thread: { id: 'codex-profile-thread' }, cwd })
      }
      if (message.method === 'turn/start') {
        expect(message.params).toEqual({
          threadId: 'codex-profile-thread',
          input: [{ type: 'text', text: 'inspect the workspace' }],
          model: 'gpt-test',
          effort: 'high',
        })
        fake.respond(message.id, { turn: { id: 'codex-profile-turn' } })
        fake.notify('turn/completed', {
          threadId: 'codex-profile-thread',
          turn: { id: 'codex-profile-turn', status: 'completed' },
        })
      }
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })
    const fixture = requestFixture({ profile: { model: 'gpt-test', reasoningEffort: 'high' } })

    await expect(driver.execute(fixture.request)).resolves.toEqual({ output: '', nativeSessionId: 'codex-profile-thread' })
    expect(child.requests.map((request) => request.method)).toEqual([
      'initialize', 'initialized', 'model/list', 'thread/start', 'turn/start',
    ])
  })

  it('registers only allowlisted bridge tools and returns the bridge result to Codex', async () => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const bridge = bridgeFixture()
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') {
        expect(message.params).toMatchObject({ capabilities: { experimentalApi: true } })
        return fake.respond(message.id, {})
      }
      if (message.method === 'thread/start') {
        expect(message.params).toMatchObject({
          cwd,
          dynamicTools: [{
            type: 'function',
            name: 'workspace_lookup',
            description: 'Reads an approved workspace value.',
            inputSchema: bridge.tools[0]?.inputSchema,
          }],
        })
        return fake.respond(message.id, { thread: { id: 'codex-bridge-thread' }, cwd })
      }
      if (message.method === 'turn/start') {
        fake.respond(message.id, { turn: { id: 'codex-bridge-turn' } })
        fake.request(91, 'item/tool/call', {
          threadId: 'codex-bridge-thread',
          callId: 'codex-bridge-call',
          turnId: 'codex-bridge-turn',
          tool: 'workspace_lookup',
          arguments: { query: 'status' },
        })
        return
      }
      if (!message.method && message.id === 91) {
        expect(message).toEqual({
          jsonrpc: '2.0',
          id: 91,
          result: {
            contentItems: [{ type: 'inputText', text: 'bridge answer' }],
            success: true,
          },
        })
        fake.notify('turn/completed', {
          threadId: 'codex-bridge-thread',
          turn: { id: 'codex-bridge-turn', status: 'completed' },
        })
      }
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })
    const fixture = requestFixture({ bridge })

    await expect(driver.execute(fixture.request)).resolves.toEqual({ output: '', nativeSessionId: 'codex-bridge-thread' })
    expect(bridge.call).toHaveBeenCalledWith({
      commandId: 'command-1',
      callId: 'codex-bridge-call',
      name: 'workspace_lookup',
      arguments: { query: 'status' },
      signal: fixture.controller.signal,
    })
  })

  it('rejects an invalid Codex bridge before spawning a native process', async () => {
    const spawn = vi.fn(() => new FakeCodexChild(() => undefined))
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn })
    const bridge: NativeToolBridge = {
      tools: [{ name: 'bad_schema', description: 'Invalid schema.', inputSchema: { type: 'string' } }],
      call: vi.fn(async () => ({ content: '', isError: false })),
    }

    await expect(driver.execute(requestFixture({ bridge }).request)).rejects.toMatchObject({ code: DRIVER_ERROR_CODE.BRIDGE_INVALID })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns a tool error without forwarding a non-allowlisted Codex tool call', async () => {
    const cwd = '/tmp/dsh-native-driver-workspace'
    const bridge = bridgeFixture()
    const child = new FakeCodexChild((message, fake) => {
      if (message.method === 'initialize') return fake.respond(message.id, {})
      if (message.method === 'thread/start') return fake.respond(message.id, { thread: { id: 'codex-deny-thread' }, cwd })
      if (message.method === 'turn/start') {
        fake.respond(message.id, { turn: { id: 'codex-deny-turn' } })
        fake.request(92, 'item/tool/call', {
          threadId: 'codex-deny-thread',
          callId: 'denied-call',
          turnId: 'codex-deny-turn',
          tool: 'not_allowlisted',
          arguments: {},
        })
        return
      }
      if (!message.method && message.id === 92) {
        expect(message).toEqual({
          jsonrpc: '2.0',
          id: 92,
          result: {
            contentItems: [{ type: 'inputText', text: 'Tool not_allowlisted is not allowed by this Resident bridge' }],
            success: false,
          },
        })
        fake.notify('turn/completed', {
          threadId: 'codex-deny-thread',
          turn: { id: 'codex-deny-turn', status: 'completed' },
        })
      }
    })
    const driver = new CodexNativeDriver({ executable: '/fake/codex', spawn: () => child })

    await expect(driver.execute(requestFixture({ bridge }).request)).resolves.toEqual({ output: '', nativeSessionId: 'codex-deny-thread' })
    expect(bridge.call).not.toHaveBeenCalled()
  })
})

describe('ClaudeNativeDriver', () => {
  it('uses the published query API with a persistent session and no bypass mode', async () => {
    const fake = new FakeClaudeQuery([initMessage('claude-session-1'), successMessage('claude-session-1', 'completed')])
    const query = vi.fn((_request: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }) => fake as unknown as Query)
    const driver = new ClaudeNativeDriver({ executable: '/fake/claude', query })
    const fixture = requestFixture()

    await expect(driver.execute(fixture.request)).resolves.toEqual({ output: 'completed', nativeSessionId: 'claude-session-1' })
    expect(fixture.sessions).toEqual(['claude-session-1'])
    expect(query).toHaveBeenCalledTimes(1)
    const invocation = query.mock.calls[0]?.[0]
    expect(invocation).toMatchObject({
      prompt: 'inspect the workspace',
      options: {
        cwd: '/tmp/dsh-native-driver-workspace',
        persistSession: true,
        permissionMode: 'dontAsk',
        pathToClaudeCodeExecutable: '/fake/claude',
      },
    })
    const options = invocation?.options
    expect(options).not.toHaveProperty('allowedTools')
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions')
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it('passes an existing native session as resume and retains that identity', async () => {
    const fake = new FakeClaudeQuery([initMessage('claude-existing'), successMessage('claude-existing')])
    const query = vi.fn((_request: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }) => fake as unknown as Query)
    const driver = new ClaudeNativeDriver({ query })
    const fixture = requestFixture({ nativeSessionId: 'claude-existing' })

    await expect(driver.execute(fixture.request)).resolves.toEqual({ output: 'Claude completed', nativeSessionId: 'claude-existing' })
    expect(query.mock.calls[0]?.[0].options?.resume).toBe('claude-existing')
    expect(fixture.sessions).toEqual([])
  })

  it('maps an SDK terminal error to COMMAND_FAILED', async () => {
    const fake = new FakeClaudeQuery([initMessage('claude-session-3'), failureMessage('claude-session-3', 'native failure')])
    const driver = new ClaudeNativeDriver({ query: () => fake as unknown as Query })

    await expect(driver.execute(requestFixture().request)).rejects.toMatchObject({ code: DRIVER_ERROR_CODE.COMMAND_FAILED })
  })

  it('marks a stream that closes before a terminal result as indeterminate', async () => {
    const fake = new FakeClaudeQuery([initMessage('claude-session-4')])
    fake.end()
    const driver = new ClaudeNativeDriver({ query: () => fake as unknown as Query })

    await expect(driver.execute(requestFixture().request)).rejects.toMatchObject({
      code: DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
    })
  })

  it('aborts, interrupts, closes, and only reports cancellation after a terminal SDK result', async () => {
    const fake = new FakeClaudeQuery([initMessage('claude-session-5')])
    fake.onInterrupt = () => fake.push(failureMessage('claude-session-5', 'interrupted'))
    const driver = new ClaudeNativeDriver({ query: () => fake as unknown as Query })
    const fixture = requestFixture()
    const execution = driver.execute(fixture.request)

    await vi.waitFor(() => expect(fake.next).toBeDefined())
    fixture.controller.abort()
    await expect(execution).rejects.toMatchObject({ code: DRIVER_ERROR_CODE.COMMAND_CANCELLED })
    expect(fake.interrupt).toHaveBeenCalledTimes(1)
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it('reads the SDK catalog from an idle stream without providing a model prompt', async () => {
    const catalog = new FakeClaudeQuery([], [
      { value: 'claude-test', displayName: 'Claude Test', supportedEffortLevels: ['low', 'high'] },
    ])
    const query = vi.fn((_request: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }) => catalog as unknown as Query)
    const driver = new ClaudeNativeDriver({ executable: '/fake/claude', query })

    await expect(driver.models('/tmp/dsh-native-driver-workspace')).resolves.toEqual([
      { id: 'claude-test', name: 'Claude Test', reasoningEfforts: ['low', 'high'] },
    ])
    expect(query).toHaveBeenCalledTimes(1)
    const invocation = query.mock.calls[0]?.[0]
    expect(typeof invocation?.prompt).not.toBe('string')
    expect(invocation?.options).toMatchObject({
      cwd: '/tmp/dsh-native-driver-workspace',
      persistSession: false,
      permissionMode: 'dontAsk',
      pathToClaudeCodeExecutable: '/fake/claude',
    })
    expect(catalog.supportedModels).toHaveBeenCalledTimes(1)
    expect(catalog.close).toHaveBeenCalledTimes(1)
  })

  it('validates an explicit Claude profile against the SDK catalog and preserves its selection', async () => {
    const catalog = new FakeClaudeQuery([], [
      { value: 'claude-test', displayName: 'Claude Test', supportedEffortLevels: ['high'] },
    ])
    const execution = new FakeClaudeQuery([initMessage('claude-profile-session'), successMessage('claude-profile-session')])
    const query = vi.fn((request: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }) => (
      typeof request.prompt === 'string' ? execution : catalog
    ) as unknown as Query)
    const driver = new ClaudeNativeDriver({ query })
    const fixture = requestFixture({ profile: { model: 'claude-test', reasoningEffort: 'high' } })

    await expect(driver.execute(fixture.request)).resolves.toEqual({ output: 'Claude completed', nativeSessionId: 'claude-profile-session' })
    expect(query).toHaveBeenCalledTimes(2)
    expect(typeof query.mock.calls[0]?.[0].prompt).not.toBe('string')
    expect(query.mock.calls[1]?.[0]).toMatchObject({
      prompt: 'inspect the workspace',
      options: { model: 'claude-test', effort: 'high' },
    })
  })

  it('provides an SDK-MCP bridge while retaining native SDK tools', async () => {
    const bridge = bridgeFixture()
    const execution = new FakeClaudeQuery([initMessage('claude-bridge-session')])
    let handler: ((arguments_: Record<string, unknown>, extra: unknown) => Promise<unknown>) | undefined
    const mcpFactory: ClaudeMcpFactory = {
      tool: (_name, _description, _shape, nextHandler) => {
        handler = nextHandler
        return { name: 'workspace_lookup' }
      },
      createSdkMcpServer: (options) => ({ type: 'sdk', name: options.name, instance: {} }),
    }
    const query = vi.fn((_request: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }) => execution as unknown as Query)
    const driver = new ClaudeNativeDriver({ query, mcpFactory })
    const fixture = requestFixture({ bridge })
    const pending = driver.execute(fixture.request)

    await vi.waitFor(() => expect(handler).toBeTypeOf('function'))
    const result = await handler!({ query: 'status' }, { requestId: 'claude-bridge-call' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'bridge answer' }], isError: false })
    expect(bridge.call).toHaveBeenCalledWith({
      commandId: 'command-1',
      callId: 'claude-bridge-call',
      name: 'workspace_lookup',
      arguments: { query: 'status' },
      signal: fixture.controller.signal,
    })
    const options = query.mock.calls[0]?.[0].options
    expect(options?.mcpServers).toMatchObject({ 'dsh-native-resident': { type: 'sdk', name: 'dsh-native-resident' } })
    expect(options?.allowedTools).toEqual(['mcp__dsh-native-resident__workspace_lookup'])
    expect(options).not.toHaveProperty('allowDangerouslySkipPermissions')

    execution.push(successMessage('claude-bridge-session'))
    await expect(pending).resolves.toEqual({ output: 'Claude completed', nativeSessionId: 'claude-bridge-session' })
  })

  it('routes a real in-memory public MCP requestId to the Claude bridge without a model call', async () => {
    const bridge = bridgeFixture()
    const execution = new FakeClaudeQuery([initMessage('claude-real-mcp-session')])
    const query = vi.fn((_request: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }) => execution as unknown as Query)
    const driver = new ClaudeNativeDriver({ query })
    const fixture = requestFixture({ bridge })
    const pending = driver.execute(fixture.request)

    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1))
    const server = query.mock.calls[0]?.[0].options?.mcpServers?.['dsh-native-resident']
    if (!server || server.type !== 'sdk') throw new Error('Claude driver did not expose a public SDK MCP server')
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'native-driver-test', version: '1' })
    try {
      await server.instance.connect(serverTransport)
      await client.connect(clientTransport)
      await expect(client.callTool({ name: 'workspace_lookup', arguments: { query: 'status' } })).resolves.toMatchObject({
        content: [{ type: 'text', text: 'bridge answer' }],
        isError: false,
      })
      // Client initialization is request id 0; this public tools/call is id 1.
      expect(bridge.call).toHaveBeenCalledWith({
        commandId: 'command-1',
        callId: '1',
        name: 'workspace_lookup',
        arguments: { query: 'status' },
        signal: fixture.controller.signal,
      })
    } finally {
      await client.close()
    }

    execution.push(successMessage('claude-real-mcp-session'))
    await expect(pending).resolves.toEqual({ output: 'Claude completed', nativeSessionId: 'claude-real-mcp-session' })
  })

  it('fences a Claude attempt after an indeterminate bridge effect even if the SDK later reports success', async () => {
    const bridge: NativeToolBridge = {
      ...bridgeFixture(),
      call: vi.fn(async () => {
        throw new ResidentError(DRIVER_ERROR_CODE.COMMAND_INDETERMINATE, 'Host bridge outcome is unknown')
      }),
    }
    const execution = new FakeClaudeQuery([initMessage('claude-fence-session')])
    execution.onInterrupt = () => execution.push(successMessage('claude-fence-session'))
    let handler: ((arguments_: Record<string, unknown>, extra: unknown) => Promise<unknown>) | undefined
    const mcpFactory: ClaudeMcpFactory = {
      tool: (_name, _description, _shape, nextHandler) => {
        handler = nextHandler
        return { name: 'workspace_lookup' }
      },
      createSdkMcpServer: (options) => ({ type: 'sdk', name: options.name, instance: {} }),
    }
    const driver = new ClaudeNativeDriver({ query: () => execution as unknown as Query, mcpFactory })
    const pending = driver.execute(requestFixture({ bridge }).request)

    await vi.waitFor(() => expect(handler).toBeTypeOf('function'))
    await expect(handler!({ query: 'status' }, { requestId: 'unknown-bridge-call' })).rejects.toMatchObject({
      code: DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
    })
    await expect(handler!({ query: 'later' }, { requestId: 'must-not-run' })).rejects.toMatchObject({
      code: DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
    })
    expect(bridge.call).toHaveBeenCalledTimes(1)
    await expect(pending).rejects.toMatchObject({ code: DRIVER_ERROR_CODE.COMMAND_INDETERMINATE })
    expect(execution.interrupt).toHaveBeenCalledTimes(1)
    expect(execution.close).toHaveBeenCalledTimes(1)
  })

  it('rejects an unsupported Claude profile without submitting an execution prompt', async () => {
    const catalog = new FakeClaudeQuery([], [
      { value: 'claude-test', displayName: 'Claude Test', supportedEffortLevels: ['low'] },
    ])
    const query = vi.fn((_request: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }) => catalog as unknown as Query)
    const driver = new ClaudeNativeDriver({ query })
    const fixture = requestFixture({ profile: { model: 'claude-test', reasoningEffort: 'high' } })

    await expect(driver.execute(fixture.request)).rejects.toMatchObject({ code: DRIVER_ERROR_CODE.PROFILE_INVALID })
    expect(query).toHaveBeenCalledTimes(1)
    expect(typeof query.mock.calls[0]?.[0].prompt).not.toBe('string')
  })

  it('rejects an invalid Claude bridge before opening an SDK query', async () => {
    const query = vi.fn()
    const driver = new ClaudeNativeDriver({ query: query as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query })
    const bridge: NativeToolBridge = {
      tools: [{ name: 'bad_schema', description: 'Invalid schema.', inputSchema: { type: 'string' } }],
      call: vi.fn(async () => ({ content: '', isError: false })),
    }

    await expect(driver.execute(requestFixture({ bridge }).request)).rejects.toMatchObject({ code: DRIVER_ERROR_CODE.BRIDGE_INVALID })
    expect(query).not.toHaveBeenCalled()
  })
})
