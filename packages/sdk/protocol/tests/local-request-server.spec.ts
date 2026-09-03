import { randomUUID } from 'node:crypto'
import { access, chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fsHarness = vi.hoisted(() => ({
  chmodCalls: [] as string[],
  rmCalls: [] as string[],
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    chmodSync(path: Parameters<typeof actual.chmodSync>[0], mode: Parameters<typeof actual.chmodSync>[1]): void {
      if (process.platform === 'win32' && typeof path === 'string' && path.startsWith('\\\\.\\pipe\\')) {
        fsHarness.chmodCalls.push(path)
        return
      }
      actual.chmodSync(path, mode)
    },
    rmSync(path: Parameters<typeof actual.rmSync>[0], options: Parameters<typeof actual.rmSync>[1]): void {
      if (process.platform === 'win32' && typeof path === 'string' && path.startsWith('\\\\.\\pipe\\')) {
        fsHarness.rmCalls.push(path)
        return
      }
      actual.rmSync(path, options)
    },
  }
})

import { JsonRpcLineTransport, LocalJsonRpcRequestServer } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  fsHarness.chmodCalls.length = 0
  fsHarness.rmCalls.length = 0
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-jsonrpc-'))
  roots.push(root)
  return root
}

async function temporaryEndpoint(
  label: string,
  ownsDirectory: boolean,
): Promise<{ path: string; directory?: string }> {
  if (process.platform === 'win32') {
    const directory = ownsDirectory ? await temporaryRoot() : undefined
    return {
      path: `\\\\.\\pipe\\dsh-local-jsonrpc-${process.pid}-${label}-${randomUUID()}`,
      ...(directory === undefined ? {} : { directory }),
    }
  }
  const root = await temporaryRoot()
  const directory = ownsDirectory ? join(root, 'nested') : root
  return {
    path: join(directory, `${label}.sock`),
    ...(ownsDirectory ? { directory } : {}),
  }
}

async function request(path: string, method = 'echo'): Promise<unknown> {
  const socket = createConnection(path)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const transport = new JsonRpcLineTransport(socket, socket)
  transport.start()
  try {
    return await transport.request(method, { value: 'hello' })
  } finally {
    transport.close()
    socket.destroy()
  }
}

describe('LocalJsonRpcRequestServer', () => {
  it('owns a filesystem-backed endpoint, serves requests, and restarts cleanly', async () => {
    const endpoint = await temporaryEndpoint('control', true)
    const server = new LocalJsonRpcRequestServer(endpoint, async (method, params) => ({ method, params }))

    const firstStart = server.start()
    expect(server.start()).toBe(firstStart)
    await firstStart
    if (endpoint.directory !== undefined) {
      if (process.platform === 'win32') {
        expect(fsHarness.chmodCalls).toEqual([endpoint.path])
      } else {
        expect((await stat(endpoint.directory)).mode & 0o777).toBe(0o700)
        expect((await stat(endpoint.path)).mode & 0o777).toBe(0o600)
      }
    }
    await expect(request(endpoint.path)).resolves.toEqual({ method: 'echo', params: { value: 'hello' } })

    await server.dispose()
    if (endpoint.directory !== undefined) {
      if (process.platform === 'win32') {
        expect(fsHarness.rmCalls).toContain(endpoint.path)
      } else {
        await expect(access(endpoint.path)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    }
    await server.dispose()

    await server.start()
    await expect(request(endpoint.path, 'again')).resolves.toEqual({ method: 'again', params: { value: 'hello' } })
    await server.dispose()
  })

  it('supports an address without filesystem ownership metadata', async () => {
    const endpoint = await temporaryEndpoint('caller-owned', false)
    if (process.platform !== 'win32') {
      await chmod(dirname(endpoint.path), 0o700)
    }
    const server = new LocalJsonRpcRequestServer(endpoint, async () => 'ok')

    await server.start()
    await expect(request(endpoint.path)).resolves.toBe('ok')
    await server.dispose()
  })

  it('rejects when the caller supplies an unreachable endpoint', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'missing', 'control.sock')
    const server = new LocalJsonRpcRequestServer({ path }, async () => 'unreachable')

    await expect(server.start()).rejects.toThrow()
  })
})
