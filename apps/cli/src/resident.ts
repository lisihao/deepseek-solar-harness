/** Trusted local CLI consumer for resident-operator management and read-only observation. @module @deepseek-ai/dsh/resident */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  ResidentDaemonClient,
  startDetachedResidentDaemon,
} from '@deepseek-ai/dsh-resident-operator-local'
import { runResidentDaemon } from '@deepseek-ai/dsh-resident-operator-local/startup'

function root(): string {
  return join(resolveDshHome(), 'resident-operators')
}

function client(autoStart: boolean): ResidentDaemonClient {
  return new ResidentDaemonClient({
    root: root(),
    autoStart,
    connectTimeoutMs: 5_000,
    pollIntervalMs: 250,
  })
}

function requireArg(args: readonly string[], index: number, label: string): string {
  const value = args[index]
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`dsh resident requires ${label}`)
  }
  return value
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return requireArg(args, index + 1, `a value after ${name}`)
}

function revision(args: readonly string[]): number {
  const value = Number(option(args, '--expected-revision'))
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('dsh resident requires --expected-revision with a non-negative integer')
  }
  return value
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/** Run one resident management command; returns a process exit code. */
export async function runResidentCommand(args: readonly string[]): Promise<number> {
  try {
    switch (args[0]) {
      case 'list':
        print(await client(true).list())
        return 0
      case 'inspect':
        print(await client(true).inspect(requireArg(args, 1, 'a session id')))
        return 0
      case 'interrupt': {
        const service = client(true)
        const snapshot = await service.inspect(requireArg(args, 1, 'a session id'))
        if (snapshot.activeTurnId === undefined) throw new Error(`resident session ${snapshot.sessionId} has no active turn`)
        await service.interrupt(snapshot.sessionId, snapshot.activeTurnId)
        print({ interrupted: true, sessionId: snapshot.sessionId, turnId: snapshot.activeTurnId })
        return 0
      }
      case 'reset': {
        const sessionId = requireArg(args, 1, 'a session id')
        const reason = option(args, '--reason') ?? 'operator requested context reset'
        print(await client(true).reset(sessionId, revision(args), reason))
        return 0
      }
      case 'resolve-indeterminate': {
        const commandId = requireArg(args, 1, 'a command id')
        await client(true).resolveIndeterminate(commandId, revision(args))
        print({ commandId, decision: 'abandon', resolved: true })
        return 0
      }
      case 'attach':
        return await attach(args)
      case 'daemon':
        return await daemon(args)
      default:
        throw new Error(`unknown dsh resident command ${JSON.stringify(args[0])}`)
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

async function attach(args: readonly string[]): Promise<number> {
  const sessionId = requireArg(args, 1, 'a session id')
  if (!args.includes('--read-only')) {
    throw new Error('dsh resident attach requires --read-only; protocol v1 exposes no writable takeover channel')
  }
  if (args.includes('--tmux')) {
    const invocation = [
      process.execPath,
      ...process.execArgv,
      process.argv[1] as string,
      'resident', 'attach', sessionId, '--read-only',
    ]
    const shellCommand = invocation.map(shellQuote).join(' ')
    const child = spawn('tmux', ['new-window', '-n', `resident-${sessionId.slice(0, 8)}`, shellCommand], { stdio: 'inherit' })
    return await new Promise((resolve) => { child.once('exit', (code) => { resolve(code ?? 1) }) })
  }
  const service = client(true)
  let cursor = 0
  const once = args.includes('--once')
  for (;;) {
    const page = await service.readEvents(sessionId, cursor, 100)
    for (const event of page.events) process.stdout.write(`${JSON.stringify(event)}\n`)
    cursor = page.nextSequence
    if (once) return 0
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

async function daemon(args: readonly string[]): Promise<number> {
  switch (args[1]) {
    case 'run':
      await runResidentDaemon(root())
      return 0
    case 'start': {
      const pid = startDetachedResidentDaemon(root())
      await waitUntilReady()
      print({ state: 'running', pid, root: root() })
      return 0
    }
    case 'status': {
      const service = client(false)
      await service.ready()
      print({ state: 'running', providers: await service.providers(), sessions: (await service.list()).length })
      return 0
    }
    case 'stop':
      await client(false).shutdown()
      await waitUntilStopped()
      print({ state: 'stopped' })
      return 0
    default:
      throw new Error('dsh resident daemon requires start, run, status, or stop')
  }
}

async function waitUntilReady(): Promise<void> {
  const deadline = Date.now() + 5_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await client(false).ready()
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  throw new Error(`resident daemon did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

async function waitUntilStopped(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await client(false).ready()
      await new Promise(resolve => setTimeout(resolve, 50))
    } catch {
      return
    }
  }
  throw new Error('resident daemon did not finish draining within 30000ms')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
