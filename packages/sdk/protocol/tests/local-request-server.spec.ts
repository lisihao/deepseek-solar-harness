import { access, chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JsonRpcLineTransport, LocalJsonRpcRequestServer } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-local-jsonrpc-'))
  roots.push(root)
  return root
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
    const root = await temporaryRoot()
    const directory = join(root, 'nested')
    const path = join(directory, 'control.sock')
    const server = new LocalJsonRpcRequestServer({ path, directory }, async (method, params) => ({ method, params }))

    const firstStart = server.start()
    expect(server.start()).toBe(firstStart)
    await firstStart
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(request(path)).resolves.toEqual({ method: 'echo', params: { value: 'hello' } })

    await server.dispose()
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await server.dispose()

    await server.start()
    await expect(request(path, 'again')).resolves.toEqual({ method: 'again', params: { value: 'hello' } })
    await server.dispose()
  })

  it('supports an address without filesystem ownership metadata', async () => {
    const root = await temporaryRoot()
    await mkdir(root, { recursive: true })
    await chmod(root, 0o700)
    const path = join(root, 'caller-owned.sock')
    const server = new LocalJsonRpcRequestServer({ path }, async () => 'ok')

    await server.start()
    await expect(request(path)).resolves.toBe('ok')
    await server.dispose()
  })

  it('rejects when the caller supplies an unreachable endpoint', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'missing', 'control.sock')
    const server = new LocalJsonRpcRequestServer({ path }, async () => 'unreachable')

    await expect(server.start()).rejects.toThrow()
  })
})
