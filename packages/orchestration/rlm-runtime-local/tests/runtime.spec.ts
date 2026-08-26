import { copyFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createConnection } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import {
  RlmCommandId,
  RlmRuntimeSessionId,
  type RlmChildExecutionResult,
  type RlmRuntimeHostBindings,
} from '@deepseek-ai/dsh-rlm-runtime'
import { describe, expect, it, vi } from 'vitest'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { LocalRlmRuntime } from '../src/index.ts'

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline })
  return { promise, resolve, reject }
}

async function waitUntil(accept: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!await accept()) {
    if (Date.now() >= deadline) throw new Error('condition did not converge')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const limits = { maxDepth: 3, maxChildren: 4, maxTurns: 12, maxCellMs: 2_000, maxOutputBytes: 64 * 1024 } as const
const model = { operatorId: 'codex', model: 'gpt-5.6-luna' } as const

async function runtime(root: string, bindings: RlmRuntimeHostBindings) {
  const ctx = new Context()
  const service = new LocalRlmRuntime(ctx, root)
  const sessionId = RlmRuntimeSessionId('rlm-session-root')
  await service.create({
    sessionId, commandId: RlmCommandId('create-root'), executionId: 'execution-root', workspace: root,
    task: 'solve a bounded task', model, limits, context: { objective: 'test' },
  }, bindings)
  return { ctx, service, sessionId }
}

describe('LocalRlmRuntime', () => {
  it('maps logical session identities to portable content-addressed directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-portable-session-'))
    const ctx = new Context()
    const service = new LocalRlmRuntime(ctx, root)
    const sessionId = RlmRuntimeSessionId('rlm:orch:run:node:1')
    try {
      const snapshot = await service.create({
        sessionId,
        commandId: RlmCommandId('create-portable-session'),
        executionId: 'execution:portable',
        workspace: root,
        task: 'verify portable storage',
        model,
        limits,
      }, { dispatchChild: () => { throw new Error('not used') } })
      expect(basename(snapshot.sessionDir)).toMatch(/^session-[a-f0-9]{64}$/u)
      expect(snapshot.sessionDir).not.toContain(String(sessionId))
      await expect(service.executeCell({
        sessionId,
        commandId: RlmCommandId('portable-session-cell'),
        code: '40 + 2',
      })).resolves.toMatchObject({ value: 42 })
    } finally {
      await ctx.root.fiber.dispose()
    }
  })

  it('persists programmable context and restores serializable variables independently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-context-'))
    const bindings: RlmRuntimeHostBindings = { dispatchChild: () => { throw new Error('not used') } }
    const first = await runtime(root, bindings)
    await first.service.executeCell({
      sessionId: first.sessionId,
      commandId: RlmCommandId('context-seed'),
      code: [
        'context.counter = 1;',
        'let stable = 40;',
        'const makeUnsupported = () => { let hidden = 0; return () => ++hidden };',
        'const unsupported = makeUnsupported();',
        '({ counter: context.counter, stable })',
      ].join('\n'),
    })
    const advanced = await first.service.executeCell({
      sessionId: first.sessionId,
      commandId: RlmCommandId('context-advance'),
      code: 'context.counter += 1; stable += 2; ({ counter: context.counter, stable })',
    })
    expect(advanced.value).toEqual({ counter: 2, stable: 42 })
    const snapshot = await first.service.inspect(first.sessionId)
    expect(snapshot.restorableVariables).toContain('stable')
    expect(snapshot.degradedVariables).toContain('unsupported')
    await first.ctx.root.fiber.dispose()

    const recoveredContext = new Context()
    const recovered = new LocalRlmRuntime(recoveredContext, root)
    await recovered.bindHost(first.sessionId, bindings)
    await expect(recovered.executeCell({
      sessionId: first.sessionId,
      commandId: RlmCommandId('context-recovered'),
      code: '({ counter: context.counter, stable })',
    })).resolves.toMatchObject({ value: { counter: 2, stable: 42 } })
    await recoveredContext.root.fiber.dispose()
  })

  it('serializes cells while admitting independent child executions concurrently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-concurrency-'))
    const childResults = new Map<string, ReturnType<typeof deferred<RlmChildExecutionResult>>>()
    const dispatches: string[] = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async (request) => {
        dispatches.push(request.name)
        const result = deferred<RlmChildExecutionResult>()
        childResults.set(request.name, result)
        return {
          nativeSessionId: `native-${request.name}`,
          nativeTurnId: `turn-${request.name}`,
          result: result.promise,
          interrupt: () => Promise.resolve(),
        }
      },
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    const slowCell = service.executeCell({
      sessionId,
      commandId: RlmCommandId('serial-cell-one'),
      code: 'await new Promise(resolve => setTimeout(resolve, 50)); let serialValue = 1; serialValue',
    })
    await expect(service.executeCell({
      sessionId,
      commandId: RlmCommandId('serial-cell-two'),
      code: '2',
    })).rejects.toMatchObject({ code: 'RLM_SESSION_BUSY' })
    await expect(slowCell).resolves.toMatchObject({ value: 1 })

    await expect(service.executeCell({
      sessionId,
      commandId: RlmCommandId('parallel-children'),
      code: [
        'const handles = await Promise.all([',
        '  rlm("inspect api", { name: "api" }),',
        '  rlm("inspect tests", { name: "tests" }),',
        ']);',
        'handles.map(handle => handle.name).sort()',
      ].join('\n'),
    })).resolves.toMatchObject({ value: ['api', 'tests'] })
    expect(dispatches.sort()).toEqual(['api', 'tests'])
    expect(await service.listChildren(sessionId)).toMatchObject([
      { name: 'api', lifecycle: 'running' },
      { name: 'tests', lifecycle: 'running' },
    ])
    childResults.get('api')!.resolve({ status: 'settled', resultRef: 'sha256:api' })
    childResults.get('tests')!.resolve({ status: 'settled', resultRef: 'sha256:tests' })
    await waitUntil(async () => (await service.listChildren(sessionId)).every(child => child.lifecycle === 'settled'))
    await ctx.root.fiber.dispose()
  })

  it('keeps a TypeScript lexical namespace across cells and Provider restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-state-'))
    const bindings: RlmRuntimeHostBindings = { dispatchChild: () => { throw new Error('not used') } }
    const first = await runtime(root, bindings)
    const created = await first.service.executeCell({
      sessionId: first.sessionId, commandId: RlmCommandId('cell-1'), code: 'let nonce: string = "alpha"; nonce',
    })
    expect(created.value).toBe('alpha')
    const continued = await first.service.executeCell({
      sessionId: first.sessionId, commandId: RlmCommandId('cell-2'), code: 'nonce = `${nonce}-beta`; nonce',
    })
    expect(continued.value).toBe('alpha-beta')
    expect((await first.service.inspect(first.sessionId)).restorableVariables).toContain('nonce')
    await first.ctx.root.fiber.dispose()

    const secondContext = new Context()
    const second = new LocalRlmRuntime(secondContext, root)
    await second.bindHost(first.sessionId, bindings)
    const restored = await second.executeCell({
      sessionId: first.sessionId, commandId: RlmCommandId('cell-3'), code: 'nonce = `${nonce}-gamma`; nonce',
    })
    expect(restored.value).toBe('alpha-beta-gamma')
    await secondContext.root.fiber.dispose()
  })

  it('restores imports, functions, classes, destructuring, and multi-declaration cells from source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-source-state-'))
    const bindings: RlmRuntimeHostBindings = { dispatchChild: () => { throw new Error('not used') } }
    const first = await runtime(root, bindings)
    const seeded = await first.service.executeCell({
      sessionId: first.sessionId,
      commandId: RlmCommandId('source-state-seed'),
      code: [
        'import { basename as baseName } from "node:path";',
        'function add(left: number, right: number): number { return left + right }',
        'class Box { readonly value: number; constructor(value: number) { this.value = value } }',
        'const [firstValue, secondValue] = [2, 3], { answer: answerValue } = { answer: 40 };',
        'let leftValue = 4, rightValue = 5;',
        'const multiplier = 3, multiply = (value: number) => value * multiplier;',
        '({ path: baseName("/tmp/seed.txt"), sum: add(firstValue, secondValue), box: new Box(answerValue).value })',
      ].join('\n'),
    })
    expect(seeded.value).toEqual({ path: 'seed.txt', sum: 5, box: 40 })
    const snapshot = await first.service.inspect(first.sessionId)
    expect(snapshot.degradedVariables).toEqual([])
    expect(snapshot.restorableVariables).toEqual(expect.arrayContaining([
      'baseName', 'add', 'Box', 'firstValue', 'secondValue', 'answerValue',
      'leftValue', 'rightValue', 'multiplier', 'multiply',
    ]))
    await first.ctx.root.fiber.dispose()

    const recoveredContext = new Context()
    const recovered = new LocalRlmRuntime(recoveredContext, root)
    await recovered.bindHost(first.sessionId, bindings)
    await expect(recovered.executeCell({
      sessionId: first.sessionId,
      commandId: RlmCommandId('source-state-recovered'),
      code: [
        '({',
        '  path: baseName("/tmp/recovered.txt"),',
        '  sum: add(firstValue, secondValue) + leftValue + rightValue,',
        '  box: new Box(answerValue).value,',
        '  product: multiply(4),',
        '})',
      ].join('\n'),
    })).resolves.toMatchObject({
      value: { path: 'recovered.txt', sum: 14, box: 40, product: 12 },
    })
    await recoveredContext.root.fiber.dispose()
  })

  it('returns child admission handles immediately and delivers only explicit later messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-child-'))
    const settled = deferred<RlmChildExecutionResult>()
    let dispatches = 0
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async () => {
        dispatches += 1
        return { nativeSessionId: 'native-session', nativeTurnId: 'native-turn', result: settled.promise, interrupt: () => Promise.resolve() }
      },
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    const admitted = await service.executeCell({
      sessionId, commandId: RlmCommandId('cell-spawn'),
      code: 'await rlm("review the public API", { name: "api-reviewer" })',
    })
    expect(admitted.value).toMatchObject({ name: 'api-reviewer', model })
    expect(admitted.value).not.toHaveProperty('answer')
    expect(dispatches).toBe(1)
    expect((await service.listChildren(sessionId))[0]).toMatchObject({ lifecycle: 'running', name: 'api-reviewer' })

    const child = (await service.listChildren(sessionId))[0]!
    settled.resolve({
      status: 'settled', resultRef: 'sha256:child-result',
      messages: [{ toSessionId: sessionId, mode: 'auto', text: 'API review complete', artifactRefs: ['sha256:child-result'] }],
    })
    await settled.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await service.listChildren(sessionId))[0]).toMatchObject({ lifecycle: 'settled', resultRef: 'sha256:child-result' })
    expect(await service.readMessages({ sessionId })).toMatchObject([{ fromSessionId: child.sessionId, text: 'API review complete' }])

    const replay = await service.executeCell({
      sessionId, commandId: RlmCommandId('cell-spawn'),
      code: 'await rlm("review the public API", { name: "api-reviewer" })',
    })
    expect(replay).toEqual(admitted)
    expect(dispatches).toBe(1)
    await ctx.root.fiber.dispose()
  })

  it('uses the Scheduler-sealed low-tier child model when rlm() omits a model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-default-child-'))
    const ctx = new Context()
    const service = new LocalRlmRuntime(ctx, root)
    const sessionId = RlmRuntimeSessionId('rlm-session-default-child')
    const defaultChildModel = { operatorId: 'codex', model: 'gpt-5.6-luna' } as const
    let dispatchedModel: unknown
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async (request) => {
        dispatchedModel = request.model
        return {
          nativeSessionId: 'native-low-tier', nativeTurnId: 'turn-low-tier',
          result: Promise.resolve({ status: 'settled' }), interrupt: () => Promise.resolve(),
        }
      },
    }
    await service.create({
      sessionId, commandId: RlmCommandId('create-default-child'), executionId: 'execution-default-child',
      workspace: root, task: 'plan with cheap children',
      model: { operatorId: 'claude-code', model: 'claude-opus-4-1' }, defaultChildModel, limits,
    }, bindings)
    const admitted = await service.executeCell({
      sessionId, commandId: RlmCommandId('spawn-default-child'),
      code: 'await rlm("bounded exploration", { name: "cheap-worker" })',
    })
    expect(admitted.value).toMatchObject({ name: 'cheap-worker', model: defaultChildModel })
    expect(dispatchedModel).toEqual(defaultChildModel)
    await ctx.root.fiber.dispose()
  })

  it('inherits the exact parent model and reasoning profile when no optimized child allocation exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-prime-inheritance-'))
    const ctx = new Context()
    const service = new LocalRlmRuntime(ctx, root)
    const sessionId = RlmRuntimeSessionId('rlm-session-prime-inheritance')
    const parentModel = {
      operatorId: 'claude-code', model: 'claude-opus-4-1', profile: { model: 'claude-opus-4-1', effort: 'max' as const },
    }
    const dispatched: unknown[] = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async (request) => {
        dispatched.push(request.model)
        return {
          nativeSessionId: `native-${request.name}`, nativeTurnId: `turn-${request.name}`,
          result: Promise.resolve({ status: 'settled' }), interrupt: () => Promise.resolve(),
        }
      },
    }
    await service.create({
      sessionId, commandId: RlmCommandId('create-prime-inheritance'), executionId: 'execution-prime-inheritance',
      workspace: root, task: 'preserve Prime defaults', model: parentModel, limits,
    }, bindings)
    await service.executeCell({
      sessionId, commandId: RlmCommandId('spawn-inherited'),
      code: 'await rlm("inherit everything", { name: "inherited" })',
    })
    await service.executeCell({
      sessionId, commandId: RlmCommandId('spawn-overridden'),
      code: 'await rlm("use Codex", { name: "overridden", model: "codex/gpt-5.6-sol", thinking: "high" })',
    })
    expect(dispatched).toEqual([
      parentModel,
      { operatorId: 'codex', model: 'gpt-5.6-sol', profile: { effort: 'high' } },
    ])
    await ctx.root.fiber.dispose()
  })

  it('rejects unknown rlm() options instead of silently ignoring them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-prime-options-'))
    let dispatches = 0
    const { ctx, service, sessionId } = await runtime(root, {
      dispatchChild: () => {
        dispatches += 1
        throw new Error('must not dispatch')
      },
    })
    await expect(service.executeCell({
      sessionId, commandId: RlmCommandId('spawn-unknown-option'),
      code: 'await rlm("invalid", { name: "invalid", tools: ["bash"], retries: 2 })',
    })).rejects.toThrow('Unsupported rlm() options: retries, tools')
    expect(dispatches).toBe(0)
    await ctx.root.fiber.dispose()
  })

  it('allows only nuclear-family messages and enforces child budgets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-family-'))
    const pending = deferred<RlmChildExecutionResult>()
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async request => ({
        nativeSessionId: `native-${request.name}`, nativeTurnId: `turn-${request.name}`,
        result: pending.promise, interrupt: () => Promise.resolve(),
      }),
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    await service.executeCell({
      sessionId, commandId: RlmCommandId('spawn-two'),
      code: 'await rlm("first", { name: "one" }); await rlm("second", { name: "two" }); "admitted"',
    })
    const [one, two] = await service.listChildren(sessionId)
    expect(one).toBeDefined()
    expect(two).toBeDefined()
    await expect(service.sendMessage({
      commandId: RlmCommandId('sibling-message'), fromSessionId: one!.sessionId, toSessionId: two!.sessionId,
      mode: 'follow_up', text: 'compare findings',
    })).resolves.toMatchObject({ text: 'compare findings' })

    const otherRoot = RlmRuntimeSessionId('unrelated-root')
    await service.create({
      sessionId: otherRoot, commandId: RlmCommandId('create-other'), executionId: 'other', workspace: root,
      task: 'unrelated', model, limits,
    }, bindings)
    await expect(service.sendMessage({
      commandId: RlmCommandId('invalid-message'), fromSessionId: one!.sessionId, toSessionId: otherRoot,
      mode: 'auto', text: 'escape family',
    })).rejects.toMatchObject({ code: 'RLM_FAMILY_VIOLATION' })
    await ctx.root.fiber.dispose()
  })

  it('exposes the complete family roster and broadcasts without escaping the family', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-roster-'))
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async request => ({
        nativeSessionId: `native-${request.name}`, nativeTurnId: `turn-${request.name}`,
        result: Promise.resolve({ status: 'settled' }), interrupt: () => Promise.resolve(),
      }),
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    await service.executeCell({
      sessionId, commandId: RlmCommandId('spawn-roster'),
      code: 'await rlm("first", { name: "one" }); await rlm("second", { name: "two" }); "ready"',
    })
    const roster = await service.executeCell({
      sessionId, commandId: RlmCommandId('list-roster'), code: 'await agent_message.list_agents()',
    })
    expect(roster.value).toMatchObject({
      current: { name: 'root', depth: 0 },
      entries: [
        { relationship: 'child', name: 'one', depth: 1 },
        { relationship: 'child', name: 'two', depth: 1 },
      ],
    })
    const broadcast = await service.executeCell({
      sessionId, commandId: RlmCommandId('broadcast-family'), code: 'await agent_message.send("all", "compare your findings")',
    })
    expect(broadcast.value).toMatchObject({ receipts: [{ text: 'compare your findings' }, { text: 'compare your findings' }] })
    const children = await service.listChildren(sessionId)
    await expect(service.readMessages({ sessionId: children[0]!.sessionId })).resolves.toMatchObject([{ text: 'compare your findings' }])
    await expect(service.readMessages({ sessionId: children[1]!.sessionId })).resolves.toMatchObject([{ text: 'compare your findings' }])
    await ctx.root.fiber.dispose()
  })

  it('applies Prime message size and sender-target rate limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-message-limits-'))
    const pending = deferred<RlmChildExecutionResult>()
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async request => ({
        nativeSessionId: `native-${request.name}`, nativeTurnId: `turn-${request.name}`,
        result: pending.promise, interrupt: () => Promise.resolve(),
      }),
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    await service.executeCell({ sessionId, commandId: RlmCommandId('spawn-rate-child'), code: 'await rlm("send updates", { name: "sender" })' })
    const child = (await service.listChildren(sessionId))[0]!
    await expect(service.sendMessage({
      commandId: RlmCommandId('too-large'), fromSessionId: child.sessionId, toSessionId: sessionId,
      mode: 'auto', text: 'x'.repeat(16_385),
    })).rejects.toMatchObject({ code: 'RLM_INVALID' })
    for (let index = 0; index < 3; index += 1) {
      await expect(service.sendMessage({
        commandId: RlmCommandId(`rate-${String(index)}`), fromSessionId: child.sessionId, toSessionId: sessionId,
        mode: 'follow_up', text: `message ${String(index)}`,
      })).resolves.toMatchObject({ deliveryStatus: 'queued' })
    }
    await expect(service.sendMessage({
      commandId: RlmCommandId('rate-overflow'), fromSessionId: child.sessionId, toSessionId: sessionId,
      mode: 'follow_up', text: 'one too many',
    })).rejects.toMatchObject({ code: 'RLM_BUDGET_EXCEEDED' })
    await ctx.root.fiber.dispose()
  })

  it('queues family messages behind active work and drains steer before follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-message-queue-'))
    const rootExecution = deferred<RlmChildExecutionResult>()
    const continuationResults: Array<ReturnType<typeof deferred<RlmChildExecutionResult>>> = []
    const continuationRequests: Array<{ deliveryMode: string; instruction: string }> = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async request => ({
        nativeSessionId: `child:${request.childSessionId}`,
        nativeTurnId: `child-turn:${request.childId}`,
        result: Promise.resolve({ status: 'settled' }),
        interrupt: () => Promise.resolve(),
      }),
      dispatchContinuation: async (request) => {
        continuationRequests.push({ deliveryMode: request.deliveryMode, instruction: request.instruction })
        const result = deferred<RlmChildExecutionResult>()
        continuationResults.push(result)
        return {
          nativeSessionId: `continuation:${request.sessionId}`,
          nativeTurnId: `continuation-turn:${request.commandId}`,
          result: result.promise,
          interrupt: () => Promise.resolve(),
        }
      },
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    await service.trackExecution(sessionId, {
      nativeSessionId: 'root-native', nativeTurnId: 'root-turn',
      result: rootExecution.promise, interrupt: () => Promise.resolve(),
    })
    const child = await service.spawn({
      commandId: RlmCommandId('queue-child'), parentSessionId: sessionId,
      name: 'messenger', task: 'send bounded evidence',
    })
    const followUp = await service.sendMessage({
      commandId: RlmCommandId('queue-follow-up'), fromSessionId: child.sessionId, toSessionId: sessionId,
      mode: 'follow_up', text: 'follow-up evidence',
    })
    const automatic = await service.sendMessage({
      commandId: RlmCommandId('queue-auto'), fromSessionId: child.sessionId, toSessionId: sessionId,
      mode: 'auto', text: 'steering evidence',
    })
    expect(followUp).toMatchObject({ deliveryStatus: 'queued', effectiveMode: 'follow_up' })
    expect(automatic).toMatchObject({ deliveryStatus: 'queued', effectiveMode: 'steer' })
    expect(continuationRequests).toHaveLength(0)

    rootExecution.resolve({ status: 'settled' })
    await waitUntil(() => continuationRequests.length === 1)
    expect(continuationRequests[0]).toMatchObject({ deliveryMode: 'steer' })
    expect(continuationRequests[0]!.instruction).toContain('steering evidence')
    continuationResults[0]!.resolve({ status: 'settled', output: [{ type: 'text', text: 'steer applied' }] })
    await waitUntil(() => continuationRequests.length === 2)
    expect(continuationRequests[1]).toMatchObject({ deliveryMode: 'follow_up' })
    expect(continuationRequests[1]!.instruction).toContain('follow-up evidence')
    continuationResults[1]!.resolve({ status: 'settled', output: [{ type: 'text', text: 'follow-up applied' }] })
    await expect(service.drain(sessionId, 1_000)).resolves.toMatchObject({ activeExecutions: 0, queuedMessages: 0 })
    expect(await service.readMessages({ sessionId })).toMatchObject([
      { text: 'follow-up evidence', deliveryStatus: 'delivered' },
      { text: 'steering evidence', deliveryStatus: 'delivered' },
    ])
    await ctx.root.fiber.dispose()
  })

  it('admits one continuation when concurrent pumps observe the same queued message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-message-pump-'))
    const continuationRequests: string[] = []
    const dispatchChild: RlmRuntimeHostBindings['dispatchChild'] = async request => ({
      nativeSessionId: `child:${request.childSessionId}`,
      nativeTurnId: `child-turn:${request.childId}`,
      result: Promise.resolve({ status: 'settled' }),
      interrupt: () => Promise.resolve(),
    })
    const { ctx, service, sessionId } = await runtime(root, { dispatchChild })
    const child = await service.spawn({
      commandId: RlmCommandId('pump-child'), parentSessionId: sessionId,
      name: 'messenger', task: 'send one bounded message',
    })
    await expect(service.sendMessage({
      commandId: RlmCommandId('pump-message'), fromSessionId: child.sessionId, toSessionId: sessionId,
      mode: 'follow_up', text: 'deliver exactly once',
    })).resolves.toMatchObject({ deliveryStatus: 'queued' })

    await service.bindHost(sessionId, {
      dispatchChild,
      dispatchContinuation: async (request) => {
        continuationRequests.push(String(request.commandId))
        await new Promise(resolve => setTimeout(resolve, 10))
        return {
          nativeSessionId: `continuation:${request.sessionId}`,
          nativeTurnId: `continuation-turn:${request.commandId}`,
          result: Promise.resolve({ status: 'settled' }),
          interrupt: () => Promise.resolve(),
        }
      },
    })

    await Promise.all([
      service.pumpMessages(sessionId),
      service.pumpMessages(sessionId),
      service.pumpMessages(sessionId),
    ])
    await expect(service.drain(sessionId, 1_000)).resolves.toMatchObject({ activeExecutions: 0, queuedMessages: 0 })
    expect(continuationRequests).toHaveLength(1)
    await ctx.root.fiber.dispose()
  })

  it('uses optimistic revisions for durable goals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-goal-'))
    const { ctx, service, sessionId } = await runtime(root, { dispatchChild: () => { throw new Error('not used') } })
    const snapshot = await service.inspect(sessionId)
    await expect(service.setGoal({
      sessionId, commandId: RlmCommandId('goal-wrong'), expectedStateRevision: snapshot.stateRevision + 1,
      objective: 'finish', continuationBudget: 4,
    })).rejects.toMatchObject({ code: 'RLM_REVISION_CONFLICT' })
    await expect(service.setGoal({
      sessionId, commandId: RlmCommandId('goal-ok'), expectedStateRevision: snapshot.stateRevision,
      objective: 'finish', continuationBudget: 4,
    })).resolves.toMatchObject({ status: 'active', objective: 'finish' })
    await ctx.root.fiber.dispose()
  })

  it('accounts Prime goal token, active wall-clock, lifecycle, and idempotent usage budgets', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-goal-budget-'))
    const bindings: RlmRuntimeHostBindings = { dispatchChild: () => { throw new Error('not used') } }
    const first = await runtime(root, bindings)
    try {
      const initial = await first.service.inspect(first.sessionId)
      const active = await first.service.setGoal({
        sessionId: first.sessionId,
        commandId: RlmCommandId('goal-budget-create'),
        expectedStateRevision: initial.stateRevision,
        objective: 'finish within the sealed budget',
        tokenBudget: 10,
        continuationBudget: 2,
      })
      expect(active).toMatchObject({
        active: true,
        status: 'active',
        tokenBudget: 10,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationsUsed: 0,
      })
      await expect(first.service.setGoal({
        sessionId: first.sessionId,
        commandId: RlmCommandId('goal-budget-create'),
        expectedStateRevision: initial.stateRevision,
        objective: 'finish within the sealed budget',
        tokenBudget: 10,
        continuationBudget: 2,
      })).resolves.toEqual(active)

      vi.setSystemTime(new Date('2026-08-24T00:00:02.500Z'))
      const usageRevision = (await first.service.inspect(first.sessionId)).stateRevision
      const firstUsage = await first.service.accountGoalUsage({
        sessionId: first.sessionId,
        commandId: RlmCommandId('goal-usage-one'),
        expectedStateRevision: usageRevision,
        inputTokens: 3,
        outputTokens: 2,
      })
      expect(firstUsage).toMatchObject({ active: true, status: 'active', tokensUsed: 5, timeUsedSeconds: 2 })

      const pauseRevision = (await first.service.inspect(first.sessionId)).stateRevision
      const paused = await first.service.setGoal({
        sessionId: first.sessionId,
        commandId: RlmCommandId('goal-pause'),
        expectedStateRevision: pauseRevision,
        objective: active.objective,
        status: 'paused',
        continuationBudget: 2,
        reason: 'waiting for evidence',
      })
      expect(paused).toMatchObject({ active: false, status: 'paused', tokensUsed: 5, timeUsedSeconds: 2, lastReason: 'waiting for evidence' })
      vi.setSystemTime(new Date('2026-08-24T00:00:12.500Z'))
      await expect(first.service.inspect(first.sessionId)).resolves.toMatchObject({ goal: { timeUsedSeconds: 2 } })

      const resumeRevision = (await first.service.inspect(first.sessionId)).stateRevision
      await first.service.setGoal({
        sessionId: first.sessionId,
        commandId: RlmCommandId('goal-resume'),
        expectedStateRevision: resumeRevision,
        objective: active.objective,
        status: 'active',
        continuationBudget: 2,
      })
      vi.setSystemTime(new Date('2026-08-24T00:00:13.700Z'))
      const finalUsageRevision = (await first.service.inspect(first.sessionId)).stateRevision
      const exhausted = await first.service.accountGoalUsage({
        sessionId: first.sessionId,
        commandId: RlmCommandId('goal-usage-two'),
        expectedStateRevision: finalUsageRevision,
        inputTokens: 4,
        outputTokens: 1,
      })
      expect(exhausted).toMatchObject({
        active: false,
        status: 'budget_limited',
        tokensUsed: 10,
        timeUsedSeconds: 3,
        lastReason: 'Reached 10 token goal budget',
      })
      await expect(first.service.accountGoalUsage({
        sessionId: first.sessionId,
        commandId: RlmCommandId('goal-usage-two'),
        expectedStateRevision: finalUsageRevision,
        inputTokens: 4,
        outputTokens: 1,
      })).resolves.toEqual(exhausted)

      const errorRevision = (await first.service.inspect(first.sessionId)).stateRevision
      await expect(first.service.setGoal({
        sessionId: first.sessionId,
        commandId: RlmCommandId('goal-error'),
        expectedStateRevision: errorRevision,
        objective: active.objective,
        status: 'error',
        continuationBudget: 2,
        error: 'provider stopped',
      })).resolves.toMatchObject({ active: false, status: 'error', lastError: 'provider stopped' })
      const completeRevision = (await first.service.inspect(first.sessionId)).stateRevision
      await expect(first.service.completeGoal(
        first.sessionId,
        RlmCommandId('goal-complete-after-error'),
        completeRevision,
      )).resolves.toMatchObject({ active: false, status: 'complete', lastReason: 'Goal achieved' })

      const persistedTime = (await first.service.inspect(first.sessionId)).goal?.timeUsedSeconds
      await first.ctx.root.fiber.dispose()
      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'))
      const recoveredContext = new Context()
      const recovered = new LocalRlmRuntime(recoveredContext, root)
      await expect(recovered.inspect(first.sessionId)).resolves.toMatchObject({
        goal: { status: 'complete', timeUsedSeconds: persistedTime },
      })
      await recoveredContext.root.fiber.dispose()
    } finally {
      if (first.ctx.root.fiber.uid !== null) await first.ctx.root.fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('persists active goal wall-clock on shutdown without charging offline time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-goal-clock-'))
    const bindings: RlmRuntimeHostBindings = { dispatchChild: () => { throw new Error('not used') } }
    const first = await runtime(root, bindings)
    let recoveredContext: Context | undefined
    try {
      const revision = (await first.service.inspect(first.sessionId)).stateRevision
      await first.service.setGoal({
        sessionId: first.sessionId,
        commandId: RlmCommandId('goal-clock-create'),
        expectedStateRevision: revision,
        objective: 'measure active runtime only',
        continuationBudget: 2,
      })
      vi.setSystemTime(new Date('2026-08-24T00:00:02.500Z'))
      await first.ctx.root.fiber.dispose()

      vi.setSystemTime(new Date('2026-08-24T01:00:00.000Z'))
      recoveredContext = new Context()
      const recovered = new LocalRlmRuntime(recoveredContext, root)
      await expect(recovered.inspect(first.sessionId)).resolves.toMatchObject({
        goal: { active: true, status: 'active', timeUsedSeconds: 2 },
      })
      await recoveredContext.root.fiber.dispose()
    } finally {
      if (first.ctx.root.fiber.uid !== null) await first.ctx.root.fiber.dispose()
      if (recoveredContext !== undefined && recoveredContext.root.fiber.uid !== null) {
        await recoveredContext.root.fiber.dispose()
      }
      vi.useRealTimers()
    }
  })

  it('accounts continuations and normalizes exhaustion to Prime budget_limited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-goal-continuations-'))
    const { ctx, service, sessionId } = await runtime(root, { dispatchChild: () => { throw new Error('not used') } })
    const revision = (await service.inspect(sessionId)).stateRevision
    await service.setGoal({
      sessionId,
      commandId: RlmCommandId('goal-continuation-create'),
      expectedStateRevision: revision,
      objective: 'finish through bounded continuations',
      continuationBudget: 2,
    })
    await expect(service.claimGoalContinuation(sessionId, RlmCommandId('goal-continuation-one')))
      .resolves.toMatchObject({ continuation: 1, continuationBudget: 2 })
    await expect(service.claimGoalContinuation(sessionId, RlmCommandId('goal-continuation-two')))
      .resolves.toMatchObject({ continuation: 2, continuationBudget: 2 })
    await expect(service.claimGoalContinuation(sessionId, RlmCommandId('goal-continuation-exhausted')))
      .resolves.toBeUndefined()
    await expect(service.inspect(sessionId)).resolves.toMatchObject({
      goal: {
        active: false,
        status: 'budget_limited',
        continuationsUsed: 2,
        lastReason: 'Reached 2 continuation goal budget',
      },
    })
    await ctx.root.fiber.dispose()
  })

  it('exposes Prime-compatible goal completion and recurring heartbeat management in TypeScript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-control-'))
    const { ctx, service, sessionId } = await runtime(root, { dispatchChild: () => { throw new Error('not used') } })
    await expect(service.executeCell({
      sessionId, commandId: RlmCommandId('control-create'),
      code: [
        'const createdGoal = await goal.create("ship the complete feature", { continuationBudget: 3 });',
        'const heartbeat = await rlm_heartbeat.create("inspect remaining work", { interval: "5m", label: "delivery", deliveryMode: "follow_up" });',
        '({ goal: createdGoal.status, heartbeat: heartbeat.status, interval: heartbeat.interval })',
      ].join('\n'),
    })).resolves.toMatchObject({ value: { goal: 'active', heartbeat: 'active', interval: '5m' } })
    const heartbeat = (await service.listHeartbeats(sessionId))[0]!
    const due = await service.claimDueHeartbeats(new Date(Date.parse(heartbeat.nextRunAt!) + 1).toISOString())
    expect(due).toHaveLength(1)
    await expect(service.settleHeartbeat(heartbeat.heartbeatId, due[0]!.commandId, { status: 'settled' }))
      .resolves.toMatchObject({ runCount: 1, status: 'active' })
    await expect(service.executeCell({
      sessionId, commandId: RlmCommandId('control-complete'),
      code: 'const completed = await goal.complete(); const listed = await rlmHeartbeat.list(true); ({ status: completed.status, count: listed.length })',
    })).resolves.toMatchObject({ value: { status: 'complete', count: 1 } })
    await ctx.root.fiber.dispose()
  })

  it('dispatches due heartbeats once and never replays an in-flight command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-heartbeat-'))
    let dispatches = 0
    const heartbeatResult = deferred<RlmChildExecutionResult>()
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: () => { throw new Error('not used') },
      dispatchContinuation: async (request) => {
        dispatches += 1
        return {
          nativeSessionId: 'heartbeat-native-session',
          nativeTurnId: String(request.commandId),
          result: heartbeatResult.promise,
          interrupt: () => Promise.resolve(),
        }
      },
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    const heartbeat = await service.createHeartbeat({
      sessionId, commandId: RlmCommandId('heartbeat-create'), instruction: 'check progress', interval: '1s',
    })
    const dueAt = new Date(Date.parse(heartbeat.nextRunAt!) + 1).toISOString()
    expect(await service.pumpHeartbeats(dueAt)).toBe(1)
    expect(await service.pumpHeartbeats(dueAt)).toBe(0)
    heartbeatResult.resolve({ status: 'settled', output: [{ type: 'text', text: 'heartbeat complete' }] })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(dispatches).toBe(1)
    expect((await service.listHeartbeats(sessionId))[0]).toMatchObject({ runCount: 1, status: 'active' })
    await ctx.root.fiber.dispose()
  })

  it('schedules Prime-compatible compaction idempotently without resetting the TypeScript namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-compact-'))
    const compactions: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: () => { throw new Error('not used') },
      hostRequest: async (request) => {
        compactions.push({ method: request.method, params: request.params })
        if (request.method === 'compact.status') return { ready: true, scheduled: false }
        if (request.method === 'compact.run') {
          return { scheduled: true, note: 'scheduled for the next native turn boundary' }
        }
        throw new Error(`unexpected host method ${request.method}`)
      },
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    const seeded = await service.executeCell({
      sessionId,
      commandId: RlmCommandId('compact-seed'),
      code: 'let retained = 41; retained',
    })
    const request = {
      sessionId,
      commandId: RlmCommandId('compact-command'),
      expectedStateRevision: seeded.stateRevision,
    }
    await expect(service.compactStatus(sessionId)).resolves.toEqual({ ready: true, scheduled: false })
    const compacted = await service.compactRun({
      ...request,
      instructions: 'Preserve the accepted evidence references.',
    })
    expect(compacted).toMatchObject({
      stateRevision: seeded.stateRevision,
      restorableVariables: ['retained'],
      scheduled: true,
      note: 'scheduled for the next native turn boundary',
    })
    await expect(service.compactRun({
      ...request,
      instructions: 'Preserve the accepted evidence references.',
    })).resolves.toEqual(compacted)
    expect(compactions).toEqual([
      { method: 'compact.status', params: {} },
      {
        method: 'compact.run',
        params: { instructions: 'Preserve the accepted evidence references.' },
      },
    ])
    const kernelRequest = {
      sessionId,
      commandId: RlmCommandId('compact-kernel'),
      code: [
        'const status = await compact.status();',
        'const run = await compact.run({ instructions: "Keep the durable goal." });',
        '({ status, run })',
      ].join('\n'),
    }
    const kernelResult = await service.executeCell(kernelRequest)
    expect(kernelResult.value).toEqual({
      status: { ready: true, scheduled: false },
      run: {
        scheduled: true,
        note: 'scheduled for the next native turn boundary',
      },
    })
    await expect(service.executeCell(kernelRequest)).resolves.toEqual(kernelResult)
    await expect(service.inspectReceipt(RlmCommandId('compact-kernel:compact-run:1'))).resolves.toMatchObject({
      state: 'settled',
      operation: 'compact.run',
    })
    expect(compactions).toHaveLength(4)
    expect(compactions.slice(2)).toEqual([
      { method: 'compact.status', params: {} },
      { method: 'compact.run', params: { instructions: 'Keep the durable goal.' } },
    ])
    await expect(service.executeCell({
      sessionId,
      commandId: RlmCommandId('compact-continued'),
      code: 'retained + 1',
    })).resolves.toMatchObject({ value: 42 })
    await ctx.root.fiber.dispose()
  })

  it('calls only host-resolved managed skills and receipt-caches structured results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-skills-'))
    const requests: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: () => { throw new Error('not used') },
      hostRequest: async (request) => {
        requests.push({ method: request.method, params: request.params })
        if (request.method === 'skills.list') {
          return [{ alias: 'summarize', title: 'Summarize', callable: 'summarize', available: true }]
        }
        if (request.method === 'skills.call') {
          const alias = request.params.alias
          if (typeof alias !== 'string') throw new Error('expected managed skill alias')
          return { ok: true, output: `summary:${alias}` }
        }
        throw new Error(`unexpected host method ${request.method}`)
      },
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    const cell = {
      sessionId,
      commandId: RlmCommandId('managed-skill-call'),
      code: [
        'const catalog = await skills.list();',
        'const result = await skills.call("summarize", { text: "bounded evidence" });',
        '({ catalog, result })',
      ].join('\n'),
    }
    const first = await service.executeCell(cell)
    expect(first.value).toEqual({
      catalog: {
        ok: true,
        result: [{ alias: 'summarize', title: 'Summarize', callable: 'summarize', available: true }],
      },
      result: { ok: true, result: { ok: true, output: 'summary:summarize' } },
    })
    await expect(service.executeCell(cell)).resolves.toEqual(first)
    expect(requests).toEqual([
      { method: 'skills.list', params: {} },
      { method: 'skills.call', params: { alias: 'summarize', args: { text: 'bounded evidence' } } },
    ])
    const invalid = await service.executeCell({
      sessionId,
      commandId: RlmCommandId('invalid-skill-call'),
      code: [
        'const path = await skills.call("../arbitrary-import", {});',
        'const scoped = await skills.call("@scope/pkg", {});',
        'const dotted = await skills.call("internal.module", {});',
        '({ path, scoped, dotted })',
      ].join('\n'),
    })
    const rejected = {
      ok: false,
      error: { code: 'RLM_INVALID', message: 'skills.call requires a Host-issued managed skill alias, not a module path' },
    }
    expect(invalid.value).toEqual({ path: rejected, scoped: rejected, dotted: rejected })
    await expect(service.inspectReceipt(RlmCommandId('invalid-skill-call'))).resolves.toMatchObject({
      state: 'settled',
    })
    expect(requests).toHaveLength(2)
    await ctx.root.fiber.dispose()
  })

  it('recovers a running receipt as indeterminate and requires explicit abandonment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-crash-source-'))
    const bindings: RlmRuntimeHostBindings = { dispatchChild: () => { throw new Error('not used') } }
    const first = await runtime(root, bindings)
    const interrupted = first.service.executeCell({
      sessionId: first.sessionId,
      commandId: RlmCommandId('crash-cell'),
      code: 'await new Promise(() => {})',
    })
    const statePath = join(root, 'state.json')
    await waitUntil(async () => {
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        readonly receipts?: readonly { readonly commandId?: unknown; readonly state?: unknown }[]
      }
      return state.receipts?.some(receipt => receipt.commandId === 'crash-cell' && receipt.state === 'running') ?? false
    })
    const recoveredRoot = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-crash-recovered-'))
    await copyFile(statePath, join(recoveredRoot, 'state.json'))
    const interruptedOutcome = interrupted.catch(() => undefined)
    await first.ctx.root.fiber.dispose()
    await interruptedOutcome

    const recoveredContext = new Context()
    const recovered = new LocalRlmRuntime(recoveredContext, recoveredRoot)
    await recovered.bindHost(first.sessionId, bindings)
    await expect(recovered.inspectReceipt(RlmCommandId('crash-cell'))).resolves.toMatchObject({
      state: 'indeterminate',
      sessionId: first.sessionId,
      operation: 'cell.execute',
    })
    await expect(recovered.executeCell({
      sessionId: first.sessionId,
      commandId: RlmCommandId('crash-cell'),
      code: 'await new Promise(() => {})',
    })).rejects.toMatchObject({ code: 'RLM_COMMAND_INDETERMINATE' })
    const snapshot = await recovered.inspect(first.sessionId)
    const resolution = {
      sessionId: first.sessionId,
      indeterminateCommandId: RlmCommandId('crash-cell'),
      resolutionCommandId: RlmCommandId('resolve-crash-cell'),
      expectedStateRevision: snapshot.stateRevision,
      decision: 'abandon',
      reason: 'native outcome cannot be proven after simulated process loss',
    } as const
    await expect(recovered.resolveIndeterminate(resolution)).resolves.toMatchObject({ state: 'indeterminate', resolution: 'abandon' })
    await expect(recovered.resolveIndeterminate(resolution)).resolves.toMatchObject({ state: 'indeterminate', resolution: 'abandon' })
    await expect(recovered.executeCell({
      sessionId: first.sessionId,
      commandId: RlmCommandId('after-crash'),
      code: '40 + 2',
    })).resolves.toMatchObject({ value: 42 })
    await recoveredContext.root.fiber.dispose()
  })

  it('serves the genuine typescript_repl tool over the owner-local bridge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-bridge-'))
    const { ctx, service, sessionId } = await runtime(root, { dispatchChild: () => { throw new Error('not used') } })
    const bridge = await service.modelToolBridge(sessionId)
    expect(bridge).toMatchObject({ version: 1, sessionId, tools: [{ name: 'typescript_repl' }] })
    const socket = createConnection(bridge.socketPath)
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const transport = new JsonRpcLineTransport(socket, socket)
    transport.start()
    const result = await transport.request('tool.call', {
      session_id: bridge.sessionId,
      command_id: 'bridge-cell',
      tool: 'typescript_repl',
      arguments: { code: 'let bridged: number = 40; bridged + 2' },
    })
    expect(result).toMatchObject({ value: 42, stateRevision: 1 })
    transport.close()
    socket.destroy()
    await ctx.root.fiber.dispose()
  })

  it('terminates a synchronous runaway cell and restores the last settled namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-timeout-'))
    const bindings: RlmRuntimeHostBindings = { dispatchChild: () => { throw new Error('not used') } }
    const ctx = new Context()
    const service = new LocalRlmRuntime(ctx, root)
    const sessionId = RlmRuntimeSessionId('rlm-session-timeout')
    await service.create({
      sessionId, commandId: RlmCommandId('create-timeout'), executionId: 'execution-timeout', workspace: root,
      task: 'contain a runaway cell', model, limits: { ...limits, maxCellMs: 25 },
    }, bindings)
    await service.executeCell({ sessionId, commandId: RlmCommandId('seed'), code: 'let stable = 41; stable' })
    await expect(service.executeCell({
      sessionId, commandId: RlmCommandId('runaway'), code: 'while (true) {}',
    })).rejects.toMatchObject({ code: 'RLM_CELL_TIMEOUT' })
    await expect(service.executeCell({
      sessionId, commandId: RlmCommandId('after-timeout'), code: 'stable + 1',
    })).resolves.toMatchObject({ value: 42 })
    await ctx.root.fiber.dispose()
  })
})
