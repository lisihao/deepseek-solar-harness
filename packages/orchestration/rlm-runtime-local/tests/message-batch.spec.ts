import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  RlmCommandId,
  RlmControlCallerId,
  RlmRuntimeError,
  RlmRuntimeSessionId,
  type RlmChildExecution,
  type RlmChildExecutionResult,
  type RlmRuntimeHostBindings,
} from '@deepseek-ai/dsh-rlm-runtime'
import { describe, expect, it, vi } from 'vitest'
import { LocalRlmRuntime } from '../src/index.ts'

type Dispatch = NonNullable<RlmRuntimeHostBindings['dispatchContinuation']>
type Request = Parameters<Dispatch>[0]

const limits = { maxDepth: 3, maxChildren: 4, maxTurns: 12, maxCellMs: 2_000, maxOutputBytes: 64 * 1024 } as const
const model = { operatorId: 'codex', model: 'gpt-5.6-luna' } as const
const MAX = 16_384

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

async function waitUntil(accept: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!await accept()) {
    if (Date.now() >= deadline) throw new Error('condition did not converge')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface Event { readonly type: string; readonly data: Record<string, unknown> }
interface StateFile {
  messageBatchDispatches: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
  events: Event[]
}

/** A root with one messenger child; the root stays busy until `release()` so messages queue first. */
async function setup(handler?: (request: Request, index: number) => Promise<RlmChildExecution> | RlmChildExecution) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-message-batch-'))
  const requests: Request[] = []
  const results: Array<ReturnType<typeof deferred<RlmChildExecutionResult>>> = []
  const bindings: RlmRuntimeHostBindings = {
    dispatchChild: request => Promise.resolve({
      nativeSessionId: `child:${request.childSessionId}`, nativeTurnId: `child-turn:${request.childId}`,
      result: Promise.resolve({ status: 'settled' }), interrupt: () => Promise.resolve(),
    }),
    dispatchContinuation: (request) => {
      requests.push(request)
      if (handler !== undefined) return Promise.resolve(handler(request, requests.length - 1))
      const result = deferred<RlmChildExecutionResult>()
      results.push(result)
      return Promise.resolve({
        nativeSessionId: `continuation:${request.sessionId}`, nativeTurnId: `turn:${request.commandId}`,
        result: result.promise, interrupt: () => Promise.resolve(),
      })
    },
  }
  const ctx = new Context()
  const service = new LocalRlmRuntime(ctx, root)
  const sessionId = RlmRuntimeSessionId('rlm-session-root')
  await service.create({
    sessionId, commandId: RlmCommandId('create-root'), executionId: 'execution-root', workspace: root,
    task: 'solve a bounded task', model, limits, context: { objective: 'test' },
  }, bindings)
  const rootExecution = deferred<RlmChildExecutionResult>()
  await service.trackExecution(sessionId, {
    nativeSessionId: 'root-native', nativeTurnId: 'root-turn', result: rootExecution.promise, interrupt: () => Promise.resolve(),
  })
  // The runtime allows three messages per second from one sender to one target, so the senders take turns.
  const children = await Promise.all([1, 2, 3, 4].map(number => service.spawn({
    commandId: RlmCommandId(`child-${String(number)}`), parentSessionId: sessionId, name: `messenger-${String(number)}`, task: 'send evidence',
  })))
  const child = children[0]!
  let counter = 0
  const send = (text: string, options: { mode?: 'steer' | 'follow_up'; artifactRefs?: string[] } = {}) => {
    counter += 1
    return service.sendMessage({
      commandId: RlmCommandId(`send-${String(counter)}`), fromSessionId: children[(counter - 1) % children.length]!.sessionId,
      toSessionId: sessionId, mode: options.mode ?? 'follow_up', text,
      ...options.artifactRefs === undefined ? {} : { artifactRefs: options.artifactRefs },
    })
  }
  const state = async (): Promise<StateFile> => JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as StateFile
  const events = async (): Promise<Event[]> => (await state()).events
  return {
    root, ctx, service, sessionId, child, requests, results, send, events, state, bindings,
    release: () => { rootExecution.resolve({ status: 'settled' }) },
  }
}

