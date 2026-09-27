import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { PhysicalOperatorModelToolBridgeV1 } from '@deepseek-ai/dsh-physical-operator'
import { PhysicalOperatorModelToolBridge } from '../src/model-tool-bridge.ts'

const contexts: Context[] = []
let nextAgentId = 0
let dshHome: string

// A short root keeps bridge sockets at their direct `physical-operator/model-tools-<pid>-<n>.sock`
// address instead of the hashed temporary-directory fallback for long Unix socket paths.
beforeEach(() => {
  dshHome = mkdtempSync('/tmp/dsh-bridge-')
  vi.stubEnv('DSH_HOME', dshHome)
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
  vi.unstubAllEnvs()
  rmSync(dshHome, { recursive: true, force: true })
})

const schema = {
  name: 'deferred_tool',
  description: 'A deferred tool used to verify bridge quiescence.',
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
} as const

const parameters = { value: { type: 'string', required: true } } as const

async function setup(execute: (value: string) => Promise<string>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const session = Session.create(SessionId(`model-tool-bridge-${++nextAgentId}`))
  const agent = { id: session.id, session } as unknown as Agent
  ctx.tools.register(defineTool({
    name: schema.name,
    description: schema.description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: args => execute(args.value),
  }))
  return { ctx, agent, bridge: new PhysicalOperatorModelToolBridge(ctx) }
}

async function connect(descriptor: PhysicalOperatorModelToolBridgeV1): Promise<{
  readonly socket: Socket
  readonly transport: JsonRpcLineTransport
}> {
  const socket = createConnection(descriptor.socketPath)
  await once(socket, 'connect')
  const transport = new JsonRpcLineTransport(socket, socket)
  transport.start()
  return { socket, transport }
}

function request(
  transport: JsonRpcLineTransport,
  descriptor: PhysicalOperatorModelToolBridgeV1,
  commandId: string,
  value: string,
) {
  return transport.request('tool.call', {
    session_id: descriptor.sessionId,
    command_id: commandId,
    tool: schema.name,
    arguments: { value },
  })
}

async function close(socket: Socket, transport: JsonRpcLineTransport): Promise<void> {
  transport.close()
  if (!socket.destroyed) {
    const closed = once(socket, 'close')
    socket.destroy()
    await closed
  }
}

describe('PhysicalOperatorModelToolBridge lifecycle', () => {
  it('revokes a binding immediately while release waits for accepted tool work', async () => {
    const tool = Promise.withResolvers<string>()
    const started = Promise.withResolvers<true>()
    const { agent, bridge } = await setup(async () => {
      started.resolve(true)
      return tool.promise
    })
    const bound = await bridge.bind('release-command', agent, [schema], new AbortController().signal)
    if (bound.descriptor === undefined) throw new Error('expected a bridge descriptor')
    const { socket, transport } = await connect(bound.descriptor)
    try {
      const accepted = request(transport, bound.descriptor, 'accepted-call', 'deferred')
      await started.promise

      let released = false
      const release = bound.release().then(() => { released = true })
      await expect(Promise.race([release.then(() => 'released'), Promise.resolve('pending')])).resolves.toBe('pending')
      await expect(request(transport, bound.descriptor, 'rejected-after-release', 'rejected')).rejects.toThrow(/not attached/u)
      expect(released).toBe(false)

      tool.resolve('settled')
      await expect(accepted).resolves.toMatchObject({ isError: false, value: 'settled' })
      await release
      expect(released).toBe(true)
    } finally {
      await close(socket, transport)
      await bridge.dispose()
    }
  })

  it('revokes bindings and waits for accepted tool work before disposing the endpoint', async () => {
    const tool = Promise.withResolvers<string>()
    const started = Promise.withResolvers<true>()
    const { agent, bridge } = await setup(async () => {
      started.resolve(true)
      return tool.promise
    })
    const bound = await bridge.bind('dispose-command', agent, [schema], new AbortController().signal)
    if (bound.descriptor === undefined) throw new Error('expected a bridge descriptor')
    const { socket, transport } = await connect(bound.descriptor)
    try {
      const accepted = request(transport, bound.descriptor, 'accepted-call', 'deferred')
      const acceptedError = accepted.catch((error: unknown) => (
        error instanceof Error ? error : new Error(String(error))
      ))
      await started.promise

      let disposed = false
      const dispose = bridge.dispose().then(() => { disposed = true })
      await expect(Promise.race([dispose.then(() => 'disposed'), Promise.resolve('pending')])).resolves.toBe('pending')
      await expect(request(transport, bound.descriptor, 'rejected-after-dispose', 'rejected')).rejects.toThrow(/not attached/u)
      expect(disposed).toBe(false)

      await close(socket, transport)
      await expect(acceptedError).resolves.toMatchObject({ message: 'JSON-RPC transport closed' })
      tool.resolve('settled')
      await dispose
      expect(disposed).toBe(true)
    } finally {
      await close(socket, transport)
      await bridge.dispose()
    }
  })

  it('waits for rejected tool execution and completes cleanup without an unhandled rejection', async () => {
    const { agent, bridge } = await setup(async () => { throw new Error('tool rejected') })
    const bound = await bridge.bind('rejected-command', agent, [schema], new AbortController().signal)
    if (bound.descriptor === undefined) throw new Error('expected a bridge descriptor')
    const { socket, transport } = await connect(bound.descriptor)
    try {
      await expect(request(transport, bound.descriptor, 'rejected-call', 'boom')).resolves.toMatchObject({
        isError: true,
        error: { message: 'tool rejected' },
      })
      await expect(bound.release()).resolves.toBeUndefined()
      await close(socket, transport)
      await expect(bridge.dispose()).resolves.toBeUndefined()
    } finally {
      await close(socket, transport)
      await bridge.dispose()
    }
  })

  it('does not start an IPC endpoint for an empty tool schema set', async () => {
    const { agent, bridge } = await setup(async value => value)
    const bound = await bridge.bind('empty-command', agent, [], new AbortController().signal)
    expect(bound.descriptor).toBeUndefined()
    await expect(bound.release()).resolves.toBeUndefined()
    await expect(bridge.dispose()).resolves.toBeUndefined()
  })
})

