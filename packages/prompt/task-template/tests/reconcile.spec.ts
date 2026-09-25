/**
 * Cross-process reconciliation contract: `reconcileBeforeWrite` folds in an
 * external change before a write derives its patch, and a `persist` that
 * still finds staleness at the last moment (inside its own exclusive lock)
 * makes {@link TaskTemplateService.write} retry against the refreshed base
 * instead of silently reverting the concurrent change. Exercised against the
 * base class directly (not the file-backed provider) so the race is
 * deterministic rather than timing-dependent.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { taskTemplateId } from '../src/brand.ts'
import { TaskTemplateService } from '../src/service.ts'
import { emptyStoreDocument } from '../src/store.ts'
import type { TaskTemplateStoreDocument } from '../src/store.ts'

const REVIEW = taskTemplateId('fixture-code-review')
const RIVAL = taskTemplateId('fixture-rival-write')

/**
 * A provider whose "storage" is a document an independent rival write can
 * mutate directly, and whose `persist` reports `'stale'` a configurable
 * number of times before committing — simulating a concurrent external
 * writer landing between `reconcileBeforeWrite` and the write's own final
 * check, without depending on real filesystem timing.
 */
class RivalWriteTemplates extends TaskTemplateService {
  /** The document a rival process has already committed to "storage". */
  storage: TaskTemplateStoreDocument = emptyStoreDocument()
  /** Every persist() attempt's document, in order — including stale ones. */
  attempts: TaskTemplateStoreDocument[] = []
  /** Remaining `persist` calls that must report `'stale'` before committing. */
  staleCountdown: number
  /** Remaining `reconcileBeforeWrite` calls that observe the rival's write. */
  reconcileCountdown: number

  constructor(ctx: ConstructorParameters<typeof TaskTemplateService>[0], options: {
    staleCountdown: number
    reconcileCountdown: number
  }) {
    super(ctx)
    this.staleCountdown = options.staleCountdown
    this.reconcileCountdown = options.reconcileCountdown
  }

  protected load(): Promise<TaskTemplateStoreDocument> {
    return Promise.resolve(structuredClone(this.storage))
  }

  protected override reconcileBeforeWrite(): Promise<void> {
    if (this.reconcileCountdown > 0) {
      this.reconcileCountdown -= 1
      this.adoptWithinWrite(structuredClone(this.storage))
    }
    return Promise.resolve()
  }

  protected persist(document: TaskTemplateStoreDocument): Promise<'committed' | 'stale'> {
    this.attempts.push(structuredClone(document))
    if (this.staleCountdown > 0) {
      this.staleCountdown -= 1
      // The rival's write becomes visible only once `persist`'s own
      // last-moment check runs — later than `reconcileBeforeWrite` already
      // ran for this attempt — so this is exactly the narrow race window
      // `reconcileBeforeWrite` alone cannot close.
      this.adoptWithinWrite(structuredClone(this.storage))
      return Promise.resolve('stale')
    }
    this.storage = structuredClone(document)
    return Promise.resolve('committed')
  }
}

async function boot(options: { staleCountdown: number; reconcileCountdown: number }) {
  const ctx = new Context()
  const fiber = ctx.plugin(RivalWriteTemplates, options)
  await fiber
  const provider = ctx.get('taskTemplates') as RivalWriteTemplates
  return { ctx, provider, fiber }
}

describe('reconcileBeforeWrite', () => {
  it('folds in a rival write observed before deriving the patch, without a persist retry', async () => {
    const { provider } = await boot({ staleCountdown: 0, reconcileCountdown: 0 })
    await provider.create({ id: REVIEW, name: 'Fictional review', method: 'Fictional method.' })
    // Simulate the rival landing its own template directly in storage, as a
    // real external process's write would land on disk.
    provider.storage.templates.push({
      id: RIVAL,
      enabled: true,
      createdAt: '2026-01-01T00:00:01.000Z',
      version: 1,
      name: 'Fictional rival',
      rank: 0,
      match: {},
      method: 'Fictional rival method.',
      history: [],
      updatedAt: '2026-01-01T00:00:01.000Z',
    })
    provider.attempts = []
    provider.reconcileCountdown = 1

    await provider.personalize(REVIEW, { preferences: 'Fictional preference.' })

    expect(provider.attempts).toHaveLength(1)
    expect(provider.attempts[0]?.templates.map(template => template.id).sort()).toEqual([REVIEW, RIVAL].sort())
    expect(provider.get(RIVAL)?.name).toBe('Fictional rival')
  })
})

describe('persist staleness retry', () => {
  it('retries the write against the refreshed base when persist detects staleness at the last moment', async () => {
    const { provider } = await boot({ staleCountdown: 0, reconcileCountdown: 0 })
    await provider.create({ id: REVIEW, name: 'Fictional review', method: 'Fictional method v1.' })
    provider.storage.templates.push({
      id: RIVAL,
      enabled: true,
      createdAt: '2026-01-01T00:00:01.000Z',
      version: 1,
      name: 'Fictional rival',
      rank: 0,
      match: {},
      method: 'Fictional rival method.',
      history: [],
      updatedAt: '2026-01-01T00:00:01.000Z',
    })
    provider.attempts = []
    provider.staleCountdown = 1

    const updated = await provider.update(REVIEW, { method: 'Fictional method v2.' })

    expect(updated.method).toBe('Fictional method v2.')
    // Two persist attempts: the first reports stale after adopting the rival
    // write, the second (built from the now-current base) commits.
    expect(provider.attempts).toHaveLength(2)
    expect(provider.attempts[0]?.templates.map(template => template.id)).not.toContain(RIVAL)
    expect(provider.attempts[1]?.templates.map(template => template.id).sort()).toEqual([REVIEW, RIVAL].sort())
    expect(provider.get(RIVAL)?.name).toBe('Fictional rival')
    expect(provider.storage.templates.map(template => template.id).sort()).toEqual([REVIEW, RIVAL].sort())
  })

  it('fails loud instead of looping forever against a repeatedly concurrently written store', async () => {
    const { provider } = await boot({ staleCountdown: 0, reconcileCountdown: 0 })
    await provider.create({ id: REVIEW, name: 'Fictional review', method: 'Fictional method.' })
    provider.staleCountdown = 100

    await expect(provider.personalize(REVIEW, { preferences: 'Fictional preference.' }))
      .rejects.toThrow(/could not commit after \d+ retries/)
  })
})
