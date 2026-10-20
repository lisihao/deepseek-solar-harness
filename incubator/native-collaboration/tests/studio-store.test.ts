import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import type { StudioGraph, StudioRun } from '../src/studio-contract.js'
import { StudioStore } from '../src/studio-store.js'

const draftId = 'a13b9ba8-4f95-440f-b104-a722335b6364'

function graph(sessionId = 'session-a', prompt = '原始提示词'): StudioGraph {
  return {
    formatVersion: 1,
    id: 'source-flow',
    sessionId,
    providerId: 'native',
    title: '来源流程',
    nodes: [{ id: 'node-a', label: '阶段 A', kind: 'native', prompt, parameters: {}, metadata: {}, position: { x: 0, y: 0 } }],
    edges: [],
    parameters: {},
    metadata: {},
  }
}

function run(status: StudioRun['status'], output?: string): StudioRun {
  const timestamp = '2026-10-20T00:00:00.000Z'
  return { id: 'external-run-a', sessionId: 'session-a', providerId: 'native', status, nodes: [], createdAt: timestamp, updatedAt: timestamp, ...(output === undefined ? {} : { output }) }
}

function runWithId(id: string, status: StudioRun['status'], output?: string): StudioRun {
  return { ...run(status, output), id }
}

let roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store(): Promise<StudioStore> {
  const root = await mkdtemp(join(tmpdir(), 'solar-studio-store-'))
  roots.push(root)
  return new StudioStore(root)
}

describe('versioned workflow store', () => {
  test('uses CAS drafts, keeps command snapshots immutable, and isolates sessions', async () => {
    const subject = await store()
    const original = graph()
    await subject.capture({ id: 'source-a', graph: original })
    const saved = await subject.saveDraft({ sessionId: 'session-a', id: draftId, expectedRevision: 0, graph: original, sourceId: 'source-a' })
    expect(saved.revision).toBe(0)

    const intent = await subject.createRunIntent({ sessionId: 'session-a', draftId, expectedRevision: 0, commandId: 'command-a' })
    expect(intent.created).toBe(true)
    expect(intent.record.graph.nodes[0]?.prompt).toBe('原始提示词')

    const revisionOne = await subject.saveDraft({ sessionId: 'session-a', id: draftId, expectedRevision: 0, graph: graph('session-a', '更新后的提示词'), sourceId: 'source-a' })
    expect(revisionOne.revision).toBe(1)
    await expect(subject.saveDraft({ sessionId: 'session-a', id: draftId, expectedRevision: 0, graph: graph('session-a', '错误写入'), sourceId: 'source-a' })).rejects.toMatchObject({ code: 'STUDIO_DRAFT_CONFLICT' })
    expect((await subject.readRun('session-a', 'command-a'))?.graph.nodes[0]?.prompt).toBe('原始提示词')
    expect(await subject.readDraft('session-b', draftId)).toBeUndefined()
    expect(await subject.readRun('session-b', 'command-a')).toBeUndefined()
  })

  test('updates only the source run projection when capture sees the same immutable graph', async () => {
    const subject = await store()
    const original = graph()
    await subject.capture({ id: 'source-a', graph: original })
    const refreshed = await subject.capture({ id: 'source-a', graph: original, run: run('completed', '完成产物') })
    expect(refreshed.graph).toEqual(original)
    expect(refreshed.run?.status).toBe('completed')
    expect(refreshed.run?.output).toBe('完成产物')
    await expect(subject.capture({ id: 'source-a', graph: graph('session-a', '不同图') })).rejects.toMatchObject({ code: 'STUDIO_COMMAND_CONFLICT' })
  })

  test('retries concurrent source observations, preserves a terminal projection, and binds the declared source run id', async () => {
    const subject = await store()
    const original = graph()
    await subject.capture({ id: 'source-a', graph: original, runId: 'external-run-a', run: run('pending') })

    await Promise.all([
      subject.observeSourceRun('session-a', 'source-a', run('running')),
      subject.observeSourceRun('session-a', 'source-a', run('completed', '最终产物')),
    ])
    const completed = await subject.readSource('session-a', 'source-a')
    expect(completed?.run?.status).toBe('completed')
    expect(completed?.run?.output).toBe('最终产物')

    const lateUnknown = await subject.observeSourceRun('session-a', 'source-a', run('unknown'))
    expect(lateUnknown.run?.status).toBe('completed')
    expect(lateUnknown.run?.output).toBe('最终产物')
    await expect(subject.observeSourceRun('session-a', 'source-a', runWithId('different-original-run', 'running'))).rejects.toMatchObject({ code: 'STUDIO_STATE_INVALID' })
    await expect(subject.capture({ id: 'source-mismatch', graph: original, runId: 'declared-run', run: run('running') })).rejects.toMatchObject({ code: 'STUDIO_STATE_INVALID' })

    await subject.capture({ id: 'source-recover', graph: original, runId: 'external-run-b', run: runWithId('external-run-b', 'unknown') })
    const recovered = await subject.observeSourceRun('session-a', 'source-recover', runWithId('external-run-b', 'completed', '已恢复产物'))
    expect(recovered.run?.status).toBe('completed')
    expect(recovered.run?.output).toBe('已恢复产物')
  })

  test('rejects an unknown durable namespace version instead of guessing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'solar-studio-version-'))
    roots.push(root)
    await mkdir(join(root, 'sources', 'session-a', 'source-a'), { recursive: true })
    await writeFile(join(root, 'sources', 'session-a', 'source-a', '0.json'), JSON.stringify({ formatVersion: 2, revision: 0, source: {} }))
    await expect(new StudioStore(root).readSource('session-a', 'source-a')).rejects.toMatchObject({ code: 'STUDIO_STATE_VERSION' })

    await mkdir(join(root, 'sources', 'session-a', 'source-b'), { recursive: true })
    await writeFile(join(root, 'sources', 'session-a', 'source-b', '0.json'), '{ not-json')
    await expect(new StudioStore(root).readSource('session-a', 'source-b')).rejects.toMatchObject({ code: 'STUDIO_STATE_INVALID' })
  })
})
