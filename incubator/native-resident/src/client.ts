import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GraphSnapshot, ModelCatalog, ResidentApi, ResidentEvent, TaskGraph } from './contracts.js'
import { ResidentError } from './contracts.js'

export interface ResidentClientOptions {
  readonly codexExecutable?: string
  readonly claudeExecutable?: string
  readonly requestTimeoutMs?: number
  readonly startupTimeoutMs?: number
}

export const socketPath = (root: string): string => join(root, 'daemon.sock')

export async function daemonFingerprint(options: ResidentClientOptions): Promise<string> {
  const source = await readFile(new URL('./daemon.js', import.meta.url))
  const manifest = await readFile(new URL('../package.json', import.meta.url))
  return createHash('sha256').update(source).update(manifest).update(JSON.stringify({ codexExecutable: options.codexExecutable, claudeExecutable: options.claudeExecutable })).digest('hex')
}

/** One request per connection; uncertain mutation results are never replayed. */
export class ResidentClient implements ResidentApi {
  readonly protocolVersion = 1 as const
  constructor(readonly root: string, readonly options: ResidentClientOptions = {}) {}

  async call<T>(method: string, params: unknown = {}, timeoutMs = this.options.requestTimeoutMs ?? 30_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = randomUUID()
      const socket = createConnection(socketPath(this.root))
      let buffer = ''
      let settled = false
      let sent = false
      const finish = (error?: unknown, value?: T): void => {
        if (settled) return
        settled = true
        socket.destroy()
        if (error) reject(error)
        else resolve(value as T)
      }
      socket.setTimeout(timeoutMs, () => finish(new ResidentError(sent && !['ping', 'list', 'inspect', 'events', 'models'].includes(method) ? 'COMMAND_INDETERMINATE' : 'DAEMON_TIMEOUT', `Resident ${method} timed out; inspect its receipt before another mutation.`)))
      socket.on('connect', () => { sent = true; socket.write(JSON.stringify({ formatVersion: 1, id, method, params }) + '\n') })
      socket.on('data', data => {
        buffer += data.toString('utf8')
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return finish(new ResidentError('RESPONSE_TOO_LARGE', 'Resident response exceeded 4 MiB.'))
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        try {
          const reply = JSON.parse(buffer.slice(0, newline))
          if (reply.formatVersion !== 1 || reply.id !== id) throw new ResidentError('PROTOCOL_MISMATCH', 'Unexpected Resident protocol or response identity.')
          if (reply.error) throw new ResidentError(reply.error.code, reply.error.message)
          if (!Object.hasOwn(reply, 'result')) throw new ResidentError('PROTOCOL_MISMATCH', 'Resident response has no result.')
          finish(undefined, reply.result)
        } catch (error) { finish(error) }
      })
      socket.on('error', error => finish(error))
      socket.on('end', () => { if (!settled) finish(new ResidentError(sent ? 'COMMAND_INDETERMINATE' : 'DAEMON_UNAVAILABLE', 'Resident connection ended before a result.')) })
    })
  }

  async ensureStarted(): Promise<void> {
    const fingerprint = await daemonFingerprint(this.options)
    try {
      const pong = await this.call<{ fingerprint: string }>('ping', {}, 1000)
      if (pong.fingerprint !== fingerprint) throw new ResidentError('DAEMON_VERSION_MISMATCH', 'Resident is running another build or native executable configuration; stop it explicitly before switching.')
      return
    } catch (error) {
      if (!(error instanceof Error) || !['ENOENT', 'ECONNREFUSED'].includes(String((error as NodeJS.ErrnoException).code))) throw error
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const log = await open(join(this.root, 'daemon.log'), 'a', 0o600)
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) delete env[key]
    const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.js', import.meta.url)), '--root', this.root, '--config', JSON.stringify({ codexExecutable: this.options.codexExecutable, claudeExecutable: this.options.claudeExecutable, fingerprint })], { detached: true, stdio: ['ignore', log.fd, log.fd], env })
    const spawnError = new Promise<never>((_, reject) => child.once('error', reject))
    child.unref()
    await log.close()
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 10_000)
    while (Date.now() < deadline) {
      try {
        const pong = await Promise.race([this.call<{ fingerprint: string }>('ping', {}, 500), spawnError])
        if (pong.fingerprint !== fingerprint) throw new ResidentError('DAEMON_VERSION_MISMATCH', 'A different Resident build owns this home.')
        return
      } catch (error) {
        if (error instanceof ResidentError && error.code === 'DAEMON_VERSION_MISMATCH') throw error
        if (child.exitCode !== null) throw new ResidentError('DAEMON_START_FAILED', `Resident exited (${child.exitCode}); inspect ${join(this.root, 'daemon.log')}.`)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    throw new ResidentError('DAEMON_START_FAILED', `Resident did not become ready; inspect ${join(this.root, 'daemon.log')}.`)
  }

  submit(request: { commandId: string; graph: TaskGraph }): Promise<GraphSnapshot> { return this.call('submit', request) }
  inspect(graphId: string): Promise<GraphSnapshot> { return this.call('inspect', { graphId }) }
  list(): Promise<readonly GraphSnapshot[]> { return this.call('list') }
  control(request: Parameters<ResidentApi['control']>[0]): Promise<GraphSnapshot> { return this.call('control', request) }
  resolve(request: Parameters<ResidentApi['resolve']>[0]): Promise<GraphSnapshot> { return this.call('resolve', request) }
  events(graphId: string, after = 0, limit = 100): Promise<readonly ResidentEvent[]> { return this.call('events', { graphId, after, limit }) }
  models(cwd: string): Promise<readonly ModelCatalog[]> { return this.call('models', { cwd }) }
  shutdown(): Promise<{ stopped: true }> { return this.call('shutdown') }
}
