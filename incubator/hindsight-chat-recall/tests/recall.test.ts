import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ChatRecallError,
  SOURCE,
  createChatRecall,
  evidenceMessage,
  MAX_QUERY_CHARACTERS,
  type ChatMessage,
  type RecallAgent,
  type RecallConfig,
  type RecallServices,
} from '../src/recall.js'

let cwd: string

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-hindsight-chat-recall-'))
})

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true })
})

function config(overrides: Partial<RecallConfig> = {}): RecallConfig {
  return { timeoutMs: 1000, resultLimit: 2, maxContextCharacters: 12000, ...overrides }
}

function agent(options: { cwd?: string; origin?: string } = {}): RecallAgent {
  const header: RecallAgent['session']['header'] = {}
  const currentCwd = Object.prototype.hasOwnProperty.call(options, 'cwd') ? options.cwd : cwd
  if (currentCwd !== undefined) header.cwd = currentCwd
  if (options.origin !== undefined) header.origin = options.origin
  return { id: 'agent-1', session: { header } }
}

function textMessage(text: string, sourceKind = 'user'): ChatMessage {
  return {
    id: `message-${sourceKind}`,
    role: sourceKind === 'user' ? 'user' : 'tool',
    source: { kind: sourceKind },
    content: [{ type: 'text', text }],
  }
}

function activeDirectory() {
  return {
    ok: true,
    value: {
      items: [{ active: true, providerEnabled: true, provider: { id: 'hindsight' } }],
    },
  }
}

function envelope(value: unknown) {
  return { ok: true, value }
}

function result(id: string, content: string, fields: Record<string, unknown> = {}) {
  return { id, content, memoryProviderId: 'hindsight', ...fields }
}

function searchEnvelope(results: readonly Record<string, unknown>[]) {
  return envelope({ results })
}

function evidenceOf(message: ChatMessage | undefined): Record<string, unknown>[] {
  expect(message).toBeDefined()
  expect(message?.source).toEqual({ kind: SOURCE, form: 'recall' })
  const block = message?.content[0]
  expect(block).toMatchObject({ type: 'text' })
  const text = (block as { type: string; text: string }).text
  const start = text.indexOf('{"formatVersion":')
  const end = text.indexOf('\n</solar_hindsight_recall>', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return (JSON.parse(text.slice(start, end)) as { evidence: Record<string, unknown>[] }).evidence
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test condition did not become true in time')
    await new Promise<void>(resolve => setTimeout(resolve, 1))
  }
}

