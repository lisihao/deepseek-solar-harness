import { once } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
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

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
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
