/** Browser-safe Remote Sync contract parsing. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseRemoteSyncDescription, parseRemoteSyncFrame, parseRemoteSyncSnapshot,
} from '../src/remote-sync.ts'
import { WebRemoteSyncClient } from '../src/client/remote-sync-client.ts'

const snapshot = {
  protocol: { major: 1, minor: 1 },
  deploymentId: 'deployment-1',
  cursor: { deploymentId: 'deployment-1', sequence: 7 },
  capturedAt: '2026-08-23T08:00:00.000Z',
  host: {
    version: '3.1.3', cwd: '/srv/dsh', attachedSessions: 1, canOpenPath: false,
  },
  sessions: [{
    sessionId: 'session-1', updatedAt: 1, running: true, blank: false, cwd: '/srv/dsh',
  }],
  workspaces: [{
    workspaceId: 'workspace-1', path: '/srv/dsh', title: 'dsh',
    sessionIds: ['session-1'], createdAt: '2026-08-23T07:00:00.000Z',
    updatedAt: '2026-08-23T08:00:00.000Z',
  }],
  archivedSessionIds: [],
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Remote Sync wire parsing', () => {
  it('accepts an authenticated Server description and rejects unknown capabilities', () => {
    const description = {
      protocol: { major: 1, minor: 1 },
      deploymentId: 'deployment-1',
      cursor: { deploymentId: 'deployment-1', sequence: 7 },
      describedAt: '2026-08-23T08:00:00.000Z',
      scope: 'cockpit',
      capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
      host: snapshot.host,
    }
    expect(parseRemoteSyncDescription(description)).toMatchObject({
      deploymentId: 'deployment-1', scope: 'cockpit',
      capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
    })
    expect(() => parseRemoteSyncDescription({
      ...description, capabilities: [...description.capabilities, 'task.write'],
    })).toThrow('capability is invalid')
  })

  it('describes the Server with a bearer header and never puts the token in its URL', async () => {
    let seenUrl = ''
    let seenAuthorization: string | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string }
      seenUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seenAuthorization = new Headers(init.headers).get('authorization')
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            protocol: { major: 1, minor: 1 },
            deploymentId: 'deployment-1',
            cursor: { deploymentId: 'deployment-1', sequence: 7 },
            describedAt: '2026-08-23T08:00:00.000Z',
            scope: 'cockpit',
            capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
            host: snapshot.host,
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    await expect(new WebRemoteSyncClient('https://server.example', 'short-lived').describe())
      .resolves.toMatchObject({ deploymentId: 'deployment-1', scope: 'cockpit' })
    expect(seenUrl).toBe('https://server.example/remote-sync/describe')
    expect(seenUrl).not.toContain('short-lived')
    expect(seenAuthorization).toBe('Bearer short-lived')
  })

  it('accepts a complete snapshot and rejects protocol or deployment mismatch', () => {
    expect(parseRemoteSyncSnapshot(snapshot)).toMatchObject({
      deploymentId: 'deployment-1', cursor: { sequence: 7 },
      sessions: [{ sessionId: 'session-1' }],
    })
    expect(() => parseRemoteSyncSnapshot({
      ...snapshot, protocol: { major: 2, minor: 0 },
    })).toThrow('protocol mismatch')
    expect(() => parseRemoteSyncSnapshot({
      ...snapshot, cursor: { deploymentId: 'deployment-2', sequence: 7 },
    })).toThrow('another deployment')
  })

  it('validates nested mux/host envelopes and structured resync frames', () => {
    expect(parseRemoteSyncFrame({
      type: 'remote-sync/event', sequence: 8, stream: 'host',
      envelope: {
        rpcId: 'rpc-1',
        payload: { type: 'host/session-status', sessionId: 'session-1', running: false },
      },
    })).toMatchObject({ sequence: 8, stream: 'host', envelope: { rpcId: 'rpc-1' } })
    expect(parseRemoteSyncFrame({
      type: 'remote-sync/resync-required', deploymentId: 'deployment-1',
      earliestSequence: 3, latestSequence: 10, reason: 'cursor-expired',
    })).toMatchObject({ reason: 'cursor-expired' })
    expect(() => parseRemoteSyncFrame({
      type: 'remote-sync/event', sequence: 0, stream: 'host', envelope: {},
    })).toThrow('must be positive')
  })
})
