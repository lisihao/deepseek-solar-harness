/** Owner-local JSON-RPC request server over a caller-selected IPC endpoint. */

import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { JsonRpcLineTransport } from './transport.ts'

/** Address and optional filesystem owner directory for a local IPC endpoint. */
export interface LocalJsonRpcEndpoint {
  readonly path: string
  /** Present for Unix-domain sockets; absent for Windows named pipes. */
  readonly directory?: string
}

/** Handler invoked for each JSON-RPC request accepted by the local server. */
export type LocalJsonRpcRequestHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>

/**
 * Own one local request listener while leaving endpoint naming to the caller.
 * The endpoint directory and socket use owner-only permissions on POSIX.
 */
export class LocalJsonRpcRequestServer {
  private readonly server: Server
  private ready: Promise<void> | undefined

  constructor(
    private readonly endpoint: LocalJsonRpcEndpoint,
    private readonly onRequest: LocalJsonRpcRequestHandler,
  ) {
    this.server = createServer((socket) => { this.accept(socket) })
  }

  /** Start listening. Repeated calls share the same in-flight or settled start. */
  start(): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      if (this.endpoint.directory !== undefined) {
        mkdirSync(this.endpoint.directory, { recursive: true, mode: 0o700 })
        chmodSync(this.endpoint.directory, 0o700)
        rmSync(this.endpoint.path, { force: true })
      }
      const onError = (error: Error): void => { reject(error) }
      this.server.once('error', onError)
      this.server.listen(this.endpoint.path, () => {
        this.server.off('error', onError)
        if (this.endpoint.directory !== undefined) chmodSync(this.endpoint.path, 0o600)
        resolve()
      })
    })
    return this.ready
  }

  /** Close the listener and remove only its filesystem-backed socket. */
  async dispose(): Promise<void> {
    if (this.ready === undefined) return
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    if (this.endpoint.directory !== undefined) rmSync(this.endpoint.path, { force: true })
    this.ready = undefined
  }

  private accept(socket: Socket): void {
    const transport = new JsonRpcLineTransport(socket, socket)
    transport.onRequest(this.onRequest)
    socket.on('close', () => { transport.close() })
    transport.start()
  }
}
