import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PhysicalOperatorModelToolBridgeV1 } from '@deepseek-ai/dsh-physical-operator'
import { LocalJsonRpcRequestServer } from '@deepseek-ai/dsh-sdk-protocol'
import { WebToolOwners } from '../src/tool-owner.ts'
import type { WebMcpCallId } from '../src/types.ts'

interface ServerResource {
  readonly root: string
  readonly socketPath: string
  readonly server: LocalJsonRpcRequestServer
}

const servers = new Set<ServerResource>()

afterEach(async () => {
  const resources = [...servers]
  servers.clear()
  await Promise.all(resources.map(async ({ root, server }) => {
    await server.dispose()
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    await rm(root, { recursive: true, force: true })
  }))
})

async function createServer(
  handler: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<ServerResource> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-web-owner-'))
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-chatgpt-web-owner-${process.pid}-${randomUUID()}`
    : join(root, 'bridge.sock')
  const server = new LocalJsonRpcRequestServer(
    process.platform === 'win32' ? { path: socketPath } : { path: socketPath, directory: root },
    handler,
  )
  try {
    await server.start()
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const resource = { root, socketPath, server }
  servers.add(resource)
  return resource
}

function bridge(
  socketPath: string,
  sessionId: string,
  toolNames: readonly string[],
): PhysicalOperatorModelToolBridgeV1 {
  return {
    version: 1,
    socketPath,
    sessionId,
    tools: toolNames.map(name => ({
      name,
      description: `${name} owner tool`,
      inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    })),
  }
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function tick(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve) })
}

function callId(value: string): WebMcpCallId {
  return value as WebMcpCallId
}

describe('WebToolOwners', () => {
  it('rejects invalid owner setup and validates native page evidence', async () => {
    expect(() => new WebToolOwners(0)).toThrow('Web tool identity timeout must be a positive integer')

    const abortedController = new AbortController()
    abortedController.abort()
    expect(() => new WebToolOwners(200).bind(
      'command-aborted-bind',
      bridge('/tmp/unreachable-aborted-bind.sock', 'parent-aborted-bind-session', ['aborted_tool']),
      abortedController.signal,
    )).toThrow('Web tool owner was cancelled')

    const owners = new WebToolOwners(200)
    const controller = new AbortController()
    const binding = owners.bind(
      'command-validation',
      bridge('/tmp/unreachable-validation.sock', 'parent-validation-session', ['validation_tool']),
      controller.signal,
    )
    expect(() => owners.bind(
      'command-validation',
      bridge('/tmp/unreachable-duplicate.sock', 'parent-duplicate-session', ['duplicate_tool']),
      new AbortController().signal,
    )).toThrow('Web tool owner is already attached')
    expect(() => { binding.observe('', []) }).toThrow('Web tool conversation identity changed during an execution')
    binding.observe('conversation-validation', ['native-request-validation'])
    binding.observe('conversation-validation', ['native-request-validation'])
    expect(() => { binding.observe('conversation-other', []) }).toThrow('Web tool conversation identity changed during an execution')
    expect(() => { binding.observe('conversation-validation', [' ']) }).toThrow('Web tool request evidence contains an invalid identity')

    binding.release()
    binding.observe('ignored-after-release', ['ignored-after-release'])

    const cancelledController = new AbortController()
    const cancelledBinding = owners.bind(
      'command-observe-cancelled',
      bridge('/tmp/unreachable-observe-cancelled.sock', 'parent-observe-cancelled-session', ['cancelled_tool']),
      cancelledController.signal,
    )
    cancelledController.abort()
    cancelledBinding.observe('ignored-after-cancel', ['ignored-after-cancel'])
    cancelledBinding.release()
  })

  it('rejects proof after the owner is cancelled before resolution', async () => {
    const owners = new WebToolOwners(200)
    const ownerController = new AbortController()
    const binding = owners.bind(
      'command-inactive-proof',
      bridge('/tmp/unreachable-inactive-proof.sock', 'parent-inactive-proof-session', ['inactive_tool']),
      ownerController.signal,
    )
    binding.observe('conversation-inactive-proof', ['native-request-inactive-proof'])
    ownerController.abort()

    await expect(owners.resolve('native-request-inactive-proof', new AbortController().signal))
      .rejects.toThrow('Web tool owner is no longer active')
    binding.release()
  })

  it('rejects resolution immediately when its inbound signal is already cancelled', async () => {
    const owners = new WebToolOwners(200)
    const controller = new AbortController()
    controller.abort()

    await expect(owners.resolve('native-request-pre-cancelled', controller.signal))
      .rejects.toThrow('Web tool identity request was cancelled')
  })

  it('waits for exact native request evidence before sealing the owner tools', async () => {
    const owners = new WebToolOwners(200)
    const controller = new AbortController()
    const binding = owners.bind(
      'command-proof',
      bridge('/tmp/unreachable-proof.sock', 'parent-proof-session', ['owner_tool']),
      controller.signal,
    )
    let settled = false
    const resolving = owners.resolve('native-request-1', controller.signal)
    void resolving.then(
      () => { settled = true },
      () => { settled = true },
    )

    await tick()
    expect(settled).toBe(false)
    expect(binding.hasPendingTools()).toBe(true)

    binding.observe('conversation-proof', ['native-request-1'])
    const owner = await resolving
    expect(owner).toMatchObject({
      tools: bridge('/tmp/unreachable-proof.sock', 'parent-proof-session', ['owner_tool']).tools,
    })
    expect(binding.hasPendingTools()).toBe(true)
    owner.release()
    expect(binding.hasPendingTools()).toBe(false)
    binding.release()
  })

  it('rejects an unproven request without attempting execution', async () => {
    const calls: Record<string, unknown>[] = []
    const resource = await createServer(async (_method, params) => {
      calls.push(params)
      return { ok: true }
    })
    const owners = new WebToolOwners(100)
    const controller = new AbortController()
    const binding = owners.bind(
      'command-unproven',
      bridge(resource.socketPath, 'parent-unproven-session', ['owner_tool']),
      controller.signal,
    )

    await expect(owners.resolve('native-request-unproven', controller.signal))
      .rejects.toThrow('Web tool caller identity was not observed in its ChatGPT conversation')
    expect(binding.hasPendingTools()).toBe(false)
    expect(calls).toHaveLength(0)
    binding.release()
  })

  it('revokes a proof when a second owner claims the same native request', async () => {
    const owners = new WebToolOwners(200)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstBinding = owners.bind(
      'command-first',
      bridge('/tmp/unreachable-first.sock', 'parent-first-session', ['first_tool']),
      firstController.signal,
    )
    const secondBinding = owners.bind(
      'command-second',
      bridge('/tmp/unreachable-second.sock', 'parent-second-session', ['second_tool']),
      secondController.signal,
    )

    firstBinding.observe('conversation-first', ['native-request-conflict'])
    const firstOwner = await owners.resolve('native-request-conflict', firstController.signal)
    secondBinding.observe('conversation-second', ['native-request-conflict'])

    await expect(firstOwner.execute(
      'native-request-conflict',
      'first_tool',
      {},
      new AbortController().signal,
      callId('conflicted-wire-call'),
    )).rejects.toThrow('Web tool request no longer has a proven owner')
    await expect(owners.resolve('native-request-conflict', secondController.signal))
      .rejects.toThrow('Web tool request identity is revoked or ambiguous')

    firstOwner.release()
    firstBinding.release()
    secondBinding.release()
  })

  it('rejects calls after release and after the owning signal is cancelled', async () => {
    const owners = new WebToolOwners(200)
    const releasedController = new AbortController()
    const releasedBinding = owners.bind(
      'command-released',
      bridge('/tmp/unreachable-released.sock', 'parent-released-session', ['released_tool']),
      releasedController.signal,
    )
    releasedBinding.observe('conversation-released', ['native-request-released'])
    const releasedOwner = await owners.resolve('native-request-released', releasedController.signal)
    releasedBinding.release()
    await expect(releasedOwner.execute(
      'native-request-released',
      'released_tool',
      {},
      new AbortController().signal,
      callId('released-wire-call'),
    )).rejects.toThrow('Web tool request no longer has a proven owner')
    releasedOwner.release()

    const cancelledController = new AbortController()
    const cancelledBinding = owners.bind(
      'command-cancelled',
      bridge('/tmp/unreachable-cancelled.sock', 'parent-cancelled-session', ['cancelled_tool']),
      cancelledController.signal,
    )
    cancelledBinding.observe('conversation-cancelled', ['native-request-cancelled'])
    const cancelledOwner = await owners.resolve('native-request-cancelled', cancelledController.signal)
    cancelledController.abort()
    await expect(cancelledOwner.execute(
      'native-request-cancelled',
      'cancelled_tool',
      {},
      new AbortController().signal,
      callId('cancelled-wire-call'),
    )).rejects.toThrow('Web tool request no longer has a proven owner')

    cancelledOwner.release()
    cancelledBinding.release()
  })

  it('keeps each request bound to its owner schemas without cross-owner leakage', async () => {
    const owners = new WebToolOwners(200)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstBinding = owners.bind(
      'command-schema-first',
      bridge('/tmp/unreachable-schema-first.sock', 'parent-schema-first-session', ['first_only']),
      firstController.signal,
    )
    const secondBinding = owners.bind(
      'command-schema-second',
      bridge('/tmp/unreachable-schema-second.sock', 'parent-schema-second-session', ['second_only']),
      secondController.signal,
    )
    firstBinding.observe('conversation-schema-first', ['native-request-first'])
    secondBinding.observe('conversation-schema-second', ['native-request-second'])

    const firstOwner = await owners.resolve('native-request-first', firstController.signal)
    const secondOwner = await owners.resolve('native-request-second', secondController.signal)
    expect(firstOwner.tools.map(tool => tool.name)).toEqual(['first_only'])
    expect(secondOwner.tools.map(tool => tool.name)).toEqual(['second_only'])
    await expect(firstOwner.execute(
      'native-request-first',
      'second_only',
      {},
      new AbortController().signal,
      callId('cross-owner-wire-call'),
    )).rejects.toThrow('Web tool is not advertised for this owner')

    firstOwner.release()
    secondOwner.release()
    firstBinding.release()
    secondBinding.release()
  })

  it('relays one call through the real local RPC bridge and tracks pending state', async () => {
    const seen = deferred<{ readonly method: string; readonly params: Record<string, unknown> }>()
    const response = deferred<unknown>()
    const resource = await createServer(async (method, params) => {
      seen.resolve({ method, params })
      return await response.promise
    })
    const owners = new WebToolOwners(200)
    const controller = new AbortController()
    const binding = owners.bind(
      'command-relay',
      bridge(resource.socketPath, 'parent-bridge-session', ['echo_tool']),
      controller.signal,
    )
    binding.observe('conversation-relay', ['native-request-relay'])
    const owner = await owners.resolve('native-request-relay', controller.signal)
    expect(binding.hasPendingTools()).toBe(true)

    const call = owner.execute(
      'native-request-relay',
      'echo_tool',
      { value: 'hello' },
      new AbortController().signal,
      callId('relay-wire-call'),
    )
    try {
      const observed = await Promise.race([
        seen.promise,
        call.then(
          () => { throw new Error('tool call settled before the local RPC request was observed') },
          (error: unknown) => { throw error },
        ),
      ])
      expect(observed).toEqual({
        method: 'tool.call',
        params: {
          session_id: 'parent-bridge-session',
          command_id: 'command-relay:chatgpt-web:relay-wire-call',
          tool: 'echo_tool',
          arguments: { value: 'hello' },
        },
      })
      expect(binding.hasPendingTools()).toBe(true)
      response.resolve({ ok: true, value: 'hello' })
      await expect(call).resolves.toEqual({ ok: true, value: 'hello' })
      expect(binding.hasPendingTools()).toBe(true)
      owner.release()
      expect(binding.hasPendingTools()).toBe(false)
    } finally {
      response.resolve({ ok: true, value: 'hello' })
      await call.catch(() => undefined)
      owner.release()
      binding.release()
    }
  })

  it('aborts an in-flight local RPC request and tears down the socket', async () => {
    const seen = deferred<{ readonly method: string; readonly params: Record<string, unknown> }>()
    const response = deferred<unknown>()
    const resource = await createServer(async (method, params) => {
      seen.resolve({ method, params })
      return await response.promise
    })
    const owners = new WebToolOwners(200)
    const ownerController = new AbortController()
    const binding = owners.bind(
      'command-rpc-abort',
      bridge(resource.socketPath, 'parent-rpc-abort-session', ['abort_tool']),
      ownerController.signal,
    )
    binding.observe('conversation-rpc-abort', ['native-request-rpc-abort'])
    const owner = await owners.resolve('native-request-rpc-abort', ownerController.signal)
    const callController = new AbortController()
    const call = owner.execute(
      'native-request-rpc-abort',
      'abort_tool',
      { value: 'abort-me' },
      callController.signal,
      callId('aborted-wire-call'),
    )
    const rejected = expect(call).rejects.toThrow()
    try {
      await seen.promise
      callController.abort()
      await rejected
    } finally {
      response.resolve({ ok: true })
      await call.catch(() => undefined)
      owner.release()
      binding.release()
    }
  })

  it('surfaces a local RPC connection failure without leaking the owner lease', async () => {
    const owners = new WebToolOwners(200)
    const ownerController = new AbortController()
    const binding = owners.bind(
      'command-rpc-failure',
      bridge('/tmp/dsh-chatgpt-web-owner-missing.sock', 'parent-rpc-failure-session', ['failure_tool']),
      ownerController.signal,
    )
    binding.observe('conversation-rpc-failure', ['native-request-rpc-failure'])
    const owner = await owners.resolve('native-request-rpc-failure', ownerController.signal)
    await expect(owner.execute(
      'native-request-rpc-failure',
      'failure_tool',
      {},
      new AbortController().signal,
      callId('failed-wire-call'),
    )).rejects.toBeDefined()
    owner.release()
    expect(binding.hasPendingTools()).toBe(false)
    binding.release()
  })

  it('clears a pending request lease when proof is cancelled or times out', async () => {
    const cancelledOwners = new WebToolOwners(200)
    const cancelledController = new AbortController()
    const cancelledBinding = cancelledOwners.bind(
      'command-proof-cancelled',
      bridge('/tmp/unreachable-proof-cancelled.sock', 'parent-proof-cancelled-session', ['cancelled_tool']),
      cancelledController.signal,
    )
    const cancelled = cancelledOwners.resolve('native-request-proof-cancelled', cancelledController.signal)
    await tick()
    expect(cancelledBinding.hasPendingTools()).toBe(true)
    cancelledController.abort()
    await expect(cancelled).rejects.toThrow('Web tool identity request was cancelled')
    expect(cancelledBinding.hasPendingTools()).toBe(false)
    cancelledBinding.release()

    const timedOutOwners = new WebToolOwners(10)
    const timedOutController = new AbortController()
    const timedOutBinding = timedOutOwners.bind(
      'command-proof-timed-out',
      bridge('/tmp/unreachable-proof-timed-out.sock', 'parent-proof-timed-out-session', ['timed_out_tool']),
      timedOutController.signal,
    )
    const timedOut = timedOutOwners.resolve('native-request-proof-timed-out', timedOutController.signal)
    await expect(timedOut).rejects.toThrow('Web tool caller identity was not observed in its ChatGPT conversation')
    expect(timedOutBinding.hasPendingTools()).toBe(false)
    timedOutBinding.release()
  })

  it('releases a proven response lease idempotently and rejects execution afterwards', async () => {
    const owners = new WebToolOwners(200)
    const controller = new AbortController()
    const binding = owners.bind(
      'command-release',
      bridge('/tmp/unreachable-release.sock', 'parent-release-session', ['release_tool']),
      controller.signal,
    )
    binding.observe('conversation-release', ['native-request-release'])
    const owner = await owners.resolve('native-request-release', controller.signal)
    expect(binding.hasPendingTools()).toBe(true)

    owner.release()
    owner.release()
    expect(binding.hasPendingTools()).toBe(false)
    await expect(owner.execute(
      'native-request-release',
      'release_tool',
      {},
      new AbortController().signal,
      callId('released-after-lease-wire-call'),
    )).rejects.toThrow('Web tool request no longer has a proven owner')

    binding.release()
    binding.release()
  })
})
