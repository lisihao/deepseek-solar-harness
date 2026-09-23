import { describe, expect, it, vi } from 'vitest'
import type {
  IApiClient, ModelCatalogFailure, ModelProviderGroup, ModelSelection, RpcResponse, SessionId, SessionModels,
} from '@deepseek-ai/dsh-api-remotes/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import { ModelDirectory } from '../src/client/directory.ts'

function response<T>(result: RpcResponse<T>['result']): RpcResponse<T> {
  return { rpcId: RpcId('directory-test'), result }
}

const selection: ModelSelection = { provider: 'provider', model: 'model' }
const groups: ModelProviderGroup[] = [{
  id: 'provider',
  name: 'Provider',
  models: [{ id: 'model', name: 'Model' }],
}]
const failures: ModelCatalogFailure[] = [{ id: 'offline', name: 'Offline', message: 'catalog unavailable' }]

function value(overrides: Partial<SessionModels> = {}): SessionModels {
  return { current: selection, routable: true, groups, failures, ...overrides }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('ModelDirectory catalog refresh', () => {
  it('forwards refresh only when requested', async () => {
    const calls: unknown[] = []
    const sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'> = {
      models: (payload) => {
        calls.push(payload)
        return Promise.resolve(response({ ok: true, value: value() }))
      },
      selectModel: () => Promise.resolve(response({ ok: true, value: { selected: selection } })),
    }
    const directory = new ModelDirectory(sessions, 's1' as SessionId, () => true)

    await directory.load()
    await directory.load({ refresh: true })

    expect(calls).toEqual([
      { sessionId: 's1' },
      { sessionId: 's1', refresh: true },
    ])
  })

  it('preserves the last good selection and catalog when a refresh fails, including a stale race', async () => {
    const initial = value()
    const stale = deferred<RpcResponse<SessionModels>>()
    const latest = deferred<RpcResponse<SessionModels>>()
    const calls: unknown[] = []
    let call = 0
    const sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'> = {
      models: (payload) => {
        calls.push(payload)
        if (call++ === 0) return Promise.resolve(response({ ok: true, value: initial }))
        if (call === 2) return stale.promise
        return latest.promise
      },
      selectModel: () => Promise.resolve(response({ ok: true, value: { selected: selection } })),
    }
    const directory = new ModelDirectory(sessions, 's1' as SessionId, () => true)
    await directory.load()

    const older = directory.load()
    const refresh = directory.load({ refresh: true })
    latest.resolve(response({
      ok: false,
      error: { code: 'internal', message: 'refresh failed', details: {} },
    }))
    await expect(refresh).rejects.toThrow('session.models failed: internal: refresh failed')
    expect(directory.store.getSnapshot()).toMatchObject({
      current: selection,
      routable: true,
      groups,
      failures,
      status: 'error',
      error: 'internal: refresh failed',
    })

    stale.resolve(response({
      ok: true,
      value: value({ current: { provider: 'provider', model: 'stale' }, groups: [], failures: [] }),
    }))
    await older
    expect(directory.store.getSnapshot()).toMatchObject({
      current: selection,
      routable: true,
      groups,
      failures,
      status: 'error',
      error: 'internal: refresh failed',
    })
    expect(calls).toEqual([
      { sessionId: 's1' },
      { sessionId: 's1' },
      { sessionId: 's1', refresh: true },
    ])
  })

  it('does not overwrite the projection when a superseded refresh fails', async () => {
    const first = deferred<RpcResponse<SessionModels>>()
    const second = deferred<RpcResponse<SessionModels>>()
    const sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'> = {
      models: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
      selectModel: () => Promise.resolve(response({ ok: true, value: { selected: selection } })),
    }
    const directory = new ModelDirectory(sessions, 's1' as SessionId, () => true)
    const older = directory.load()
    const newer = directory.load({ refresh: true })
    second.resolve(response({ ok: true, value: value() }))
    await newer
    first.resolve(response({
      ok: false,
      error: { code: 'internal', message: 'stale failure', details: {} },
    }))
    await expect(older).rejects.toThrow('internal: stale failure')
    expect(directory.store.getSnapshot()).toMatchObject({
      current: selection,
      routable: true,
      groups,
      failures,
      status: 'ready',
      error: null,
    })
  })

  it('marks the current generation errored on transport rejection while preserving the last good projection', async () => {
    const transport = new Error('transport offline')
    const sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'> = {
      models: vi.fn()
        .mockResolvedValueOnce(response({ ok: true, value: value() }))
        .mockRejectedValueOnce(transport),
      selectModel: () => Promise.resolve(response({ ok: true, value: { selected: selection } })),
    }
    const directory = new ModelDirectory(sessions, 's1' as SessionId, () => true)
    await directory.load()

    await expect(directory.load({ refresh: true })).rejects.toBe(transport)
    expect(directory.store.getSnapshot()).toMatchObject({
      current: selection,
      routable: true,
      groups,
      failures,
      status: 'error',
      error: 'transport offline',
    })
  })

  it('does not let a stale or disposed transport rejection overwrite a newer state', async () => {
    const stale = deferred<RpcResponse<SessionModels>>()
    const latest = deferred<RpcResponse<SessionModels>>()
    const sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'> = {
      models: vi.fn()
        .mockResolvedValueOnce(response({ ok: true, value: value() }))
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(latest.promise),
      selectModel: () => Promise.resolve(response({ ok: true, value: { selected: selection } })),
    }
    const directory = new ModelDirectory(sessions, 's1' as SessionId, () => true)
    await directory.load()

    const older = directory.load()
    const newer = directory.load({ refresh: true })
    latest.resolve(response({ ok: true, value: value({ current: { provider: 'provider', model: 'newer' } }) }))
    await newer
    stale.reject(new Error('stale transport'))
    await expect(older).rejects.toThrow('stale transport')
    expect(directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'provider', model: 'newer' },
      status: 'ready',
      error: null,
    })

    const disposed = deferred<RpcResponse<SessionModels>>()
    const disposedSessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'> = {
      models: () => disposed.promise,
      selectModel: () => Promise.resolve(response({ ok: true, value: { selected: selection } })),
    }
    const disposedDirectory = new ModelDirectory(disposedSessions, 's2' as SessionId, () => true)
    const pending = disposedDirectory.load()
    disposedDirectory.dispose()
    disposed.reject(new Error('disposed transport'))
    await expect(pending).rejects.toThrow('disposed transport')
    expect(disposedDirectory.store.getSnapshot()).toMatchObject({ status: 'loading', error: null })
  })

  it('replaces successful groups and retains the last good list for failed providers on refresh', async () => {
    const oldGroups: ModelProviderGroup[] = [
      { id: 'stable', name: 'Stable', models: [{ id: 'old', name: 'Old' }] },
      { id: 'flaky', name: 'Flaky', models: [{ id: 'old', name: 'Old' }] },
    ]
    const freshGroups: ModelProviderGroup[] = [
      { id: 'stable', name: 'Stable', models: [{ id: 'new', name: 'New' }] },
      { id: 'new', name: 'New', models: [{ id: 'first', name: 'First' }] },
    ]
    const failed: ModelCatalogFailure = { id: 'flaky', name: 'Flaky', message: 'catalog offline' }
    const sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'> = {
      models: vi.fn()
        .mockResolvedValueOnce(response({
          ok: true,
          value: value({ current: selection, groups: oldGroups, failures: [] }),
        }))
        .mockResolvedValueOnce(response({
          ok: true,
          value: value({ current: selection, groups: freshGroups, failures: [failed] }),
        })),
      selectModel: () => Promise.resolve(response({ ok: true, value: { selected: selection } })),
    }
    const directory = new ModelDirectory(sessions, 's1' as SessionId, () => true)

    await directory.load()
    await directory.load({ refresh: true })

    expect(directory.store.getSnapshot()).toMatchObject({
      current: selection,
      groups: [...freshGroups, oldGroups[1]],
      failures: [failed],
      status: 'ready',
      error: null,
    })
  })
})
