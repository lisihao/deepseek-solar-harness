import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import type { StudioGraph, StudioRun } from '../src/studio-contract.js'
import { STUDIO_LIMITS, StudioValidationError, assertRunnableStudioGraph, parseStudioGraph, validateStudioGraph } from '../src/studio-validation.js'
import { StudioStore } from '../src/studio-store.js'

function graph(overrides: Partial<StudioGraph> = {}): StudioGraph {
  return {
    formatVersion: 1,
    id: 'flow-a',
    sessionId: 'session-a',
    providerId: 'native',
    title: '流程 A',
    nodes: [{ id: 'one', label: '第一步', kind: 'native', prompt: '完成第一步', parameters: {}, metadata: {}, position: { x: 0, y: 0 } }],
    edges: [],
    parameters: {},
    metadata: {},
    ...overrides,
  }
}

function run(status: StudioRun['status'], output?: string, message?: string): StudioRun {
  const timestamp = '2026-10-20T00:00:00.000Z'
  return {
    id: 'external-run-a',
    sessionId: 'session-a',
    providerId: 'native',
    status,
    nodes: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(output === undefined ? {} : { output }),
    ...(message === undefined ? {} : { message }),
  }
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function store(): Promise<StudioStore> {
  const root = await mkdtemp(join(tmpdir(), 'solar-studio-validation-'))
  roots.push(root)
  return new StudioStore(root)
}

describe('workflow graph browser-safe validation', () => {
  test('accepts a bounded JSON graph and rejects non-finite layout coordinates', () => {
    expect(parseStudioGraph(graph()).nodes[0]?.position).toEqual({ x: 0, y: 0 })
    expect(() => parseStudioGraph(graph({ nodes: [{ id: 'one', label: '第一步', kind: 'native', prompt: 'x', parameters: {}, metadata: {}, position: { x: Number.NaN, y: 0 } }] }))).toThrow('有限数值')
  })

  test('reports dangling, self, duplicate, and cyclic edges before run admission', () => {
    const cyclic = graph({
      nodes: [
        { id: 'one', label: '第一步', kind: 'native', prompt: '一', parameters: {}, metadata: {}, position: { x: 0, y: 0 } },
        { id: 'two', label: '第二步', kind: 'native', prompt: '二', parameters: {}, metadata: {}, position: { x: 1, y: 0 } },
      ],
      edges: [
        { id: 'edge-one', source: 'one', target: 'two' },
        { id: 'edge-two', source: 'two', target: 'one' },
        { id: 'self', source: 'one', target: 'one' },
        { id: 'missing', source: 'one', target: 'gone' },
      ],
    })
    const messages = validateStudioGraph(cyclic, { sessionId: 'session-a', forRun: true }).map((issue) => issue.message).join('\n')
    expect(messages).toContain('依赖环')
    expect(messages).toContain('节点自身')
    expect(messages).toContain('不存在的节点')
    expect(() => assertRunnableStudioGraph(cyclic, { sessionId: 'session-a' })).toThrow('尚不能运行')

    const edited = { ...cyclic, edges: [{ id: 'edge-one', source: 'one', target: 'two' }] }
    expect(validateStudioGraph(edited, { sessionId: 'session-a', forRun: true })).toEqual([])
  })

  test('keeps empty/cyclic graphs representable as drafts while refusing them at run time', () => {
    const empty = graph({ nodes: [] })
    expect(parseStudioGraph(empty).nodes).toEqual([])
    expect(validateStudioGraph(empty, { forRun: true })[0]?.message).toContain('至少需要一个节点')
    expect(() => assertRunnableStudioGraph(empty)).toThrow('至少需要一个节点')
  })

  test('rejects duplicate node identities, foreign sessions, oversized prompts, and non-JSON metadata', () => {
    expect(() => parseStudioGraph(graph({ nodes: [
      { id: 'same', label: 'A', kind: 'native', prompt: 'a', parameters: {}, metadata: {}, position: { x: 0, y: 0 } },
      { id: 'same', label: 'B', kind: 'native', prompt: 'b', parameters: {}, metadata: {}, position: { x: 1, y: 0 } },
    ] }))).toThrow('重复')
    expect(validateStudioGraph(graph(), { sessionId: 'another-session' })[0]?.message).toContain('不属于当前会话')
    expect(() => parseStudioGraph(graph({ nodes: [{ id: 'one', label: 'A', kind: 'native', prompt: 'x'.repeat(STUDIO_LIMITS.maxPromptCharacters + 1), parameters: {}, metadata: {}, position: { x: 0, y: 0 } }] }))).toThrow(StudioValidationError)
    expect(() => parseStudioGraph(graph({ metadata: { invalid: undefined } as never }))).toThrow('JSON')
  })

  test('accepts a real Web source graph with a 127 KiB prompt and duplicated context metadata', async () => {
    const subject = await store()
    const context = 'w'.repeat(127 * 1024)
    const value = graph({
      id: 'web-source-flow',
      providerId: 'web',
      parameters: { context },
      metadata: { context },
      nodes: [{
        id: 'web-node',
        label: '网页阶段',
        kind: 'chatgpt-web',
        prompt: context,
        parameters: { context },
        metadata: { context },
        position: { x: 0, y: 0 },
      }],
    })

    const captured = await subject.capture({ id: 'web-source', graph: value })
    expect(captured.graph.nodes[0]?.prompt).toBe(context)
    expect(captured.graph.parameters.context).toBe(context)
    expect(captured.graph.metadata.context).toBe(context)
    expect((await subject.readSource('session-a', 'web-source'))?.graph.nodes[0]?.prompt).toBe(context)
  })

  test('accepts a 2 MiB run report and message exactly, then rejects values above reachable limits', async () => {
    const subject = await store()
    const report = 'markdown\n'.repeat(Math.floor((2 * 1024 * 1024) / 9)).concat('x'.repeat((2 * 1024 * 1024) % 9))
    expect(report.length).toBe(2 * 1024 * 1024)
    const captured = await subject.capture({
      id: 'large-source',
      graph: graph(),
      runId: 'external-run-a',
      run: run('completed', report, report),
    })
    expect(captured.run?.output).toBe(report)
    expect(captured.run?.message).toBe(report)
    const reopened = await subject.readSource('session-a', 'large-source')
    expect(reopened?.run?.output).toBe(report)
    expect(reopened?.run?.message).toBe(report)

    const oversizedOutput = 'o'.repeat(STUDIO_LIMITS.maxOutputCharacters + 1)
    await expect(subject.capture({
      id: 'oversized-output',
      graph: graph(),
      runId: 'external-run-output-too-large',
      run: { ...run('completed'), id: 'external-run-output-too-large', output: oversizedOutput },
    })).rejects.toMatchObject({ code: 'STUDIO_STATE_INVALID' })

    const oversizedMessage = 'm'.repeat(STUDIO_LIMITS.maxMessageCharacters + 1)
    await expect(subject.capture({
      id: 'oversized-message',
      graph: graph(),
      runId: 'external-run-message-too-large',
      run: { ...run('completed'), id: 'external-run-message-too-large', message: oversizedMessage },
    })).rejects.toMatchObject({ code: 'STUDIO_STATE_INVALID' })
  })
})