type Harness = Awaited<ReturnType<typeof setup>>

const block = (from: string, text: string, refs?: string[]): string => `Agent message from ${from}:\n${text}${refs === undefined ? '' : `\nArtifact references: ${refs.join(', ')}`}`
const noExecution = (): RlmChildExecution => ({ nativeSessionId: 'n', nativeTurnId: 't', result: Promise.resolve({ status: 'settled' }), interrupt: () => Promise.resolve() })
const pending = (): Promise<RlmChildExecutionResult> => new Promise<RlmChildExecutionResult>(() => undefined)

/** Another owner of the same state file, with a host that fails the test if it is ever asked to continue. */
async function reread(t: Harness): Promise<{ readonly calls: Request[]; readonly dispose: () => Promise<void> }> {
  const context = new Context()
  const owner = new LocalRlmRuntime(context, t.root)
  const calls: Request[] = []
  await owner.bindHost(t.sessionId, {
    ...t.bindings,
    dispatchContinuation: (request) => { calls.push(request); throw new Error('must not be sent') },
  })
  await owner.pumpMessages(t.sessionId)
  return { calls, dispose: () => context.root.fiber.dispose() }
}

describe('message batches', () => {
  it('delivers messages that were queued together as one continuation with one command', async () => {
    const t = await setup()
    const first = await t.send('first')
    const second = await t.send('second')
    t.release()
    await waitUntil(() => t.requests.length === 1)
    const [request] = t.requests
    expect(request).toMatchObject({
      source: 'message', messageOrigin: 'agent', deliveryMode: 'follow_up',
      messageIds: [first.messageId, second.messageId],
      instruction: `${block(first.fromSessionId, 'first')}\n\n${block(second.fromSessionId, 'second')}`,
    })
    expect(String(request!.commandId)).toMatch(new RegExp(`^${first.messageId}:batch-2-[0-9a-f]{8}:deliver$`))
    t.results[0]!.resolve({ status: 'settled', stopReason: 'completed', resultRef: 'sha256:r', output: [] })
    await expect(t.service.drain(t.sessionId, 1_000)).resolves.toMatchObject({ queuedMessages: 0, activeExecutions: 0 })
    const events = await t.events()
    const commandId = String(request!.commandId)
    expect(events.filter(e => e.type === 'rlm.message.delivered').map(e => e.data)).toMatchObject([
      { messageId: first.messageId, commandId, batchSize: 2, batchIndex: 0 },
      { messageId: second.messageId, commandId, batchSize: 2, batchIndex: 1 },
    ])
    expect(events.filter(e => e.type === 'rlm.message.continuation.settled').map(e => e.data)).toMatchObject([
      { messageId: first.messageId, commandId, resultRef: 'sha256:r', stopReason: 'completed', batchIndex: 0 },
      { messageId: second.messageId, commandId, resultRef: 'sha256:r', stopReason: 'completed', batchIndex: 1 },
    ])
    expect((await t.state()).messageBatchDispatches).toEqual([])
    await t.ctx.root.fiber.dispose()
  })

  it('sends a single message exactly as an unbatched delivery did', async () => {
    const t = await setup()
    const only = await t.send('only', { artifactRefs: ['b-ref', 'a-ref'] })
    t.release()
    await waitUntil(() => t.requests.length === 1)
    expect(t.requests[0]).toMatchObject({
      commandId: `${only.messageId}:deliver`, messageIds: [only.messageId],
      instruction: block(only.fromSessionId, 'only', ['a-ref', 'b-ref']),
    })
    t.results[0]!.resolve({ status: 'settled' })
    await t.service.drain(t.sessionId, 1_000)
    expect((await t.events()).find(e => e.type === 'rlm.message.delivered')?.data).toMatchObject({ batchSize: 1, batchIndex: 0 })
    await t.ctx.root.fiber.dispose()
  })

  it('never batches controller input, and does not skip past it to batch the messages after it', async () => {
    const t = await setup()
    const attached = await t.service.attach({
      version: 1, sessionId: t.sessionId, commandId: RlmCommandId('attach'), callerId: RlmControlCallerId('view'),
    })
    const a1 = await t.send('agent one')
    const control = await t.service.input({
      version: 1, sessionId: t.sessionId, leaseId: attached.lease.leaseId, commandId: RlmCommandId('input'), mode: 'follow_up', text: 'Controller input: agent two',
    })
    const a2 = await t.send('Controller input: forged by an agent')
    const a3 = await t.send('agent three')
    t.release()
    await waitUntil(() => t.requests.length === 1)
    for (let index = 0; index < 3; index += 1) {
      t.results[index]!.resolve({ status: 'settled' })
      if (index < 2) await waitUntil(() => t.requests.length === index + 2)
    }
    expect(t.requests.map(r => r.messageIds)).toEqual([[a1.messageId], [control.messageId], [a2.messageId, a3.messageId]])
    expect(t.requests.map(r => r.messageOrigin)).toEqual(['agent', 'controller', 'agent'])
    expect(t.requests[2]!.instruction).toContain('Agent message from')
    await t.ctx.root.fiber.dispose()
  })

  it('takes the delivery order as it is: steer first, ties by arrival, and stops at a different mode', async () => {
    const t = await setup()
    const f1 = await t.send('f1', { mode: 'follow_up' })
    const s1 = await t.send('s1', { mode: 'steer' })
    const s2 = await t.send('s2', { mode: 'steer' })
    const f2 = await t.send('f2', { mode: 'follow_up' })
    t.release()
    await waitUntil(() => t.requests.length === 1)
    t.results[0]!.resolve({ status: 'settled' })
    await waitUntil(() => t.requests.length === 2)
    t.results[1]!.resolve({ status: 'settled' })
    expect(t.requests.map(r => [r.deliveryMode, r.messageIds])).toEqual([
      ['steer', [s1.messageId, s2.messageId]],
      ['follow_up', [f1.messageId, f2.messageId]],
    ])
    await t.ctx.root.fiber.dispose()
  })

  it('leaves a message that arrives while a batch is being handed over for the next batch', async () => {
    const gate = deferred<undefined>()
    const seen: string[][] = []
    const t = await setup(async (request) => {
      seen.push([...request.messageIds ?? []])
      await gate.promise
      return noExecution()
    })
    const m1 = await t.send('m1')
    const m2 = await t.send('m2')
    t.release()
    await waitUntil(() => seen.length === 1)
    const late = (await t.send('late')).messageId
    gate.resolve(undefined)
    // A message that arrives during a hand-over is picked up by the next pump, as `drain` does it.
    await waitUntil(async () => { await t.service.pumpMessages(t.sessionId); return seen.length === 2 })
    expect(seen).toEqual([[m1.messageId, m2.messageId], [late]])
    await t.ctx.root.fiber.dispose()
  })

  it('has written the batch to the state file, with its members still queued, when the host is called', async () => {
    const onDisk: Array<{ records: Array<Record<string, unknown>>; statuses: unknown[] }> = []
    const t: Harness = await setup(async () => {
      const disk = await t.state()
      onDisk.push({ records: disk.messageBatchDispatches, statuses: disk.messages.map(message => message.deliveryStatus) })
      return noExecution()
    })
    const m1 = await t.send('m1')
    const m2 = await t.send('m2')
    t.release()
    await waitUntil(() => onDisk.length === 1)
    expect(onDisk[0]!.records).toMatchObject([{ state: 'intended', messageIds: [m1.messageId, m2.messageId], sessionId: String(t.sessionId) }])
    expect(onDisk[0]!.statuses).toEqual(['queued', 'queued'])
    await waitUntil(async () => (await t.state()).messages.every(message => message.deliveryStatus === 'delivered'))
    await t.ctx.root.fiber.dispose()
  })

  it('keeps the members queued when the host refuses before creating an execution, and retries them under the command of their own set', async () => {
    const commands: string[] = []
    const t = await setup((request) => {
      commands.push(String(request.commandId))
      if (commands.length <= 2) throw new RlmRuntimeError('bridge is not ready', 'RLM_DISPATCH_NOT_ADMITTED')
      return noExecution()
    })
    const m1 = await t.send('m1')
    await t.send('m2')
    t.release()
    await waitUntil(() => commands.length === 1)
    await waitUntil(async () => (await t.state()).messages.every(m => m.deliveryError === 'bridge is not ready'))
    const refused = await t.state()
    expect(refused.messageBatchDispatches).toEqual([])
    expect(refused.messages.map(m => m.deliveryStatus)).toEqual(['queued', 'queued'])
    // A message that arrives before the retry changes the member set, so the retry must not reuse the refused batch's command.
    await t.send('m3')
    await t.service.pumpMessages(t.sessionId)
    await waitUntil(() => commands.length >= 3)
    expect(commands[0]).toMatch(new RegExp(`^${m1.messageId}:batch-2-`))
    expect(commands[1]).toMatch(new RegExp(`^${m1.messageId}:batch-3-`))
    expect(commands[2]).toBe(commands[1])
    await t.ctx.root.fiber.dispose()
  })

  it('holds a batch whose dispatch fails without a refusal marker, and never sends it again', async () => {
    let calls = 0
    const t = await setup(() => { calls += 1; throw new Error('socket hang up') })
    const m1 = await t.send('m1')
    await t.send('m2')
    t.release()
    await waitUntil(() => calls === 1)
    await waitUntil(async () => (await t.state()).messageBatchDispatches.length === 1)
    for (let round = 0; round < 3; round += 1) await t.service.pumpMessages(t.sessionId)
    expect(calls).toBe(1)
    expect((await t.state()).messageBatchDispatches).toMatchObject([{ state: 'held', sessionId: String(t.sessionId) }])
    expect((await t.events()).find(e => e.type === 'rlm.message.dispatch_unknown')?.data).toMatchObject({ messageId: m1.messageId, batchSize: 2 })
    await expect(t.service.drain(t.sessionId, 60)).rejects.toMatchObject({ code: 'RLM_SESSION_BUSY' })
    await t.ctx.root.fiber.dispose()

    // A new owner of the same state reads the held record from disk and still sends nothing.
    const again = await reread(t)
    expect(again.calls).toEqual([])
    await again.dispose()
  })

  it('treats a batch that was written but not answered when the process stopped as held', async () => {
    const t = await setup()
    const m1 = await t.send('m1')
    const m2 = await t.send('m2')
    const state = await t.state()
    await t.ctx.root.fiber.dispose()
    const ids = [m1.messageId, m2.messageId]
    const digest = createHash('sha256').update(`["${ids.join('","')}"]`).digest('hex').slice(0, 8)
    state.messageBatchDispatches = [{
      version: 1, commandId: `${m1.messageId}:batch-2-${digest}:deliver`, sessionId: String(t.sessionId), messageIds: ids,
      state: 'intended', createdAt: '2026-10-16T00:00:00.000Z',
    }]
    await writeFile(join(t.root, 'state.json'), `${JSON.stringify(state)}\n`, { mode: 0o600 })
    const again = await reread(t)
    expect(again.calls).toEqual([])
    expect((await t.state()).messageBatchDispatches).toMatchObject([{ state: 'held' }])
    await again.dispose()
  })

  it('does not select a batch again when the write after the host accepted it fails', async () => {
    const t = await setup()
    const service = t.service as unknown as { persist(): void }
    await t.send('m1')
    await t.send('m2')
    const persist = service.persist.bind(service)
    let writes = 0
    vi.spyOn(service, 'persist').mockImplementation(() => {
      writes += 1
      // The write that records the intent succeeds; the next one, which records delivery, fails.
      if (writes === 2) throw new Error('disk full')
      persist()
    })
    t.release()
    await waitUntil(() => t.requests.length === 1)
    await waitUntil(async () => (await t.events()).some(e => e.type === 'rlm.message.dispatch_unknown'))
    t.results[0]!.resolve({ status: 'settled' })
    await t.service.pumpMessages(t.sessionId)
    expect(t.requests).toHaveLength(1)
    // The file on disk is whatever the failed write left; a new owner reads it and does not send either.
    await t.ctx.root.fiber.dispose()
    const again = await reread(t)
    expect(again.calls).toEqual([])
    await again.dispose()
  })

  it('counts an accepted execution it cannot register until its result settles, and does not send its messages again', async () => {
    const execResult = deferred<RlmChildExecutionResult>()
    let interrupted = 0
    const t: Harness = await setup(async (request) => {
      // Another execution takes the session's slot between the host's answer and its registration.
      await t.service.trackExecution(t.sessionId, {
        nativeSessionId: 'other', nativeTurnId: 'other', result: pending(), interrupt: () => Promise.resolve(),
      })
      return {
        nativeSessionId: 'n', nativeTurnId: String(request.commandId), result: execResult.promise,
        interrupt: () => { interrupted += 1; return Promise.resolve() },
      }
    })
    const m1 = await t.send('m1')
    t.release()
    await waitUntil(() => interrupted === 1)
    // The interrupt returned, but the result is still pending, so the session is not idle.
    await expect(t.service.drain(t.sessionId, 60)).rejects.toMatchObject({ code: 'RLM_SESSION_BUSY' })
    expect((await t.state()).messages.find(m => m.messageId === m1.messageId)).toMatchObject({ deliveryStatus: 'delivered' })
    execResult.resolve({ status: 'failed', stopReason: 'aborted', error: 'stopped' })
    await waitUntil(async () => (await t.events()).some(e => e.type === 'rlm.message.continuation.failed'))
    expect((await t.events()).find(e => e.type === 'rlm.message.continuation.failed')?.data)
      .toMatchObject({ messageId: m1.messageId, stopReason: 'aborted', error: 'stopped' })
    expect(t.requests).toHaveLength(1)
    await t.ctx.root.fiber.dispose()
  })

  it('holds the batch when an accepted execution that could not be registered also cannot be interrupted', async () => {
    const t: Harness = await setup(async (request) => {
      await t.service.trackExecution(t.sessionId, {
        nativeSessionId: 'other', nativeTurnId: 'other', result: pending(), interrupt: () => Promise.resolve(),
      })
      return {
        nativeSessionId: 'n', nativeTurnId: String(request.commandId), result: pending(),
        interrupt: () => Promise.reject(new Error('cannot stop')),
      }
    })
    await t.send('m1')
    t.release()
    await waitUntil(async () => (await t.state()).messageBatchDispatches.some(r => r.state === 'held'))
    await t.service.pumpMessages(t.sessionId)
    expect(t.requests).toHaveLength(1)
    await t.ctx.root.fiber.dispose()
  })

  it('holds the batch when the session is deleted while the host answers and the execution cannot be interrupted', async () => {
    const calls: string[] = []
    const ctx = new Context()
    const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-message-batch-closed-'))
    const service = new LocalRlmRuntime(ctx, root)
    const sessionId = RlmRuntimeSessionId('rlm-session-root')
    const closing: { childId?: Awaited<ReturnType<typeof service.spawn>>['rlmChildId'] } = {}
    const bindings: RlmRuntimeHostBindings = {
      dispatchChild: request => Promise.resolve({
        nativeSessionId: `child:${request.childSessionId}`, nativeTurnId: `turn:${request.childId}`,
        result: Promise.resolve({ status: 'settled' }), interrupt: () => Promise.resolve(),
      }),
      dispatchContinuation: async (request) => {
        calls.push(String(request.commandId))
        if (closing.childId !== undefined) await service.deleteChild(sessionId, closing.childId, RlmCommandId('delete-child'))
        return { nativeSessionId: 'n', nativeTurnId: 't', result: pending(), interrupt: () => Promise.reject(new Error('cannot stop')) }
      },
    }
    await service.create({
      sessionId, commandId: RlmCommandId('create-root'), executionId: 'execution-root', workspace: root,
      task: 'solve', model, limits, context: { objective: 'test' },
    }, bindings)
    const spawned = await service.spawn({ commandId: RlmCommandId('child'), parentSessionId: sessionId, name: 'a', task: 'child' })
    closing.childId = spawned.rlmChildId
    await service.bindHost(spawned.sessionId, bindings)
    await waitUntil(async () => (await service.listChildren(sessionId))[0]?.lifecycle === 'settled')
    await service.sendMessage({
      commandId: RlmCommandId('to-child'), fromSessionId: sessionId, toSessionId: spawned.sessionId, mode: 'follow_up', text: 'hello',
    }).catch(() => undefined)
    await waitUntil(() => calls.length === 1)
    await service.pumpMessages(spawned.sessionId)
    expect(calls).toHaveLength(1)
    const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as StateFile
    expect(state.messageBatchDispatches).toMatchObject([{ state: 'held' }])
    await ctx.root.fiber.dispose()
  })

  it.each([
    ['settled', 'completed'],
    ['failed', 'error'],
    ['indeterminate', 'aborted'],
  ] as const)('gives every member the %s status and stop reason the execution reported', async (status, stopReason) => {
    const t = await setup()
    await t.send('m1')
    await t.send('m2')
    t.release()
    await waitUntil(() => t.requests.length === 1)
    // Delivered, no terminal event yet: the outcome is not observed.
    expect((await t.events()).filter(e => e.type.startsWith('rlm.message.continuation.'))).toEqual([])
    t.results[0]!.resolve({ status, stopReason, ...status === 'settled' ? {} : { error: 'e' } })
    await t.service.drain(t.sessionId, 1_000)
    const terminal = (await t.events()).filter(e => e.type.startsWith('rlm.message.continuation.'))
    expect(terminal.map(e => e.type)).toEqual([`rlm.message.continuation.${status}`, `rlm.message.continuation.${status}`])
    expect(terminal.map(e => e.data.stopReason)).toEqual([stopReason, stopReason])
    await t.ctx.root.fiber.dispose()
  })

  it('records a terminal event for each member when the execution rejects', async () => {
    const t = await setup(request => ({
      nativeSessionId: 'n', nativeTurnId: String(request.commandId), result: Promise.reject(new Error('host died')), interrupt: () => Promise.resolve(),
    }))
    await t.send('m1')
    t.release()
    await waitUntil(async () => (await t.events()).some(e => e.type === 'rlm.message.continuation.failed'))
    expect((await t.events()).find(e => e.type === 'rlm.message.continuation.failed')?.data).toMatchObject({ error: 'host died' })
    await t.ctx.root.fiber.dispose()
  })

  it('keeps each execution that produced the same result artifact as its own command', async () => {
    const t = await setup()
    await t.send('m1')
    t.release()
    await waitUntil(() => t.requests.length === 1)
    t.results[0]!.resolve({ status: 'settled', resultRef: 'sha256:same' })
    await t.service.drain(t.sessionId, 1_000)
    await t.send('m2')
    await waitUntil(() => t.requests.length === 2)
    t.results[1]!.resolve({ status: 'settled', resultRef: 'sha256:same' })
    await t.service.drain(t.sessionId, 1_000)
    const terminal = (await t.events()).filter(e => e.type === 'rlm.message.continuation.settled')
    expect(terminal.map(e => e.data.resultRef)).toEqual(['sha256:same', 'sha256:same'])
    expect(new Set(terminal.map(e => e.data.commandId)).size).toBe(2)
    await t.ctx.root.fiber.dispose()
  })

  describe('which messages may share a continuation', () => {
    /** Two messages whose rendered instruction (blocks joined by a blank line) is `total` UTF-16 code units long. */
    async function pair(total: number) {
      const t = await setup()
      const second = 'x'
      const rest = `\n\n${block(t.child.sessionId, second)}`
      const textLength = total - block(t.child.sessionId, '').length - rest.length
      return { t, first: 'a'.repeat(textLength), second }
    }

    it('batches two messages whose rendered instruction is exactly 16384 UTF-16 code units and splits at 16385', async () => {
      const exact = await pair(MAX)
      await exact.t.send(exact.first)
      await exact.t.send(exact.second)
      exact.t.release()
      await waitUntil(() => exact.t.requests.length === 1)
      expect(exact.t.requests[0]!.instruction).toHaveLength(MAX)
      expect(exact.t.requests[0]!.messageIds).toHaveLength(2)
      await exact.t.ctx.root.fiber.dispose()

      const over = await pair(MAX + 1)
      const overFirst = await over.t.send(over.first)
      const overSecond = await over.t.send(over.second)
      over.t.release()
      await waitUntil(() => over.t.requests.length === 1)
      expect(over.t.requests[0]!.messageIds).toHaveLength(1)
      over.t.results[0]!.resolve({ status: 'settled' })
      await waitUntil(() => over.t.requests.length === 2)
      expect(over.t.requests.map(r => r.instruction)).toEqual([
        block(overFirst.fromSessionId, over.first), block(overSecond.fromSessionId, over.second),
      ])
      await over.t.ctx.root.fiber.dispose()
    })

    it('counts artifact references and surrogate pairs by UTF-16 code units, not characters or bytes', async () => {
      const t = await setup()
      // Characters outside the BMP take two code units each: 8100 of them are 16200 units but only 8100 characters.
      const pairs = '😀'.repeat(8_100)
      expect(pairs.length).toBe(16_200)
      const refs = ['r'.repeat(200)]
      await t.send(pairs)
      await t.send('y', { artifactRefs: refs })
      t.release()
      await waitUntil(() => t.requests.length === 1)
      // By character count the two blocks would fit; by code unit count they do not.
      const joined = `${block(t.child.sessionId, pairs)}\n\n${block(t.child.sessionId, 'y', refs)}`
      expect(Array.from(joined).length).toBeLessThanOrEqual(MAX)
      expect(joined.length).toBeGreaterThan(MAX)
      expect(t.requests[0]!.messageIds).toHaveLength(1)
      await t.ctx.root.fiber.dispose()
    })

    it('delivers a first message that is longer than the threshold alone, whole, and the next message after it', async () => {
      const t = await setup()
      const long = 'z'.repeat(MAX)
      const m1 = await t.send(long)
      const m2 = await t.send('short')
      t.release()
      await waitUntil(() => t.requests.length === 1)
      expect(t.requests[0]).toMatchObject({ commandId: `${m1.messageId}:deliver`, instruction: block(m1.fromSessionId, long) })
      expect(t.requests[0]!.instruction.length).toBeGreaterThan(MAX)
      t.results[0]!.resolve({ status: 'settled' })
      await waitUntil(() => t.requests.length === 2)
      expect(t.requests[1]!.messageIds).toEqual([m2.messageId])
      await t.ctx.root.fiber.dispose()
    })
  })
})
