import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createConnection } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import {
  RLM_TYPESCRIPT_REPL_TOOL_SCHEMA,
  RlmControlCallerId,
  RlmCommandId,
  RlmRuntimeSessionId,
  type RlmChildExecutionResult,
  type RlmChildExecutionOptionsV1,
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

async function runtime(
  root: string,
  bindings: RlmRuntimeHostBindings,
  executionOptions?: RlmChildExecutionOptionsV1,
) {
  const ctx = new Context()
  const service = new LocalRlmRuntime(ctx, root)
  const sessionId = RlmRuntimeSessionId('rlm-session-root')
  await service.create({
    sessionId, commandId: RlmCommandId('create-root'), executionId: 'execution-root', workspace: root,
    task: 'solve a bounded task', model, limits, context: { objective: 'test' },
    ...executionOptions === undefined ? {} : { executionOptions },
  }, bindings)
  return { ctx, service, sessionId }
}

describe('LocalRlmRuntime', () => {
  it('provides an exclusive persistent Agents View control lease and routes input through continuations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-control-lease-'))
    const continuationRequests: string[] = []
    const origins: (string | undefined)[] = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: () => { throw new Error('not used') },
      dispatchContinuation: async (request) => {
        continuationRequests.push(request.instruction)
        origins.push(request.messageOrigin)
        return {
          nativeSessionId: 'native-control-session',
          nativeTurnId: String(request.commandId),
          result: Promise.resolve({ status: 'settled', output: [{ type: 'text', text: 'control accepted' }] }),
          interrupt: () => Promise.resolve(),
        }
      },
    }
    const first = await runtime(root, bindings)
    const attached = await first.service.attach({
      version: 1,
      sessionId: first.sessionId,
      commandId: RlmCommandId('control-attach-a'),
      callerId: RlmControlCallerId('agents-view-a'),
    })
    expect(attached).toMatchObject({
      version: 1,
      lease: { version: 1, sessionId: first.sessionId, callerId: 'agents-view-a' },
      snapshot: { sessionId: first.sessionId },
      eventCursor: attached.snapshot.eventCursor,
    })
    await expect(first.service.attach({
      version: 1,
      sessionId: first.sessionId,
      commandId: RlmCommandId('control-attach-b'),
      callerId: RlmControlCallerId('agents-view-b'),
    })).rejects.toMatchObject({ code: 'RLM_CONTROL_BUSY' })

    const input = {
      version: 1 as const,
      sessionId: first.sessionId,
      leaseId: attached.lease.leaseId,
      commandId: RlmCommandId('control-input-a'),
      text: 'continue with the current evidence',
    }
    const accepted = await first.service.input(input)
    await expect(first.service.input(input)).resolves.toEqual(accepted)
    expect(accepted).toMatchObject({ version: 1, deliveryStatus: 'delivered', effectiveMode: 'follow_up' })
    expect(continuationRequests).toHaveLength(1)
    expect(origins).toEqual(['controller'])
    await expect(first.service.input({ ...input, text: 'different command' })).rejects.toMatchObject({ code: 'RLM_COMMAND_CONFLICT' })

    const detached = await first.service.detach({
      version: 1,
      sessionId: first.sessionId,
      leaseId: attached.lease.leaseId,
      commandId: RlmCommandId('control-detach-a'),
    })
    await expect(first.service.detach({
      version: 1,
      sessionId: first.sessionId,
      leaseId: attached.lease.leaseId,
      commandId: RlmCommandId('control-detach-a'),
    })).resolves.toEqual(detached)
    await expect(first.service.input({ ...input, commandId: RlmCommandId('control-input-after-detach') }))
      .rejects.toMatchObject({ code: 'RLM_CONTROL_LEASE_INVALID' })
    await first.ctx.root.fiber.dispose()

    const recoveredContext = new Context()
    const recovered = new LocalRlmRuntime(recoveredContext, root)
    await recovered.bindHost(first.sessionId, bindings)
    const recoveredAttach = await recovered.attach({
      version: 1,
      sessionId: first.sessionId,
      commandId: RlmCommandId('control-attach-after-restart'),
      callerId: RlmControlCallerId('agents-view-after-restart'),
    })
    expect(recoveredAttach.snapshot.eventCursor).toBeGreaterThan(attached.eventCursor)
    await recoveredContext.root.fiber.dispose()
  })

  it('reclaims a control lease persisted by a dead runtime owner without replaying input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-control-reclaim-'))
    const first = await runtime(root, { dispatchChild: () => { throw new Error('not used') } })
    const attached = await first.service.attach({
      version: 1,
      sessionId: first.sessionId,
      commandId: RlmCommandId('control-reclaim-attach-a'),
      callerId: RlmControlCallerId('agents-view-a'),
    })
    const statePath = join(root, 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      controlLeases: Array<Record<string, unknown>>
    }
    state.controlLeases[0]!.ownerPid = Number.MAX_SAFE_INTEGER
    const recoveredRoot = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-control-reclaim-recovered-'))
    await writeFile(join(recoveredRoot, 'state.json'), `${JSON.stringify(state)}\n`, { mode: 0o600 })
    const recoveredContext = new Context()
    const recovered = new LocalRlmRuntime(recoveredContext, recoveredRoot)
    const reclaimed = await recovered.attach({
      version: 1,
      sessionId: first.sessionId,
      commandId: RlmCommandId('control-reclaim-attach-b'),
      callerId: RlmControlCallerId('agents-view-b'),
    })
    expect(reclaimed.lease.leaseId).not.toBe(attached.lease.leaseId)
    expect(reclaimed.lease.callerId).toBe('agents-view-b')
    await recoveredContext.root.fiber.dispose()
    await first.ctx.root.fiber.dispose()
  })

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
    let dispatched: { readonly model: unknown; readonly modelOrigin: unknown } | undefined
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async (request) => {
        dispatched = { model: request.model, modelOrigin: request.modelOrigin }
        return {
          nativeSessionId: 'native-low-tier', nativeTurnId: 'turn-low-tier',
          result: Promise.resolve({ status: 'settled' }), interrupt: () => Promise.resolve(),
        }
      },
    }
    await service.create({
      sessionId, commandId: RlmCommandId('create-default-child'), executionId: 'execution-default-child',
      workspace: root, task: 'plan with cheap children', childModelPolicy: 'allocator-default',
      model: { operatorId: 'claude-code', model: 'claude-opus-4-1' }, defaultChildModel, limits,
    }, bindings)
    const admitted = await service.executeCell({
      sessionId, commandId: RlmCommandId('spawn-default-child'),
      code: 'await rlm("bounded exploration", { name: "cheap-worker" })',
    })
    expect(admitted.value).toMatchObject({ name: 'cheap-worker', model: defaultChildModel, modelOrigin: 'allocator-default' })
    expect(dispatched).toEqual({ model: defaultChildModel, modelOrigin: 'allocator-default' })
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
    const dispatched: Array<{ readonly model: unknown; readonly modelOrigin: unknown }> = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async (request) => {
        dispatched.push({ model: request.model, modelOrigin: request.modelOrigin })
        return {
          nativeSessionId: `native-${request.name}`, nativeTurnId: `turn-${request.name}`,
          result: Promise.resolve({ status: 'settled' }), interrupt: () => Promise.resolve(),
        }
      },
    }
    await service.create({
      sessionId, commandId: RlmCommandId('create-prime-inheritance'), executionId: 'execution-prime-inheritance',
      workspace: root, task: 'preserve Prime defaults', model: parentModel, childModelPolicy: 'parent-inherit', limits,
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
      { model: parentModel, modelOrigin: 'parent-inherited' },
      { model: { operatorId: 'codex', model: 'gpt-5.6-sol', profile: { model: 'gpt-5.6-sol', effort: 'high' } }, modelOrigin: 'explicit' },
    ])
    await ctx.root.fiber.dispose()
  })

  it('rejects an allocator child default when the sealed policy is Prime parent inheritance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-prime-no-allocator-default-'))
    const ctx = new Context()
    const service = new LocalRlmRuntime(ctx, root)
    expect(() => service.create({
      sessionId: RlmRuntimeSessionId('rlm-session-prime-no-allocator-default'),
      commandId: RlmCommandId('create-prime-no-allocator-default'),
      executionId: 'execution-prime-no-allocator-default',
      workspace: root,
      task: 'preserve exact parent inheritance',
      model: { operatorId: 'claude-code', model: 'claude-opus-4-1' },
      defaultChildModel: { operatorId: 'codex', model: 'gpt-5.6-luna' },
      childModelPolicy: 'parent-inherit',
      limits,
    }, { dispatchChild: () => { throw new Error('must not dispatch') } })).toThrow(expect.objectContaining({ code: 'RLM_INVALID' }))
    await ctx.root.fiber.dispose()
  })

  it('inherits the sealed parent execution options without exposing a child override path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-prime-execution-options-'))
    const ctx = new Context()
    const service = new LocalRlmRuntime(ctx, root)
    const sessionId = RlmRuntimeSessionId('rlm-session-prime-execution-options')
    const parentModel = {
      operatorId: 'claude-code', model: 'claude-opus-4-1', profile: { model: 'claude-opus-4-1', effort: 'max' as const },
    }
    const executionOptions = {
      version: 1,
      tools: [{
        name: 'workspace.read', description: 'Read a bounded workspace artifact', parameters: { type: 'object' },
      }],
      skills: [{
        alias: 'repo-inspect', title: 'Repository inspection', callable: 'repo.inspect', available: true,
        binding: {
          entryId: 'repo-inspect', entryVersion: 3, digest: 'repo-inspect-v3',
          moduleId: 'repo-tools', callable: 'repo.inspect',
        },
      }],
      retryPolicy: {
        mode: 'normal', maxRetries: 2, retryableCodes: ['TIMEOUT'],
        initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0,
      },
      capabilityContext: {
        contextPacketRef: 'sha256:context',
        capabilityPlanRef: 'sha256:capability',
        graphCertificateHash: 'sha256:graph',
      },
    } as const satisfies RlmChildExecutionOptionsV1
    const dispatched: Array<{ model: unknown; modelOrigin: unknown; executionOptions: unknown }> = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async (request) => {
        dispatched.push({ model: request.model, modelOrigin: request.modelOrigin, executionOptions: request.executionOptions })
        return {
          nativeSessionId: `native-${request.name}`, nativeTurnId: `turn-${request.name}`,
          result: Promise.resolve({ status: 'settled' }), interrupt: () => Promise.resolve(),
        }
      },
    }
    await service.create({
      sessionId, commandId: RlmCommandId('create-prime-execution-options'), executionId: 'execution-prime-execution-options',
      workspace: root, task: 'preserve parent execution context', model: parentModel,
      childModelPolicy: 'parent-inherit', executionOptions, limits,
    }, bindings)
    await service.executeCell({
      sessionId, commandId: RlmCommandId('spawn-prime-execution-options'),
      code: 'await rlm("inherit execution options", { name: "inherited-options" })',
    })
    const child = (await service.listChildren(sessionId))[0]!
    expect(dispatched).toEqual([{ model: parentModel, modelOrigin: 'parent-inherited', executionOptions }])
    await expect(service.inspect(child.sessionId)).resolves.toMatchObject({
      model: parentModel,
      childModelPolicy: 'parent-inherit',
      executionOptions,
    })
    await ctx.root.fiber.dispose()

    const recoveredContext = new Context()
    const recovered = new LocalRlmRuntime(recoveredContext, root)
    await expect(recovered.inspect(child.sessionId)).resolves.toMatchObject({
      model: parentModel,
      childModelPolicy: 'parent-inherit',
      executionOptions,
    })
    await recoveredContext.root.fiber.dispose()
  })

  it('does not replay a strict child dispatch receipt after Provider restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-strict-restart-'))
    const pending = deferred<RlmChildExecutionResult>()
    let dispatches = 0
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async (request) => {
        dispatches += 1
        return {
          nativeSessionId: `native-${request.name}`,
          nativeTurnId: `turn-${request.name}`,
          result: pending.promise,
          interrupt: () => Promise.resolve(),
        }
      },
    }
    const first = await runtime(root, bindings)
    await first.service.create({
      sessionId: RlmRuntimeSessionId('rlm-session-strict-restart'),
      commandId: RlmCommandId('create-strict-restart'),
      executionId: 'execution-strict-restart',
      workspace: root,
      task: 'preserve one strict child receipt',
      model: { operatorId: 'claude-code', model: 'claude-opus-4-1' },
      childModelPolicy: 'parent-inherit',
      executionOptions: { version: 1 },
      limits,
    }, bindings)
    const strictSessionId = RlmRuntimeSessionId('rlm-session-strict-restart')
    const admitted = await first.service.executeCell({
      sessionId: strictSessionId,
      commandId: RlmCommandId('spawn-before-restart'),
      code: 'await rlm("preserve this native receipt", { name: "strict-child" })',
    })
    expect(dispatches).toBe(1)
    const statePath = join(root, 'state.json')
    const recoveredRoot = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-strict-recovered-'))
    await copyFile(statePath, join(recoveredRoot, 'state.json'))
    await first.ctx.root.fiber.dispose()

    const recoveredContext = new Context()
    const recovered = new LocalRlmRuntime(recoveredContext, recoveredRoot)
    await recovered.bindHost(strictSessionId, bindings)
    const child = (await recovered.listChildren(strictSessionId))[0]!
    expect(child).toMatchObject({ lifecycle: 'indeterminate', modelOrigin: 'parent-inherited' })
    await expect(recovered.inspect(child.sessionId)).resolves.toMatchObject({ childModelPolicy: 'parent-inherit' })
    await expect(recovered.inspectReceipt(RlmCommandId('spawn-before-restart:child:1')))
      .resolves.toMatchObject({ state: 'settled', operation: 'child.spawn' })
    await expect(recovered.executeCell({
      sessionId: strictSessionId,
      commandId: RlmCommandId('spawn-before-restart'),
      code: 'await rlm("preserve this native receipt", { name: "strict-child" })',
    })).resolves.toEqual(admitted)
    expect(dispatches).toBe(1)
    await recoveredContext.root.fiber.dispose()
  })

  describe('the durable state file', () => {
    type StateJson = {
      version?: number
      messages: Array<Record<string, unknown>>
      messageBatchDispatches?: unknown
    } & Record<string, unknown>

    async function freshState(): Promise<StateJson> {
      const sourceRoot = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-state-source-'))
      const first = await runtime(sourceRoot, { dispatchChild: () => { throw new Error('not used') } })
      await first.ctx.root.fiber.dispose()
      return JSON.parse(await readFile(join(sourceRoot, 'state.json'), 'utf8')) as StateJson
    }

    function messageOf(outcome: unknown): string { return outcome instanceof Error ? outcome.message : '' }

    function message(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        version: 1, messageId: id, commandId: `send-${id}`, fromSessionId: 'rlm-session-other', toSessionId: 'rlm-session-root',
        mode: 'steer', text: 'x', effectiveMode: 'steer', deliveryStatus: 'queued', queuedAt: '2026-10-16T00:00:00.000Z',
        createdAt: '2026-10-16T00:00:00.000Z', ...patch,
      }
    }

    function record(ids: string[], patch: Record<string, unknown> = {}): Record<string, unknown> {
      const [first] = ids
      return {
        version: 1,
        commandId: ids.length === 1 ? `${first}:deliver` : 'wrong',
        sessionId: 'rlm-session-root', messageIds: ids, state: 'held', createdAt: '2026-10-16T00:00:00.000Z', ...patch,
      }
    }

    async function load(state: StateJson): Promise<{ readonly bytes: string; readonly outcome: unknown }> {
      const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-state-load-'))
      const bytes = `${JSON.stringify(state)}\n`
      await writeFile(join(root, 'state.json'), bytes, { mode: 0o600 })
      let outcome: unknown
      try {
        const context = new Context()
        outcome = new LocalRlmRuntime(context, root)
        await context.root.fiber.dispose()
      } catch (error) {
        outcome = error
      }
      expect(await readFile(join(root, 'state.json'), 'utf8')).toBe(bytes)
      return { bytes, outcome }
    }

    it.each([1, 2, 3, 4, 5, 7])('refuses a version %i file by name and leaves its bytes unchanged', async (version) => {
      const state = await freshState()
      state.version = version
      delete state.messageBatchDispatches
      const { outcome } = await load(state)
      expect(outcome).toMatchObject({ code: 'RLM_UNAVAILABLE' })
      expect(messageOf(outcome)).toContain(`version ${String(version)}`)
    })

    it('refuses a version 6 file that has no messageBatchDispatches, leaving it unchanged', async () => {
      const state = await freshState()
      delete state.messageBatchDispatches
      const { outcome } = await load(state)
      expect(outcome).toMatchObject({ code: 'RLM_UNAVAILABLE' })
      expect(messageOf(outcome)).toContain('unsupported shape')
    })

    it('loads a version 6 file and keeps accepted and held batches', async () => {
      const state = await freshState()
      state.messages = [message('m1', { deliveryStatus: 'delivered' }), message('m2')]
      state.messageBatchDispatches = [record(['m1'], { state: 'accepted' }), record(['m2'])]
      expect((await load(state)).outcome).toBeInstanceOf(LocalRlmRuntime)
    })

    it.each([
      ['a record that is not an object', () => ({ state: 'held' }), []],
      ['an unknown state', () => record(['m1'], { state: 'done' }), ['m1']],
      ['no members', () => record([], { commandId: 'x' }), []],
      ['a duplicate member', () => record(['m1', 'm1']), ['m1']],
      ['a command that does not match its members', () => record(['m1'], { commandId: 'm1:batch-9-00000000:deliver' }), ['m1']],
      ['a member that is not in the state', () => record(['gone']), []],
      ['a member addressed to another session', () => record(['m1'], { sessionId: 'rlm-session-elsewhere' }), ['m1']],
      ['an accepted batch whose member is still queued', () => record(['m1'], { state: 'accepted' }), ['m1']],
      ['an intended batch whose member is delivered', () => record(['m1'], { state: 'intended' }), ['m1:delivered']],
    ])('refuses %s, leaving the file unchanged', async (_name, make, ids) => {
      const state = await freshState()
      state.messages = ids.map((id) => {
        const [name, status] = id.split(':')
        return message(name!, status === 'delivered' ? { deliveryStatus: 'delivered' } : {})
      })
      state.messageBatchDispatches = [make()]
      expect((await load(state)).outcome).toMatchObject({ code: 'RLM_UNAVAILABLE' })
    })

    it('refuses a member that is in two batches', async () => {
      const state = await freshState()
      state.messages = [message('m1'), message('m2')]
      state.messageBatchDispatches = [record(['m1']), record(['m1'])]
      const { outcome } = await load(state)
      expect(outcome).toMatchObject({ code: 'RLM_UNAVAILABLE' })
      expect(messageOf(outcome)).toContain('two batches')
    })

    it('refuses members whose delivery order disagrees with their record', async () => {
      const state = await freshState()
      state.messages = [
        message('m1', { effectiveMode: 'follow_up' }),
        message('m2', { effectiveMode: 'steer' }),
      ]
      const members = ['m1', 'm2']
      state.messageBatchDispatches = [record(members, { commandId: `m1:batch-2-${createHash('sha256').update('["m1","m2"]').digest('hex').slice(0, 8)}:deliver` })]
      const { outcome } = await load(state)
      expect(outcome).toMatchObject({ code: 'RLM_UNAVAILABLE' })
      expect(messageOf(outcome)).toContain('out of order')
    })
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
    })).rejects.toMatchObject({ code: 'RLM_INVALID', message: 'Unsupported rlm() options: retries, tools' })
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
    const continuationRequests: Array<{ deliveryMode: string; instruction: string; messageOrigin?: string | undefined }> = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async request => ({
        nativeSessionId: `child:${request.childSessionId}`,
        nativeTurnId: `child-turn:${request.childId}`,
        result: Promise.resolve({ status: 'settled' }),
        interrupt: () => Promise.resolve(),
      }),
      dispatchContinuation: async (request) => {
        continuationRequests.push({
          deliveryMode: request.deliveryMode, instruction: request.instruction, messageOrigin: request.messageOrigin,
        })
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
    expect(continuationRequests[0]).toMatchObject({ deliveryMode: 'steer', messageOrigin: 'agent' })
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

  it.each([
    ['failed', 'error'],
    ['indeterminate', 'aborted'],
  ] as const)('keeps the %s status, partial output and stop reason of the last continuation through drain', async (status, stopReason) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-continuation-failure-'))
    const rootExecution = deferred<RlmChildExecutionResult>()
    const continuation = deferred<RlmChildExecutionResult>()
    const requests: string[] = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async request => ({
        nativeSessionId: `child:${request.childSessionId}`,
        nativeTurnId: `child-turn:${request.childId}`,
        result: Promise.resolve({ status: 'settled' }),
        interrupt: () => Promise.resolve(),
      }),
      dispatchContinuation: async (request) => {
        requests.push(String(request.commandId))
        return {
          nativeSessionId: `continuation:${request.sessionId}`,
          nativeTurnId: `continuation-turn:${request.commandId}`,
          result: continuation.promise,
          interrupt: () => Promise.resolve(),
        }
      },
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    await service.trackExecution(sessionId, {
      nativeSessionId: 'root-native', nativeTurnId: 'root-turn', result: rootExecution.promise, interrupt: () => Promise.resolve(),
    })
    const child = await service.spawn({
      commandId: RlmCommandId('failure-child'), parentSessionId: sessionId, name: 'messenger', task: 'send bounded evidence',
    })
    await service.sendMessage({
      commandId: RlmCommandId('failure-message'), fromSessionId: child.sessionId, toSessionId: sessionId,
      mode: 'follow_up', text: 'evidence',
    })
    rootExecution.resolve({ status: 'settled' })
    await waitUntil(() => requests.length === 1)
    continuation.resolve({ status, stopReason, output: [{ type: 'text', text: 'partial output' }], error: 'did not finish' })
    const drained = await service.drain(sessionId, 1_000)
    expect(drained.lastContinuation).toEqual({
      status, stopReason, output: [{ type: 'text', text: 'partial output' }], error: 'did not finish',
    })
    await ctx.root.fiber.dispose()
  })

  it('interrupts the active executions of a deleted child and of what it spawned, and no others', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-delete-subtree-'))
    const interrupted: string[] = []
    const dispatchChild: RlmRuntimeHostBindings['dispatchChild'] = async request => ({
      nativeSessionId: `child:${request.childSessionId}`,
      nativeTurnId: `child-turn:${request.childId}`,
      // Every child execution stays open, so each one is active when the delete arrives.
      result: new Promise<RlmChildExecutionResult>(() => undefined),
      interrupt: () => { interrupted.push(request.name); return Promise.resolve() },
    })
    const { ctx, service, sessionId } = await runtime(root, { dispatchChild })
    const a = await service.spawn({ commandId: RlmCommandId('subtree-a'), parentSessionId: sessionId, name: 'a', task: 'child a' })
    const a1 = await service.spawn({ commandId: RlmCommandId('subtree-a1'), parentSessionId: a.sessionId, name: 'a1', task: 'grandchild' })
    await service.spawn({ commandId: RlmCommandId('subtree-a2'), parentSessionId: a1.sessionId, name: 'a2', task: 'great-grandchild' })
    await service.spawn({ commandId: RlmCommandId('subtree-b'), parentSessionId: sessionId, name: 'b', task: 'sibling' })
    await service.deleteChild(sessionId, a.rlmChildId, RlmCommandId('subtree-delete'))
    expect([...interrupted].sort()).toEqual(['a', 'a1', 'a2'])
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
        cacheReadInputTokens: 7,
        cacheWriteInputTokens: 1,
      })
      expect(firstUsage).toMatchObject({ active: true, status: 'active', tokensUsed: 6, timeUsedSeconds: 2 })

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
      expect(paused).toMatchObject({ active: false, status: 'paused', tokensUsed: 6, timeUsedSeconds: 2, lastReason: 'waiting for evidence' })
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
        inputTokens: 3,
        outputTokens: 0,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 1,
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
        inputTokens: 3,
        outputTokens: 0,
        cacheReadInputTokens: 20,
        cacheWriteInputTokens: 1,
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
    const requests: Array<{
      method: string
      params: Readonly<Record<string, unknown>>
      sealedSkill?: unknown
    }> = []
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: () => { throw new Error('not used') },
      hostRequest: async (request) => {
        requests.push({ method: request.method, params: request.params, sealedSkill: request.sealedSkill })
        if (request.method === 'skills.call') {
          const alias = request.params.alias
          if (typeof alias !== 'string') throw new Error('expected managed skill alias')
          return { ok: true, output: `summary:${alias}` }
        }
        throw new Error(`unexpected host method ${request.method}`)
      },
    }
    const { ctx, service, sessionId } = await runtime(root, bindings, {
      version: 1,
      skills: [{
        alias: 'summarize', title: 'Summarize', callable: 'summarize', available: true,
        binding: {
          entryId: 'summarize', entryVersion: 7, digest: 'summarize-v7',
          moduleId: 'skill-provider-v1', callable: 'summarize',
        },
      }],
    })
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
      {
        method: 'skills.call',
        params: { alias: 'summarize', args: { text: 'bounded evidence' } },
        sealedSkill: {
          entryId: 'summarize', entryVersion: 7, digest: 'summarize-v7',
          moduleId: 'skill-provider-v1', callable: 'summarize',
        },
      },
    ])
    const invalid = await service.executeCell({
      sessionId,
      commandId: RlmCommandId('invalid-skill-call'),
      code: [
        'const path = await skills.call("../arbitrary-import", {});',
        'const scoped = await skills.call("@scope/pkg", {});',
        'const dotted = await skills.call("internal.module", {});',
        'const unlisted = await skills.call("not-sealed", {});',
        '({ path, scoped, dotted, unlisted })',
      ].join('\n'),
    })
    const rejected = {
      ok: false,
      error: { code: 'RLM_INVALID', message: 'skills.call requires a Host-issued managed skill alias, not a module path' },
    }
    expect(invalid.value).toEqual({
      path: rejected,
      scoped: rejected,
      dotted: rejected,
      unlisted: {
        ok: false,
        error: {
          code: 'RLM_INVALID',
          message: 'managed skill is absent from the sealed parent execution: not-sealed',
        },
      },
    })
    await expect(service.inspectReceipt(RlmCommandId('invalid-skill-call'))).resolves.toMatchObject({
      state: 'settled',
    })
    expect(requests).toHaveLength(1)
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
    expect(bridge).toMatchObject({
      version: 1,
      sessionId,
      tools: [{
        name: RLM_TYPESCRIPT_REPL_TOOL_SCHEMA.name,
        description: RLM_TYPESCRIPT_REPL_TOOL_SCHEMA.description,
        inputSchema: RLM_TYPESCRIPT_REPL_TOOL_SCHEMA.parameters,
      }],
    })
    expect(bridge.tools[0]?.inputSchema).toEqual(RLM_TYPESCRIPT_REPL_TOOL_SCHEMA.parameters)
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

  it('serves the RLM bridge when the configured temporary root exceeds Unix socket limits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-runtime-long-bridge-'))
    vi.stubEnv('TMPDIR', join('/tmp', 'dsh-long-temporary-root-'.repeat(8)))
    const { ctx, service, sessionId } = await runtime(root, { dispatchChild: () => { throw new Error('not used') } })
    let socketPath = ''
    try {
      const bridge = await service.modelToolBridge(sessionId)
      socketPath = bridge.socketPath
      expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103)
      const socket = createConnection(socketPath)
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
      socket.destroy()
    } finally {
      await ctx.root.fiber.dispose()
      if (socketPath.length > 0) expect(existsSync(socketPath)).toBe(false)
      vi.unstubAllEnvs()
    }
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

