import { Context } from '@deepseek-ai/cordis'
import { describe, expect, test, vi } from 'vitest'

import type { StudioUiApi } from '../src/studio-contract.js'
import { StudioControl } from '../src/studio-control.js'
import { STUDIO_RPC_REMOTE } from '../src/studio-remote.js'

const draftId = 'a13b9ba8-4f95-440f-b104-a722335b6364'

function api(): StudioUiApi {
  return {
    overview: vi.fn(async ({ sessionId }) => ({ sessionId, mode: { formatVersion: 1 as const, sessionId, revision: 0, mode: 'ordinary' as const }, providers: [], sources: [], drafts: [], runs: [] })),
    refreshSource: vi.fn(async ({ sourceId }) => ({ id: sourceId, graph: {} as never, capturedAt: '2026-10-20T00:00:00.000Z' })),
    save: vi.fn(async (input) => ({ formatVersion: 1 as const, id: input.id, revision: 0, graph: input.graph, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' })),
    validate: vi.fn(async () => []),
    run: vi.fn(async () => ({ formatVersion: 1 as const, commandId: 'command-a', draftId, draftRevision: 0, graph: {} as never, run: {} as never })),
    inspect: vi.fn(async () => ({ formatVersion: 1 as const, commandId: 'command-a', draftId, draftRevision: 0, graph: {} as never, run: {} as never })),
    resume: vi.fn(async () => ({ id: 'command-a', sessionId: 'session-a', providerId: 'web' as const, status: 'running' as const, nodes: [], createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' })),
    setMode: vi.fn(async ({ sessionId, mode, expectedRevision }) => ({ formatVersion: 1 as const, sessionId, mode, revision: expectedRevision + 1 })),
  }
}

describe('workflow StudioControl', () => {
  test('exports every editor RPC and rejects extra request fields before forwarding', async () => {
    expect(STUDIO_RPC_REMOTE.descriptors.map((descriptor) => descriptor.method)).toEqual(['overview', 'refreshSource', 'save', 'validate', 'run', 'inspect', 'resume', 'setMode'])
    const target = api()
    const control = new StudioControl(new Context(), target)
    await control.overview({ sessionId: 'session-a' })
    await control.refreshSource({ sessionId: 'session-a', sourceId: 'source-a' })
    await control.save({ sessionId: 'session-a', id: draftId, expectedRevision: 0, graph: {} })
    await control.validate({ sessionId: 'session-a', graph: {} })
    await control.run({ sessionId: 'session-a', draftId, expectedRevision: 0, commandId: 'command-a' })
    await control.inspect({ sessionId: 'session-a', commandId: 'command-a' })
    await control.resume({ sessionId: 'session-a', commandId: 'command-a' })
    await control.setMode({ sessionId: 'session-a', mode: 'smart', expectedRevision: 0 })
    await expect(control.run({ sessionId: 'session-a', draftId, expectedRevision: 0, commandId: 'command-a', retry: true })).rejects.toThrow()
    expect(target.run).toHaveBeenCalledTimes(1)
  })

  test('denies every method to a non-owner Remote caller', async () => {
    const control = new StudioControl(new Context(), api())
    const remote = Object.create(control) as StudioControl
    Object.defineProperty(remote, 'ctx', { value: { invocation: { peer: { principal: { kind: 'untrusted-test-peer' } } } } })
    await expect(remote.overview({ sessionId: 'session-a' })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(remote.refreshSource({ sessionId: 'session-a', sourceId: 'source-a' })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(remote.save({ sessionId: 'session-a', id: draftId, expectedRevision: 0, graph: {} })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(remote.validate({ sessionId: 'session-a', graph: {} })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(remote.run({ sessionId: 'session-a', draftId, expectedRevision: 0, commandId: 'command-a' })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(remote.inspect({ sessionId: 'session-a', commandId: 'command-a' })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(remote.resume({ sessionId: 'session-a', commandId: 'command-a' })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(remote.setMode({ sessionId: 'session-a', mode: 'smart', expectedRevision: 0 })).rejects.toThrow('LOCAL_OWNER_REQUIRED')
  })
})
