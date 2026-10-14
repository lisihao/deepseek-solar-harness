import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  SubprocessHandle,
  SubprocessOutcome,
} from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as codex from '../src/index.ts'
import * as invariant from '../src/invariant.ts'
import {
  codexAppServerArgv,
  DEFAULT_DISPOSE_GRACE_MS,
  disposeCodexChild,
  startCodexRun,
  textTask,
  type CodexRunSpec,
} from '../src/run.ts'
import { CodexAppServerWire, CodexTurnStartUncertainError } from '../src/wire.ts'

type JsonObject = Record<string, unknown>

const fakeParent = {
  id: 'parent',
  session: { header: { cwd: process.cwd() } },
} as unknown as Agent

function request(
  prompt: ContentBlock[] = [{ type: 'text', text: 'do the task' }],
  signal = new AbortController().signal,
) {
  return { prompt, parent: fakeParent, signal }
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

class ProtocolPeer {
  private buffer = ''
  private readonly frames: JsonObject[] = []
  private readonly wakeups = new Set<() => void>()

  constructor(
    input: PassThrough,
    private readonly output: PassThrough,
  ) {
    input.on('data', (chunk: Buffer | string) => {
      this.buffer += chunk.toString()
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim().length > 0) this.frames.push(JSON.parse(line) as JsonObject)
      }
      for (const wake of this.wakeups) wake()
      this.wakeups.clear()
    })
  }

  async next(predicate: (frame: JsonObject) => boolean): Promise<JsonObject> {
    for (;;) {
      const index = this.frames.findIndex(predicate)
      if (index >= 0) return this.frames.splice(index, 1)[0]!
      await new Promise<void>((resolve) => { this.wakeups.add(resolve) })
    }
  }

  nextMethod(method: string): Promise<JsonObject> {
    return this.next(frame => frame.method === method)
  }

  nextResponse(id: unknown): Promise<JsonObject> {
    return this.next(frame => frame.id === id && frame.method === undefined)
  }

  send(...frames: readonly JsonObject[]): void {
    this.output.write(`${frames.map(frame => JSON.stringify(frame)).join('\n')}\n`)
  }

  respond(requestFrame: JsonObject, result: unknown): void {
    this.send({ id: requestFrame.id, result })
  }
}

interface FakeChildOptions {
  readonly pid?: number
  readonly exitOnTerminate?: boolean
  readonly doneError?: Error
}

interface FakeChild {
  readonly handle: SubprocessHandle
  readonly peer: ProtocolPeer
  readonly fromChild: PassThrough
  readonly toChild: PassThrough
  readonly settle: (outcome?: SubprocessOutcome) => void
  readonly fail: (error: Error) => void
  readonly terminate: () => void
  readonly waitForExit: (signal?: AbortSignal) => Promise<boolean>
}

function fakeChild(options: FakeChildOptions = {}): FakeChild {
  const fromChild = new PassThrough()
  const toChild = new PassThrough()
  const peer = new ProtocolPeer(toChild, fromChild)
  let exited = false
  let resolveDone!: (outcome: SubprocessOutcome) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  const settle = (
    outcome: SubprocessOutcome = { exitCode: 0, signal: null },
  ): void => {
    if (exited) return
    exited = true
    resolveDone(outcome)
  }
  const fail = (error: Error): void => {
    if (exited) return
    exited = true
    rejectDone(error)
  }
  if (options.doneError !== undefined) fail(options.doneError)
  const terminate = vi.fn(() => {
    if (options.exitOnTerminate !== false) settle()
  })
  const waitForExit = vi.fn(async (signal?: AbortSignal) => {
    if (exited) return true
    if (signal === undefined) {
      await done.catch(() => {})
      return true
    }
    return await new Promise<boolean>((resolve) => {
      const onAbort = (): void => { resolve(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void done.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve(true)
        },
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve(true)
        },
      )
    })
  })
  const handle: SubprocessHandle = {
    pid: options.pid ?? 1234,
    stdin: toChild,
    stdout: fromChild,
    stderr: undefined,
    collected: {},
    done,
    terminate,
    waitForExit,
  }
  return {
    handle,
    peer,
    fromChild,
    toChild,
    settle,
    fail,
    terminate,
    waitForExit,
  }
}

function runSpec(
  child: FakeChild,
  overrides: Partial<CodexRunSpec> = {},
): CodexRunSpec {
  return {
    cwd: process.cwd(),
    env: {},
    disposeGraceMs: DEFAULT_DISPOSE_GRACE_MS,
    spawn: () => child.handle,
    ...overrides,
  }
}

async function initializeWire(approvalBehavior: 'decline' | 'require' = 'decline'): Promise<{
  readonly child: FakeChild
  readonly wire: CodexAppServerWire
}> {
  const child = fakeChild()
  const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!, approvalBehavior)
  wire.start()
  const initializing = wire.initialize(new AbortController().signal)
  const initialize = await child.peer.nextMethod('initialize')
  child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
  await initializing
  expect(await child.peer.nextMethod('initialized')).toEqual({
    jsonrpc: '2.0',
    method: 'initialized',
  })
  const starting = wire.startThread(process.cwd(), new AbortController().signal)
  const threadStart = await child.peer.nextMethod('thread/start')
  child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
  await starting
  return { child, wire }
}

async function publishRun(
  child = fakeChild(),
  signal = new AbortController().signal,
  specOverrides: Partial<CodexRunSpec> = {},
) {
  const starting = startCodexRun(request(undefined, signal), runSpec(child, specOverrides))
  const initialize = await child.peer.nextMethod('initialize')
  child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
  await child.peer.nextMethod('initialized')
  const threadStart = await child.peer.nextMethod('thread/start')
  child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
  const run = await starting
  const turnStart = await child.peer.nextMethod('turn/start')
  return { child, run, turnStart }
}

function agentMessage(
  text: unknown,
  phase: unknown,
  turnId = 'turn-1',
  threadId = 'thread-1',
): JsonObject {
  return {
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: { type: 'agentMessage', text, phase },
    },
  }
}

function turnCompleted(
  status: unknown,
  turnId = 'turn-1',
  threadId = 'thread-1',
  error: unknown = null,
): JsonObject {
  return {
    method: 'turn/completed',
    params: {
      threadId,
      turn: { id: turnId, status, error },
    },
  }
}

