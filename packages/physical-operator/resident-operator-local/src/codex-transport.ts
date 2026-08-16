/** WebSocket-over-Unix adapter for the managed Codex app-server daemon. @module @deepseek-ai/dsh-resident-operator-local/codex-transport */

import { Duplex } from 'node:stream'
import WebSocket, { type RawData } from 'ws'

const OPEN_TIMEOUT_MS = 15_000
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

function textFrame(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return data.toString('utf8')
}

/**
 * Adapt one-message-per-frame app-server WebSocket traffic to the NDJSON byte
 * streams consumed by the shared Codex protocol wire.
 */
class WebSocketLineStream extends Duplex {
  private outbound = ''

  constructor(private readonly socket: WebSocket) {
    super({ decodeStrings: false })
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.destroy(new Error('Codex app-server sent an unexpected binary WebSocket frame'))
        return
      }
      this.push(`${textFrame(data)}\n`)
    })
    socket.once('error', (error) => { this.destroy(error) })
    socket.once('close', () => { this.push(null) })
  }

  override _read(): void {}

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.outbound += typeof chunk === 'string' ? chunk : chunk.toString(encoding)
    const frames: string[] = []
    for (;;) {
      const newline = this.outbound.indexOf('\n')
      if (newline < 0) break
      const frame = this.outbound.slice(0, newline).trim()
      this.outbound = this.outbound.slice(newline + 1)
      if (frame.length > 0) frames.push(frame)
    }
    if (frames.length === 0) {
      callback()
      return
    }
    if (this.socket.readyState !== WebSocket.OPEN) {
      callback(new Error('Codex app-server WebSocket is not open'))
      return
    }
    let pending = frames.length
    let settled = false
    for (const frame of frames) {
      this.socket.send(frame, (error) => {
        if (settled) return
        if (error !== undefined) {
          settled = true
          callback(error)
          return
        }
        pending -= 1
        if (pending === 0) {
          settled = true
          callback()
        }
      })
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.terminate()
    }
    callback(error)
  }
}

/**
 * Open the owner-local managed Codex app-server control socket and return an
 * NDJSON-shaped duplex stream. The Unix listener requires a real WebSocket
 * upgrade; `codex app-server proxy` is only a raw byte proxy for that protocol.
 *
 * @param socketPath - absolute app-server Unix control socket.
 * @param signal - caller cancellation during the WebSocket handshake.
 * @returns an open stream whose writes become text frames and messages become lines.
 */
export function openCodexDaemonStream(socketPath: string, signal: AbortSignal): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws+unix://${socketPath}:/`, {
      handshakeTimeout: OPEN_TIMEOUT_MS,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    })
    let settled = false
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      socket.off('open', onOpen)
      socket.off('error', onError)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      socket.once('error', () => {})
      socket.terminate()
      reject(error)
    }
    const onAbort = (): void => {
      fail(signal.reason instanceof Error
        ? signal.reason
        : new Error(`Codex app-server connection aborted: ${String(signal.reason)}`))
    }
    const onError = (error: Error): void => { fail(error) }
    const onOpen = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(new WebSocketLineStream(socket))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('open', onOpen)
    socket.once('error', onError)
  })
}
