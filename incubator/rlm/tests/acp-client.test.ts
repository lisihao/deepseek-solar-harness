import { EventEmitter } from 'node:events'
import { Writable, PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import {
  AcpClient,
  AcpProtocolError,
  AcpRpcError,
  AcpTransportError,
} from '../src/acp-client.js'

class FakeChild extends EventEmitter {
  readonly writes: string[] = []
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(Buffer.from(chunk).toString('utf8'))
      callback()
    },
  })
  killCalls = 0

  kill(): boolean {
    this.killCalls += 1
    return true
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams
  }

  send(value: unknown, splitAt?: number): void {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
    if (splitAt === undefined) {
      this.stdout.write(bytes)
      return
    }
    this.stdout.write(bytes.subarray(0, splitAt))
    this.stdout.write(bytes.subarray(splitAt))
  }

  frames(): Record<string, unknown>[] {
    return this.writes
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }
}

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('AcpClient', () => {
  it('writes JSON-RPC frames after durable send records and forces initialize protocolVersion 1', async () => {
    const child = new FakeChild()
    const events: string[] = []
    const client = new AcpClient(child.asChild(), {
      record: async (direction, value) => {
        events.push(`${direction}:${JSON.stringify(value)}`)
        await Promise.resolve()
      },
    })

    const resultPromise = client.request('initialize', { clientCapabilities: { image: true }, protocolVersion: 9 })
    await flush()
    expect(child.frames()).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientCapabilities: { image: true }, protocolVersion: 1 },
      },
    ])
    expect(events[0]?.startsWith('send:')).toBe(true)
    expect(events.some((event) => event.startsWith('receive:'))).toBe(false)

    child.send({ jsonrpc: '2.0', id: 1, result: { ready: '✓' } }, 7)
    await expect(resultPromise).resolves.toEqual({ ready: '✓' })
    expect(events.at(-1)).toContain('receive:')
    await client.dispose()
  })

  it('matches concurrent responses and serializes session/update callbacks', async () => {
    const child = new FakeChild()
    const updates: unknown[] = []
    const client = new AcpClient(child.asChild(), {
      record: async () => undefined,
      onUpdate: (params) => updates.push(params),
    })

    const first = client.request('first', { n: 1 })
    const second = client.request('second', { n: 2 })
    await flush()
    expect(child.frames().map((frame) => frame.method)).toEqual(['first', 'second'])
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sequence: 1 } })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { second: true } })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sequence: 2 } })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { first: true } })}\n`,
    )
    await expect(first).resolves.toEqual({ first: true })
    await expect(second).resolves.toEqual({ second: true })
    expect(updates).toEqual([{ sequence: 1 }, { sequence: 2 }])
    await client.dispose()
  })

  it('answers unknown server requests with method_not_found', async () => {
    const child = new FakeChild()
    const client = new AcpClient(child.asChild(), { record: async () => undefined })

    child.send({ jsonrpc: '2.0', id: 'server-1', method: 'server/request', params: {} })
    await flush()
    expect(child.frames()).toContainEqual({
      jsonrpc: '2.0',
      id: 'server-1',
      error: { code: -32601, message: 'Method not found' },
    })
    await client.dispose()
  })

  it('requires session/cancel to be sent as a notification', async () => {
    const child = new FakeChild()
    const client = new AcpClient(child.asChild(), { record: async () => undefined })

    await expect(client.request('session/cancel', { sessionId: 's' })).rejects.toBeInstanceOf(AcpProtocolError)
    await client.notify('session/cancel', { sessionId: 's' })
    expect(child.frames()).toEqual([{ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } }])
    await client.dispose()
  })

  it('surfaces JSON-RPC errors and clears timed-out and aborted requests', async () => {
    const child = new FakeChild()
    const client = new AcpClient(child.asChild(), { record: async () => undefined })

    const rpc = client.request('failing', {})
    await flush()
    child.send({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'nope', data: { retry: false } } })
    await expect(rpc).rejects.toMatchObject({ name: 'AcpRpcError', code: -32001, data: { retry: false } } satisfies Partial<AcpRpcError>)

    const timedOut = client.request('slow', {}, { timeoutMs: 1 })
    await expect(timedOut).rejects.toThrow('timed out')
    const controller = new AbortController()
    const aborted = client.request('abort', {}, { signal: controller.signal })
    controller.abort(new Error('stop now'))
    await expect(aborted).rejects.toThrow('stop now')
    await client.dispose()
  })

  it('does not write a queued request after its signal aborts', async () => {
    const child = new FakeChild()
    let releaseRecord!: () => void
    const recordGate = new Promise<void>((resolve) => { releaseRecord = resolve })
    const client = new AcpClient(child.asChild(), {
      record: async () => recordGate,
    })
    const controller = new AbortController()
    const request = client.request('queued', {}, { signal: controller.signal })
    controller.abort(new Error('cancel before write'))
    await expect(request).rejects.toThrow('cancel before write')
    releaseRecord()
    await flush()
    expect(child.writes).toEqual([])
    await client.dispose()
  })

  it('rejects pending requests on EOF and dispose never kills the child', async () => {
    const child = new FakeChild()
    const client = new AcpClient(child.asChild(), { record: async () => undefined })
    const pending = client.request('wait', {})
    await flush()
    child.stdout.end()
    await expect(pending).rejects.toBeInstanceOf(AcpTransportError)

    const second = new FakeChild()
    const secondClient = new AcpClient(second.asChild(), { record: async () => undefined })
    const pendingAfterDispose = secondClient.request('wait', {})
    await secondClient.dispose()
    await expect(pendingAfterDispose).rejects.toThrow('disposed')
    expect(second.killCalls).toBe(0)
  })

  it('bounds incoming frames and retains a bounded stderr tail', async () => {
    const child = new FakeChild()
    const client = new AcpClient(child.asChild(), { record: async () => undefined, maxFrameBytes: 64 })
    const pending = client.request('wait', {})
    await flush()
    child.stdout.write(Buffer.from('x'.repeat(65), 'utf8'))
    await expect(pending).rejects.toThrow('maxFrameBytes')

    const stderr = 'z'.repeat(40_000)
    child.stderr.write(stderr)
    expect(client.stderrTail.length).toBeLessThanOrEqual(32 * 1024)
    await client.dispose()
  })
})
