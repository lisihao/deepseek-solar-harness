import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { type RawData, WebSocketServer } from 'ws'
import { openCodexDaemonStream } from '../src/codex-transport.ts'

const roots: string[] = []

function nextConnection(server: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => { server.once('connection', resolve) })
}

function nextMessage(socket: WebSocket): Promise<{ data: RawData; isBinary: boolean }> {
  return new Promise((resolve) => {
    socket.once('message', (data, isBinary) => { resolve({ data, isBinary }) })
  })
}

function nextData(stream: NodeJS.ReadableStream): Promise<Buffer | string> {
  return new Promise((resolve) => {
    stream.once('data', (data: Buffer | string) => { resolve(data) })
  })
}

function text(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return data.toString('utf8')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Codex managed daemon transport', () => {
  it('performs a WebSocket upgrade over Unix and maps JSON frames to NDJSON lines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-codex-websocket-'))
    roots.push(root)
    const socketPath = join(root, 'control.sock')
    const server = createServer()
    const websocket = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      websocket.handleUpgrade(request, socket, head, (client) => { websocket.emit('connection', client, request) })
    })
    server.listen(socketPath)
    await once(server, 'listening')

    const connected = nextConnection(websocket)
    const stream = await openCodexDaemonStream(socketPath, new AbortController().signal)
    const peer = await connected
    const received = nextMessage(peer)
    stream.write('{"id":1,"method":"initialize"}\n')
    const { data: frame, isBinary } = await received
    expect(isBinary).toBe(false)
    expect(text(frame)).toBe('{"id":1,"method":"initialize"}')

    const incoming = nextData(stream)
    peer.send('{"id":1,"result":{}}')
    const line = await incoming
    expect(line.toString()).toBe('{"id":1,"result":{}}\n')

    stream.destroy()
    websocket.close()
    server.close()
    await once(server, 'close')
  })

  it('honors cancellation before opening the Unix socket', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(openCodexDaemonStream('/missing/codex.sock', controller.signal))
      .rejects.toThrow('cancelled')
  })
})
