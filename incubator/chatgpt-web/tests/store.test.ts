import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WebRunStore, type WebRunRequest } from '../src/store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'chatgpt-web-store-'))
  roots.push(root)
  return join(root, 'records')
}

function request(prompt = 'Keep this input byte-for-byte.\n第二行'): WebRunRequest {
  return { prompt, modelLabel: 'gpt-5', effortLabel: 'high' }
}

describe('WebRunStore', () => {
  it('persists complete records, uses private modes, and reopens without changing stage', async () => {
    const root = await makeRoot()
    const id = randomUUID()
    const first = new WebRunStore(root)
    const created = await first.create(id, request())

    expect(created).toMatchObject({ formatVersion: 1, id, revision: 0, stage: 'prepared', request: request() })
    expect(await stat(root).then((value) => value.mode & 0o777)).toBe(0o700)
    expect(await stat(join(root, id)).then((value) => value.mode & 0o777)).toBe(0o700)
    expect(await stat(join(root, id, '0.json')).then((value) => value.mode & 0o777)).toBe(0o600)

    const reopened = new WebRunStore(root)
    expect(await reopened.read(id)).toEqual(created)
    expect(await reopened.list()).toEqual([created])
  })

  it('returns the latest revision for an idempotent create and rejects changed input without leaking it', async () => {
    const root = await makeRoot()
    const id = randomUUID()
    const store = new WebRunStore(root)
    const created = await store.create(id, request())
    const completed = await store.transition(id, created.revision, { stage: 'completed' })

    await expect(store.create(id, request())).resolves.toEqual(completed)
    const secret = 'prompt-secret-that-must-not-appear-in-an-error'
    const failure = await store.create(id, request(secret)).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'WEB_COMMAND_CONFLICT' })
    expect(String(failure instanceof Error ? failure.message : failure)).not.toContain(secret)
  })

  it('preserves full input and output bytes while appending immutable revisions', async () => {
    const root = await makeRoot()
    const id = randomUUID()
    const store = new WebRunStore(root)
    const created = await store.create(id, request('输入\n'.repeat(3000)))
    const before = await readFile(join(root, id, '0.json'))
    const text = 'answer\n'.repeat(3000) + '末尾🙂'
    const markdown = '# heading\n\n' + text
    const completed = await store.transition(id, created.revision, {
      stage: 'completed',
      resource: { spaceId: 7, pageLabel: 'Space A', conversationUrl: 'https://chatgpt.com/c/abc' },
      observed: { modelLabel: 'gpt-5', effortLabel: 'high' },
      output: { text, markdown },
    })

    expect(completed.request.prompt).toBe('输入\n'.repeat(3000))
    expect(completed.output).toEqual({ text, markdown })
    expect(await readFile(join(root, id, '0.json'))).toEqual(before)
    const files = await readdir(join(root, id))
    expect(files.filter((name) => name.endsWith('.json')).sort()).toEqual(['0.json', '1.json'])
    expect(await readFile(join(root, id, '1.json'), 'utf8')).toContain(JSON.stringify(text).slice(1, -1))
  })

  it('allows only one concurrent CAS transition for the same revision', async () => {
    const root = await makeRoot()
    const id = randomUUID()
    const store = new WebRunStore(root)
    await store.create(id, request())

    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, () => store.transition(id, 0, { stage: 'submitted' })),
    )
    const accepted = outcomes.filter((result) => result.status === 'fulfilled')
    const rejected = outcomes.filter((result) => result.status === 'rejected')
    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(11)
    for (const result of rejected) expect(result.reason).toMatchObject({ code: 'WEB_STATE_CONFLICT' })
    expect((await store.read(id))?.revision).toBe(1)
  })

  it('distinguishes an unknown durable version from corrupt JSON', async () => {
    const root = await makeRoot()
    const id = randomUUID()
    const directory = join(root, id)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, '0.json'), '{"formatVersion":99}', { mode: 0o600 })
    const store = new WebRunStore(root)
    await expect(store.read(id)).rejects.toMatchObject({ code: 'WEB_STATE_VERSION' })

    await writeFile(join(directory, '0.json'), '{not-json', { mode: 0o600 })
    await expect(store.read(id)).rejects.toMatchObject({ code: 'WEB_STATE_INVALID' })
  })

  it('rejects a valid-looking appended revision that rewrites the immutable request', async () => {
    const root = await makeRoot()
    const id = randomUUID()
    const store = new WebRunStore(root)
    await store.create(id, request('original immutable prompt'))
    await store.transition(id, 0, { stage: 'submitted' })

    const revisionPath = join(root, id, '1.json')
    const tampered = JSON.parse(await readFile(revisionPath, 'utf8')) as { request: WebRunRequest }
    tampered.request = { ...tampered.request, prompt: 'rewritten prompt' }
    await writeFile(revisionPath, JSON.stringify(tampered), { mode: 0o600 })

    await expect(store.read(id)).rejects.toMatchObject({ code: 'WEB_STATE_INVALID' })
    await expect(store.create(id, request('original immutable prompt'))).rejects.toMatchObject({ code: 'WEB_STATE_INVALID' })
  })

  it('reports stale revisions and does not create browser or process side effects', async () => {
    const root = await makeRoot()
    const id = randomUUID()
    const store = new WebRunStore(root)
    await store.create(id, request())

    await expect(store.transition(id, 2, { stage: 'ready' })).rejects.toMatchObject({ code: 'WEB_STATE_CONFLICT' })
    expect(await readdir(root)).toEqual([id])
    expect(await store.read(id)).toMatchObject({ stage: 'prepared', revision: 0 })
  })
})