describe('createChatRecall', () => {
  it('counts escaped JSON and emoji within the complete evidence budget', () => {
    const message = evidenceMessage({ results: [result('escaped', '\\"\n🧭'.repeat(1000))] }, config({ maxContextCharacters: 1000 }))
    const text = (message!.content[0] as { text: string }).text
    expect(text.length).toBeLessThanOrEqual(1000)
    const evidence = evidenceOf(message)
    expect(evidence[0]?.contentTruncated).toBe(true)
    expect(String(evidence[0]?.content)).not.toMatch(/[\uD800-\uDBFF]$/u)
  })

  it('bounds the latest query without changing the original user message', async () => {
    let query: unknown
    const message = textMessage('old '.repeat(1000) + '🧭'.repeat(1200) + ' latest topic')
    const before = JSON.stringify(message)
    const services: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async (operation, payload) => {
        if (operation === 'body-directory') return activeDirectory()
        query = payload.query
        return searchEnvelope([])
      },
    }
    await createChatRecall(services, config(), new AbortController().signal)(agent(), [message], new AbortController().signal)
    expect(String(query).length).toBeLessThanOrEqual(MAX_QUERY_CHARACTERS)
    expect(String(query)).toMatch(/latest topic$/)
    expect(String(query)).not.toMatch(/^[\uDC00-\uDFFF]/u)
    expect(JSON.stringify(message)).toBe(before)
  })
  it('reads fresh results for changed and repeated user topics', async () => {
    const queries: unknown[] = []
    let searchCount = 0
    const services: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async (operation, payload) => {
        if (operation === 'body-directory') return activeDirectory()
        queries.push(payload.query)
        searchCount += 1
        return searchEnvelope([result(`result-${searchCount}`, `fresh-result-${searchCount}`, { score: searchCount / 10 })])
      },
    }
    const recall = createChatRecall(services, config(), new AbortController().signal)

    const first = await recall(agent(), [textMessage('topic one')], new AbortController().signal)
    const second = await recall(agent(), [textMessage('topic two')], new AbortController().signal)
    const repeated = await recall(agent(), [textMessage('topic two')], new AbortController().signal)

    expect(queries).toEqual(['topic one', 'topic two', 'topic two'])
    expect(evidenceOf(first)[0]).toMatchObject({ id: 'result-1', content: 'fresh-result-1' })
    expect(evidenceOf(second)[0]).toMatchObject({ id: 'result-2', content: 'fresh-result-2' })
    expect(evidenceOf(repeated)[0]).toMatchObject({ id: 'result-3', content: 'fresh-result-3' })
  })

  it('does not read for tool-only input, subagents, or an agent without cwd', async () => {
    let reads = 0
    const services: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async () => {
        reads += 1
        return activeDirectory()
      },
    }
    const recall = createChatRecall(services, config(), new AbortController().signal)

    await expect(recall(agent(), [textMessage('tool continuation', 'tool')], new AbortController().signal)).resolves.toBeUndefined()
    await expect(recall(agent({ origin: 'subagent' }), [textMessage('subagent question')], new AbortController().signal)).resolves.toBeUndefined()
    await expect(recall(agent({ cwd: undefined }), [textMessage('no workspace question')], new AbortController().signal)).resolves.toBeUndefined()
    expect(reads).toBe(0)
  })

  it('does not search when the current workspace has no active Hindsight provider', async () => {
    const operations: string[] = []
    const services: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async operation => {
        operations.push(operation)
        return operation === 'body-directory'
          ? envelope({ items: [{ active: true, providerEnabled: true, provider: { id: 'native' } }] })
          : searchEnvelope([result('must-not-search', 'must not search')])
      },
    }
    const recall = createChatRecall(services, config(), new AbortController().signal)

    await expect(recall(agent(), [textMessage('question')], new AbortController().signal)).resolves.toBeUndefined()
    expect(operations).toEqual(['body-directory'])
  })

  it('fails clearly for missing or ambiguous workspaces and for retrieval errors', async () => {
    const workspaceCases: Array<{ name: string; workspaces: RecallServices['workspaces'] }> = [
      { name: 'missing', workspaces: () => [] },
      {
        name: 'ambiguous',
        workspaces: () => [
          { id: 'workspace-a', path: cwd },
          { id: 'workspace-b', path: cwd },
        ],
      },
    ]
    for (const current of workspaceCases) {
      const services: RecallServices = { workspaces: current.workspaces, read: async () => activeDirectory() }
      const recall = createChatRecall(services, config(), new AbortController().signal)
      await expect(recall(agent(), [textMessage(current.name)], new AbortController().signal))
        .rejects.toMatchObject({ name: 'ChatRecallError', message: /工作区未唯一登记/ })
    }

    const bodyFailure: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async () => ({ ok: false, error: { message: 'memory service unavailable' } }),
    }
    const bodyRecall = createChatRecall(bodyFailure, config(), new AbortController().signal)
    await expect(bodyRecall(agent(), [textMessage('body failure')], new AbortController().signal))
      .rejects.toMatchObject({ name: 'ChatRecallError', message: 'memory service unavailable' })

    const searchFailure: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async operation => {
        if (operation === 'body-directory') return activeDirectory()
        throw new Error('search service unavailable')
      },
    }
    const searchRecall = createChatRecall(searchFailure, config(), new AbortController().signal)
    await expect(searchRecall(agent(), [textMessage('search failure')], new AbortController().signal))
      .rejects.toThrow('search service unavailable')
  })

  it('injects only Hindsight results, preserves source fields, and does not fabricate usage or score', async () => {
    const services: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async operation => operation === 'body-directory'
        ? activeDirectory()
        : searchEnvelope([
          { id: 'native-1', content: 'native result', memoryProviderId: 'native', score: 0.99 },
          result('hindsight-1', 'kept result', { score: 0.71, source: { kind: 'memory', origin: 'hindsight' }, usage: { tokens: 12 } }),
          result('hindsight-2', 'no score result', { source: 'memory-body', usage: { tokens: 99 } }),
        ]),
    }
    const recall = createChatRecall(services, config({ resultLimit: 2 }), new AbortController().signal)

    const message = await recall(agent(), [textMessage('question')], new AbortController().signal)
    const evidence = evidenceOf(message)
    expect(evidence).toHaveLength(2)
    expect(evidence.map(item => item.id)).toEqual(['hindsight-1', 'hindsight-2'])
    expect(evidence[0]).toMatchObject({
      id: 'hindsight-1',
      content: 'kept result',
      score: 0.71,
      source: { kind: 'memory', origin: 'hindsight' },
    })
    expect(evidence[0]).not.toHaveProperty('usage')
    expect(evidence[1]).not.toHaveProperty('score')
    expect(evidence[1]).not.toHaveProperty('usage')
  })

  it('bounds the number and total content of injected results', async () => {
    const services: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async operation => operation === 'body-directory'
        ? activeDirectory()
        : searchEnvelope([
          result('result-1', 'a'.repeat(600)),
          result('result-2', 'b'.repeat(600)),
          result('result-3', 'c'.repeat(600)),
          result('result-4', 'd'.repeat(600)),
        ]),
    }
    const recall = createChatRecall(services, config({ resultLimit: 3, maxContextCharacters: 1000 }), new AbortController().signal)

    const message = await recall(agent(), [textMessage('question')], new AbortController().signal)
    const evidence = evidenceOf(message)
    expect(evidence.length).toBeLessThanOrEqual(3)
    expect((message!.content[0] as { text: string }).text.length).toBeLessThanOrEqual(1000)
    expect(evidence.some(item => item.contentTruncated === true)).toBe(true)
  })

  it('rejects on timeout even when the service ignores abort, and ignores the late result', async () => {
    let searchStarted = false
    let searchSignal: AbortSignal | undefined
    let resolveSearch!: (value: unknown) => void
    const lateSearch = new Promise<unknown>(resolve => { resolveSearch = resolve })
    const services: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async (operation, _payload, signal) => {
        if (operation === 'body-directory') return activeDirectory()
        searchStarted = true
        searchSignal = signal
        return lateSearch
      },
    }
    const recall = createChatRecall(services, config({ timeoutMs: 20 }), new AbortController().signal)
    const pending = recall(agent(), [textMessage('slow question')], new AbortController().signal)
    await waitFor(() => searchStarted)
    const started = Date.now()
    const outcome = await pending.then(
      () => ({ status: 'resolved' as const }),
      error => ({ status: 'rejected' as const, error }),
    )
    expect(Date.now() - started).toBeLessThan(250)
    expect(outcome.status).toBe('rejected')
    expect(outcome.status === 'rejected' ? outcome.error : undefined).toBeInstanceOf(ChatRecallError)
    expect(outcome.status === 'rejected' ? outcome.error.message : '').toMatch(/超时/)
    expect(searchSignal?.aborted).toBe(true)

    resolveSearch(searchEnvelope([result('late', 'late result')]))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(outcome.status).toBe('rejected')
  })

  it('rejects with the caller cancellation reason and aborts the read', async () => {
    let searchStarted = false
    let searchSignal: AbortSignal | undefined
    let resolveSearch!: (value: unknown) => void
    const pendingSearch = new Promise<unknown>(resolve => { resolveSearch = resolve })
    const services: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async (operation, _payload, signal) => {
        if (operation === 'body-directory') return activeDirectory()
        searchStarted = true
        searchSignal = signal
        return pendingSearch
      },
    }
    const caller = new AbortController()
    const reason = new Error('caller cancelled')
    const recall = createChatRecall(services, config(), new AbortController().signal)
    const pending = recall(agent(), [textMessage('cancel question')], caller.signal)
    await waitFor(() => searchStarted)
    caller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(searchSignal?.aborted).toBe(true)
    resolveSearch(searchEnvelope([]))
  })

  it('rejects with the lifetime cancellation reason when the plugin is disposed', async () => {
    let searchStarted = false
    let searchSignal: AbortSignal | undefined
    let resolveSearch!: (value: unknown) => void
    const pendingSearch = new Promise<unknown>(resolve => { resolveSearch = resolve })
    const services: RecallServices = {
      workspaces: () => [{ id: 'workspace-1', path: cwd }],
      read: async (operation, _payload, signal) => {
        if (operation === 'body-directory') return activeDirectory()
        searchStarted = true
        searchSignal = signal
        return pendingSearch
      },
    }
    const lifetime = new AbortController()
    const reason = new Error('plugin disposed')
    const recall = createChatRecall(services, config(), lifetime.signal)
    const pending = recall(agent(), [textMessage('dispose question')], new AbortController().signal)
    await waitFor(() => searchStarted)
    lifetime.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(searchSignal?.aborted).toBe(true)
    resolveSearch(searchEnvelope([]))
  })
})
