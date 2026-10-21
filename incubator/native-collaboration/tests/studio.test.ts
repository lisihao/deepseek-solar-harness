import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

import type { CollaborationModePort, CollaborationModeState, StudioGraph, StudioProvider, StudioRun, StudioRunRecord, StudioSource } from '../src/studio-contract.js'
import { StudioStore } from '../src/studio-store.js'
import { WorkflowStudio, buildStudioDeliveryPrompt, buildStudioSourceDeliveryPrompt } from '../src/studio.js'

const firstDraftId = 'a13b9ba8-4f95-440f-b104-a722335b6364'
const secondDraftId = 'b13b9ba8-4f95-440f-b104-a722335b6364'
let roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function graph(overrides: Partial<StudioGraph> = {}): StudioGraph {
  return {
    formatVersion: 1,
    id: 'flow-a',
    sessionId: 'session-a',
    providerId: 'native',
    title: '流程 A',
    nodes: [{ id: 'one', label: '阶段一', kind: 'native', prompt: '原始提示词', parameters: {}, metadata: {}, position: { x: 0, y: 0 } }],
    edges: [],
    parameters: {},
    metadata: {},
    ...overrides,
  }
}

function receipt(commandId: string, status: StudioRun['status'] = 'pending', output?: string): StudioRun {
  const timestamp = '2026-10-20T00:00:00.000Z'
  return { id: commandId, sessionId: 'session-a', providerId: 'native', status, nodes: [], createdAt: timestamp, updatedAt: timestamp, ...(output === undefined ? {} : { output }) }
}

function webGraph(overrides: Partial<StudioGraph> = {}): StudioGraph {
  return graph({
    providerId: 'web',
    nodes: [{ id: 'web-one', label: '网页阶段', kind: 'chatgpt-web', prompt: '原始网页提示词', parameters: {}, metadata: {}, position: { x: 0, y: 0 } }],
    ...overrides,
  })
}

function webReceipt(commandId: string, status: StudioRun['status'] = 'unknown', output?: string): StudioRun {
  return { ...receipt(commandId, status, output), providerId: 'web' }
}

function modePort(): CollaborationModePort {
  const values = new Map<string, CollaborationModeState>()
  const read = async (sessionId: string): Promise<CollaborationModeState> => values.get(sessionId) ?? { formatVersion: 1, sessionId, revision: 0, mode: 'ordinary' }
  return {
    read,
    select: async (sessionId, mode, expectedRevision) => {
      const current = await read(sessionId)
      if (current.revision !== expectedRevision) throw new Error('MODE_CAS_CONFLICT')
      const next: CollaborationModeState = { formatVersion: 1, sessionId, revision: current.revision + 1, mode }
      values.set(sessionId, next)
      return next
    },
  }
}

async function setup(
  overrides: Partial<StudioProvider> = {},
  onCompleted?: (record: StudioRunRecord) => Promise<void>,
  onSourceCompleted?: (source: StudioSource) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'solar-workflow-studio-'))
  roots.push(root)
  const execute = vi.fn(async (request) => receipt(request.commandId))
  const inspect = vi.fn(async (_sessionId: string, commandId: string) => receipt(commandId, 'running'))
  const observeSource = vi.fn(async (source) => receipt(source.runId ?? 'source-run-a', 'running'))
  const provider: StudioProvider = {
    id: 'native',
    label: 'Native',
    validate: vi.fn(async () => []),
    execute,
    inspect,
    observeSource,
    ...overrides,
  }
  const studio = new WorkflowStudio(new Context(), modePort(), {
    root,
    ...(onCompleted === undefined ? {} : { onCompleted }),
    ...(onSourceCompleted === undefined ? {} : { onSourceCompleted }),
  })
  const unregister = studio.register(provider)
  return { studio, provider, execute, inspect, observeSource, unregister, root }
}

async function capturedDraft(studio: WorkflowStudio, id = firstDraftId, value = graph()) {
  await studio.capture({ id: 'source-a', graph: value, runId: 'source-run-a' })
  return studio.save({ sessionId: 'session-a', id, expectedRevision: 0, graph: value, sourceId: 'source-a' })
}

