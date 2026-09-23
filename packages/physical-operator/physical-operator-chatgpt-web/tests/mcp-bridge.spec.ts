import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import type { PhysicalOperatorModelToolV1 } from '@deepseek-ai/dsh-physical-operator'
import {
  ChatGptWebMcpBridge,
  type ChatGptWebMcpBridgeOwner,
} from '../src/mcp-bridge.ts'

const SECRET_PATH = '/mcp/bridge-token-which-must-not-appear-in-errors'
const OWNER_TOOLS: readonly PhysicalOperatorModelToolV1[] = [{
  name: 'read_note',
  description: 'Read one note.',
  inputSchema: {
    type: 'object',
    properties: { note: { type: 'string' } },
    required: ['note'],
    additionalProperties: false,
  },
}]

const bridges = new Set<ChatGptWebMcpBridge>()

afterEach(async () => {
  await Promise.all([...bridges].map(bridge => bridge.dispose()))
  bridges.clear()
})

function owner(
  execute: ChatGptWebMcpBridgeOwner['execute'] = async (_requestId, _name, _argumentsValue, _signal, _callId) => ({ ok: true }),
  release: ChatGptWebMcpBridgeOwner['release'] = () => {},
): ChatGptWebMcpBridgeOwner {
  return { tools: OWNER_TOOLS, release, execute }
}

function bridgeFor(
  resolveOwner: (requestId: string, signal: AbortSignal) => Promise<ChatGptWebMcpBridgeOwner>,
  bounds: { readonly maxRequestBytes?: number; readonly requestTimeoutMs?: number } = {},
): ChatGptWebMcpBridge {
  const bridge = new ChatGptWebMcpBridge({
    port: 0,
    path: SECRET_PATH,
    maxRequestBytes: bounds.maxRequestBytes ?? 8 * 1024,
    requestTimeoutMs: bounds.requestTimeoutMs ?? 5_000,
    resolveOwner,
  })
  bridges.add(bridge)
  return bridge
}

function clientTransport(transport: StreamableHTTPClientTransport): Transport {
  // The SDK client transport models a missing session id as `undefined`; its generic Transport type requires omission.
  return transport as Transport
}

async function connected(bridge: ChatGptWebMcpBridge, requestId = 'chatgpt-request-1'): Promise<Client> {
  const client = new Client({ name: 'chatgpt-web-bridge-test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(await bridge.start()), {
    requestInit: { headers: { 'x-request-id': requestId } },
  })
  await client.connect(clientTransport(transport))
  return client
}

function textOf(result: unknown): string {
  if (!isRecord(result) || !isUnknownArray(result.content)) {
    throw new Error('expected a non-task tool result')
  }
  const block = result.content[0]
  if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('expected a text result')
  }
  return block.text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function mcpCall(name: string, argumentsValue: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 'raw-call',
    method: 'tools/call',
    params: { name, arguments: argumentsValue },
  })
}

function rawPost(url: string, headers: OutgoingHttpHeaders, body: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.once('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.once('error', reject)
    request.end(body)
  })
}

function rawChunkedPost(
  url: string,
  headers: OutgoingHttpHeaders,
  chunks: readonly string[],
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      const responseChunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { responseChunks.push(chunk) })
      response.once('end', () => {
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(responseChunks).toString('utf8') })
      })
    })
    request.once('error', reject)
    for (const chunk of chunks) request.write(chunk)
    request.end()
  })
}

function abandonedPost(url: string, headers: OutgoingHttpHeaders, body: string) {
  const request = httpRequest(url, { method: 'POST', headers }, (response) => { response.resume() })
  request.once('error', () => {})
  request.end(body)
  return request
}

