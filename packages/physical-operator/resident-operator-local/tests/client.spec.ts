import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  ResidentOperatorError,
  RESIDENT_PROTOCOL_VERSION,
  RESIDENT_STATE_SCHEMA_VERSION,
} from '@deepseek-ai/dsh-resident-operator'
import { ResidentDaemonClient, waitForDaemonSocketRelease } from '../src/client.ts'
import { residentDriverManifestSha256 } from '../src/driver-modules.ts'

const REQUIRED_METHODS = [
  'system.handshake',
  'system.shutdown',
  'operator.list',
  'operator.authenticate',
  'session.list',
  'session.inspect',
  'turn.execute',
  'turn.inspect',
  'turn.interrupt',
  'turn.resolve_indeterminate',
  'session.compact',
  'session.reset',
  'event.read',
]
const V5_PROTOCOL_VERSION = 14
const V5_STATE_SCHEMA_VERSION = 5

function mockHandshake(): Record<string, unknown> {
  return {
    protocolVersion: RESIDENT_PROTOCOL_VERSION,
    stateSchemaVersion: RESIDENT_STATE_SCHEMA_VERSION,
    daemonInstanceId: 'mock-daemon',
    buildCommit: process.env.DSH_BUILD_COMMIT ?? 'development',
    methods: REQUIRED_METHODS,
    driverManifestSha256: residentDriverManifestSha256([]),
  }
}

function mockV5Handshake(params: Record<string, unknown>, daemonInstanceId: string): Record<string, unknown> {
  if (params.protocol_version !== V5_PROTOCOL_VERSION
    || params.state_schema_version !== V5_STATE_SCHEMA_VERSION
    || params.driver_manifest_sha256 !== residentDriverManifestSha256([])) {
    throw new ResidentOperatorError('resident daemon protocol 14/schema 5 does not match client', 'PROTOCOL_MISMATCH')
  }
  return {
    ...mockHandshake(),
    protocolVersion: V5_PROTOCOL_VERSION,
    stateSchemaVersion: V5_STATE_SCHEMA_VERSION,
    daemonInstanceId,
    buildCommit: 'v5-build',
  }
}

async function listenMockDaemon(
  socketPath: string,
  handshake: (params: Record<string, unknown>) => Record<string, unknown>,
  shutdownOnRequest = false,
  onShutdownComplete?: () => void,
  verifyShutdown?: (params: Record<string, unknown>) => void,
): Promise<{
  readonly server: ReturnType<typeof createServer>
  readonly methods: string[][]
  readonly handshakeParams: Record<string, unknown>[]
  readonly operatorListParams: Record<string, unknown>[]
  readonly shutdownParams: Record<string, unknown>[]
}> {
  const methods: string[][] = []
  const handshakeParams: Record<string, unknown>[] = []
  const operatorListParams: Record<string, unknown>[] = []
  const shutdownParams: Record<string, unknown>[] = []
  const server = createServer((socket) => {
    const connectionMethods: string[] = []
    let recordedConnection = false
    let qualified = false
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.length === 0) continue
        const frame = JSON.parse(line) as {
          readonly id: string | number
          readonly method: string
          readonly params?: unknown
        }
        const params = frame.params !== null && typeof frame.params === 'object' && !Array.isArray(frame.params)
          ? frame.params as Record<string, unknown>
          : {}
        if (!recordedConnection) {
          methods.push(connectionMethods)
          recordedConnection = true
        }
        connectionMethods.push(frame.method)
        try {
          let value: Record<string, unknown>
          if (frame.method === 'system.handshake') {
            handshakeParams.push(params)
            value = handshake(params)
            qualified = true
          } else if (frame.method === 'operator.list') {
            operatorListParams.push(params)
            value = { providers: [] }
          } else if (frame.method === 'session.list') {
            value = { sessions: [] }
          } else if (frame.method === 'system.shutdown') {
            if (shutdownOnRequest && !qualified) {
              throw new ResidentOperatorError('resident client must complete a compatible handshake before shutdown', 'PROTOCOL_MISMATCH')
            }
            shutdownParams.push(params)
            verifyShutdown?.(params)
            value = {}
          } else {
            value = {}
          }
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { ok: true, value } })}\n`)
          if (frame.method === 'system.shutdown' && shutdownOnRequest) {
            setTimeout(() => {
              socket.end()
              server.close(() => { onShutdownComplete?.() })
            }, 0)
          }
        } catch (error) {
          const residentError = error instanceof ResidentOperatorError ? error : undefined
          socket.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            result: {
              ok: false,
              error: {
                code: residentError?.code ?? 'RUNTIME_UNAVAILABLE',
                message: error instanceof Error ? error.message : String(error),
              },
            },
          })}\n`)
        }
      }
    })
  })
  server.listen(socketPath)
  await once(server, 'listening')
  return { server, methods, handshakeParams, operatorListParams, shutdownParams }
}

