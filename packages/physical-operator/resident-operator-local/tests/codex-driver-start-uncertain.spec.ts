/**
 * A resident Codex turn whose `turn/start` gets no response: the driver holds the turn until the native turn settles
 * and reports it as unknown, and the progress phase follows the start rather than the request for it.
 */
import { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { ResidentOperatorError, type ResidentDriverExecuteRequest } from '@deepseek-ai/dsh-resident-operator'
import { normalizeResidentDriverError } from '../src/daemon.ts'
import { CodexResidentDriver } from '../src/drivers.ts'

type Frame = { id?: number | string; method?: string; params?: Record<string, unknown> }

/** An app-server connection that answers each request from a handler; the handler may leave one unanswered. */
class FakeAppServer extends Duplex {
  readonly methods: string[] = []
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = []
  private buffer = ''

  constructor(private readonly answer: (method: string, params: Record<string, unknown>, server: FakeAppServer) => unknown) {
    super()
  }

  override _read(): void {}

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.buffer += chunk.toString()
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const frame = JSON.parse(this.buffer.slice(0, newline)) as Frame
      this.buffer = this.buffer.slice(newline + 1)
      if (frame.method === undefined || frame.id === undefined) continue
      this.methods.push(frame.method)
      this.requests.push({ method: frame.method, params: frame.params ?? {} })
      const result = this.answer(frame.method, frame.params ?? {}, this)
      if (result !== undefined) this.push(`${JSON.stringify({ id: frame.id, result })}\n`)
    }
    done()
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    callback(error)
  }
}

const baseAnswers = (method: string): unknown => {
  if (method === 'initialize') return { userAgent: 'codex-cli 0.160.0' }
  if (method === 'thread/resume') return { thread: { id: 'thread-1', ephemeral: false } }
  return undefined
}

function request(patch: Partial<ResidentDriverExecuteRequest> = {}) {
  const onRunning = vi.fn()
  const onProgress = vi.fn<(phase: string) => void>()
  const value = {
    commandId: 'command-1', workspace: '/project', prompt: [{ type: 'text', text: 'the task' }], nativeSessionId: 'thread-1',
    nativeToolPolicy: 'native', signal: new AbortController().signal, onRunning, onProgress, onObservation: vi.fn(),
    ...patch,
  } as unknown as ResidentDriverExecuteRequest
  return { value, onRunning, onProgress }
}

function driverWith(streams: Array<FakeAppServer | Error>) {
  const driver = new CodexResidentDriver()
  const internals = driver as unknown as { openStream: () => Promise<FakeAppServer>; requireAvailable: () => Promise<void> }
  internals.requireAvailable = async () => {}
  const opened = vi.fn(async () => {
    const next = streams.shift()
    if (next instanceof Error) throw next
    return next!
  })
  internals.openStream = opened
  return { driver, opened }
}