describe('ChatGptWebMcpBridge', () => {
  it('serves the static MCP API and executes an owner-approved tool through a real HTTP SDK client', async () => {
    const execute = vi.fn<ChatGptWebMcpBridgeOwner['execute']>(async (requestId, name, argumentsValue, _signal, _callId) => ({
      requestId,
      name,
      arguments: argumentsValue,
      content: [{ type: 'text', text: 'owner result' }],
    }))
    const resolveOwner = vi.fn(async () => owner(execute))
    const client = await connected(bridgeFor(resolveOwner))
    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          { name: 'dsh_tools' },
          { name: 'dsh_execute' },
        ],
      })
      expect(resolveOwner).not.toHaveBeenCalled()

      const listed = await client.callTool({ name: 'dsh_tools', arguments: {} })
      expect(JSON.parse(textOf(listed))).toEqual(OWNER_TOOLS)

      const executed = await client.callTool({
        name: 'dsh_execute',
        arguments: { name: 'read_note', arguments: { note: 'fixture' } },
      })
      expect(JSON.parse(textOf(executed))).toEqual({
        requestId: 'chatgpt-request-1',
        name: 'read_note',
        arguments: { note: 'fixture' },
        content: [{ type: 'text', text: 'owner result' }],
      })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0]?.slice(0, 3)).toEqual([
        'chatgpt-request-1',
        'read_note',
        { note: 'fixture' },
      ])
      expect(execute.mock.calls[0]?.[4]).toMatch(/^[a-f0-9]{64}$/u)
    } finally {
      await client.close()
    }
  })

  it('normalizes a suffixed request identity before owner lookup and execution', async () => {
    const execute = vi.fn<ChatGptWebMcpBridgeOwner['execute']>(
      async (requestId, _name, _argumentsValue, _signal, callId) => ({ requestId, callId }),
    )
    const resolveOwner = vi.fn(async () => owner(execute))
    const client = await connected(bridgeFor(resolveOwner), 'wfr_fixture/hop-2')
    try {
      const result = await client.callTool({
        name: 'dsh_execute',
        arguments: { name: 'read_note', arguments: { note: 'fixture' } },
      })
      const value: unknown = JSON.parse(textOf(result))
      if (!isRecord(value) || typeof value.requestId !== 'string' || typeof value.callId !== 'string') {
        throw new Error('expected the normalized owner proof and opaque call identity')
      }
      expect(value.requestId).toBe('wfr_fixture')
      expect(value.callId).toMatch(/^[a-f0-9]{64}$/u)
      expect(resolveOwner).toHaveBeenCalledWith('wfr_fixture', expect.any(AbortSignal))
      expect(execute.mock.calls[0]?.[0]).toBe('wfr_fixture')
    } finally {
      await client.close()
    }
  })

  it('rejects an unknown path without revealing the secret endpoint', async () => {
    const bridge = bridgeFor(async () => owner())
    const url = new URL(await bridge.start())
    url.pathname = '/mcp/not-the-secret-path'
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: mcpCall('dsh_tools', {}),
    })
    const body = await response.text()

    expect(response.status).toBe(404)
    expect(body).not.toContain(SECRET_PATH)
  })

  it('requires exactly one request identity and fails closed when owner proof is absent', async () => {
    const resolveOwner = vi.fn(async () => owner())
    const bridge = bridgeFor(resolveOwner)
    const client = new Client({ name: 'chatgpt-web-bridge-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(await bridge.start()))
    await client.connect(clientTransport(transport))
    try {
      await expect(client.callTool({ name: 'dsh_tools', arguments: {} }))
        .rejects.toMatchObject({ code: ErrorCode.InvalidParams })
      expect(resolveOwner).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('does not collapse duplicate request identity headers into an owner proof', async () => {
    const resolveOwner = vi.fn(async () => owner())
    const bridge = bridgeFor(resolveOwner)
    const response = await rawPost(
      await bridge.start(),
      {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'x-request-id': ['wfr_fixture', 'wfr_fixture/hop-2'],
      },
      mcpCall('dsh_tools', {}),
    )
    const payload = JSON.parse(response.body) as { readonly error?: { readonly code?: number } }

    expect(response.status).toBe(200)
    expect(payload.error?.code).toBe(ErrorCode.InvalidParams)
    expect(resolveOwner).not.toHaveBeenCalled()
  })

  it('does not expose owner details when request proof resolves no owner', async () => {
    const resolveOwner = vi.fn(async () => {
      throw new Error(`owner proof for ${SECRET_PATH} is absent`)
    })
    const client = await connected(bridgeFor(resolveOwner))
    try {
      const failure = await client.callTool({ name: 'dsh_tools', arguments: {} }).then(
        () => { throw new Error('expected owner-proof rejection') },
        (error: unknown) => error,
      )
      expect(failure).toMatchObject({ code: ErrorCode.InvalidParams })
      expect(String(failure)).not.toContain(SECRET_PATH)
    } finally {
      await client.close()
    }
  })

  it('does not expose owner execution errors', async () => {
    const release = vi.fn<ChatGptWebMcpBridgeOwner['release']>()
    const client = await connected(bridgeFor(async () => owner(async () => {
      throw new Error(`owner execution exposed ${SECRET_PATH}`)
    }, release)))
    try {
      const failure = await client.callTool({
        name: 'dsh_execute',
        arguments: { name: 'read_note', arguments: { note: 'fixture' } },
      }).then(
        () => { throw new Error('expected owner-execution rejection') },
        (error: unknown) => error,
      )
      expect(failure).toMatchObject({ code: ErrorCode.InternalError })
      expect(String(failure)).not.toContain(SECRET_PATH)
      await vi.waitFor(() => { expect(release).toHaveBeenCalledTimes(1) })
    } finally {
      await client.close()
    }
  })

  it('denies unadvertised or schema-invalid owner tools before execution', async () => {
    const execute = vi.fn<ChatGptWebMcpBridgeOwner['execute']>(async (_requestId, _name, _argumentsValue, _signal, _callId) => ({ unexpected: true }))
    const client = await connected(bridgeFor(async () => owner(execute)))
    try {
      await expect(client.callTool({
        name: 'dsh_execute',
        arguments: { name: 'not_advertised', arguments: {} },
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
      await expect(client.callTool({
        name: 'dsh_execute',
        arguments: { name: 'read_note', arguments: {} },
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it('rejects non-loopback host or origin headers and oversized actual HTTP bodies', async () => {
    const bridge = bridgeFor(async () => owner(), { maxRequestBytes: 32 })
    const url = await bridge.start()
    const hostResponse = await rawPost(
      url,
      {
        'content-type': 'application/json',
        host: 'chatgpt.com',
      },
      '{}',
    )
    const originResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://chatgpt.com',
      },
      body: mcpCall('dsh_tools', {}),
    })
    const oversizedResponse = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(33),
    })

    expect(hostResponse.status).toBe(403)
    expect(originResponse.status).toBe(403)
    expect(oversizedResponse.status).toBe(413)
  })

  it('rejects malformed HTTP method, headers, body, and origin before resolving authority', async () => {
    const resolveOwner = vi.fn(async () => owner())
    const bridge = bridgeFor(resolveOwner, { maxRequestBytes: 16 })
    const url = await bridge.start()
    const methodResponse = await fetch(url, { method: 'GET' })
    const contentTypeResponse = await rawPost(url, { 'content-type': 'text/plain' }, '{}')
    const emptyBodyResponse = await rawPost(url, { 'content-type': 'application/json' }, '')
    const malformedBodyResponse = await rawPost(url, { 'content-type': 'application/json' }, '{')
    const malformedOriginResponse = await rawPost(
      url,
      { 'content-type': 'application/json', origin: 'not a URL' },
      '{}',
    )
    const chunkedOverflowResponse = await rawChunkedPost(
      url,
      { 'content-type': 'application/json' },
      ['0123456789', 'abcdefg'],
    )

    expect(methodResponse.status).toBe(405)
    expect(contentTypeResponse.status).toBe(415)
    expect(emptyBodyResponse.status).toBe(400)
    expect(malformedBodyResponse.status).toBe(400)
    expect(malformedOriginResponse.status).toBe(403)
    expect(chunkedOverflowResponse.status).toBe(413)
    expect(resolveOwner).not.toHaveBeenCalled()
  })

  it('does not reuse a previous owner when the same request identity loses proof', async () => {
    const release = vi.fn<ChatGptWebMcpBridgeOwner['release']>()
    const execute = vi.fn<ChatGptWebMcpBridgeOwner['execute']>(async (_requestId, _name, _argumentsValue, _signal, _callId) => ({ unexpected: true }))
    let resolutions = 0
    const resolveOwner = vi.fn(async () => {
      resolutions += 1
      if (resolutions === 1) return owner(execute, release)
      throw new Error('request proof expired')
    })
    const client = await connected(bridgeFor(resolveOwner), 'request-with-expiring-proof')
    try {
      await client.callTool({ name: 'dsh_tools', arguments: {} })
      await vi.waitFor(() => { expect(release).toHaveBeenCalledTimes(1) })

      await expect(client.callTool({
        name: 'dsh_execute',
        arguments: { name: 'read_note', arguments: { note: 'must-not-reuse' } },
      })).rejects.toMatchObject({ code: ErrorCode.InvalidParams })
      expect(resolveOwner).toHaveBeenCalledTimes(2)
      expect(execute).not.toHaveBeenCalled()
      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      await client.close()
    }
  })

  it('cancels timed-out work but releases its owner only after the actual operation settles', async () => {
    const completion = Promise.withResolvers<unknown>()
    const release = vi.fn<ChatGptWebMcpBridgeOwner['release']>()
    let executeSignal: AbortSignal | undefined
    const execute = vi.fn<ChatGptWebMcpBridgeOwner['execute']>(
      async (_requestId, _name, _argumentsValue, signal, _callId) => {
        executeSignal = signal
        return await completion.promise
      },
    )
    const client = await connected(bridgeFor(async () => owner(execute, release), { requestTimeoutMs: 100 }))
    try {
      const pending = client.callTool({
        name: 'dsh_execute',
        arguments: { name: 'read_note', arguments: { note: 'wait-for-timeout' } },
      }).then(
        () => { throw new Error('expected a timeout response') },
        (error: unknown) => error,
      )
      await vi.waitFor(() => { expect(execute).toHaveBeenCalledTimes(1) })
      await vi.waitFor(() => { expect(executeSignal?.aborted).toBe(true) })
      expect(release).not.toHaveBeenCalled()

      completion.resolve({ completedAfterTimeout: true })
      await expect(pending).resolves.toMatchObject({ code: ErrorCode.RequestTimeout })
      await vi.waitFor(() => { expect(release).toHaveBeenCalledTimes(1) })
    } finally {
      completion.resolve({ cleanup: true })
      await client.close()
    }
  })

  it('cancels abandoned HTTP callers while waiting for their noncooperative work before release', async () => {
    const completion = Promise.withResolvers<unknown>()
    const release = vi.fn<ChatGptWebMcpBridgeOwner['release']>()
    let executeSignal: AbortSignal | undefined
    const execute = vi.fn<ChatGptWebMcpBridgeOwner['execute']>(
      async (_requestId, _name, _argumentsValue, signal, _callId) => {
        executeSignal = signal
        return await completion.promise
      },
    )
    const bridge = bridgeFor(async () => owner(execute, release))
    const request = abandonedPost(
      await bridge.start(),
      {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'x-request-id': 'abandoned-http-request',
      },
      mcpCall('dsh_execute', { name: 'read_note', arguments: { note: 'wait-for-abort' } }),
    )
    try {
      await vi.waitFor(() => { expect(execute).toHaveBeenCalledTimes(1) })
      request.destroy()
      await vi.waitFor(() => { expect(executeSignal?.aborted).toBe(true) })
      expect(release).not.toHaveBeenCalled()

      completion.resolve({ completedAfterAbort: true })
      await vi.waitFor(() => { expect(release).toHaveBeenCalledTimes(1) })
    } finally {
      completion.resolve({ cleanup: true })
      request.destroy()
    }
  })

  it('holds the owner lease through execution and response publication', async () => {
    const completion = Promise.withResolvers<unknown>()
    const release = vi.fn<ChatGptWebMcpBridgeOwner['release']>()
    const execute = vi.fn<ChatGptWebMcpBridgeOwner['execute']>(async (_requestId, _name, _argumentsValue, _signal, _callId) => await completion.promise)
    const bridge = bridgeFor(async () => owner(execute, release))
    const client = await connected(bridge)
    try {
      const pending = client.callTool({
        name: 'dsh_execute',
        arguments: { name: 'read_note', arguments: { note: 'wait' } },
      })
      await vi.waitFor(() => { expect(execute).toHaveBeenCalledTimes(1) })
      expect(release).not.toHaveBeenCalled()

      completion.resolve({ completed: true })
      expect(JSON.parse(textOf(await pending))).toEqual({ completed: true })
      await vi.waitFor(() => { expect(release).toHaveBeenCalledTimes(1) })
    } finally {
      await client.close()
    }
  })

  it('waits for noncooperative owner work before releasing the lease during disposal', async () => {
    const completion = Promise.withResolvers<unknown>()
    const release = vi.fn<ChatGptWebMcpBridgeOwner['release']>()
    let executeSignal: AbortSignal | undefined
    const execute = vi.fn<ChatGptWebMcpBridgeOwner['execute']>(
      async (_requestId, _name, _argumentsValue, signal, _callId) => {
        executeSignal = signal
        return await completion.promise
      },
    )
    const bridge = bridgeFor(async () => owner(execute, release))
    const client = await connected(bridge)
    try {
      const pending = client.callTool({
        name: 'dsh_execute',
        arguments: { name: 'read_note', arguments: { note: 'wait' } },
      }).catch(() => undefined)
      await vi.waitFor(() => { expect(execute).toHaveBeenCalledTimes(1) })

      const disposal = bridge.dispose()
      let disposalFinished = false
      void disposal.then(() => { disposalFinished = true })
      await vi.waitFor(() => { expect(executeSignal?.aborted).toBe(true) })
      await Promise.resolve()
      expect(disposalFinished).toBe(false)
      expect(release).not.toHaveBeenCalled()

      completion.resolve({ aborted: true })
      await disposal
      await pending
      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      await client.close()
    }
  })

  it('releases a late owner resolution once after its request was aborted', async () => {
    const resolution = Promise.withResolvers<ChatGptWebMcpBridgeOwner>()
    const release = vi.fn<ChatGptWebMcpBridgeOwner['release']>()
    const resolveOwner = vi.fn(() => resolution.promise)
    const bridge = bridgeFor(resolveOwner)
    const client = await connected(bridge)
    try {
      const pending = client.callTool({ name: 'dsh_tools', arguments: {} }).catch(() => undefined)
      await vi.waitFor(() => { expect(resolveOwner).toHaveBeenCalledTimes(1) })

      const disposal = bridge.dispose()
      let disposalFinished = false
      void disposal.then(() => { disposalFinished = true })
      await Promise.resolve()
      expect(disposalFinished).toBe(false)

      resolution.resolve(owner(undefined, release))
      await disposal
      await pending
      expect(release).toHaveBeenCalledTimes(1)
    } finally {
      await client.close()
    }
  })
})