describe('LocalRlmRuntime after a permanent delete', () => {
  /**
   * Root with A and B; A has A1. Executions named in `held` stay open until their interrupt, the others settle at once, which
   * leaves their session idle between two turns. A `stuck` execution survives its interrupt request, as a Resident turn
   * that has not stopped yet does.
   */
  interface TreeOptions {
    readonly held?: readonly string[]
    readonly stuck?: readonly string[]
    readonly failInterrupt?: readonly string[]
    /** Executions whose interrupt rejects with a value that is not an Error. */
    readonly failInterruptPlain?: readonly string[]
    /** Executions whose result rejects once an interrupt was requested, even if the request itself failed. */
    readonly rejectResult?: readonly string[]
    /** Continuations stay open and survive their interrupt request, as a Resident turn that has not stopped yet does. */
    readonly stuckContinuations?: boolean
    /** The child of this name is deleted at the moment the runtime first reads its result, right after it registered it. */
    readonly deleteOnRegistration?: string
  }
  async function tree(prefix: string, options: TreeOptions = {}) {
    const root = await mkdtemp(join(tmpdir(), prefix))
    const held = new Set(options.held ?? [])
    const stuck = new Set(options.stuck ?? [])
    const failInterrupt = new Set(options.failInterrupt ?? [])
    const failInterruptPlain = new Set(options.failInterruptPlain ?? [])
    const rejectResult = new Set(options.rejectResult ?? [])
    const results = new Map<string, ReturnType<typeof deferred<RlmChildExecutionResult>>>()
    const interrupted: string[] = []
    const continuations: string[] = []
    const gate = { dispatch: undefined as Promise<void> | undefined }
    const race: { service?: LocalRlmRuntime; deletion?: Promise<void> | undefined } = {}
    const execution = (name: string, nativeTurnId: string, settleOnInterrupt: boolean) => {
      const result = deferred<RlmChildExecutionResult>()
      if (!held.has(name) && !(options.stuckContinuations === true && name.startsWith('continuation:'))) result.resolve({ status: 'settled' })
      results.set(name, result)
      return {
        nativeSessionId: `native-${name}`,
        nativeTurnId,
        result: result.promise,
        interrupt: (): Promise<void> => {
          interrupted.push(name)
          if (rejectResult.has(name)) result.reject(new Error(`${name} stopped`))
          if (failInterrupt.has(name)) return Promise.reject(new Error(`${name} cannot be interrupted`))
          // oxlint-disable-next-line prefer-promise-reject-errors -- the service contract accepts any rejection value
          if (failInterruptPlain.has(name)) return Promise.reject(`${name} refused`)
          if (settleOnInterrupt) result.resolve({ status: 'failed', stopReason: 'aborted', error: 'interrupted' })
          return Promise.resolve()
        },
      }
    }
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: async (request) => {
        await gate.dispatch
        const started = execution(request.name, `turn-${request.name}`, !stuck.has(request.name))
        if (request.name !== options.deleteOnRegistration) return started
        return {
          nativeSessionId: started.nativeSessionId,
          nativeTurnId: started.nativeTurnId,
          interrupt: started.interrupt,
          get result() {
            race.deletion ??= race.service?.deleteChild(request.parentSessionId, request.childId, RlmCommandId('race-delete'))
            return started.result
          },
        }
      },
      dispatchContinuation: async (request) => {
        continuations.push(String(request.sessionId))
        await gate.dispatch
        return execution(`continuation:${String(request.sessionId)}`, String(request.commandId), options.stuckContinuations !== true)
      },
    }
    const { ctx, service, sessionId } = await runtime(root, bindings)
    race.service = service
    const a = await service.spawn({ commandId: RlmCommandId('tree-a'), parentSessionId: sessionId, name: 'a', task: 'child a' })
    const b = await service.spawn({ commandId: RlmCommandId('tree-b'), parentSessionId: sessionId, name: 'b', task: 'sibling' })
    const a1 = await service.spawn({ commandId: RlmCommandId('tree-a1'), parentSessionId: a.sessionId, name: 'a1', task: 'grandchild' })
    const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20))
    await settle()
    return { root, ctx, service, sessionId, a, b, a1, results, interrupted, continuations, gate, race, bindings, settle }
  }
  const message = (id: string, from: RlmRuntimeSessionId, to: RlmRuntimeSessionId) => (
    { commandId: RlmCommandId(id), fromSessionId: from, toSessionId: to, mode: 'follow_up', text: id } as const
  )

  it('does not deliver a message that was queued for a session of a deleted subtree', async () => {
    const t = await tree('dsh-rlm-closed-queued-', { held: ['a1'] })
    await t.service.sendMessage(message('queued-a1', t.a.sessionId, t.a1.sessionId))
    expect(t.continuations).toEqual([])
    await t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))
    await t.settle()
    await t.service.pumpMessages()
    expect(t.continuations).toEqual([])
    await t.ctx.root.fiber.dispose()
  })

  it('does not run a due heartbeat of a session in a deleted subtree', async () => {
    const t = await tree('dsh-rlm-closed-heartbeat-')
    const heartbeat = await t.service.createHeartbeat({
      sessionId: t.a1.sessionId, commandId: RlmCommandId('closed-heartbeat'), instruction: 'check progress', interval: '1s',
    })
    await t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))
    const dueAt = new Date(Date.parse(heartbeat.nextRunAt!) + 1).toISOString()
    await expect(t.service.pumpHeartbeats(dueAt)).resolves.toBe(0)
    expect(t.continuations).toEqual([])
    await expect(t.service.claimDueHeartbeats(dueAt)).resolves.toEqual([])
    await t.ctx.root.fiber.dispose()
  })

  it('still admits the root and a sibling after A is deleted, and a plain interrupt of A keeps its subtree open', async () => {
    const t = await tree('dsh-rlm-closed-controls-', { held: ['a1'] })
    await t.service.sendMessage(message('queued-a1', t.a.sessionId, t.a1.sessionId))
    await t.service.interrupt(t.a.sessionId)
    await t.settle()
    expect(t.continuations).toEqual([String(t.a1.sessionId)])
    await t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))
    await t.service.sendMessage(message('to-b', t.sessionId, t.b.sessionId))
    await t.settle()
    expect(t.continuations).toContain(String(t.b.sessionId))
    await t.ctx.root.fiber.dispose()
  })

  it('interrupts a child execution that is dispatched while its subtree is being deleted, and keeps the child deleted', async () => {
    const t = await tree('dsh-rlm-closed-late-child-')
    const opened = deferred<undefined>()
    t.gate.dispatch = opened.promise
    const spawned = t.service.spawn({
      commandId: RlmCommandId('late-c'), parentSessionId: t.sessionId, name: 'c', task: 'dispatched while deleting',
    })
    const settled = spawned.then(() => 'registered', () => 'refused')
    await waitUntil(async () => (await t.service.listChildren(t.sessionId)).some(child => child.name === 'c'))
    const c = (await t.service.listChildren(t.sessionId)).find(child => child.name === 'c')!
    await t.service.deleteChild(t.sessionId, c.rlmChildId, RlmCommandId('delete-c'))
    opened.resolve(undefined)
    await expect(settled).resolves.toBe('refused')
    expect(t.interrupted).toContain('c')
    expect((await t.service.listChildren(t.sessionId)).find(child => child.name === 'c')?.lifecycle).toBe('deleted')
    await expect(t.service.drain(t.sessionId, 200)).resolves.toMatchObject({ activeExecutions: 0 })
    await t.ctx.root.fiber.dispose()
  })

  it.each([
    ['c', { held: ['c'], failInterrupt: ['c'], rejectResult: ['c'] }, 'interrupting it also failed: c cannot be interrupted'],
    ['d', { failInterruptPlain: ['d'] }, 'interrupting it also failed: d refused'],
  ] as const)('names a failed interrupt of the late execution %s in the refusal', async (name, options, expected) => {
    const t = await tree('dsh-rlm-closed-late-failed-interrupt-', options)
    const opened = deferred<undefined>()
    t.gate.dispatch = opened.promise
    const spawned = t.service.spawn({ commandId: RlmCommandId(`late-${name}`), parentSessionId: t.sessionId, name, task: 'dispatched while deleting' })
    const settled = spawned.then(() => 'registered', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    await waitUntil(async () => (await t.service.listChildren(t.sessionId)).some(child => child.name === name))
    const child = (await t.service.listChildren(t.sessionId)).find(value => value.name === name)!
    await t.service.deleteChild(t.sessionId, child.rlmChildId, RlmCommandId(`delete-${name}`))
    opened.resolve(undefined)
    await expect(settled).resolves.toContain(expected)
    await t.ctx.root.fiber.dispose()
  })

  it('records a child whose dispatch failed with a value that is not an Error', async () => {
    const t = await tree('dsh-rlm-closed-plain-dispatch-failure-')
    const opened = deferred<undefined>()
    t.gate.dispatch = opened.promise
    const spawned = t.service.spawn({ commandId: RlmCommandId('plain-failure'), parentSessionId: t.sessionId, name: 'e', task: 'dispatch rejects' })
    const settled = spawned.then(() => 'registered', (error: unknown) => error)
    await waitUntil(async () => (await t.service.listChildren(t.sessionId)).some(child => child.name === 'e'))
    opened.reject('dispatch refused')
    await expect(settled).resolves.toBe('dispatch refused')
    const children = await t.service.listChildren(t.sessionId)
    expect(children.find(child => child.name === 'e')).toMatchObject({ lifecycle: 'failed', error: 'dispatch refused' })
    await t.ctx.root.fiber.dispose()
  })

  it('interrupts a continuation that is dispatched while its subtree is being deleted', async () => {
    const t = await tree('dsh-rlm-closed-late-continuation-')
    const opened = deferred<undefined>()
    t.gate.dispatch = opened.promise
    const sent = t.service.sendMessage(message('late-a1', t.a.sessionId, t.a1.sessionId))
    await waitUntil(() => t.continuations.length === 1)
    await t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))
    opened.resolve(undefined)
    await sent.catch(() => undefined)
    await t.settle()
    expect(t.interrupted).toContain(`continuation:${String(t.a1.sessionId)}`)
    await expect(t.service.readMessages({ sessionId: t.a1.sessionId })).resolves.toMatchObject([{ deliveryStatus: 'queued' }])
    const events = await t.service.readEvents({ sessionId: t.a1.sessionId, limit: 100 })
    expect(events.map(event => event.type)).not.toContain('rlm.message.delivered')
    await expect(t.service.drain(t.sessionId, 200)).resolves.toMatchObject({ activeExecutions: 0 })
    await t.ctx.root.fiber.dispose()
  })

  it('interrupts a heartbeat execution that is dispatched while its subtree is being deleted, and does not count it', async () => {
    const t = await tree('dsh-rlm-closed-late-heartbeat-')
    const heartbeat = await t.service.createHeartbeat({
      sessionId: t.a1.sessionId, commandId: RlmCommandId('late-heartbeat'), instruction: 'check progress', interval: '1s',
    })
    const opened = deferred<undefined>()
    t.gate.dispatch = opened.promise
    const pumped = t.service.pumpHeartbeats(new Date(Date.parse(heartbeat.nextRunAt!) + 1).toISOString())
    await waitUntil(() => t.continuations.length === 1)
    await t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))
    opened.resolve(undefined)
    await expect(pumped).resolves.toBe(0)
    expect(t.interrupted).toContain(`continuation:${String(t.a1.sessionId)}`)
    await expect(t.service.drain(t.sessionId, 200)).resolves.toMatchObject({ activeExecutions: 0 })
    await t.ctx.root.fiber.dispose()
  })

  it('keeps a child deleted when the delete lands right after its execution was registered', async () => {
    const t = await tree('dsh-rlm-closed-registration-race-', { held: ['f'], deleteOnRegistration: 'f' })
    await t.service.spawn({ commandId: RlmCommandId('race-f'), parentSessionId: t.sessionId, name: 'f', task: 'registered, then deleted' })
    await t.race.deletion
    expect(t.interrupted).toContain('f')
    const children = await t.service.listChildren(t.sessionId)
    expect(children.find(child => child.name === 'f')?.lifecycle).toBe('deleted')
    await t.ctx.root.fiber.dispose()
  })

  it('interrupts a deleted descendant that is still stopping when the root is interrupted', async () => {
    const t = await tree('dsh-rlm-closed-interrupt-root-', { held: ['a1'], stuck: ['a1'] })
    await t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))
    await t.service.interrupt(t.sessionId)
    expect(t.interrupted.filter(name => name === 'a1')).toHaveLength(2)
    await t.ctx.root.fiber.dispose()
  })

  describe('an execution that is dispatched while its subtree is being deleted and survives its interrupt', () => {
    /** Each late path hands the runtime an execution after the delete; the execution ignores the interrupt request. */
    const paths = [
      ['child dispatch', 'c', { held: ['c'], stuck: ['c'] }],
      ['message continuation', 'continuation', { stuckContinuations: true }],
      ['heartbeat', 'continuation', { stuckContinuations: true }],
    ] as const

    async function lateExecution(label: (typeof paths)[number][0], options: TreeOptions) {
      const t = await tree('dsh-rlm-closed-late-tracked-', options)
      const opened = deferred<undefined>()
      t.gate.dispatch = opened.promise
      let admitted: Promise<unknown>
      if (label === 'child dispatch') {
        admitted = t.service.spawn({ commandId: RlmCommandId('late-c'), parentSessionId: t.sessionId, name: 'c', task: 'dispatched while deleting' })
        await waitUntil(async () => (await t.service.listChildren(t.sessionId)).some(child => child.name === 'c'))
      } else if (label === 'message continuation') {
        admitted = t.service.sendMessage(message('late-message', t.a.sessionId, t.a1.sessionId))
        await waitUntil(() => t.continuations.length === 1)
      } else {
        const heartbeat = await t.service.createHeartbeat({
          sessionId: t.a1.sessionId, commandId: RlmCommandId('late-heartbeat'), instruction: 'check progress', interval: '1s',
        })
        admitted = t.service.pumpHeartbeats(new Date(Date.parse(heartbeat.nextRunAt!) + 1).toISOString())
        await waitUntil(() => t.continuations.length === 1)
      }
      const target = label === 'child dispatch'
        ? (await t.service.listChildren(t.sessionId)).find(child => child.name === 'c')!
        : t.a
      await t.service.deleteChild(t.sessionId, target.rlmChildId, RlmCommandId('delete-target'))
      opened.resolve(undefined)
      const admission = await admitted.then(() => 'registered', (error: unknown) => (error instanceof Error ? error.message : String(error)))
      const name = label === 'child dispatch' ? 'c' : `continuation:${String(t.a1.sessionId)}`
      return { t, name, admission }
    }

    it.each(paths)('keeps the refused %s tracked, so the root is not reported drained until it ends', async (label, _name, options) => {
      const { t, name } = await lateExecution(label, options)
      expect(t.interrupted).toContain(name)
      await expect(t.service.drain(t.sessionId, 60)).rejects.toMatchObject({ code: 'RLM_SESSION_BUSY' })
      t.results.get(name)!.resolve({ status: 'settled' })
      await expect(t.service.drain(t.sessionId, 500)).resolves.toMatchObject({ activeExecutions: 0 })
      await t.ctx.root.fiber.dispose()
    })

    it('releases a refused execution whose result rejects', async () => {
      const { t, name } = await lateExecution('child dispatch', { held: ['c'], stuck: ['c'] })
      await expect(t.service.drain(t.sessionId, 60)).rejects.toMatchObject({ code: 'RLM_SESSION_BUSY' })
      t.results.get(name)!.reject(new Error('stopped late'))
      await expect(t.service.drain(t.sessionId, 500)).resolves.toMatchObject({ activeExecutions: 0 })
      await t.ctx.root.fiber.dispose()
    })

    it('names a rejected interrupt of a refused execution whose result stays pending, and keeps it reachable until it settles', async () => {
      const { t, name, admission } = await lateExecution('child dispatch', { held: ['c'], stuck: ['c'], failInterrupt: ['c'] })
      expect(admission).toContain('interrupting it also failed: c cannot be interrupted')
      await expect(t.service.drain(t.sessionId, 60)).rejects.toMatchObject({ code: 'RLM_SESSION_BUSY' })
      const count = () => t.interrupted.filter(value => value === name).length
      const first = count()
      await t.service.interrupt(t.sessionId)
      expect(count()).toBe(first + 1)
      const c = (await t.service.listChildren(t.sessionId)).find(child => child.name === 'c')!
      await expect(t.service.deleteChild(t.sessionId, c.rlmChildId, RlmCommandId('delete-c-again'))).rejects.toThrow('c cannot be interrupted')
      expect(count()).toBe(first + 2)
      t.results.get(name)!.resolve({ status: 'settled' })
      await expect(t.service.drain(t.sessionId, 500)).resolves.toMatchObject({ activeExecutions: 0 })
      await t.ctx.root.fiber.dispose()
    })

    it('interrupts a refused execution again when the root is interrupted or the delete is repeated', async () => {
      const { t, name } = await lateExecution('child dispatch', { held: ['c'], stuck: ['c'] })
      const count = () => t.interrupted.filter(value => value === name).length
      const first = count()
      await t.service.interrupt(t.sessionId)
      expect(count()).toBe(first + 1)
      const c = (await t.service.listChildren(t.sessionId)).find(child => child.name === 'c')!
      await t.service.deleteChild(t.sessionId, c.rlmChildId, RlmCommandId('delete-c-again'))
      expect(count()).toBe(first + 2)
      await t.ctx.root.fiber.dispose()
    })
  })

  it('keeps a rejected interrupt and a pending result visible until the result settles', async () => {
    const t = await tree('dsh-rlm-closed-rejected-interrupt-pending-', { held: ['a1'], failInterrupt: ['a1'] })
    await expect(t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))).rejects.toThrow('a1 cannot be interrupted')
    await expect(t.service.drain(t.sessionId, 60)).rejects.toMatchObject({ code: 'RLM_SESSION_BUSY' })
    const before = t.interrupted.filter(name => name === 'a1').length
    await t.service.interrupt(t.sessionId)
    expect(t.interrupted.filter(name => name === 'a1').length).toBe(before + 1)
    t.results.get('a1')!.resolve({ status: 'settled' })
    await expect(t.service.drain(t.sessionId, 500)).resolves.toMatchObject({ activeExecutions: 0 })
    await t.ctx.root.fiber.dispose()
  })

  it('does not report the root drained while an execution of a deleted descendant is still running', async () => {
    const t = await tree('dsh-rlm-closed-drain-', { held: ['a1'], stuck: ['a1'] })
    await t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))
    await expect(t.service.drain(t.sessionId, 60)).rejects.toMatchObject({ code: 'RLM_SESSION_BUSY' })
    await t.ctx.root.fiber.dispose()
  })

  it('keeps the subtree closed after the Provider restarts', async () => {
    const t = await tree('dsh-rlm-closed-restart-', { held: ['a1'], stuck: ['a1'] })
    await t.service.sendMessage(message('queued-a1', t.a.sessionId, t.a1.sessionId))
    await t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))
    await t.ctx.root.fiber.dispose()
    const recoveredContext = new Context()
    const recovered = new LocalRlmRuntime(recoveredContext, t.root)
    const before = t.continuations.length
    await recovered.bindHost(t.a1.sessionId, t.bindings)
    await recovered.pumpMessages()
    await t.settle()
    expect(t.continuations.length).toBe(before)
    await recoveredContext.root.fiber.dispose()
  })

  it('treats a session as closed when only its ancestor\'s record of the child says deleted', async () => {
    const t = await tree('dsh-rlm-closed-legacy-', { held: ['a1'], stuck: ['a1'] })
    await t.service.sendMessage(message('queued-a1', t.a.sessionId, t.a1.sessionId))
    await t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))
    await t.ctx.root.fiber.dispose()
    // A cell that finished after the delete, or a state written before this change, leaves every session open and only the
    // record of the deleted child in its parent.
    const statePath = join(t.root, 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { sessions: Array<{ snapshot: { sessionId: string; lifecycle: string } }> }
    for (const session of state.sessions) {
      if ([t.a.sessionId, t.a1.sessionId].map(String).includes(session.snapshot.sessionId)) session.snapshot.lifecycle = 'idle'
    }
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    const recoveredContext = new Context()
    const recovered = new LocalRlmRuntime(recoveredContext, t.root)
    const before = t.continuations.length
    await recovered.bindHost(t.a1.sessionId, t.bindings)
    await recovered.pumpMessages()
    await t.settle()
    expect(t.continuations.length).toBe(before)
    await expect(recovered.executeCell({
      sessionId: t.a1.sessionId, commandId: RlmCommandId('legacy-cell'), code: '1 + 1',
    })).rejects.toMatchObject({ code: 'RLM_UNAVAILABLE' })
    await recoveredContext.root.fiber.dispose()
  })

  it('refuses to spawn under, message, or run a cell in a session of a deleted subtree', async () => {
    const t = await tree('dsh-rlm-closed-refusals-')
    await t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a'))
    await expect(t.service.spawn({
      commandId: RlmCommandId('closed-spawn'), parentSessionId: t.a1.sessionId, name: 'late', task: 'must not start',
    })).rejects.toMatchObject({ code: 'RLM_UNAVAILABLE' })
    // Refused before anything was created or dispatched.
    await expect(t.service.listChildren(t.a1.sessionId)).resolves.toEqual([])
    expect(t.results.has('late')).toBe(false)
    await expect(t.service.sendMessage(message('closed-send', t.a.sessionId, t.a1.sessionId))).rejects.toMatchObject({ code: 'RLM_UNAVAILABLE' })
    // Only the sender is closed (A to its open sibling B), then only the receiver is closed (the root to A).
    await expect(t.service.sendMessage(message('closed-sender', t.a.sessionId, t.b.sessionId))).rejects.toMatchObject({ code: 'RLM_UNAVAILABLE' })
    await expect(t.service.sendMessage(message('closed-receiver', t.sessionId, t.a.sessionId))).rejects.toMatchObject({ code: 'RLM_UNAVAILABLE' })
    await expect(t.service.executeCell({
      sessionId: t.a1.sessionId, commandId: RlmCommandId('closed-cell'), code: '1 + 1',
    })).rejects.toMatchObject({ code: 'RLM_UNAVAILABLE' })
    await t.ctx.root.fiber.dispose()
  })

  it('records a delete whose interrupt failed, keeps the subtree closed, and lets a new delete command interrupt again', async () => {
    const t = await tree('dsh-rlm-closed-failed-delete-', { held: ['a1'], failInterrupt: ['a1'] })
    const command = RlmCommandId('delete-a')
    await expect(t.service.deleteChild(t.sessionId, t.a.rlmChildId, command)).rejects.toThrow('a1 cannot be interrupted')
    await expect(t.service.inspectReceipt(command)).resolves.toMatchObject({ state: 'failed' })
    await expect(t.service.deleteChild(t.sessionId, t.a.rlmChildId, command)).rejects.toThrow('a1 cannot be interrupted')
    expect((await t.service.listChildren(t.sessionId)).find(child => child.name === 'a')?.lifecycle).toBe('deleted')
    await expect(t.service.sendMessage(message('after-failed-delete', t.a.sessionId, t.a1.sessionId))).rejects.toMatchObject({ code: 'RLM_UNAVAILABLE' })
    const interruptsBefore = t.interrupted.filter(name => name === 'a1').length
    await expect(t.service.deleteChild(t.sessionId, t.a.rlmChildId, RlmCommandId('delete-a-again'))).rejects.toThrow('a1 cannot be interrupted')
    expect(t.interrupted.filter(name => name === 'a1').length).toBe(interruptsBefore + 1)
    await expect(t.service.drain(t.sessionId, 60)).rejects.toMatchObject({ code: 'RLM_SESSION_BUSY' })
    await t.ctx.root.fiber.dispose()
  })
})
