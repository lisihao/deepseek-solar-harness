import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { RlmHost, RlmStoppedReceiptError, stopOwnedFrontend } from '../src/core.js'
import type { RuntimePaths } from '../src/runtime.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function directory() { const value = await mkdtemp(join(tmpdir(), 'solar-rlm-life-')); directories.push(value); return value }

describe('owned native lifecycle', () => {
  it('confirms termination of an owned frontend even when it ignores SIGTERM', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      await once(child.stdout, 'data')
      await stopOwnedFrontend(child)
      expect(child.signalCode).toBe('SIGKILL')
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  })

  it('waits for an in-flight admission and prevents its launch after disposal', async () => {
    const root = await directory()
    const ctx = { llm: { resolveModelInfo: vi.fn(async () => ({})) } } as unknown as Context
    const host = new RlmHost(ctx, root, '/unused', 100)
    let release!: (paths: RuntimePaths) => void
    vi.spyOn(host, 'runtime').mockImplementation(() => new Promise(resolve => { release = resolve }))
    const started = host.start({ task: 'Never dispatched', cwd: root, maxModelRequests: 1, maxWallTimeMs: 1000 }, { sessionId: 'owner', route: { provider: 'fixture', model: 'only' } })
    const stopped = host.dispose()
    release({ binary: '/not-spawned', python: '/unused', packageDir: '/unused', fingerprint: 'fixture' })
    await expect(started).rejects.toThrow('RLM_OWNER_UNAVAILABLE')
    await stopped
    expect(await host.store.list()).toEqual([])
  })

  it('attempts native cleanup even when persistence and ACP cancellation fail', async () => {
    const root = await directory(), host = new RlmHost({} as Context, root, '/unused', 100)
    const record = await host.store.create({ ownerSessionId: 'owner', cwd: root, route: { provider: 'fixture', model: 'only' }, label: 'cleanup', maxModelRequests: 1, maxWallTimeMs: 1000 })
    const live = { record, acpId: 'owned', acp: { notify: vi.fn(async () => { throw new Error('ACP closed') }) } }
    const lives = Reflect.get(host, 'lives') as Map<string, unknown>
    lives.set(record.runId, live)
    const close = vi.spyOn(host as unknown as { close(value: unknown): Promise<void> }, 'close').mockResolvedValue()
    vi.spyOn(host.store, 'save').mockRejectedValue(new Error('disk full'))
    await expect(host.cancel(record.runId, 'owner')).rejects.toThrow('RLM_STOPPED_RECEIPT_UNSAVED')
    expect(close).toHaveBeenCalledWith(live)
    expect(record.state).toBe('cancelled')
    lives.clear(); await host.dispose()
  })

  it('distinguishes confirmed native stop from a failed receipt write', async () => {
    const root = await directory(), host = new RlmHost({} as Context, root, '/unused', 100)
    const binary = join(root, 'fixture-cli')
    await writeFile(binary, '#!/bin/sh\nprintf \'%s\\n\' \'{"stopped":[],"failed":[]}\'\n', { mode: 0o700 })
    vi.spyOn(host as unknown as { storeReceipt(agentDir: string, stdout: string): Promise<void> }, 'storeReceipt').mockRejectedValue(new Error('disk full'))
    const shutdown = Reflect.get(host, 'shutdown').bind(host) as (runtime: RuntimePaths, env: NodeJS.ProcessEnv, cwd: string) => Promise<void>
    await expect(shutdown({ binary, python: '/unused', packageDir: '/unused', fingerprint: 'fixture' }, { PRIME_AGENT_CODING_AGENT_DIR: root }, root)).rejects.toBeInstanceOf(RlmStoppedReceiptError)

    const record = await host.store.create({ ownerSessionId: 'owner', cwd: root, route: { provider: 'fixture', model: 'only' }, label: 'receipt failure', maxModelRequests: 1, maxWallTimeMs: 1000 })
    const live = { record, acpId: 'owned', acp: { notify: vi.fn(async () => undefined) } }
    const lives = Reflect.get(host, 'lives') as Map<string, unknown>; lives.set(record.runId, live)
    vi.spyOn(host as unknown as { close(value: unknown): Promise<void> }, 'close').mockRejectedValue(new RlmStoppedReceiptError('disk full'))
    await expect(host.cancel(record.runId, 'owner')).rejects.toThrow('RLM_STOPPED_RECEIPT_UNSAVED')
    expect((await host.store.get(record.runId)).state).toBe('cancelled')
    lives.clear(); await host.dispose()
  })

  it('lets a fresh explicit stop reconcile an earlier failed cleanup', async () => {
    const root = await directory(), host = new RlmHost({} as Context, root, '/unused', 100)
    const record = await host.store.create({ ownerSessionId: 'owner', cwd: root, route: { provider: 'fixture', model: 'only' }, label: 'retry stop', maxModelRequests: 1, maxWallTimeMs: 1000 })
    const live = { record, acpId: 'owned', acp: { notify: vi.fn(async () => undefined) } }
    const lives = Reflect.get(host, 'lives') as Map<string, unknown>; lives.set(record.runId, live)
    const close = vi.spyOn(host as unknown as { closeOnce(value: unknown): Promise<void> }, 'closeOnce').mockRejectedValueOnce(new Error('RLM_NATIVE_EXIT_UNKNOWN')).mockResolvedValueOnce()
    await expect(host.cancel(record.runId, 'owner')).rejects.toThrow('RLM_NATIVE_EXIT_UNKNOWN')
    expect(record.state).toBe('indeterminate')
    expect((await host.cancel(record.runId, 'owner')).state).toBe('cancelled')
    expect(close).toHaveBeenCalledTimes(2)
    lives.clear(); await host.dispose()
  })

  it('waits for native completion and releases only the tool-scoped owner listener', async () => {
    const root = await directory(), host = new RlmHost({} as Context, root, '/unused', 100)
    const record = await host.store.create({ ownerSessionId: 'owner', cwd: root, route: { provider: 'fixture', model: 'only' }, label: 'wait', maxModelRequests: 1, maxWallTimeMs: 1000 })
    let finish!: () => void
    const removeOwnerAbort = vi.fn()
    const live = { record, removeOwnerAbort, turn: new Promise<void>(resolve => { finish = resolve }) }
    const lives = Reflect.get(host, 'lives') as Map<string, unknown>; lives.set(record.runId, live)
    let settled = false
    const waiting = host.waitForResult(record.runId, 'owner').then(value => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    await expect(host.waitForResult(record.runId, 'another-owner')).rejects.toThrow('RLM_OWNER_REQUIRED')
    expect(removeOwnerAbort).not.toHaveBeenCalled()
    record.state = 'idle'; record.result = 'native answer'; finish()
    expect(await waiting).toMatchObject({ state: 'idle', result: 'native answer' })
    expect(removeOwnerAbort).toHaveBeenCalledOnce()
    expect(lives.has(record.runId)).toBe(true)
    lives.clear(); await host.dispose()
  })

  it('keeps the result pending until in-flight cancellation has a durable receipt', async () => {
    const root = await directory(), host = new RlmHost({} as Context, root, '/unused', 100)
    const record = await host.store.create({ ownerSessionId: 'owner', cwd: root, route: { provider: 'fixture', model: 'only' }, label: 'cancel wait', maxModelRequests: 1, maxWallTimeMs: 1000 })
    const live = { record, acpId: '', removeOwnerAbort: vi.fn(), turn: Promise.resolve() }
    const lives = Reflect.get(host, 'lives') as Map<string, unknown>; lives.set(record.runId, live)
    let finishClose!: () => void
    const close = vi.spyOn(host as unknown as { close(value: unknown): Promise<void> }, 'close').mockImplementation(() => new Promise<void>(resolve => { finishClose = resolve }))
    const stopped = host.cancel(record.runId, 'owner')
    let settled = false
    const waiting = host.waitForResult(record.runId, 'owner').then(value => { settled = true; return value })
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(settled).toBe(false)
    await expect(host.cancel(record.runId, 'another-owner')).rejects.toThrow('RLM_OWNER_REQUIRED')
    finishClose()
    expect((await stopped).state).toBe('cancelled')
    expect((await waiting).state).toBe('cancelled')
    expect((await host.store.get(record.runId)).state).toBe('cancelled')
    lives.clear(); await host.dispose()
  })


  it('does not send a native prompt when the owner aborts during turn-intent persistence', async () => {
    const root = await directory(), host = new RlmHost({} as Context, root, '/unused', 100)
    const record = await host.store.create({ ownerSessionId: 'owner', cwd: root, route: { provider: 'fixture', model: 'only' }, label: 'admission abort', maxModelRequests: 1, maxWallTimeMs: 1000 })
    let release!: () => void
    vi.spyOn(host.store, 'append').mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
    const turn = vi.spyOn(host as unknown as { turn(value: unknown, text: string): Promise<void> }, 'turn').mockResolvedValue()
    const controller = new AbortController()
    const live = { record, controller: new AbortController(), evidence: { beginTurn: vi.fn() } }
    const beginTurn = Reflect.get(host, 'beginTurn').bind(host) as (value: unknown, text: string, signal: AbortSignal) => Promise<void>
    const starting = beginTurn(live, 'must not be sent', controller.signal)
    controller.abort(); release()
    await expect(starting).rejects.toThrow('RLM_OWNER_UNAVAILABLE')
    expect(turn).not.toHaveBeenCalled()
    expect(Reflect.get(live, 'timer')).toBeUndefined()
    await host.dispose()
  })

  it('waits for a cancellation receipt even after native cleanup has removed the live connection', async () => {
    const root = await directory(), host = new RlmHost({} as Context, root, '/unused', 100)
    const record = await host.store.create({ ownerSessionId: 'owner', cwd: root, route: { provider: 'fixture', model: 'only' }, label: 'detached cancel', maxModelRequests: 1, maxWallTimeMs: 1000 })
    record.state = 'cancelling'; await host.store.save(record)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve }).then(async () => {
      record.state = 'cancelled'; await host.store.save(record); return host.summary(record)
    })
    const cancellations = Reflect.get(host, 'cancellations') as Map<string, unknown>; cancellations.set(record.runId, pending)
    let settled = false
    const waiting = host.waitForResult(record.runId, 'owner').then(value => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    expect((await waiting).state).toBe('cancelled')
    cancellations.clear(); await host.dispose()
  })


  it('does not promote a late normal ACP response to success after cancellation', async () => {
    const root = await directory(), host = new RlmHost({} as Context, root, '/unused', 100)
    const record = await host.store.create({ ownerSessionId: 'owner', cwd: root, route: { provider: 'fixture', model: 'only' }, label: 'late ACP', maxModelRequests: 1, maxWallTimeMs: 1000 })
    record.state = 'running'
    let finish!: (value: unknown) => void
    const controller = new AbortController()
    const assertSettled = vi.fn()
    const live = { record, controller, acpId: 'fixture', acp: { request: vi.fn(() => new Promise(resolve => { finish = resolve })) }, evidence: { assertSettled } }
    const turn = Reflect.get(host, 'turn').bind(host) as (value: unknown, text: string) => Promise<void>
    const pending = turn(live, 'started before cancellation')
    record.state = 'cancelled'; controller.abort(); finish({ stopReason: 'end_turn' })
    await pending
    expect(record.state).toBe('cancelled')
    expect(assertSettled).not.toHaveBeenCalled()
    await host.dispose()
  })


  it('plugin disposal waits for a detached cancellation and surfaces its receipt failure', async () => {
    const root = await directory(), host = new RlmHost({} as Context, root, '/unused', 100)
    let rejectReceipt!: (error: Error) => void
    const pending = new Promise<never>((_resolve, reject) => { rejectReceipt = reject })
    const cancellations = Reflect.get(host, 'cancellations') as Map<string, unknown>; cancellations.set('already-detached', pending)
    let settled = false
    const stopped = host.dispose().finally(() => { settled = true })
    await Promise.resolve(); await Promise.resolve()
    expect(settled).toBe(false)
    rejectReceipt(new Error('receipt write failed'))
    await expect(stopped).rejects.toThrow('RLM 原生进程清理未全部确认')
    cancellations.clear()
  })

})