function createMockAuthority(root: string, pid: number, instanceId: string): () => void {
  const path = join(root, 'daemon-authority.sqlite')
  const authority = new DatabaseSync(path)
  authority.exec(`
    CREATE TABLE daemon_authority (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      pid INTEGER NOT NULL,
      instance_id TEXT NOT NULL
    ) STRICT;
  `)
  authority.prepare(
    'INSERT INTO daemon_authority (singleton, pid, instance_id) VALUES (1, ?, ?)',
  ).run(pid, instanceId)
  authority.close()
  return () => {
    const release = new DatabaseSync(path)
    try {
      release.prepare(
        'DELETE FROM daemon_authority WHERE singleton = 1 AND pid = ? AND instance_id = ?',
      ).run(pid, instanceId)
    } finally {
      release.close()
    }
  }
}

async function closeMockDaemon(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
}

describe('waitForDaemonSocketRelease', () => {
  it('returns immediately when the daemon path is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-daemon-release-'))
    try {
      await expect(waitForDaemonSocketRelease(join(root, 'control.sock'), 100, 'darwin')).resolves.toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('observes release within the bounded shutdown interval', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-daemon-release-'))
    const control = join(root, 'control.sock')
    writeFileSync(control, '')
    const timer = setTimeout(() => { rmSync(control) }, 5)
    try {
      await expect(waitForDaemonSocketRelease(control, 100, 'darwin')).resolves.toBe(true)
    } finally {
      clearTimeout(timer)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports a daemon path that remains past the deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-daemon-release-'))
    const control = join(root, 'control.sock')
    writeFileSync(control, '')
    try {
      await expect(waitForDaemonSocketRelease(control, 1, 'darwin')).resolves.toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ResidentDaemonClient request qualification', () => {
  it('performs the handshake and business method on the same transport', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-client-'))
    const client = new ResidentDaemonClient({ root, autoStart: false, connectTimeoutMs: 1_000, pollIntervalMs: 10 })
    const mock = await listenMockDaemon(client.socketPath, mockHandshake)
    try {
      await expect(client.providers()).resolves.toEqual([])
      expect(mock.methods).toEqual([
        ['system.handshake'],
        ['system.handshake', 'operator.list'],
      ])
    } finally {
      await closeMockDaemon(mock.server)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes explicit model refresh intent while normal provider reads stay unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-client-'))
    const client = new ResidentDaemonClient({ root, autoStart: false, connectTimeoutMs: 1_000, pollIntervalMs: 10 })
    const mock = await listenMockDaemon(client.socketPath, mockHandshake)
    try {
      await expect(client.providers()).resolves.toEqual([])
      await expect(client.providers({ refreshModels: true })).resolves.toEqual([])
      expect(mock.operatorListParams).toEqual([{}, { refresh_models: true }])
    } finally {
      await closeMockDaemon(mock.server)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requalifies cached readiness after daemon replacement and sends no business method after a failed handshake', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-client-'))
    const client = new ResidentDaemonClient({ root, autoStart: false, connectTimeoutMs: 1_000, pollIntervalMs: 10 })
    let replaced = false
    const mock = await listenMockDaemon(client.socketPath, () => replaced
      ? { ...mockHandshake(), protocolVersion: RESIDENT_PROTOCOL_VERSION - 1 }
      : mockHandshake())
    try {
      await client.ready()
      replaced = true
      await expect(client.providers()).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
      expect(mock.methods).toEqual([
        ['system.handshake'],
        ['system.handshake'],
      ])
    } finally {
      await closeMockDaemon(mock.server)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a daemon without an instance identity before sending the business method', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-client-'))
    const client = new ResidentDaemonClient({ root, autoStart: false, connectTimeoutMs: 1_000, pollIntervalMs: 10 })
    const mock = await listenMockDaemon(client.socketPath, () => {
      const { daemonInstanceId: _omitted, ...response } = mockHandshake()
      return response
    })
    try {
      await expect(client.providers()).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
      expect(mock.methods).toEqual([['system.handshake']])
    } finally {
      await closeMockDaemon(mock.server)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retires and replaces an incompatible daemon before the first business request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-client-upgrade-'))
    const client = new ResidentDaemonClient({ root, autoStart: true, connectTimeoutMs: 5_000, pollIntervalMs: 10 })
    writeFileSync(join(root, 'daemon.pid'), `${process.pid}\n`)
    let authorityReleased = false
    const releaseAuthority = createMockAuthority(root, process.pid, 'v5-daemon')
    const mock = await listenMockDaemon(
      client.socketPath,
      params => mockV5Handshake(params, 'v5-daemon'),
      true,
      () => {
        releaseAuthority()
        authorityReleased = true
      },
      (params) => {
        expect(params).toEqual({
          expected_daemon_pid: process.pid,
          expected_daemon_instance_id: 'v5-daemon',
        })
      },
    )
    const internals = client as unknown as {
      handshake: () => Promise<void>
      startAndWaitForReady: () => Promise<void>
    }
    let replacement: Awaited<ReturnType<typeof listenMockDaemon>> | undefined
    internals.startAndWaitForReady = async () => {
      expect(authorityReleased).toBe(true)
      replacement = await listenMockDaemon(client.socketPath, mockHandshake)
      await internals.handshake()
    }
    try {
      await expect(client.ready()).resolves.toBeUndefined()
      await expect(client.list()).resolves.toEqual([])
      expect(mock.methods).toEqual([
        ['system.handshake'],
        ['system.handshake', 'system.shutdown'],
      ])
      expect(mock.handshakeParams).toEqual([
        {
          protocol_version: RESIDENT_PROTOCOL_VERSION,
          state_schema_version: RESIDENT_STATE_SCHEMA_VERSION,
          driver_manifest_sha256: residentDriverManifestSha256([]),
        },
        {
          protocol_version: RESIDENT_PROTOCOL_VERSION,
          state_schema_version: V5_STATE_SCHEMA_VERSION,
          driver_manifest_sha256: residentDriverManifestSha256([]),
        },
      ])
      expect(mock.shutdownParams).toEqual([{
        expected_daemon_pid: process.pid,
        expected_daemon_instance_id: 'v5-daemon',
      }])
      expect(replacement?.methods).toEqual([
        ['system.handshake'],
        ['system.handshake', 'session.list'],
      ])
    } finally {
      if (replacement?.server.listening) await closeMockDaemon(replacement.server)
      if (mock.server.listening) await closeMockDaemon(mock.server)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not retire a v5 daemon whose authority identifies a replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-client-upgrade-'))
    const client = new ResidentDaemonClient({ root, autoStart: true, connectTimeoutMs: 1_000, pollIntervalMs: 10 })
    writeFileSync(join(root, 'daemon.pid'), `${process.pid}\n`)
    const releaseAuthority = createMockAuthority(root, process.pid, 'replacement-daemon')
    const mock = await listenMockDaemon(client.socketPath, params => mockV5Handshake(params, 'v5-daemon'))
    try {
      await expect(client.ready()).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
      expect(mock.methods).toEqual([
        ['system.handshake'],
        ['system.handshake'],
      ])
    } finally {
      if (mock.server.listening) await closeMockDaemon(mock.server)
      releaseAuthority()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retires a same-schema daemon after an observed build mismatch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-client-upgrade-'))
    const client = new ResidentDaemonClient({ root, autoStart: true, connectTimeoutMs: 1_000, pollIntervalMs: 10 })
    writeFileSync(join(root, 'daemon.pid'), `${process.pid}\n`)
    let authorityReleased = false
    const releaseAuthority = createMockAuthority(root, process.pid, 'build-mismatch-daemon')
    const mock = await listenMockDaemon(
      client.socketPath,
      () => ({
        ...mockHandshake(),
        daemonInstanceId: 'build-mismatch-daemon',
        buildCommit: 'previous-build',
      }),
      true,
      () => {
        releaseAuthority()
        authorityReleased = true
      },
      (params) => {
        expect(params).toEqual({
          expected_daemon_pid: process.pid,
          expected_daemon_instance_id: 'build-mismatch-daemon',
        })
      },
    )
    const internals = client as unknown as {
      handshake: () => Promise<void>
      startAndWaitForReady: () => Promise<void>
    }
    let replacement: Awaited<ReturnType<typeof listenMockDaemon>> | undefined
    internals.startAndWaitForReady = async () => {
      expect(authorityReleased).toBe(true)
      replacement = await listenMockDaemon(client.socketPath, mockHandshake)
      await internals.handshake()
    }
    try {
      await expect(client.ready()).resolves.toBeUndefined()
      expect(mock.methods).toEqual([
        ['system.handshake'],
        ['system.handshake', 'system.shutdown'],
      ])
      expect(mock.handshakeParams).toEqual([
        {
          protocol_version: RESIDENT_PROTOCOL_VERSION,
          state_schema_version: RESIDENT_STATE_SCHEMA_VERSION,
          driver_manifest_sha256: residentDriverManifestSha256([]),
        },
        {
          protocol_version: RESIDENT_PROTOCOL_VERSION,
          state_schema_version: RESIDENT_STATE_SCHEMA_VERSION,
          driver_manifest_sha256: residentDriverManifestSha256([]),
        },
      ])
      expect(mock.shutdownParams).toEqual([{
        expected_daemon_pid: process.pid,
        expected_daemon_instance_id: 'build-mismatch-daemon',
      }])
    } finally {
      if (replacement?.server.listening) await closeMockDaemon(replacement.server)
      if (mock.server.listening) await closeMockDaemon(mock.server)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retires a mismatched daemon when a cross-package-shaped error only exposes a stable code', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-client-'))
    const client = new ResidentDaemonClient({ root, autoStart: true, connectTimeoutMs: 1_000, pollIntervalMs: 10 })
    writeFileSync(join(root, 'daemon.pid'), `${process.pid}\n`)
    const internals = client as unknown as {
      handshake: () => Promise<void>
      retireIncompatibleDaemon: (error: unknown, daemonPid: number | undefined) => Promise<boolean>
      startAndWaitForReady: () => Promise<void>
    }
    let handshakeCalls = 0
    let retiredError: unknown
    internals.handshake = async () => {
      handshakeCalls += 1
      throw { code: 'PROTOCOL_MISMATCH', message: 'foreign copy error' }
    }
    internals.retireIncompatibleDaemon = async (error) => {
      retiredError = error
      return true
    }
    internals.startAndWaitForReady = async () => undefined

    try {
      await expect(client.ready()).resolves.toBeUndefined()
      expect(handshakeCalls).toBe(1)
      expect(retiredError).toEqual({ code: 'PROTOCOL_MISMATCH', message: 'foreign copy error' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('shares one incompatible-daemon recovery across clients for the same root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-resident-client-shared-recovery-'))
    const first = new ResidentDaemonClient({ root, autoStart: true, connectTimeoutMs: 1_000, pollIntervalMs: 10 })
    const second = new ResidentDaemonClient({ root, autoStart: true, connectTimeoutMs: 1_000, pollIntervalMs: 10 })
    type RecoveryInternals = {
      recoverIncompatibleDaemon(error: unknown, daemonPid: number | undefined): Promise<void>
      retireIncompatibleDaemon(error: unknown, daemonPid: number | undefined): Promise<boolean>
      startAndWaitForReady(): Promise<void>
      handshake(): Promise<void>
    }
    const firstInternals = first as unknown as RecoveryInternals
    const secondInternals = second as unknown as RecoveryInternals
    const gate = Promise.withResolvers<undefined>()
    let retireCalls = 0
    let startCalls = 0
    let secondHandshakeCalls = 0
    firstInternals.retireIncompatibleDaemon = async () => {
      retireCalls += 1
      await gate.promise
      return true
    }
    firstInternals.startAndWaitForReady = async () => { startCalls += 1 }
    secondInternals.retireIncompatibleDaemon = async () => { throw new Error('duplicate retirement') }
    secondInternals.startAndWaitForReady = async () => { throw new Error('duplicate start') }
    secondInternals.handshake = async () => { secondHandshakeCalls += 1 }

    try {
      const firstRecovery = firstInternals.recoverIncompatibleDaemon(
        { code: 'PROTOCOL_MISMATCH', message: 'old daemon' },
        process.pid,
      )
      await Promise.resolve()
      const secondRecovery = secondInternals.recoverIncompatibleDaemon(
        { code: 'PROTOCOL_MISMATCH', message: 'old daemon' },
        process.pid,
      )
      gate.resolve(undefined)
      await Promise.all([firstRecovery, secondRecovery])
      expect({ retireCalls, startCalls, secondHandshakeCalls }).toEqual({
        retireCalls: 1,
        startCalls: 1,
        secondHandshakeCalls: 1,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
