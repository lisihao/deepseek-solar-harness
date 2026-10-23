import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { commandExitGrader, fileContainsGrader, sessionEventGrader } from '../src/index.js'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-bench-graders-'))
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

function toolCall(name: string, seq: number): SessionEvent {
  return { type: 'tool/call', seq, time: seq, data: { turn: 1, step: 1, callId: `c${String(seq)}`, name, arguments: '{}' } } as SessionEvent
}

describe('command-exit', () => {
  const node = process.execPath

  it('passes on the expected exit code and fails otherwise, quoting the output tail', async () => {
    const ok = await commandExitGrader.grade({ kind: 'command-exit', command: [node, '-e', 'console.log("hi")'], timeoutMs: 10_000 }, { workspace, events: [] })
    expect(ok).toMatchObject({ pass: true, score: 1 })
    expect(ok.details).toContain('exited 0, expected 0')
    expect(ok.details).toContain('hi')
    const bad = await commandExitGrader.grade({ kind: 'command-exit', command: [node, '-e', 'console.error("boom"); process.exit(3)'], timeoutMs: 10_000 }, { workspace, events: [] })
    expect(bad).toMatchObject({ pass: false, score: 0 })
    expect(bad.details).toContain('boom')
    const expected = await commandExitGrader.grade({ kind: 'command-exit', command: [node, '-e', 'process.exit(3)'], timeoutMs: 10_000, expectExit: 3 }, { workspace, events: [] })
    expect(expected.pass).toBe(true)
  })

  it('runs in the workspace', async () => {
    await writeFile(join(workspace, 'marker'), 'x')
    const result = await commandExitGrader.grade({ kind: 'command-exit', command: [node, '-e', 'require("fs").statSync("marker")'], timeoutMs: 10_000 }, { workspace, events: [] })
    expect(result.pass).toBe(true)
  })

  it('fails a command killed by its timeout or an abort', async () => {
    const timed = await commandExitGrader.grade({ kind: 'command-exit', command: [node, '-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 100 }, { workspace, events: [] })
    expect(timed.pass).toBe(false)
    expect(timed.details).toContain('was killed')
    const controller = new AbortController()
    const pending = commandExitGrader.grade({ kind: 'command-exit', command: [node, '-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 60_000 }, { workspace, events: [], signal: controller.signal })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ pass: false })
  })

  it('rejects when the executable cannot start', async () => {
    await expect(commandExitGrader.grade({ kind: 'command-exit', command: [join(workspace, 'missing')], timeoutMs: 1000 }, { workspace, events: [] })).rejects.toThrow(/ENOENT/)
  })

  it('validates parameters', () => {
    expect(() =>{  commandExitGrader.validate({ kind: 'command-exit', command: [], timeoutMs: 1 }) }).toThrow(/invalid command-exit grader spec/)
    expect(() =>{  commandExitGrader.validate({ kind: 'command-exit', command: ['x'] }) }).toThrow(/timeoutMs/)
    expect(() =>{  commandExitGrader.validate({ kind: 'command-exit', command: ['x'], timeoutMs: 1, extra: true }) }).toThrow(/extra/)
    expect(() =>{  commandExitGrader.validate({ kind: 'command-exit', command: ['x'], timeoutMs: 1 }) }).not.toThrow()
  })
})

describe('file-contains', () => {
  it('passes when the file contains the text', async () => {
    await writeFile(join(workspace, 'out.txt'), 'hello world')
    await expect(fileContainsGrader.grade({ kind: 'file-contains', path: 'out.txt', text: 'world' }, { workspace, events: [] })).resolves.toMatchObject({ pass: true, score: 1 })
    const miss = await fileContainsGrader.grade({ kind: 'file-contains', path: 'out.txt', text: 'mars' }, { workspace, events: [] })
    expect(miss).toMatchObject({ pass: false, score: 0 })
    expect(miss.details).toContain('does not contain')
  })

  it('fails without throwing when the file is missing', async () => {
    const result = await fileContainsGrader.grade({ kind: 'file-contains', path: 'absent.txt', text: 'x' }, { workspace, events: [] })
    expect(result.pass).toBe(false)
    expect(result.details).toContain('absent.txt is not readable')
  })

  it('refuses paths that leave the workspace', () => {
    expect(() =>{  fileContainsGrader.validate({ kind: 'file-contains', path: '../x', text: 'a' }) }).toThrow(/leaves the workspace/)
    expect(() =>{  fileContainsGrader.validate({ kind: 'file-contains', path: '..', text: 'a' }) }).toThrow(/leaves the workspace/)
    expect(() =>{  fileContainsGrader.validate({ kind: 'file-contains', path: '/etc/passwd', text: 'a' }) }).toThrow(/leaves the workspace/)
    expect(() =>{  fileContainsGrader.validate({ kind: 'file-contains', path: 'a/../b.txt', text: 'a' }) }).not.toThrow()
    expect(() =>{  fileContainsGrader.validate({ kind: 'file-contains', path: 'a.txt' }) }).toThrow(/text/)
  })
})

describe('session-event', () => {
  const events = [toolCall('bash', 1), toolCall('bash', 2), toolCall('read', 3), { type: 'turn/start', seq: 4, time: 4, data: { turn: 2 } } as SessionEvent]

  it('counts calls of the named tool against the bounds', async () => {
    await expect(sessionEventGrader.grade({ kind: 'session-event', tool: 'bash', min: 2 }, { workspace, events })).resolves.toMatchObject({ pass: true })
    await expect(sessionEventGrader.grade({ kind: 'session-event', tool: 'bash', min: 3 }, { workspace, events })).resolves.toMatchObject({ pass: false })
    const capped = await sessionEventGrader.grade({ kind: 'session-event', tool: 'read', max: 0 }, { workspace, events })
    expect(capped).toMatchObject({ pass: false, details: 'read called 1 times, expected [-, 0]' })
    const both = await sessionEventGrader.grade({ kind: 'session-event', tool: 'bash', min: 1, max: 2 }, { workspace, events })
    expect(both).toMatchObject({ pass: true, details: 'bash called 2 times, expected [1, 2]' })
  })

  it('requires at least one bound', () => {
    expect(() =>{  sessionEventGrader.validate({ kind: 'session-event', tool: 'bash' }) }).toThrow(/set min, max, or both/)
    expect(() =>{  sessionEventGrader.validate({ kind: 'session-event', tool: 'bash', max: 1 }) }).not.toThrow()
  })
})
