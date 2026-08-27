/** Background Session handoff without active-authority duplication. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionHeader, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  DesktopSessionSyncController, type DesktopRemoteReplicaClient,
} from '../src/session-sync.ts'

const header = { version: 1, id: 'session-1', createdAt: 1, cwd: '/work' } as unknown as SessionHeader
const document = { meta: header, events: [], balanced: true } as const

function remote(overrides: Partial<DesktopRemoteReplicaClient> = {}): DesktopRemoteReplicaClient {
  return {
    replicaList: async () => [{ header, revision: 'remote-r1' }],
    replicaRead: async () => document,
    replicaApply: async () => ({
      sessionId: 'session-1', state: 'created', sourceEventCount: 0,
      destinationEventCount: 0, appendedEventCount: 0,
    }),
    ...overrides,
  }
}

describe('DesktopSessionSyncController', () => {
  it('stages a closed remote Session in Frontend mode and imports it once local Server starts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-session-sync-'))
    const replicaRead = vi.fn(async () => document)
    const replicate = vi.fn(async () => ({
      sessionId: header.id, state: 'created' as const, sourceEventCount: 0,
      destinationEventCount: 0, appendedEventCount: 0,
    }))
    let local: Pick<SessionPersistence, 'listSnapshots' | 'load' | 'replicate'> | undefined
    const controller = new DesktopSessionSyncController(root, {
      remote: async () => ({ serverId: 'mini-1', client: remote({ replicaRead }) }),
      local: () => local,
    })
    await controller.start()

    const pulled = await controller.runNow()
    expect(pulled.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: 'pull', status: 'ok', sessionId: 'session-1' }),
    ]))
    expect(replicaRead).toHaveBeenCalledOnce()

    local = {
      listSnapshots: async () => [],
      load: async () => document,
      replicate,
    }
    await expect(controller.importInbox()).resolves.toEqual([
      expect.objectContaining({ direction: 'import', status: 'ok', sessionId: 'session-1' }),
    ])
    await expect(controller.importInbox()).resolves.toEqual([])
    expect(replicate).toHaveBeenCalledOnce()
    controller.stop()
  })

  it('reuses successful pull and push revisions instead of retransferring unchanged logs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-session-revisions-'))
    const replicaRead = vi.fn(async () => document)
    const replicaApply = vi.fn(async () => ({
      sessionId: 'session-1', state: 'unchanged' as const, sourceEventCount: 0,
      destinationEventCount: 0, appendedEventCount: 0,
    }))
    const local = {
      listSnapshots: vi.fn(async () => [{ header, revision: 'local-r1' as never }]),
      load: vi.fn(async () => document),
      replicate: vi.fn(async () => ({
        sessionId: header.id, state: 'unchanged' as const, sourceEventCount: 0,
        destinationEventCount: 0, appendedEventCount: 0,
      })),
    }
    const controller = new DesktopSessionSyncController(root, {
      remote: async () => ({ serverId: 'mini-1', client: remote({ replicaRead, replicaApply }) }),
      local: () => local,
    })
    await controller.start()
    await controller.configure({ enabled: false, intervalMinutes: 10, direction: 'bidirectional' })

    await controller.runNow()
    await controller.runNow()

    expect(replicaRead).toHaveBeenCalledOnce()
    expect(local.replicate).toHaveBeenCalledOnce()
    expect(local.load).toHaveBeenCalledOnce()
    expect(replicaApply).toHaveBeenCalledOnce()
    controller.stop()
  })
})
