import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadDeclarativeSuite } from '@deepseek-ai/dsh-bench'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-bench-suite-'))
  await writeFile(join(dir, 'suite.yml'), 'id: demo\nversion: "1"\ndescription: Demo suite.\n')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function tasks(...lines: string[]): Promise<void> {
  await writeFile(join(dir, 'tasks.jsonl'), lines.join('\n'))
}

describe('loadDeclarativeSuite', () => {
  it('reads the header and the tasks with resolved fixtures', async () => {
    await mkdir(join(dir, 'fixtures', 'a'), { recursive: true })
    await tasks(
      JSON.stringify({ id: 'a', prompt: 'do a', fixture: 'fixtures/a', grader: { kind: 'file-contains', path: 'x', text: 'y' }, tags: ['code'] }),
      '',
      JSON.stringify({ id: 'b', prompt: 'do b', grader: { kind: 'session-event', tool: 'bash', min: 1 } }),
    )
    const suite = await loadDeclarativeSuite(dir)
    expect(suite).toMatchObject({ id: 'demo', version: '1', description: 'Demo suite.' })
    const loaded = await suite.load()
    expect(loaded).toEqual([
      { id: 'a', prompt: 'do a', fixture: join(dir, 'fixtures', 'a'), grader: { kind: 'file-contains', path: 'x', text: 'y' }, tags: ['code'] },
      { id: 'b', prompt: 'do b', grader: { kind: 'session-event', tool: 'bash', min: 1 }, tags: [] },
    ])
  })

  it('re-reads tasks on every load', async () => {
    await tasks(JSON.stringify({ id: 'a', prompt: 'p', grader: { kind: 'k' } }))
    const suite = await loadDeclarativeSuite(dir)
    expect(await suite.load()).toHaveLength(1)
    await tasks(JSON.stringify({ id: 'a', prompt: 'p', grader: { kind: 'k' } }), JSON.stringify({ id: 'b', prompt: 'p', grader: { kind: 'k' } }))
    expect(await suite.load()).toHaveLength(2)
  })

  it('refuses a relative directory and an invalid header', async () => {
    await expect(loadDeclarativeSuite('relative')).rejects.toThrow(/must be absolute/)
    await writeFile(join(dir, 'suite.yml'), 'id: Bad Id\nversion: "1"\ndescription: d\n')
    await expect(loadDeclarativeSuite(dir)).rejects.toThrow(/suite\.yml/)
  })

  it.each([
    ['invalid JSON', ['{nope'], /tasks\.jsonl:1: not valid JSON/],
    ['a schema violation', [JSON.stringify({ id: 'a', grader: { kind: 'k' } })], /tasks\.jsonl:1: .*prompt/s],
    ['a duplicate id', [JSON.stringify({ id: 'a', prompt: 'p', grader: { kind: 'k' } }), JSON.stringify({ id: 'a', prompt: 'p', grader: { kind: 'k' } })], /tasks\.jsonl:2: duplicate task id "a"/],
    ['an escaping fixture', [JSON.stringify({ id: 'a', prompt: 'p', fixture: '../x', grader: { kind: 'k' } })], /must stay inside the suite directory/],
    ['an absolute fixture', [JSON.stringify({ id: 'a', prompt: 'p', fixture: '/tmp', grader: { kind: 'k' } })], /must stay inside the suite directory/],
    ['a missing fixture', [JSON.stringify({ id: 'a', prompt: 'p', fixture: 'none', grader: { kind: 'k' } })], /fixture "none" is not a directory/],
  ])('refuses %s with the line number', async (_label, lines, error) => {
    await tasks(...lines)
    const suite = await loadDeclarativeSuite(dir)
    await expect(suite.load()).rejects.toThrow(error)
  })

  it('refuses a fixture that is a file', async () => {
    await writeFile(join(dir, 'file'), 'x')
    await tasks(JSON.stringify({ id: 'a', prompt: 'p', fixture: 'file', grader: { kind: 'k' } }))
    await expect((await loadDeclarativeSuite(dir)).load()).rejects.toThrow(/is not a directory/)
  })
})
