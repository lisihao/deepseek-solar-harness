/** Remote agent protocol: operations, argument checks, and the single result line. */

import { describe, expect, it, vi } from 'vitest'
import { GOUZI_AGENT_PROTOCOL, GOUZI_AGENT_RESULT_PREFIX, main, runGouziAgent, type LocalGouziOperationsLike } from '../src/gouzi-agent.ts'

function operations(): LocalGouziOperationsLike & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    resolveRepository: vi.fn(async (path: string) => { calls.push(['resolve', path]); return { projectId: 'project-test', repository: 'github.com/x/y', source: path } }),
    prepareRepository: vi.fn(async (path: string) => { calls.push(['prepare', path]); return { projectId: 'project-test', source: path } }),
    provision: vi.fn(async (input) => { calls.push(['provision', input]) }),
    start: vi.fn(async (id: string) => { calls.push(['start', id]); return { port: 4100, pid: 7, incarnation: 1 } }),
    stop: vi.fn(async (id: string, options) => { calls.push(['stop', id, options]); return { processTreeStopped: true } }),
    browse: vi.fn((path?: string) => { calls.push(['browse', path]); return { path: path ?? '/home', entries: [] } }),
  }
}

const environment = (ops: LocalGouziOperationsLike) => ({ appVersion: '3.36.0', operations: ops, membersRoot: '/members', home: '/home/dsh' })

describe('runGouziAgent', () => {
  it('reports the protocol, version, and where members live', async () => {
    expect(await runGouziAgent(['probe'], '', environment(operations()))).toMatchObject({
      protocol: GOUZI_AGENT_PROTOCOL, appVersion: '3.36.0', membersRoot: '/members', home: '/home/dsh',
    })
  })

  it('passes each operation its own arguments', async () => {
    const ops = operations()
    const env = environment(ops)
    await runGouziAgent(['resolve', '--path', '/work/a b'], '', env)
    await runGouziAgent(['prepare', '--path', '/work/a b'], '', env)
    await runGouziAgent(['browse'], '', env)
    await runGouziAgent(['browse', '--path', '/work'], '', env)
    await runGouziAgent(['provision'], JSON.stringify({ gouziId: 'gouzi-1' }), env)
    await runGouziAgent(['start', '--id', 'gouzi-1'], '', env)
    await runGouziAgent(['stop', '--id', 'gouzi-1'], '', env)
    await runGouziAgent(['stop', '--id', 'gouzi-1', '--reclaim'], '', env)
    expect(ops.calls).toEqual([
      ['resolve', '/work/a b'], ['prepare', '/work/a b'], ['browse', undefined], ['browse', '/work'], ['provision', { gouziId: 'gouzi-1' }], ['start', 'gouzi-1'],
      ['stop', 'gouzi-1', { reclaimResident: false }], ['stop', 'gouzi-1', { reclaimResident: true }],
    ])
  })

  it.each([
    ['an unknown operation', ['explode'], /unknown operation explode/u],
    ['no operation', [], /unknown operation undefined/u],
    ['a missing flag value', ['resolve'], /--path is required/u],
    ['a missing preparation path', ['prepare'], /--path is required/u],
    ['a missing id', ['start'], /--id is required/u],
    ['an id with a path separator', ['start', '--id', '../etc'], /is not valid/u],
    ['an id with capitals', ['stop', '--id', 'Gouzi'], /is not valid/u],
  ])('refuses %s without touching any member', async (_label, argv, message) => {
    const ops = operations()
    await expect(runGouziAgent(argv, '', environment(ops))).rejects.toThrow(message)
    expect(ops.calls).toEqual([])
  })
})

describe('agent entry', () => {
  it('preserves a directory inspection errno in the remote result', async () => {
    const lines: string[] = []
    await main(['resolve', '--path', '/definitely-missing-dsh-project-413592'], '3.36.0', async () => '', text => lines.push(text))
    expect(JSON.parse(lines[0]!.slice(GOUZI_AGENT_RESULT_PREFIX.length))).toMatchObject({ ok: false, code: 'ENOENT' })
  })

  it('prints one result line for a success and one for a failure, and reads stdin only for provision', async () => {
    const lines: string[] = []
    const readStdin = vi.fn(async () => '{}')
    await main(['probe'], '3.36.0', readStdin, text => lines.push(text))
    await main(['explode'], '3.36.0', readStdin, text => lines.push(text))
    expect(readStdin).not.toHaveBeenCalled()
    expect(lines).toHaveLength(2)
    expect(lines[0]!.startsWith(GOUZI_AGENT_RESULT_PREFIX)).toBe(true)
    expect(JSON.parse(lines[0]!.slice(GOUZI_AGENT_RESULT_PREFIX.length))).toMatchObject({ ok: true, value: { appVersion: '3.36.0' } })
    expect(JSON.parse(lines[1]!.slice(GOUZI_AGENT_RESULT_PREFIX.length))).toEqual({ ok: false, message: 'unknown operation explode' })
    expect(lines.every(line => line.endsWith('\n') && line.split('\n').length === 2)).toBe(true)
  })
})