describe('Codex resident turn with an unknown start', () => {
  it('holds the turn until the native turn settles, then fences the command as indeterminate instead of failing it', async () => {
    const reads = [
      [{ id: 'turn-old', status: 'completed' }],
      [{ id: 'turn-new', status: 'inProgress' }],
      [{ id: 'turn-new', status: 'completed' }],
    ]
    let listed = 0
    const main = new FakeAppServer((method, _params, server) => {
      if (method === 'thread/turns/list') return { data: reads[listed++] }
      if (method === 'turn/start') { setImmediate(() => { server.push(null) }); return undefined }
      return baseAnswers(method)
    })
    const probe = new FakeAppServer(method => method === 'thread/turns/list' ? { data: reads[listed++] } : baseAnswers(method))
    const { driver, opened } = driverWith([main, probe])
    const { value, onRunning, onProgress } = request()
    const error = await driver.execute(value).then(() => undefined, (caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'COMMAND_INDETERMINATE', nativeOutcomeUnconfirmed: true })
    // The turn is only inferred, so its end is reported as unproven rather than as this command's.
    expect((error as Error).message).toContain('native turn turn-new appeared after it and ended with status completed')
    expect((error as Error).message).not.toContain('the task')
    expect(opened).toHaveBeenCalledTimes(2)
    expect(main.methods).toEqual(['initialize', 'thread/resume', 'thread/turns/list', 'turn/start'])
    expect(probe.methods).toEqual(['initialize', 'thread/resume', 'thread/turns/list', 'thread/turns/list'])
    // The inspecting connection changes nothing about the thread: no model, sandbox, approval, or instruction overrides.
    expect(probe.requests.find(entry => entry.method === 'thread/resume')?.params).toEqual({ threadId: 'thread-1', cwd: '/project' })
    expect(probe.requests.filter(entry => entry.method === 'thread/turns/list').map(entry => entry.params))
      .toEqual([{ threadId: 'thread-1', limit: 1, sortDirection: 'desc' }, { threadId: 'thread-1', limit: 1, sortDirection: 'desc' }])
    // No native turn was named, so the model was never reported as reasoning.
    expect(onRunning).toHaveBeenCalledWith('thread-1')
    expect(onProgress.mock.calls.map(([phase]) => phase)).toEqual(['connecting', 'session_ready'])
  }, 20_000)

  it('reports the outcome as unknown when the thread cannot be inspected afterwards', async () => {
    const main = new FakeAppServer((method, _params, server) => {
      if (method === 'thread/turns/list') return { data: [] }
      if (method === 'turn/start') { setImmediate(() => { server.push(null) }); return undefined }
      return baseAnswers(method)
    })
    const { driver } = driverWith([main])
    const error = await driver.execute(request().value).then(() => undefined, (caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'COMMAND_INDETERMINATE', nativeOutcomeUnconfirmed: true })
    expect((error as Error).message).toContain('could not be inspected')
  }, 20_000)

  it('keeps the Session closed when the inspecting connection cannot be opened, with the real typed unavailability error', async () => {
    const main = new FakeAppServer((method, _params, server) => {
      if (method === 'thread/turns/list') return { data: [] }
      if (method === 'turn/start') { setImmediate(() => { server.push(null) }); return undefined }
      return baseAnswers(method)
    })
    const unavailable = new ResidentOperatorError('Codex app-server could not be started', 'RUNTIME_UNAVAILABLE')
    const { driver, opened } = driverWith([main, unavailable])
    const error = await driver.execute(request().value).then(() => undefined, (caught: unknown) => caught)
    expect(opened).toHaveBeenCalledTimes(2)
    expect(error).toBeInstanceOf(ResidentOperatorError)
    expect(error).toMatchObject({ code: 'COMMAND_INDETERMINATE', nativeOutcomeUnconfirmed: true })
    expect((error as Error).message).toContain('could not be inspected')
    expect((error as Error).message).toContain('Codex app-server could not be started')
    expect((error as Error).message).not.toContain('the task')
    // The daemon keeps the verdict: the command is fenced, not failed, and the Session stays closed.
    expect(normalizeResidentDriverError(error, false)).toMatchObject({ code: 'COMMAND_INDETERMINATE', nativeOutcomeUnconfirmed: true })
    // The turn was started once on the main connection and never replayed.
    expect(main.methods.filter(method => method === 'turn/start')).toHaveLength(1)
  }, 20_000)

  it('keeps the turn id the response named when reading the notifications before it fails, and waits for that turn by id', async () => {
    const statuses = ['inProgress', 'completed']
    let read = 0
    const main = new FakeAppServer((method, _params, server) => {
      if (method === 'thread/turns/list') return { data: [] }
      if (method === 'turn/start') {
        // A terminal notification of the turn the response is about to name, with a status the wire cannot accept.
        server.push(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-known', status: 'bogus', error: null } } })}\n`)
        return { turn: { id: 'turn-known' } }
      }
      return baseAnswers(method)
    })
    const probe = new FakeAppServer(method => method === 'thread/turns/list'
      ? { data: [{ id: 'turn-other', status: 'completed' }, { id: 'turn-known', status: statuses[Math.min(read++, 1)] }] }
      : baseAnswers(method))
    const { driver } = driverWith([main, probe])
    const { value, onRunning, onProgress } = request()
    const error = await driver.execute(value).then(() => undefined, (caught: unknown) => caught)
    // The server named the turn and it was seen to end, so the execution is known to have stopped: the Session is released.
    expect(error).toMatchObject({ code: 'COMMAND_INDETERMINATE', nativeOutcomeUnconfirmed: false })
    expect((error as Error).message).toContain('Codex turn turn-known ended with status completed')
    expect((error as Error).message).toContain('the response named turn turn-known')
    expect(probe.requests.filter(entry => entry.method === 'thread/turns/list').map(entry => entry.params.limit)).toEqual([20, 20])
    expect(onRunning.mock.calls).toEqual([['thread-1']])
    expect(onProgress.mock.calls.map(([phase]) => phase)).toEqual(['connecting', 'session_ready'])
  }, 20_000)

  it('reports the progress phase only after the native turn is named', async () => {
    const main = new FakeAppServer((method, _params, server) => {
      if (method === 'thread/turns/list') return { data: [] }
      if (method === 'turn/start') {
        setImmediate(() => {
          server.push(`${JSON.stringify({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', text: 'done', phase: 'final_answer' } } })}\n`)
          server.push(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null } } })}\n`)
        })
        return { turn: { id: 'turn-1' } }
      }
      return baseAnswers(method)
    })
    const { driver } = driverWith([main])
    const { value, onRunning, onProgress } = request()
    const result = await driver.execute(value)
    expect(result).toMatchObject({ stopReason: 'completed', nativeSessionId: 'thread-1' })
    expect(onRunning.mock.calls).toEqual([['thread-1'], ['thread-1', 'turn-1']])
    expect(onProgress.mock.calls.map(([phase]) => phase)).toEqual(['connecting', 'session_ready', 'reasoning', 'finalizing'])
  }, 20_000)
})
