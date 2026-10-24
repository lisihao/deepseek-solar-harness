import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { GrokRequest } from '../src/grok-contract.js'
import { GrokRunStore } from '../src/grok-store.js'

const roots: string[] = []
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111'
const REPLY_ID = '22222222-2222-4222-8222-222222222222'
const RESPONSE_ID = `response-${REPLY_ID}`

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeCallerRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-grok-store-'))
  roots.push(root)
  return root
}

function request(id = randomUUID(), overrides: Partial<GrokRequest> = {}): GrokRequest {
  return {
    id,
    sessionId: 'session-1',
    canonical: 'provider=grok;request=immutable',
    prompt: '保留这段输入\r\n以及第二行。',
    modelLabel: 'Grok 4',
    ...overrides,
  }
}

describe('GrokRunStore', () => {
  it('writes a private append-only v1 journal below callerRoot/grok-web', async () => {
    const callerRoot = await makeCallerRoot()
    const store = new GrokRunStore(callerRoot)
    const created = await store.create(request())
    const root = join(callerRoot, 'grok-web')
    const withResource = await store.transition(created.id, created.revision, {
      stage: 'prepared',
      resource: { provider: 'grok', spaceId: 7, pageLabel: 'Grok task', conversationUrl: 'https://grok.com/' },
    })
    const submitted = await store.transition(withResource.id, withResource.revision, {
      stage: 'submitted',
      intentAt: '2026-10-24T12:00:00.000Z',
      promptReceiptId: 'user-message-1',
      resource: {
        provider: 'grok',
        spaceId: 7,
        pageLabel: 'Grok task',
        conversationUrl: `https://grok.com/c/${CONVERSATION_ID}`,
      },
    })
    const completed = await store.transition(submitted.id, submitted.revision, {
      stage: 'completed',
      replyId: RESPONSE_ID,
      resource: {
        provider: 'grok',
        spaceId: 7,
        pageLabel: 'Grok task',
        conversationUrl: `https://grok.com/c/${CONVERSATION_ID}?rid=${REPLY_ID}`,
      },
      output: {
        text: '可见文字回答',
        sha256: createHash('sha256').update('可见文字回答', 'utf8').digest('hex'),
      },
    })

    expect(completed).toMatchObject({ formatVersion: 1, revision: 3, stage: 'completed' })
    expect(await stat(root).then(value => value.mode & 0o777)).toBe(0o700)
    expect(await stat(join(root, created.id)).then(value => value.mode & 0o777)).toBe(0o700)
    expect(await stat(join(root, created.id, '0.json')).then(value => value.mode & 0o777)).toBe(0o600)
    expect(await readdir(join(root, created.id))).toEqual(['0.json', '1.json', '2.json', '3.json'])
    expect(await new GrokRunStore(callerRoot).read(created.id)).toEqual(completed)
  })

  it('atomically admits one concurrent creator and refuses a changed request identity', async () => {
    const callerRoot = await makeCallerRoot()
    const id = randomUUID()
    const original = request(id)
    const first = new GrokRunStore(callerRoot)
    const second = new GrokRunStore(callerRoot)
    const admitted = await Promise.all([first.createOrRead(original), second.createOrRead(original)])

    expect(admitted.filter(value => value.created)).toHaveLength(1)
    expect(admitted.map(value => value.record.revision)).toEqual([0, 0])
    expect(await readdir(join(callerRoot, 'grok-web', id))).toEqual(['0.json'])
    const secret = 'must-not-leak-in-conflict-message'
    const conflict = await first.create({ ...original, canonical: secret }).catch(error => error)
    expect(conflict).toMatchObject({ code: 'GROK_COMMAND_CONFLICT' })
    expect(String(conflict instanceof Error ? conflict.message : conflict)).not.toContain(secret)
  })

  it('rejects non-Grok and non-canonical resource URLs without adding a revision', async () => {
    const callerRoot = await makeCallerRoot()
    const store = new GrokRunStore(callerRoot)
    const created = await store.create(request())
    const invalid = await store.transition(created.id, created.revision, {
      resource: { provider: 'grok', spaceId: 2, pageLabel: 'x', conversationUrl: 'https://chatgpt.com/c/not-grok' },
    }).catch(error => error)
    expect(invalid).toMatchObject({ code: 'GROK_STATE_INVALID' })
    expect(await store.read(created.id)).toEqual(created)

    const nonCanonical = await store.transition(created.id, created.revision, {
      resource: { provider: 'grok', spaceId: 2, pageLabel: 'x', conversationUrl: 'https://grok.com' },
    }).catch(error => error)
    expect(nonCanonical).toMatchObject({ code: 'GROK_STATE_INVALID' })
    expect(await readdir(join(callerRoot, 'grok-web', created.id))).toEqual(['0.json'])
  })

  it('allows one compare-and-swap transition and retains the original revision bytes', async () => {
    const callerRoot = await makeCallerRoot()
    const store = new GrokRunStore(callerRoot)
    const created = await store.create(request())
    const revisionZero = await readFile(join(callerRoot, 'grok-web', created.id, '0.json'))
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => store.transition(created.id, 0, { stage: 'preparing' })))

    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(7)
    expect(await readFile(join(callerRoot, 'grok-web', created.id, '0.json'))).toEqual(revisionZero)
    expect((await store.read(created.id))?.revision).toBe(1)
  })

  it('rejects unknown or malformed schemas and detects a rewritten original request while preserving the old revision', async () => {
    const callerRoot = await makeCallerRoot()
    const store = new GrokRunStore(callerRoot)
    const created = await store.create(request())
    const directory = join(callerRoot, 'grok-web', created.id)
    const original = await readFile(join(directory, '0.json'))

    await writeFile(join(directory, '0.json'), '{"formatVersion":99}', { mode: 0o600 })
    await expect(store.read(created.id)).rejects.toMatchObject({ code: 'GROK_STATE_VERSION' })
    await writeFile(join(directory, '0.json'), '{not-json', { mode: 0o600 })
    await expect(store.read(created.id)).rejects.toMatchObject({ code: 'GROK_STATE_INVALID' })
    await writeFile(join(directory, '0.json'), original, { mode: 0o600 })

    const next = await store.transition(created.id, 0, { stage: 'preparing' })
    const revisionOnePath = join(directory, `${next.revision}.json`)
    const rewritten = JSON.parse(await readFile(revisionOnePath, 'utf8')) as { request: GrokRequest }
    rewritten.request = { ...rewritten.request, prompt: 'rewritten prompt' }
    await writeFile(revisionOnePath, JSON.stringify(rewritten), { mode: 0o600 })

    await expect(store.read(created.id)).rejects.toMatchObject({ code: 'GROK_STATE_INVALID' })
    expect(await readFile(join(directory, '0.json'))).toEqual(original)
  })
})
