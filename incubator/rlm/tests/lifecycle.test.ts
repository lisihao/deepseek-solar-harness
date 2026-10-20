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
})