describe('task admission and package contracts', () => {
  it('resolves the fixed app-server command through the Windows npm shim boundary', () => {
    expect(codexAppServerArgv('win32')).toEqual([
      'cmd.exe',
      '/d',
      '/s',
      '/c',
      'codex',
      'app-server',
      '--stdio',
    ])
    expect(codexAppServerArgv('linux')).toEqual(['codex', 'app-server', '--stdio'])
  })

  it('accepts one or more text blocks and rejects empty or non-text tasks', () => {
    expect(textTask([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ])).toEqual(['one', 'two'])
    expect(() => textTask([])).toThrow('only text blocks')
    expect(() => textTask([{ type: 'reasoning', text: 'hidden' }]))
      .toThrow('only text blocks')
    expect(() => textTask([{ type: 'text', text: ' \n ' }]))
      .toThrow('must not be empty')
  })

  it('registers one fixed descriptor, validates config, and unregisters on HMR', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const fiber = await ctx.plugin(codex, {})
    const provider = ctx.subagents.getProvider('codex')!
    expect(provider).toMatchObject({
      name: 'codex',
      authentication: { mode: 'native-subscription' },
      capabilities: {
        outputSchema: false,
        depthLimit: false,
        toolFilter: false,
        persona: false,
      },
      inheritsParentContext: false,
    })
    expect(ctx.subagents.list()).toEqual(['codex'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])

    const explicitFiber = await ctx.plugin(codex, {
      env: { OPENAI_API_KEY: 'test-only-key' },
    })
    expect(ctx.subagents.getProvider('codex')).toMatchObject({
      authentication: { mode: 'explicit-environment' },
    })
    await explicitFiber.dispose()

    for (const disposeGraceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(ctx.plugin(codex, { disposeGraceMs }))
        .rejects.toThrow('disposeGraceMs must be a positive finite number')
    }
    await expect(ctx.plugin(codex, { disposeGraceMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(`disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
    await ctx.fiber.dispose()
  })

  it('requires a parent session cwd without suggesting unsupported config', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const spawn = vi.spyOn(ctx.subprocess, 'spawn')
    await ctx.plugin(codex, {})

    await expect(ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: {
        id: 'parent-without-cwd',
        session: { header: {} },
      } as unknown as Agent,
      signal: new AbortController().signal,
    })).rejects.toThrow(
      'subagent-codex: no working directory for the child — delegate from a parent session that has one',
    )
    expect(spawn).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('keeps the namespace export shape and package-owned empty invariant', async () => {
    expect('default' in codex).toBe(false)
    expect(codex.name).toBe('subagent-codex')
    expect(codex.inject).toEqual(['subagents', 'subprocess'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(codex)).toBe(codex)

    const dispose = vi.fn()
    const register = vi.fn((
      _packageName: string,
      _installer: InvariantInstaller,
    ) => dispose)
    const ctx = { invariants: { register } } as unknown as Context
    await expect(invariant.apply(ctx)).resolves.toBe(dispose)
    expect(register).toHaveBeenCalledWith(
      '@deepseek-ai/dsh-subagent-codex',
      expect.any(Function),
    )
    const install = register.mock.calls[0]![1]
    await install(new Context(), (message) => { throw new Error(message) })
    expect(invariant.name).toBe('subagent-codex-invariant')
    expect(invariant.inject).toEqual(['invariants'])
  })
})

describe('CodexAppServerWire', () => {
  it('sends the fixed handshake, thread, and turn payloads and keeps final_answer', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    expect(wire.collectOutput()).toEqual([])
    wire.start()

    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    expect(initialize.params).toEqual({
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
      },
    })
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await initializing
    await child.peer.nextMethod('initialized')

    const starting = wire.startThread('/workspace', new AbortController().signal)
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({ cwd: '/workspace', ephemeral: true })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    await starting

    const result = wire.runTurn(
      ['first', 'second'],
      new AbortController().signal,
    )
    const turnStart = await child.peer.nextMethod('turn/start')
    expect(turnStart.params).toEqual({
      threadId: 'thread-1',
      input: [
        { type: 'text', text: 'first', text_elements: [] },
        { type: 'text', text: 'second', text_elements: [] },
      ],
    })
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
      },
      agentMessage('other thread', 'final_answer', 'turn-1', 'thread-2'),
      agentMessage('other turn', 'final_answer', 'turn-2'),
      {
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'reasoning', text: 'not output' },
        },
      },
      agentMessage('commentary', 'commentary'),
      agentMessage('unphased', null),
      agentMessage('first final', 'final_answer'),
      agentMessage('last final', 'final_answer'),
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1', turnId: 'turn-1',
          tokenUsage: {
            total: {
              totalTokens: 180, inputTokens: 150, cachedInputTokens: 90,
              cacheWriteInputTokens: 3, outputTokens: 30, reasoningOutputTokens: 10,
            },
            last: {
              totalTokens: 48, inputTokens: 40, cachedInputTokens: 12,
              cacheWriteInputTokens: 2, outputTokens: 8, reasoningOutputTokens: 3,
            },
            modelContextWindow: 258_400,
          },
        },
      },
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'last final' }],
      stopReason: 'completed',
      usage: {
        inputTokens: 28,
        outputTokens: 8,
        cacheReadInputTokens: 12,
        cacheWriteInputTokens: 2,
      },
    })
    expect(wire.collectOutput()).toEqual([{ type: 'text', text: 'last final' }])
    wire.close()
    wire.close()
  })

  it('keeps an early item when turn/start response follows turn notifications', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      agentMessage('early final', 'final_answer'),
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'early final' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('queues the terminal notification until turn/start establishes its id', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } },
      agentMessage('terminal-ordered final', 'final_answer'),
      turnCompleted('completed'),
    )
    await nextTask()
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'terminal-ordered final' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('keeps a late item before the authoritative terminal notification', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(agentMessage('late final', 'final_answer'))
    child.peer.send(turnCompleted('completed'))
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'late final' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('keeps final_answer precedence over a later unphased message', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      agentMessage('explicit final', 'final_answer'),
      agentMessage('unphased fallback', null),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'explicit final' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('rejects a completed turn that has commentary but no public answer', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(agentMessage('progress only', 'commentary'), turnCompleted('completed'))
    await expect(result).rejects.toThrow('without a final answer')
    wire.close()
  })

  it('resets output and turn association state for consecutive turns', async () => {
    const { child, wire } = await initializeWire()
    const first = wire.runTurn(['first task'], new AbortController().signal)
    const firstStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(firstStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      agentMessage('first final', 'final_answer'),
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: { last: { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 } },
        },
      },
      turnCompleted('completed'),
    )
    await expect(first).resolves.toEqual({
      output: [{ type: 'text', text: 'first final' }],
      stopReason: 'completed',
      usage: {
        inputTokens: 2,
        outputTokens: 2,
        cacheReadInputTokens: 1,
        cacheWriteInputTokens: 0,
      },
    })

    const second = wire.runTurn(['second task'], new AbortController().signal)
    const secondStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(secondStart, { turn: { id: 'turn-2' } })
    await nextTask()
    expect(wire.currentTurnId).toBe('turn-2')
    child.peer.send(agentMessage('second unphased', null, 'turn-2'), turnCompleted('completed', 'turn-2'))
    await nextTask()
    expect(wire.collectOutput()).toEqual([{ type: 'text', text: 'second unphased' }])
    await expect(second).resolves.toEqual({
      output: [{ type: 'text', text: 'second unphased' }],
      stopReason: 'completed',
    })
    expect(wire.currentTurnId).toBe('turn-2')
    wire.close()
  })

  it('normalizes only public text, tool lifecycle, approval, and usage for Resident trace observers', async () => {
    const child = fakeChild()
    const observations: unknown[] = []
    const wire = new CodexAppServerWire(
      child.handle.stdout!, child.handle.stdin!, 'decline', [], undefined,
      (observation) => { observations.push(observation) },
    )
    wire.start()
    const initializing = wire.initialize(new AbortController().signal)
    child.peer.respond(await child.peer.nextMethod('initialize'), { userAgent: 'codex-cli 0.151.0' })
    await initializing
    await child.peer.nextMethod('initialized')
    const starting = wire.startThread('/workspace', new AbortController().signal, false)
    child.peer.respond(await child.peer.nextMethod('thread/start'), { thread: { id: 'thread-1', ephemeral: false } })
    await starting
    const result = wire.runTurn(['trace task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', command: 'cat .env' } } },
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', aggregatedOutput: 'DATABASE_PASSWORD=never-persist-this' } } },
      agentMessage('Visible implementation update.', 'commentary'),
      { method: 'thread/tokenUsage/updated', params: {
        threadId: 'thread-1', turnId: 'turn-1', tokenUsage: { last: { inputTokens: 8, cachedInputTokens: 3, outputTokens: 2 } },
      } },
      { id: 'approval', method: 'item/fileChange/requestApproval', params: {
        threadId: 'thread-1', turnId: 'turn-1', availableDecisions: ['decline'],
      } },
    )
    await child.peer.nextResponse('approval')
    child.peer.send(agentMessage('Final answer.', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(observations).toEqual([
      { kind: 'tool-started', toolName: 'commandExecution' },
      { kind: 'tool-completed', toolName: 'commandExecution' },
      { kind: 'public-output', preview: 'Visible implementation update.' },
      { kind: 'usage-updated', usage: { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 3, cacheWriteInputTokens: 0 } },
      { kind: 'approval-required', approvalKind: 'item/fileChange/requestApproval' },
      { kind: 'public-output', preview: 'Final answer.' },
    ])
    expect(JSON.stringify(observations)).not.toContain('DATABASE_PASSWORD')
    wire.close()
  })

  it('registers experimental dynamic tools and returns host tool results to the active turn', async () => {
    const child = fakeChild()
    const tools = [{
      type: 'function' as const,
      name: 'typescript_repl',
      description: 'Execute one persistent TypeScript cell',
      inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    }]
    const handler = vi.fn(async () => ({ success: true, text: '{"value":42}' }))
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!, 'require', tools, handler)
    wire.start()
    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    expect(initialize.params).toMatchObject({ capabilities: { experimentalApi: true } })
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await initializing
    await child.peer.nextMethod('initialized')

    const starting = wire.startThread('/workspace', new AbortController().signal, false)
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({ cwd: '/workspace', ephemeral: false, dynamicTools: tools })
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: false } })
    await starting

    const result = wire.runTurn(['use the repl'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send({
      id: 'tool-request-1',
      method: 'item/tool/call',
      params: {
        threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', namespace: null,
        tool: 'typescript_repl', arguments: { code: '40 + 2' },
      },
    })
    expect(await child.peer.nextResponse('tool-request-1')).toEqual({
      jsonrpc: '2.0',
      id: 'tool-request-1',
      result: { success: true, contentItems: [{ type: 'inputText', text: '{"value":42}' }] },
    })
    expect(handler).toHaveBeenCalledWith({
      threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1',
      tool: 'typescript_repl', arguments: { code: '40 + 2' },
    })
    child.peer.send(agentMessage('done', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
  })

  it('reads the native model catalog and sends explicit model and effort overrides', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await initializing
    await child.peer.nextMethod('initialized')

    const listing = wire.listModels(new AbortController().signal)
    const modelList = await child.peer.nextMethod('model/list')
    expect(modelList.params).toEqual({ limit: 100, includeHidden: false })
    child.peer.respond(modelList, {
      data: [{
        id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test', description: 'Fixture',
        hidden: false, isDefault: true, defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
      }],
    })
    await expect(listing).resolves.toEqual([expect.objectContaining({ model: 'gpt-test', isDefault: true })])

    const profile = { model: 'gpt-test', effort: 'medium' }
    const starting = wire.startThread('/workspace', new AbortController().signal, false, profile, 'DSH system')
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: '/workspace', ephemeral: false, model: 'gpt-test', developerInstructions: 'DSH system',
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-profile', ephemeral: false } })
    await starting

    const result = wire.runTurn(['task'], new AbortController().signal, undefined, profile)
    const turnStart = await child.peer.nextMethod('turn/start')
    expect(turnStart.params).toMatchObject({
      threadId: 'thread-profile',
      model: 'gpt-test',
      effort: 'medium',
    })
    child.peer.respond(turnStart, { turn: { id: 'turn-profile' } })
    child.peer.send(
      agentMessage('profile result', 'final_answer', 'turn-profile', 'thread-profile'),
      turnCompleted('completed', 'turn-profile', 'thread-profile'),
    )
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
  })

  it('compacts one resumed persistent thread in place through thread/compact/start', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    wire.start()
    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await initializing
    await child.peer.nextMethod('initialized')

    const resuming = wire.resumeThread(
      'thread-persistent', '/workspace', new AbortController().signal, undefined, 'DSH resumed system',
      { approval: 'never', nativeEffects: 'read-only', environmentAccess: 'disabled' },
    )
    const threadResume = await child.peer.nextMethod('thread/resume')
    expect(threadResume.params).toEqual({
      threadId: 'thread-persistent', cwd: '/workspace', developerInstructions: 'DSH resumed system',
      approvalPolicy: 'never', sandbox: 'read-only',
    })
    child.peer.respond(threadResume, { thread: { id: 'thread-persistent', ephemeral: false } })
    await resuming
    const compacting = wire.compactThread(new AbortController().signal)
    const compact = await child.peer.nextMethod('thread/compact/start')
    expect(compact.params).toEqual({ threadId: 'thread-persistent' })
    child.peer.respond(compact, {})
    await compacting
    expect(wire.currentThreadId).toBe('thread-persistent')
    wire.close()
  })

  it('seals the DSH tool execution boundary at thread and turn start', async () => {
    const child = fakeChild()
    const tools = [{
      type: 'function' as const,
      name: 'Bash',
      description: 'Run through DSH.',
      inputSchema: { type: 'object' },
    }]
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!, 'decline', tools)
    wire.start()
    const initializing = wire.initialize(new AbortController().signal)
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.151.0' })
    await initializing
    await child.peer.nextMethod('initialized')

    const boundary = {
      approval: 'never' as const,
      nativeEffects: 'read-only' as const,
      environmentAccess: 'disabled' as const,
    }
    const starting = wire.startThread(
      '/workspace', new AbortController().signal, false, undefined, 'DSH authority', boundary,
    )
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(threadStart.params).toEqual({
      cwd: '/workspace', ephemeral: false, developerInstructions: 'DSH authority', dynamicTools: tools,
      approvalPolicy: 'never', sandbox: 'read-only', environments: [],
    })
    child.peer.respond(threadStart, { thread: { id: 'thread-dsh-tools', ephemeral: false } })
    await starting

    const result = wire.runTurn(['task'], new AbortController().signal, undefined, undefined, boundary)
    const turnStart = await child.peer.nextMethod('turn/start')
    expect(turnStart.params).toMatchObject({
      threadId: 'thread-dsh-tools',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      environments: [],
    })
    expect(turnStart.params).not.toHaveProperty('sandbox')
    child.peer.respond(turnStart, { turn: { id: 'turn-dsh-tools' } })
    child.peer.send(
      agentMessage('done', 'final_answer', 'turn-dsh-tools', 'thread-dsh-tools'),
      turnCompleted('completed', 'turn-dsh-tools', 'thread-dsh-tools'),
    )
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
  })

  it('uses the last nullable-phase answer when no explicit final exists', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      agentMessage('first', null),
      agentMessage('fallback', null),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'fallback' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('maps only an explicit context-window failure to max-tokens', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(
      agentMessage('partial answer', null),
      turnCompleted('failed', 'turn-1', 'thread-1', {
        message: 'too much context',
        codexErrorInfo: 'contextWindowExceeded',
      }),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'partial answer' }],
      stopReason: 'max-tokens',
    })
    wire.close()
  })

  it('rejects invalid handshake, thread, and turn response shapes', async () => {
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      const frame = await child.peer.nextMethod('initialize')
      child.peer.respond(frame, null)
      await expect(pending).rejects.toThrow('invalid initialize response')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.startThread('/workspace', new AbortController().signal)
      const frame = await child.peer.nextMethod('thread/start')
      child.peer.respond(frame, { thread: { id: 'thread-1', ephemeral: false } })
      await expect(pending).rejects.toThrow('did not create an ephemeral thread')
      wire.close()
    }
    {
      const { child, wire } = await initializeWire()
      const pending = wire.runTurn(['task'], new AbortController().signal)
      const frame = await child.peer.nextMethod('turn/start')
      child.peer.respond(frame, { turn: { id: '' } })
      await expect(pending).rejects.toThrow('turn/start turn id')
      wire.close()
    }
  })

  it('fails closed for empty output, malformed messages, phases, and terminal status', async () => {
    const scenarios: Array<{
      readonly frames: JsonObject[]
      readonly message: string
    }> = [
      {
        frames: [turnCompleted('completed')],
        message: 'without a final answer',
      },
      {
        frames: [
          agentMessage('fallback', null),
          agentMessage(' \n ', 'final_answer'),
          turnCompleted('completed'),
        ],
        message: 'without a final answer',
      },
      {
        frames: [agentMessage(42, 'final_answer')],
        message: 'invalid agent message',
      },
      {
        frames: [agentMessage('answer', 'future_phase')],
        message: 'unknown agent message phase',
      },
      {
        frames: [turnCompleted('failed', 'turn-1', 'thread-1', { message: 'no' })],
        message: 'status failed',
      },
      {
        frames: [turnCompleted('interrupted')],
        message: 'status interrupted',
      },
      {
        frames: [turnCompleted('inProgress')],
        message: 'invalid terminal turn status',
      },
    ]
    for (const scenario of scenarios) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.peer.send(...scenario.frames)
      await expect(result).rejects.toThrow(scenario.message)
      wire.close()
    }
  })

  it('fails closed when terminal notification params are not an object', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send({ method: 'turn/completed', params: null })
    await expect(result).rejects.toThrow('invalid turn/completed thread id')
    wire.close()
  })

  it('keeps an unsupported request authoritative over an early terminal in the same chunk', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      { id: 'future-request', method: 'future/request', params: {} },
      agentMessage('early answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).rejects.toThrow('unsupported app-server request')
    wire.close()
  })

  it('answers all five unattended request classes without granting authority', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')

    child.peer.send({
      id: 'command',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['decline', 'cancel'],
      },
    })
    // A request that arrives before the turn/start response waits for it, so the run knows its own turn first.
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    expect(await child.peer.nextResponse('command')).toMatchObject({
      result: { decision: 'cancel' },
    })
    await nextTask()
    const requests = [
      {
        id: 'file',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['decline'],
        },
        result: { decision: 'decline' },
      },
      {
        id: 'file-default',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        result: { decision: 'decline' },
      },
      {
        id: 'permissions',
        method: 'item/permissions/requestApproval',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
        result: { permissions: {}, scope: 'turn' },
      },
      {
        id: 'user-input',
        method: 'item/tool/requestUserInput',
        params: { threadId: 'thread-1', turnId: 'turn-1', questions: [] },
        result: { answers: {} },
      },
      {
        id: 'mcp',
        method: 'mcpServer/elicitation/request',
        params: { threadId: 'thread-1', turnId: null },
        result: { action: 'decline', content: null, _meta: null },
      },
    ] as const
    for (const serverRequest of requests) {
      child.peer.send(serverRequest)
      expect(await child.peer.nextResponse(serverRequest.id)).toMatchObject({
        result: serverRequest.result,
      })
    }

    child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
  })

  it('fails loud on native approval requests when a Resident caller requires out-of-band approval', async () => {
    const { child, wire } = await initializeWire('require')
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send({
      id: 'approval',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        availableDecisions: ['decline', 'cancel'],
      },
    })
    expect(await child.peer.nextResponse('approval')).toMatchObject({
      result: { decision: 'cancel' },
    })
    await expect(result).rejects.toMatchObject({
      name: 'CodexApprovalRequiredError',
      method: 'item/commandExecution/requestApproval',
    })
    wire.close()
  })

  it('fails the run on unknown requests or wrong request association', async () => {
    for (const serverRequest of [
      {
        id: 'unknown',
        method: 'future/request',
        params: { threadId: 'thread-1', turnId: 'turn-1' },
      },
      {
        id: 'approval',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: ['accept'],
        },
      },
      {
        id: 'malformed-approval',
        method: 'item/fileChange/requestApproval',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          availableDecisions: 'decline',
        },
      },
      {
        id: 'thread',
        method: 'item/fileChange/requestApproval',
        params: { threadId: 'thread-2', turnId: 'turn-1' },
      },
    ]) {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      await nextTask()
      child.peer.send(serverRequest)
      const response = await child.peer.nextResponse(serverRequest.id)
      expect(response.error).toMatchObject({ code: -32603 })
      await expect(result).rejects.toThrow()
      wire.close()
    }
  })

  it('reads only the responded turn when the app-server reports other turns of the thread before the response', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    // An unfinished turn of an earlier process and a turn the server started itself, both before the response.
    child.peer.send(
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-stale' } } },
      agentMessage('stale output', 'final_answer', 'turn-stale'),
      turnCompleted('interrupted', 'turn-stale'),
      { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-internal' } } },
      agentMessage('internal output', 'final_answer', 'turn-internal'),
      agentMessage('early output', 'commentary', 'turn-response'),
    )
    child.peer.respond(turnStart, { turn: { id: 'turn-response' } })
    child.peer.send(agentMessage('the answer', 'final_answer', 'turn-response'), turnCompleted('completed', 'turn-response'))
    await expect(result).resolves.toMatchObject({ output: [{ type: 'text', text: 'the answer' }], stopReason: 'completed' })
    expect(wire.currentTurnId).toBe('turn-response')
    wire.close()
  })

  it('takes the terminal notification of the responded turn when it arrives before the response, and not another turn\'s', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      turnCompleted('failed', 'turn-stale'),
      agentMessage('the answer', 'final_answer', 'turn-response'),
      turnCompleted('completed', 'turn-response'),
    )
    child.peer.respond(turnStart, { turn: { id: 'turn-response' } })
    await expect(result).resolves.toMatchObject({ output: [{ type: 'text', text: 'the answer' }], stopReason: 'completed' })
    wire.close()
  })

  it('refuses a request that names a turn before any turn is started', async () => {
    const { child, wire } = await initializeWire()
    child.peer.send({ id: 'too-early', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } })
    expect((await child.peer.nextResponse('too-early')).error).toMatchObject({ code: -32603 })
    wire.close()
  })

  it('holds a tool call or approval that arrives before the response and answers it only for the responded turn', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: 'ours', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1' } },
      { id: 'foreign', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-stale' } },
    )
    await nextTask()
    // Neither is answered before the run knows its turn.
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    expect(await child.peer.nextResponse('ours')).toMatchObject({ result: { decision: 'decline' } })
    // The foreign turn's request is rejected without failing the run.
    expect((await child.peer.nextResponse('foreign')).error).toMatchObject({ code: -32603 })
    child.peer.send(agentMessage('the answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ output: [{ type: 'text', text: 'the answer' }], stopReason: 'completed' })
    wire.close()
  })

  it('rejects a request for another turn after the response without failing the run', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send({ id: 'foreign', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-2' } })
    expect((await child.peer.nextResponse('foreign')).error).toMatchObject({ code: -32603 })
    child.peer.send(agentMessage('the answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
  })

  it('counts usage only from the responded turn when old and new usage notifications interleave', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    const usage = (turnId: string, total: number) => ({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1', turnId,
        tokenUsage: {
          last: { inputTokens: total, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: total + 1 },
          total: {},
        },
      },
    })
    child.peer.send(usage('turn-stale', 111), usage('turn-1', 7))
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    child.peer.send(usage('turn-stale', 222), agentMessage('the answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ usage: { inputTokens: 7 } })
    wire.close()
  })

  it('reports a start whose response never came as unknown, with the frames in receive order and no task text', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['secret task text'], new AbortController().signal)
    await child.peer.nextMethod('turn/start')
    child.peer.send(
      { method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-9', tokenUsage: { last: {}, total: {} } } },
      { id: 'tool', method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-9', tool: 't', callId: 'c', arguments: {} } },
    )
    await nextTask()
    child.fromChild.end()
    const error = await result.then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(CodexTurnStartUncertainError)
    const uncertain = error as CodexTurnStartUncertainError
    expect(uncertain.threadId).toBe('thread-1')
    expect(uncertain.frames.map(frame => [frame.order, frame.kind, frame.method, frame.turnId])).toEqual([
      [1, 'notification', 'thread/tokenUsage/updated', 'turn-9'],
      [2, 'request', 'item/tool/call', 'turn-9'],
    ])
    expect(uncertain.message).toContain('#1 notification thread/tokenUsage/updated turn=turn-9')
    expect(uncertain.message).not.toContain('secret task text')
    wire.close()
  })

  it('keeps the turn id a valid response named when reading the notifications before it fails, and tells that apart from no response', async () => {
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      // A terminal notification of the turn the response will name, with a status the wire cannot accept.
      child.peer.send(turnCompleted('bogus', 'turn-1'))
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      const error = await result.then(() => undefined, (caught: unknown) => caught) as CodexTurnStartUncertainError
      expect(error).toBeInstanceOf(CodexTurnStartUncertainError)
      expect(error.startedTurnId).toBe('turn-1')
      expect(error.message).toContain('the response named turn turn-1')
      expect(error.message).toContain('invalid terminal turn status')
      // The notification that could not be read is in the frames, with the turn id it named.
      expect(error.frames.map(frame => [frame.kind, frame.method, frame.turnId])).toEqual([
        ['notification', 'turn/completed', 'turn-1'], ['response', 'turn/start', 'turn-1'],
      ])
      wire.close()
    }
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      await child.peer.nextMethod('turn/start')
      child.fromChild.end()
      const error = await result.then(() => undefined, (caught: unknown) => caught) as CodexTurnStartUncertainError
      expect(error.startedTurnId).toBeUndefined()
      expect(error.message).not.toContain('the response named')
      wire.close()
    }
  })

  it('reads the status of one turn by id among the thread\'s newest', async () => {
    const { child, wire } = await initializeWire()
    const status = wire.turnStatus('turn-b', new AbortController().signal)
    const list = await child.peer.nextMethod('thread/turns/list')
    expect(list.params).toEqual({ threadId: 'thread-1', limit: 20, sortDirection: 'desc' })
    child.peer.respond(list, { data: [{ id: 'turn-c', status: 'completed' }, { id: 'turn-b', status: 'inProgress' }] })
    await expect(status).resolves.toBe('inProgress')
    const missing = wire.turnStatus('turn-z', new AbortController().signal)
    child.peer.respond(await child.peer.nextMethod('thread/turns/list'), { data: [{ id: 'turn-c', status: 'completed' }] })
    await expect(missing).resolves.toBeUndefined()
    wire.close()
  })

  it('treats a server refusal of turn/start as not started, and an aborted signal as no request at all', async () => {
    {
      const { child, wire } = await initializeWire()
      const result = wire.runTurn(['task'], new AbortController().signal)
      const turnStart = await child.peer.nextMethod('turn/start')
      child.peer.send({ id: turnStart.id, error: { code: -32000, message: 'thread is busy' } })
      const error = await result.then(() => undefined, (caught: unknown) => caught)
      expect(error).not.toBeInstanceOf(CodexTurnStartUncertainError)
      expect((error as Error).message).toContain('thread is busy')
      wire.close()
    }
    {
      const { wire } = await initializeWire()
      const controller = new AbortController()
      controller.abort(new Error('stopped before start'))
      await expect(wire.runTurn(['task'], controller.signal)).rejects.toThrow('stopped before start')
      wire.close()
    }
  })

  it('reports a start aborted after it was sent as unknown, because the turn may be running', async () => {
    const { child, wire } = await initializeWire()
    const controller = new AbortController()
    const result = wire.runTurn(['task'], controller.signal)
    await child.peer.nextMethod('turn/start')
    controller.abort(new Error('interrupted'))
    await expect(result).rejects.toBeInstanceOf(CodexTurnStartUncertainError)
    wire.close()
  })

  it('reports a malformed turn/start response as unknown', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: {} })
    await expect(result).rejects.toBeInstanceOf(CodexTurnStartUncertainError)
    wire.close()
  })

  it('stops holding notifications when too many arrive before the response, and reports the start as unknown', async () => {
    const { child, wire } = await initializeWire()
    const result = wire.runTurn(['task'], new AbortController().signal)
    await child.peer.nextMethod('turn/start')
    const flood = Array.from({ length: 513 }, () => agentMessage('x', 'commentary', 'turn-stale'))
    child.peer.send(...flood)
    const error = await result.then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(CodexTurnStartUncertainError)
    expect((error as Error).message).toContain('too many notifications')
    // The diagnostic keeps only the most recent frames.
    expect((error as CodexTurnStartUncertainError).frames).toHaveLength(64)
    wire.close()
  })

  it('reads the newest turn, keeps the baseline for an unknown start, and interrupts a turn it did not start', async () => {
    const { child, wire } = await initializeWire()
    const capturing = wire.captureBaseline(new AbortController().signal)
    const first = await child.peer.nextMethod('thread/turns/list')
    expect(first.params).toEqual({ threadId: 'thread-1', limit: 1, sortDirection: 'desc' })
    child.peer.respond(first, { data: [{ id: 'turn-old', status: 'completed' }], nextCursor: null, backwardsCursor: null })
    await capturing
    const latest = wire.latestTurn(new AbortController().signal)
    child.peer.respond(await child.peer.nextMethod('thread/turns/list'), { data: [{ id: 'turn-new', status: 'inProgress' }] })
    await expect(latest).resolves.toEqual({ id: 'turn-new', status: 'inProgress' })
    const empty = wire.latestTurn(new AbortController().signal)
    child.peer.respond(await child.peer.nextMethod('thread/turns/list'), { data: [] })
    await expect(empty).resolves.toBeUndefined()
    const bad = wire.latestTurn(new AbortController().signal)
    child.peer.respond(await child.peer.nextMethod('thread/turns/list'), { data: 'nope' })
    await expect(bad).rejects.toThrow('invalid thread/turns/list data')
    for (const status of ['aborted', 'COMPLETED', '']) {
      const unknown = wire.latestTurn(new AbortController().signal)
      child.peer.respond(await child.peer.nextMethod('thread/turns/list'), { data: [{ id: 'turn-x', status }] })
      await expect(unknown).rejects.toThrow('invalid thread/turns/list turn status')
    }
    for (const status of ['completed', 'interrupted', 'failed', 'inProgress']) {
      const legal = wire.latestTurn(new AbortController().signal)
      child.peer.respond(await child.peer.nextMethod('thread/turns/list'), { data: [{ id: 'turn-x', status }] })
      await expect(legal).resolves.toEqual({ id: 'turn-x', status })
    }

    const running = wire.runTurn(['task'], new AbortController().signal)
    await child.peer.nextMethod('turn/start')
    child.fromChild.end()
    expect((await running.then(() => undefined, (caught: unknown) => caught) as CodexTurnStartUncertainError).baselineTurnId).toBe('turn-old')

    const { child: other, wire: second } = await initializeWire()
    second.interruptTurn('turn-x')
    expect((await other.peer.nextMethod('turn/interrupt')).params).toEqual({ threadId: 'thread-1', turnId: 'turn-x' })
    wire.close()
    second.close()
  })

  it('leaves the baseline unknown when the thread cannot be listed', async () => {
    const { child, wire } = await initializeWire()
    const capturing = wire.captureBaseline(new AbortController().signal)
    const list = await child.peer.nextMethod('thread/turns/list')
    child.peer.send({ id: list.id, error: { code: -32601, message: 'method not found' } })
    await capturing
    const result = wire.runTurn(['task'], new AbortController().signal)
    await child.peer.nextMethod('turn/start')
    child.fromChild.end()
    const unknownStart = await result.then(() => undefined, (caught: unknown) => caught) as CodexTurnStartUncertainError
    expect(unknownStart.baselineTurnId).toBeUndefined()
    wire.close()
  })

  it('interrupts only an active open turn and contains remote interrupt failure', async () => {
    const { child, wire } = await initializeWire()
    wire.interrupt()
    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    wire.interrupt()
    const interrupt = await child.peer.nextMethod('turn/interrupt')
    expect(interrupt.params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
    child.peer.send({
      id: interrupt.id,
      error: { code: -32000, message: 'already done' },
    })
    child.peer.send(agentMessage('answer', 'final_answer'), turnCompleted('completed'))
    await expect(result).resolves.toMatchObject({ stopReason: 'completed' })
    wire.close()
    wire.interrupt()
  })

  it('ignores unrelated and out-of-window notifications', async () => {
    const { child, wire } = await initializeWire()
    child.peer.send(
      {
        method: 'turn/started',
        params: { threadId: 'thread-2', turn: { id: 'turn-other' } },
      },
      {
        method: 'turn/started',
        params: { threadId: 'thread-1', turn: { id: 'turn-before' } },
      },
      agentMessage('before', 'final_answer'),
      { method: 'future/notification', params: {} },
      turnCompleted('completed'),
      turnCompleted('completed', 'turn-other', 'thread-2'),
    )
    await nextTask()

    const result = wire.runTurn(['task'], new AbortController().signal)
    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    child.peer.send(
      agentMessage('wrong turn', 'final_answer', 'turn-2'),
      turnCompleted('completed', 'turn-2'),
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    wire.close()
  })

  it('rejects pending work on abort, EOF, and stream error', async () => {
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const controller = new AbortController()
      controller.abort('pre-aborted')
      await expect(wire.initialize(controller.signal))
        .rejects.toThrow('app-server request aborted: pre-aborted')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const controller = new AbortController()
      const pending = wire.initialize(controller.signal)
      await child.peer.nextMethod('initialize')
      controller.abort(new Error('cancel initialize'))
      await expect(pending).rejects.toThrow('cancel initialize')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.fromChild.end()
      await expect(pending).rejects.toThrow(/(?:protocol stream|JSON-RPC input) closed/)
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.fromChild.emit('error', new Error('stdout broke'))
      await expect(pending).rejects.toThrow('stdout broke')
      wire.close()
    }
    {
      const child = fakeChild()
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      wire.start()
      const pending = wire.initialize(new AbortController().signal)
      await child.peer.nextMethod('initialize')
      child.toChild.emit('error', new Error('stdin broke'))
      await expect(pending).rejects.toThrow('stdin broke')
      wire.close()
      child.toChild.emit('error', new Error('late stdin close'))
    }
  })
})

describe('run lifecycle and quiescence', () => {
  it('spawns the fixed app-server, publishes after thread creation, and disposes once', async () => {
    const child = fakeChild()
    const spawn = vi.fn(() => child.handle)
    const starting = startCodexRun(
      request([{ type: 'text', text: 'task' }]),
      runSpec(child, { env: { OPENAI_API_KEY: 'fake' }, spawn }),
    )
    let published = false
    void starting.then(() => { published = true })
    const initialize = await child.peer.nextMethod('initialize')
    expect(published).toBe(false)
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    expect(published).toBe(false)
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    const run = await starting
    expect(spawn).toHaveBeenCalledWith({
      argv: codexAppServerArgv(),
      cwd: process.cwd(),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
      graceMs: DEFAULT_DISPOSE_GRACE_MS,
      env: { OPENAI_API_KEY: 'fake' },
    })
    expect(run.localAgent).toBeUndefined()

    const turnStart = await child.peer.nextMethod('turn/start')
    child.peer.send(
      { id: turnStart.id, result: { turn: { id: 'turn-1' } } },
      agentMessage('answer', 'final_answer'),
      turnCompleted('completed'),
    )
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'answer' }],
      stopReason: 'completed',
    })
    const disposal = run.dispose()
    expect(run.dispose()).toBe(disposal)
    await disposal
    await nextTask()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledTimes(1)
  })

  it('settles local cancellation immediately and sends best-effort interrupt', async () => {
    const controller = new AbortController()
    const { child, run, turnStart } = await publishRun(
      fakeChild(),
      controller.signal,
    )
    child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
    await nextTask()
    controller.abort(new Error('stop'))
    await expect(run.result).resolves.toEqual({
      output: [],
      stopReason: 'aborted',
    })
    expect(await child.peer.nextMethod('turn/interrupt')).toMatchObject({
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    })
    await run.dispose()
  })

  it('flattens child exit and protocol failures after publication', async () => {
    const errors: string[] = []
    {
      const child = fakeChild({ exitOnTerminate: false })
      const { run } = await publishRun(child, undefined, {
        onError: (error) => { errors.push(error.message) },
      })
      child.settle({ exitCode: 9, signal: null })
      await expect(run.result).resolves.toEqual({ output: [], stopReason: 'error' })
      expect(errors.at(-1)).toContain('code 9')
      await run.dispose().catch(() => {})
    }
    {
      const child = fakeChild()
      const { run, turnStart } = await publishRun(child, undefined, {
        onError: () => { throw new Error('diagnostic sink') },
      })
      child.peer.respond(turnStart, { turn: { id: 'turn-1' } })
      child.fromChild.end()
      await expect(run.result).resolves.toEqual({ output: [], stopReason: 'error' })
      await run.dispose()
    }
  })

  it('rejects before spawn when pre-aborted and rolls back startup failures', async () => {
    const controller = new AbortController()
    controller.abort()
    const spawn = vi.fn()
    await expect(startCodexRun(
      request(undefined, controller.signal),
      {
        cwd: process.cwd(),
        env: {},
        disposeGraceMs: 10,
        spawn,
      },
    )).rejects.toThrow('aborted before app-server startup')
    expect(spawn).not.toHaveBeenCalled()

    const child = fakeChild()
    const starting = startCodexRun(request(), runSpec(child))
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, null)
    await expect(starting).rejects.toThrow('invalid initialize response')
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('rolls back an abort that wins immediately after thread creation', async () => {
    const controller = new AbortController()
    const child = fakeChild()
    const starting = startCodexRun(
      request(undefined, controller.signal),
      runSpec(child),
    )
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    controller.abort('startup race')
    await expect(starting).rejects.toThrow('aborted before run publication')
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('rolls back a subprocess done rejection during startup', async () => {
    const child = fakeChild({ doneError: new Error('spawn observer failed') })
    const error: unknown = await startCodexRun(request(), runSpec(child)).then(
      () => undefined,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(AggregateError)
    if (!(error instanceof AggregateError)) {
      throw new Error('expected startup and rollback failures')
    }
    expect(error.errors).toEqual([
      expect.objectContaining({ message: 'spawn observer failed' }),
      expect.objectContaining({ message: 'spawn observer failed' }),
    ])
    expect(child.terminate).toHaveBeenCalledTimes(1)
  })

  it('keeps overlapping runs isolated', async () => {
    const first = fakeChild()
    const second = fakeChild()
    const runs = await Promise.all([
      publishRun(first),
      publishRun(second),
    ])
    for (const [index, entry] of runs.entries()) {
      const id = `turn-${index + 1}`
      entry.child.peer.send(
        { id: entry.turnStart.id, result: { turn: { id } } },
        agentMessage(`answer-${index + 1}`, 'final_answer', id),
        turnCompleted('completed', id),
      )
    }
    const results = await Promise.all(runs.map(entry => entry.run.result))
    expect(results.map(result => result.output)).toEqual([
      [{ type: 'text', text: 'answer-1' }],
      [{ type: 'text', text: 'answer-2' }],
    ])
    expect(runs[0].run.id).not.toBe(runs[1].run.id)
    await Promise.all(runs.map(entry => entry.run.dispose()))
  })

  it('uses the registered provider config and logs flattened errors', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalSubprocessRuntime)
    const child = fakeChild()
    const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue(child.handle)
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => {
      warnings.push(String(message))
    }) as typeof ctx.logger.warn
    await ctx.plugin(codex, {
      env: { OPENAI_API_KEY: 'fake' },
      disposeGraceMs: 25,
    })
    const starting = ctx.subagents.start('codex', {
      prompt: [{ type: 'text', text: 'task' }],
      parent: fakeParent,
      signal: new AbortController().signal,
    })
    const initialize = await child.peer.nextMethod('initialize')
    child.peer.respond(initialize, { userAgent: 'codex-cli 0.147.0' })
    await child.peer.nextMethod('initialized')
    const threadStart = await child.peer.nextMethod('thread/start')
    child.peer.respond(threadStart, { thread: { id: 'thread-1', ephemeral: true } })
    const run = await starting
    await child.peer.nextMethod('turn/start')
    child.settle({ exitCode: 1, signal: null })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      env: { OPENAI_API_KEY: 'fake' },
      graceMs: 25,
      cwd: process.cwd(),
    }))
    expect(warnings).toEqual([
      expect.stringContaining('subagent-codex: child run failed (error):'),
    ])
    await run.dispose().catch(() => {})
    await ctx.fiber.dispose()
  })
})

describe('disposeCodexChild', () => {
  it('closes stdin, terminates, and waits for the managed tree', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    const end = vi.spyOn(child.toChild, 'end')
    await disposeCodexChild(wire, child.handle)
    expect(end).toHaveBeenCalled()
    expect(child.terminate).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledTimes(1)
    expect(child.waitForExit).toHaveBeenCalledWith()
  })

  it('does not finish disposal before the managed tree exits', async () => {
    const child = fakeChild({ exitOnTerminate: false })
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    let disposed = false
    const disposal = disposeCodexChild(wire, child.handle).then(() => {
      disposed = true
    })
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(disposed).toBe(false)
    child.settle()
    await disposal
    expect(disposed).toBe(true)
  })

  it('contains a concurrently closed stdin error', async () => {
    const child = fakeChild()
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    vi.spyOn(child.toChild, 'end').mockImplementation(() => {
      throw new Error('already closed')
    })
    await expect(disposeCodexChild(wire, child.handle))
      .resolves.toBeUndefined()
  })

  it('handles a spawn-level failure with no process tree', async () => {
    const child = fakeChild({
      pid: -1,
      doneError: new Error('spawn failed'),
    })
    const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
    await expect(disposeCodexChild(wire, child.handle))
      .resolves.toBeUndefined()
    expect(child.terminate).not.toHaveBeenCalled()
    expect(child.waitForExit).not.toHaveBeenCalled()
  })

  it('reports direct-child observer failure and accepts absent stdin', async () => {
    {
      const child = fakeChild({
        doneError: new Error('close observer failed'),
      })
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      await expect(disposeCodexChild(wire, child.handle))
        .rejects.toThrow('close observer failed')
    }
    {
      const child = fakeChild()
      const handle = { ...child.handle, stdin: undefined }
      const wire = new CodexAppServerWire(child.handle.stdout!, child.handle.stdin!)
      await expect(disposeCodexChild(wire, handle)).resolves.toBeUndefined()
    }
  })
})