/** Leave a socket file behind the way a crashed process does, and return the dead owner's pid. */
async function crashedOwnerSocket(directory: string): Promise<number> {
  const child = spawn(process.execPath, ['-e', `
    const { createServer } = require('node:net')
    const path = require('node:path').join(${JSON.stringify(directory)}, 'model-tools-' + process.pid + '-0.sock')
    createServer().listen(path, () => { process.kill(process.pid, 'SIGKILL') })
  `], { stdio: 'ignore' })
  await once(child, 'exit')
  if (child.pid === undefined) throw new Error('expected a child pid')
  return child.pid
}

describe.skipIf(process.platform === 'win32')('PhysicalOperatorModelToolBridge socket files', () => {
  it('unlinks the socket when the last binding is released and listens again for the next binding', async () => {
    const { agent, bridge } = await setup(async value => value)
    const first = await bridge.bind('first-command', agent, [schema], new AbortController().signal)
    if (first.descriptor === undefined) throw new Error('expected a bridge descriptor')
    const { socketPath } = first.descriptor
    expect(dirname(socketPath)).toBe(join(dshHome, 'physical-operator'))
    expect(basename(socketPath)).toMatch(new RegExp(`^model-tools-${String(process.pid)}-\\d+\\.sock$`, 'u'))
    expect(existsSync(socketPath)).toBe(true)
    const { socket, transport } = await connect(first.descriptor)
    try {
      await expect(request(transport, first.descriptor, 'first-call', 'one')).resolves.toMatchObject({ value: 'one' })
      await first.release()
      expect(existsSync(socketPath)).toBe(false)

      const second = await bridge.bind('second-command', agent, [schema], new AbortController().signal)
      if (second.descriptor === undefined) throw new Error('expected a bridge descriptor')
      expect(second.descriptor.socketPath).toBe(socketPath)
      const next = await connect(second.descriptor)
      await expect(request(next.transport, second.descriptor, 'second-call', 'two')).resolves.toMatchObject({ value: 'two' })
      await close(next.socket, next.transport)
      await second.release()
      expect(existsSync(socketPath)).toBe(false)
    } finally {
      await close(socket, transport)
      await bridge.dispose()
    }
  })

  it('keeps the socket while another binding remains attached', async () => {
    const { agent, bridge } = await setup(async value => value)
    const first = await bridge.bind('kept-first', agent, [schema], new AbortController().signal)
    const second = await bridge.bind('kept-second', agent, [schema], new AbortController().signal)
    if (second.descriptor === undefined) throw new Error('expected a bridge descriptor')
    try {
      await first.release()
      expect(existsSync(second.descriptor.socketPath)).toBe(true)
      const { socket, transport } = await connect(second.descriptor)
      await expect(request(transport, second.descriptor, 'kept-call', 'kept')).resolves.toMatchObject({ value: 'kept' })
      await close(socket, transport)
    } finally {
      await bridge.dispose()
    }
    expect(existsSync(second.descriptor.socketPath)).toBe(false)
  })

  it('unlinks the socket on dispose while a binding and an idle connection remain open', async () => {
    const { agent, bridge } = await setup(async value => value)
    const bound = await bridge.bind('disposed-command', agent, [schema], new AbortController().signal)
    if (bound.descriptor === undefined) throw new Error('expected a bridge descriptor')
    const { socket, transport } = await connect(bound.descriptor)
    try {
      await bridge.dispose()
      expect(existsSync(bound.descriptor.socketPath)).toBe(false)
    } finally {
      await close(socket, transport)
    }
  })

  it('removes only sockets whose owning process no longer exists when it first starts listening', async () => {
    const directory = join(dshHome, 'physical-operator')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const deadPid = await crashedOwnerSocket(directory)
    const deadSocket = `model-tools-${String(deadPid)}-0.sock`
    expect(readdirSync(directory)).toContain(deadSocket)
    const liveSocket = `model-tools-${String(process.pid)}-999999.sock`
    const live = createServer()
    await new Promise<void>((resolve) => { live.listen(join(directory, liveSocket), resolve) })
    writeFileSync(join(directory, 'native-catalogs.json'), '{}')
    writeFileSync(join(directory, `model-tools-${String(deadPid)}-1.sock`), 'not a socket')

    const { agent, bridge } = await setup(async value => value)
    const bound = await bridge.bind('sweep-command', agent, [schema], new AbortController().signal)
    try {
      expect(readdirSync(directory).sort()).toEqual([
        `model-tools-${String(deadPid)}-1.sock`,
        liveSocket,
        basename(bound.descriptor?.socketPath ?? ''),
        'native-catalogs.json',
      ].sort())
    } finally {
      await bound.release()
      await bridge.dispose()
      await new Promise<void>((resolve) => { live.close(() => { resolve() }) })
    }
  })
})
