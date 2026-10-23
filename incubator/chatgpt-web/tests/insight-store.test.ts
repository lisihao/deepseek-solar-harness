import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { defaultInsightConfig } from '../src/insight-contract.js'
import { InsightStore } from '../src/insight-store.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-insight-store-'))
  roots.push(temporary)
  return join(temporary, 'state')
}

describe('InsightStore', () => {
  it('uses immutable revision publication for competing CAS transitions', async () => {
    const stateRoot = await root()
    const id = randomUUID()
    const store = new InsightStore(stateRoot)
    const created = await store.create(id, {
      input: { id, question: 'immutable question', conversationContext: 'immutable context' },
      config: defaultInsightConfig(),
    })

    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => store.transition(id, created.revision, {
      status: 'paused',
      reason: 'one CAS writer wins',
    })))

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(9)
    for (const attempt of attempts.filter((attempt) => attempt.status === 'rejected')) {
      expect(attempt.reason).toMatchObject({ code: 'INSIGHT_STATE_CONFLICT' })
    }
    expect(await store.read(id)).toMatchObject({ revision: 1, request: created.request, status: 'paused' })
    expect((await readdir(join(stateRoot, id))).filter((name) => name.endsWith('.json')).sort()).toEqual(['0.json', '1.json'])
  })
})