async function waitForRun(studio: WorkflowStudio, commandId: string, status: StudioRun['status']) {
  await vi.waitFor(async () => {
    expect((await studio.store.readRun('session-a', commandId))?.run.status).toBe(status)
  })
  return (await studio.store.readRun('session-a', commandId))!
}

async function flushBackground(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function waitForNativeMonitor(studio: WorkflowStudio): Promise<void> {
  const internals = studio as unknown as { nativeMonitors: ReadonlyMap<string, unknown> }
  await vi.waitFor(() => expect(internals.nativeMonitors.size).toBeGreaterThan(0))
}

function nativePollClock() {
  const callbacks = new Map<object, () => void>()
  const delays: number[] = []
  const setIntervalMock = ((handler: TimerHandler, delay?: number) => {
    const handle = {}
    if (typeof handler !== 'function') throw new Error('Native monitor must register a callable interval.')
    callbacks.set(handle, handler as () => void)
    delays.push(Number(delay))
    return handle as unknown as ReturnType<typeof setInterval>
  }) as unknown as typeof setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation(setIntervalMock)
  const clearIntervalMock = ((handle?: ReturnType<typeof setInterval>) => {
    if (handle !== undefined) callbacks.delete(handle as unknown as object)
  }) as unknown as typeof clearInterval
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(clearIntervalMock)
  return {
    delays,
    tick: () => { for (const callback of [...callbacks.values()]) callback() },
  }
}

describe('WorkflowStudio admission and observation', () => {
  test('saving, overview, validation, and changing mode do not execute a provider', async () => {
    const { studio, execute } = await setup()
    await capturedDraft(studio)
    await studio.overview({ sessionId: 'session-a' })
    await studio.validate({ sessionId: 'session-a', graph: graph() })
    await studio.setMode({ sessionId: 'session-a', mode: 'smart', expectedRevision: 0 })
    expect(execute).not.toHaveBeenCalled()
  })

  test('permits an invalid cycle in a draft, then accepts it only after the edge is deleted', async () => {
    const cyclic = graph({
      nodes: [
        { id: 'one', label: '一', kind: 'native', prompt: '一', parameters: {}, metadata: {}, position: { x: 0, y: 0 } },
        { id: 'two', label: '二', kind: 'native', prompt: '二', parameters: {}, metadata: {}, position: { x: 1, y: 0 } },
      ],
      edges: [{ id: 'one-two', source: 'one', target: 'two' }, { id: 'two-one', source: 'two', target: 'one' }],
    })
    const { studio, execute } = await setup()
    await capturedDraft(studio, firstDraftId, cyclic)
    await expect(studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'cycle-command' })).rejects.toThrow('依赖环')
    expect(execute).not.toHaveBeenCalled()

    const fixed = { ...cyclic, edges: [{ id: 'one-two', source: 'one', target: 'two' }] }
    await studio.save({ sessionId: 'session-a', id: firstDraftId, expectedRevision: 0, graph: fixed, sourceId: 'source-a' })
    await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 1, commandId: 'cycle-command-fixed' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('freezes the exact draft revision and executes a stable command once', async () => {
    const { studio, execute, inspect } = await setup()
    await capturedDraft(studio)
    const first = await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'stable-command' })
    expect(first.graph.nodes[0]?.prompt).toBe('原始提示词')
    await studio.save({ sessionId: 'session-a', id: firstDraftId, expectedRevision: 0, graph: graph({ nodes: [{ id: 'one', label: '阶段一', kind: 'native', prompt: '已编辑提示词', parameters: {}, metadata: {}, position: { x: 0, y: 0 } }] }), sourceId: 'source-a' })
    expect((await studio.overview({ sessionId: 'session-a' })).runs[0]?.graph.nodes[0]?.prompt).toBe('原始提示词')
    await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'stable-command' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  test('does not use a new command to bypass a pending source execution and isolates sessions', async () => {
    const { studio, execute } = await setup()
    await capturedDraft(studio)
    await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'original-command' })
    await expect(studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'replacement-command' })).rejects.toMatchObject({ code: 'STUDIO_RESOURCE_COORDINATION_REQUIRED' })
    await studio.save({ sessionId: 'session-a', id: secondDraftId, expectedRevision: 0, graph: graph() })
    await expect(studio.run({ sessionId: 'session-a', draftId: secondDraftId, expectedRevision: 0, commandId: 'new-draft-cannot-bypass' })).rejects.toMatchObject({ code: 'STUDIO_RESOURCE_COORDINATION_REQUIRED' })
    await expect(studio.run({ sessionId: 'session-b', draftId: firstDraftId, expectedRevision: 0, commandId: 'other-session-command' })).rejects.toThrow('不存在')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('requires coordination when the captured original source is still unknown', async () => {
    const { studio, execute } = await setup()
    const source = graph()
    await studio.capture({ id: 'source-a', graph: source, run: receipt('source-original-command', 'unknown') })
    await studio.save({ sessionId: 'session-a', id: firstDraftId, expectedRevision: 0, graph: source, sourceId: 'source-a' })
    await expect(studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'cannot-bypass-source-unknown' })).rejects.toMatchObject({ code: 'STUDIO_RESOURCE_COORDINATION_REQUIRED' })
    expect(execute).not.toHaveBeenCalled()
  })

  test('preserves execute and inspector failures as unknown without replaying execute', async () => {
    const execute = vi.fn(async () => { throw new Error('network after submit') })
    const inspect = vi.fn(async () => { throw new Error('inspection unavailable') })
    const { studio } = await setup({ execute, inspect })
    await capturedDraft(studio)
    const admitted = await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'uncertain-command' })
    expect(admitted.run.status).toBe('pending')
    const uncertain = await waitForRun(studio, 'uncertain-command', 'unknown')
    expect(uncertain.run.status).toBe('unknown')
    const inspected = await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'uncertain-command' })
    expect(inspected.run.status).toBe('unknown')
    expect(inspected.run.message).toContain('inspection unavailable')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  test('refreshes one source through observeSource without executing it', async () => {
    const { studio, execute, observeSource } = await setup()
    await studio.capture({ id: 'source-a', graph: graph(), runId: 'source-run-a' })
    const refreshed = await studio.refreshSource({ sessionId: 'session-a', sourceId: 'source-a' })
    expect(refreshed.run?.status).toBe('running')
    expect(observeSource).toHaveBeenCalledTimes(1)
    expect(execute).not.toHaveBeenCalled()
  })

  test('delivers a completed output once and resolves only its exact no-replay prompt', async () => {
    const onCompleted = vi.fn(async () => undefined)
    const execute = vi.fn(async (request) => receipt(request.commandId, 'completed', '最终结果'))
    const inspect = vi.fn(async (_sessionId: string, commandId: string) => receipt(commandId, 'completed', '最终结果'))
    const { studio } = await setup({ execute, inspect }, onCompleted)
    await capturedDraft(studio, secondDraftId)
    const admitted = await studio.run({ sessionId: 'session-a', draftId: secondDraftId, expectedRevision: 0, commandId: 'completed-command' })
    expect(admitted.run.status).toBe('pending')
    const record = await waitForRun(studio, 'completed-command', 'completed')
    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1))
    const prompt = buildStudioDeliveryPrompt(record)
    expect(onCompleted).toHaveBeenCalledTimes(1)
    expect(await studio.resolveDelivery('session-a', prompt)).toBe('最终结果')
    expect(await studio.resolveDelivery('session-b', prompt)).toBeUndefined()
    await studio.inspect({ sessionId: 'session-a', commandId: 'completed-command' })
    expect(onCompleted).toHaveBeenCalledTimes(1)
    // Callback entry precedes the asynchronous durable settlement. Assert the
    // completed ledger state, not the timing of the callback spy.
    await vi.waitFor(async () => expect((await studio.store.readDelivery('session-a', 'completed-command'))?.status).toBe('submitted'))
  })

  test('keeps a completed run completed when its original-session callback is uncertain and never blindly resends it', async () => {
    const onCompleted = vi.fn(async () => { throw new Error('queue receipt unavailable') })
    const execute = vi.fn(async (request) => receipt(request.commandId, 'completed', '可回写结果'))
    const { studio } = await setup({ execute }, onCompleted)
    await capturedDraft(studio, secondDraftId)
    const admitted = await studio.run({ sessionId: 'session-a', draftId: secondDraftId, expectedRevision: 0, commandId: 'delivery-unknown-command' })
    expect(admitted.run.status).toBe('pending')
    const record = await waitForRun(studio, 'delivery-unknown-command', 'completed')
    expect(record.run.status).toBe('completed')
    await vi.waitFor(async () => expect((await studio.store.readDelivery('session-a', 'delivery-unknown-command'))?.status).toBe('unknown'))
    const ledger = await studio.store.readDelivery('session-a', 'delivery-unknown-command')
    expect(ledger?.status).toBe('unknown')
    expect(ledger?.message).toContain('queue receipt unavailable')
    await studio.inspect({ sessionId: 'session-a', commandId: 'delivery-unknown-command' })
    expect(onCompleted).toHaveBeenCalledTimes(1)
  })

  test('returns admission before a deferred Provider completes, then inspect observes the completed run', async () => {
    let resolveExecute!: (value: StudioRun) => void
    const execute = vi.fn((_request: { readonly commandId: string }) => new Promise<StudioRun>((resolve) => { resolveExecute = resolve }))
    const inspect = vi.fn(async (_sessionId: string, commandId: string) => receipt(commandId, 'completed', '后台完成'))
    const { studio } = await setup({ execute, inspect })
    await capturedDraft(studio)
    const admitted = await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'deferred-command' })
    expect(admitted.run.status).toBe('pending')
    expect(execute).toHaveBeenCalledTimes(1)
    resolveExecute(receipt('deferred-command', 'completed', '后台完成'))
    await waitForRun(studio, 'deferred-command', 'completed')
    const inspected = await studio.inspect({ sessionId: 'session-a', commandId: 'deferred-command' })
    expect(inspected.run.status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('observes an admitted Native command to completion without a foreground inspect or another execute', async () => {
    const clock = nativePollClock()
    let completed = false
    const onCompleted = vi.fn(async () => undefined)
    const execute = vi.fn(async (request) => receipt(request.commandId, 'pending'))
    const inspect = vi.fn(async (_sessionId: string, commandId: string) => (
      completed ? receipt(commandId, 'completed', 'Native 完成产物') : receipt(commandId, 'running')
    ))
    const { studio } = await setup({ execute, inspect }, onCompleted)
    await capturedDraft(studio)

    const admitted = await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'native-monitored-command' })
    expect(admitted.run.status).toBe('pending')
    await waitForNativeMonitor(studio)
    expect(clock.delays).toEqual([1_000])
    expect(inspect).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()

    completed = true
    clock.tick()
    await waitForRun(studio, 'native-monitored-command', 'completed')
    expect((await studio.store.readRun('session-a', 'native-monitored-command'))?.run.status).toBe('completed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(onCompleted).toHaveBeenCalledTimes(1)

    clock.tick()
    await flushBackground()
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(onCompleted).toHaveBeenCalledTimes(1)
  })

  test('stops Native observation when its provider lifecycle disposer runs', async () => {
    const clock = nativePollClock()
    const inspect = vi.fn(async (_sessionId: string, commandId: string) => receipt(commandId, 'running'))
    const { studio, unregister } = await setup({ inspect })
    await capturedDraft(studio)
    await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'native-disposed-command' })
    await waitForNativeMonitor(studio)
    unregister()
    clock.tick()
    await flushBackground()
    expect(inspect).not.toHaveBeenCalled()
  })

  test('marks a monitored Native command unknown after an inspection error and never submits it again', async () => {
    const clock = nativePollClock()
    const execute = vi.fn(async (request) => receipt(request.commandId, 'pending'))
    const inspect = vi.fn(async () => { throw new Error('native inspection unavailable') })
    const { studio } = await setup({ execute, inspect })
    await capturedDraft(studio)
    await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'native-monitor-unknown-command' })
    await waitForNativeMonitor(studio)
    clock.tick()
    const unknown = await waitForRun(studio, 'native-monitor-unknown-command', 'unknown')
    expect(unknown.run.message).toContain('native inspection unavailable')
    clock.tick()
    await flushBackground()
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  test('restarts Native monitoring from its durable original command without submitting a pending intent again', async () => {
    const clock = nativePollClock()
    const root = await mkdtemp(join(tmpdir(), 'solar-workflow-studio-restart-'))
    roots.push(root)
    const persisted = new StudioStore(root)
    await persisted.saveDraft({ sessionId: 'session-a', id: firstDraftId, expectedRevision: 0, graph: graph() })
    await persisted.createRunIntent({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'native-restarted-command' })

    const execute = vi.fn(async (request) => receipt(request.commandId, 'pending'))
    const inspect = vi.fn(async (_sessionId: string, commandId: string) => receipt(commandId, 'completed', '恢复完成'))
    const onCompleted = vi.fn(async () => undefined)
    const studio = new WorkflowStudio(new Context(), modePort(), { root, onCompleted })
    studio.register({ id: 'native', label: 'Native', validate: async () => [], execute, inspect })

    await waitForNativeMonitor(studio)
    expect(clock.delays).toEqual([1_000])
    clock.tick()
    await waitForRun(studio, 'native-restarted-command', 'completed')
    expect((await studio.store.readRun('session-a', 'native-restarted-command'))?.run.status).toBe('completed')
    expect(inspect).toHaveBeenCalledWith('session-a', 'native-restarted-command')
    expect(execute).not.toHaveBeenCalled()
    expect(onCompleted).toHaveBeenCalledTimes(1)
  })

  test('continues an unknown Web frozen run exactly once with its original command', async () => {
    let resolveResume!: (value: StudioRun) => void
    const execute = vi.fn(async (request) => webReceipt(request.commandId, 'unknown'))
    const resume = vi.fn((_sessionId: string, _commandId: string) => new Promise<StudioRun>((resolve) => { resolveResume = resolve }))
    const { studio } = await setup({ id: 'web', label: 'Web', execute, resume })
    await capturedDraft(studio, firstDraftId, webGraph())
    await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'web-original-command' })
    await waitForRun(studio, 'web-original-command', 'unknown')

    const current = await studio.resume({ sessionId: 'session-a', commandId: 'web-original-command' })
    expect(current.status).toBe('unknown')
    await studio.resume({ sessionId: 'session-a', commandId: 'web-original-command' })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith('session-a', 'web-original-command')

    resolveResume(webReceipt('web-original-command', 'completed', '下一阶段完成'))
    const completed = await waitForRun(studio, 'web-original-command', 'completed')
    expect(completed.run.output).toBe('下一阶段完成')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(1)
  })

  test('leaves an original Web run and source exclusively owned when Provider rejects continuation', async () => {
    const assertCanResume = vi.fn(async () => { throw new Error('原请求仍负责交付，不能由流程编辑器继续。') })
    const resume = vi.fn(async (_sessionId: string, commandId: string) => webReceipt(commandId, 'completed', '不应到达'))
    const onCompleted = vi.fn(async () => undefined)
    const onSourceCompleted = vi.fn(async () => undefined)
    const { studio } = await setup({
      id: 'web',
      label: 'Web',
      assertCanResume,
      resume,
      execute: vi.fn(async (request) => webReceipt(request.commandId, 'unknown')),
      inspect: vi.fn(async (_sessionId: string, commandId: string) => webReceipt(commandId, 'unknown')),
    }, onCompleted, onSourceCompleted)
    await capturedDraft(studio, firstDraftId, webGraph())
    await studio.run({ sessionId: 'session-a', draftId: firstDraftId, expectedRevision: 0, commandId: 'web-guarded-command' })
    await waitForRun(studio, 'web-guarded-command', 'unknown')
    const runBefore = await studio.store.readRun('session-a', 'web-guarded-command')

    await expect(studio.resume({ sessionId: 'session-a', commandId: 'web-guarded-command' })).rejects.toThrow('原请求仍负责交付')
    expect(await studio.store.readRun('session-a', 'web-guarded-command')).toEqual(runBefore)
    expect((await studio.store.readDelivery('session-a', 'web-guarded-command'))).toBeUndefined()

    await studio.capture({ id: 'source-guarded', graph: webGraph(), runId: 'source-guarded-command', run: webReceipt('source-guarded-command', 'unknown') })
    const sourceBefore = await studio.store.readSource('session-a', 'source-guarded')
    await expect(studio.resume({ sessionId: 'session-a', commandId: 'source-guarded-command', sourceId: 'source-guarded' })).rejects.toThrow('原请求仍负责交付')
    expect(await studio.store.readSource('session-a', 'source-guarded')).toEqual(sourceBefore)
    expect((await studio.store.readDelivery('session-a', 'source-guarded-command'))).toBeUndefined()

    expect(assertCanResume).toHaveBeenNthCalledWith(1, 'session-a', 'web-guarded-command')
    expect(assertCanResume).toHaveBeenNthCalledWith(2, 'session-a', 'source-guarded-command')
    expect(resume).not.toHaveBeenCalled()
    expect(onCompleted).not.toHaveBeenCalled()
    expect(onSourceCompleted).not.toHaveBeenCalled()
  })

  test('continues only the exact captured Web source and delivers its output once', async () => {
    let resolveResume!: (value: StudioRun) => void
    const resume = vi.fn((_sessionId: string, _commandId: string) => new Promise<StudioRun>((resolve) => { resolveResume = resolve }))
    const onSourceCompleted = vi.fn(async () => undefined)
    const { studio } = await setup({
      id: 'web',
      label: 'Web',
      resume,
      execute: vi.fn(async (request) => webReceipt(request.commandId)),
      inspect: vi.fn(async (_sessionId: string, commandId: string) => webReceipt(commandId, 'unknown')),
    }, undefined, onSourceCompleted)
    await studio.capture({ id: 'source-web', graph: webGraph(), runId: 'source-web-command', run: webReceipt('source-web-command', 'unknown') })

    await expect(studio.resume({ sessionId: 'session-b', commandId: 'source-web-command', sourceId: 'source-web' })).rejects.toThrow('不存在')
    const current = await studio.resume({ sessionId: 'session-a', commandId: 'source-web-command', sourceId: 'source-web' })
    expect(current.status).toBe('unknown')
    await studio.resume({ sessionId: 'session-a', commandId: 'source-web-command', sourceId: 'source-web' })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith('session-a', 'source-web-command')

    resolveResume(webReceipt('source-web-command', 'completed', '来源继续产物'))
    await vi.waitFor(async () => expect((await studio.store.readSource('session-a', 'source-web'))?.run?.status).toBe('completed'))
    await vi.waitFor(() => expect(onSourceCompleted).toHaveBeenCalledTimes(1))
    const source = (await studio.store.readSource('session-a', 'source-web'))!
    expect(await studio.resolveDelivery('session-a', buildStudioSourceDeliveryPrompt(source))).toBe('来源继续产物')
    expect(await studio.resolveDelivery('session-b', buildStudioSourceDeliveryPrompt(source))).toBeUndefined()
    await vi.waitFor(async () => expect((await studio.store.readDelivery('session-a', 'source-web-command'))?.status).toBe('submitted'))
    expect(onSourceCompleted).toHaveBeenCalledTimes(1)
  })

  test('does not call the source completion callback for ordinary source refresh', async () => {
    const onSourceCompleted = vi.fn(async () => undefined)
    const { studio } = await setup({
      id: 'web',
      label: 'Web',
      execute: vi.fn(async (request) => webReceipt(request.commandId)),
      inspect: vi.fn(async (_sessionId: string, commandId: string) => webReceipt(commandId, 'unknown')),
      observeSource: vi.fn(async (source) => webReceipt(source.runId!, 'completed', '自动观察产物')),
    }, undefined, onSourceCompleted)
    await studio.capture({ id: 'source-observe', graph: webGraph(), runId: 'source-observe-command', run: webReceipt('source-observe-command', 'running') })
    await studio.refreshSource({ sessionId: 'session-a', sourceId: 'source-observe' })
    expect(onSourceCompleted).not.toHaveBeenCalled()
  })
})
