import { afterEach, describe, expect, test } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { ResidentClient } from '../incubator/native-resident/src/client.js'
import type { GraphSnapshot, TaskGraph } from '../incubator/native-resident/src/contracts.js'

const roots: string[] = []
const children = new Set<ChildProcess>()
const prefix = join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'dsv4-daemon-')
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, 'exit')
      child.kill('SIGKILL')
      await exit
    }
  }
  children.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Expected durable daemon state did not appear.')
}

async function start(root: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['tools/fixtures/resident-daemon.mjs', root], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: root } })
  children.add(child)
  let output = ''
  let errors = ''
  child.stdout!.on('data', data => { output += data.toString() })
  child.stderr!.on('data', data => { errors += data.toString() })
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`Fixture exited: ${errors}`)
    return output
  }, value => value.includes('FIXTURE_READY'))
  return child
}

function graph(id: string, cwd: string, prompt = 'complete'): TaskGraph {
  return { formatVersion: 1, id, label: 'Durable process test', cwd, maxParallel: 1, nodes: [{ id: 'work', executor: 'codex', prompt, sessionKey: 'coding' }] }
}

describe('packaged resident daemon, no native products or credentials', () => {
  test('owns an owner-only socket and persists results through process restart', async () => {
    const root = await mkdtemp(prefix)
    roots.push(root)
    const first = await start(root)
    const client = new ResidentClient(root)
    expect((await stat(join(root, 'daemon.sock'))).mode & 0o777).toBe(0o600)
    await client.submit({ commandId: 'submit-complete', graph: graph('complete', root) })
    const completed = await waitFor(() => client.inspect('complete'), value => value.status === 'completed')
    expect(completed.nodes[0]?.output).toBe('keyless fixture result')
    const exited = once(first, 'exit')
    await client.shutdown()
    await exited
    await start(root)
    expect((await client.inspect('complete')).nodes[0]?.nativeSessionId).toBe('fixture-native-session')
    expect((await readFile(join(root, 'dispatches.log'), 'utf8')).trim().split('\n')).toHaveLength(1)
    await client.shutdown()
  })

  test('SIGKILL during a native effect recovers unknown without a duplicate dispatch', async () => {
    const root = await mkdtemp(prefix)
    roots.push(root)
    const first = await start(root)
    const client = new ResidentClient(root)
    await client.submit({ commandId: 'submit-unknown', graph: graph('unknown', root, 'wait-for-crash') })
    await waitFor(() => client.inspect('unknown'), value => value.nodes[0]?.nativeSessionId === 'fixture-native-session')
    const exited = once(first, 'exit')
    first.kill('SIGKILL')
    await exited
    await start(root)
    const recovered = await waitFor<GraphSnapshot>(() => client.inspect('unknown'), value => value.nodes[0]?.status === 'indeterminate')
    expect(recovered.status).toBe('indeterminate')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect((await readFile(join(root, 'dispatches.log'), 'utf8')).trim().split('\n')).toHaveLength(1)
    const replay = await client.submit({ commandId: 'submit-unknown', graph: graph('unknown', root, 'wait-for-crash') })
    expect(replay.graph.id).toBe('unknown')
    expect((await readFile(join(root, 'dispatches.log'), 'utf8')).trim().split('\n')).toHaveLength(1)
    await client.shutdown()
  })
})
