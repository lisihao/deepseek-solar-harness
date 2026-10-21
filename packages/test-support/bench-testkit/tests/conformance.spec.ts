import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BenchGrader, BenchSuite, BenchSuiteId, BenchTask, BenchTaskId } from '@deepseek-ai/dsh-bench'
import { checkSuiteConformance, describeSuiteConformance } from '@deepseek-ai/dsh-bench-testkit'

const fixture = await mkdtemp(join(tmpdir(), 'dsh-bench-testkit-fixture-'))
await writeFile(join(fixture, 'seed.txt'), 'seed')

function suite(tasks: BenchTask[] | (() => Promise<BenchTask[]>)): BenchSuite {
  return { id: 'demo' as BenchSuiteId, version: '1', description: 'd', load: typeof tasks === 'function' ? tasks : () => Promise.resolve(tasks) }
}

const contains = (id: string, extra: Partial<BenchTask> = {}): BenchTask => ({
  id: id as BenchTaskId, prompt: 'p', grader: { kind: 'file-contains', path: 'out/result.txt', text: 'ok' }, tags: [], ...extra,
})

const good = { pass: { files: { 'out/result.txt': 'ok' } }, fail: { files: { 'out/result.txt': 'no' } } }

describe('describeSuiteConformance', () => {
  describeSuiteConformance({
    suite: suite([contains('a', { fixture }), { id: 'b' as BenchTaskId, prompt: 'p', grader: { kind: 'seed' }, tags: [] }]),
    graders: [{
      kind: 'seed', version: 1, validate: () => {},
      // Passes only when the fixture was copied and the run's log is non-empty.
      grade: async (_spec, input) => {
        const { readFile } = await import('node:fs/promises')
        const seeded = await readFile(join(input.workspace, 'seed.txt'), 'utf8').then(() => true, () => false)
        return { pass: input.events.length > 0 && !seeded, score: 0, details: '' }
      },
    }],
    runs: {
      a: good,
      b: { pass: { events: [{ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }] }, fail: {} },
    },
  })
})

describe('checkSuiteConformance', () => {
  it('reports a suite that fails to load or has no tasks', async () => {
    expect(await checkSuiteConformance({ suite: suite(() => Promise.reject(new Error('nope'))), runs: {} })).toEqual(['suite demo fails to load: nope'])
    expect(await checkSuiteConformance({ suite: suite([]), runs: {} })).toEqual(['suite demo has no tasks'])
  })

  it('reports every task-level violation', async () => {
    const passesAll: BenchGrader = { kind: 'lenient', version: 1, validate: () => {}, grade: () => Promise.resolve({ pass: true, score: 1, details: '' }) }
    const failsAll: BenchGrader = { kind: 'strict', version: 1, validate: () => {}, grade: () => Promise.resolve({ pass: false, score: 0, details: '' }) }
    const missingDir = join(fixture, 'missing')
    await mkdir(join(fixture, 'sub'), { recursive: true })
    const problems = await checkSuiteConformance({
      suite: suite([
        contains('dup'),
        contains('dup'),
        contains('nofix', { fixture: missingDir }),
        contains('filefix', { fixture: join(fixture, 'seed.txt') }),
        { id: 'unknown' as BenchTaskId, prompt: 'p', grader: { kind: 'nope' }, tags: [] },
        contains('invalid', { grader: { kind: 'file-contains', path: '../x', text: 'a' } }),
        contains('noruns'),
        { id: 'lenient' as BenchTaskId, prompt: 'p', grader: { kind: 'lenient' }, tags: [] },
        { id: 'strict' as BenchTaskId, prompt: 'p', grader: { kind: 'strict' }, tags: [] },
      ]),
      graders: [passesAll, failsAll],
      runs: { dup: good, lenient: good, strict: good, ghost: good },
    })
    expect(problems).toEqual([
      'task dup: duplicate id',
      `task nofix: fixture ${missingDir} is not a directory`,
      `task filefix: fixture ${join(fixture, 'seed.txt')} is not a directory`,
      'task unknown: grader nope is not registered',
      'task invalid: invalid file-contains grader spec: path "../x" leaves the workspace',
      'task noruns: no pass/fail runs given',
      'task lenient: grader passes the failing run',
      'task strict: grader fails the passing run',
      'runs given for unknown task ghost',
    ])
  })
})
