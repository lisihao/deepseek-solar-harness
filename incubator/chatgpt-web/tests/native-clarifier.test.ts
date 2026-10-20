import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GraphSnapshot, ResidentApi, TaskGraph } from '@lisihao/dsh-solar-native-resident/contracts'

import { createNativeClarifier, type NativeClarifierOptions } from '../src/native-clarifier.js'
import type { StudioClarifyPortRequest, StudioExternalPortRequest } from '../src/studio-provider.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-native-clarifier-'))
  roots.push(value)
  return value
}

function request(overrides: Partial<StudioClarifyPortRequest> = {}): StudioClarifyPortRequest {
  return {
    runId: 'run-clarifier',
    sessionId: 'session-clarifier',
    nodeId: 'node-clarifier',
    nodeKind: 'clarify',
    phase: 'clarify',
    stage: 'clarify',
    round: 1,
    commandId: 'stage-command-clarifier',
    resource: { provider: 'codex', id: 'resource-clarifier' },
    requested: { provider: 'codex', modelId: 'gpt-codex-exact', modelLabel: 'Codex display', effortLabel: 'high' },
    template: { formatVersion: 1, id: 'template', version: '1', text: 'template', hash: 'hash' },
    renderedInput: '完整 rendered input\n包含之前阶段的全部内容。',
    assets: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

function snapshot(graph: TaskGraph, status: GraphSnapshot['status'], output?: string, error?: { readonly code: string; readonly message: string }): GraphSnapshot {
  const node = graph.nodes[0]
  if (!node) throw new Error('fixture graph is missing its node')
  const nodeStatus = status === 'completed' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : status === 'indeterminate' ? 'indeterminate' : status === 'failed' ? 'failed' : 'running'
  return {
    formatVersion: 1,
    graph,
    status,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    nodes: [{
      id: node.id,
      status: nodeStatus,
      attempt: status === 'queued' ? 0 : 1,
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
    }],
  }
}

function fakeResident(initial: 'complete' | 'running' | 'failed' = 'complete', output = '{"brief":"完整简报","questions":[]}') {
  const submitted: Array<Parameters<ResidentApi['submit']>[0]> = []
  const graphs = new Map<string, GraphSnapshot>()
  const inspect = vi.fn(async (graphId: string) => {
    const value = graphs.get(graphId)
    if (value === undefined) throw new Error(`missing graph ${graphId}`)
    return value
  })
  const submit = vi.fn(async (input: Parameters<ResidentApi['submit']>[0]) => {
    submitted.push(input)
    const graphStatus = initial === 'complete' ? 'completed' : initial
    const value = initial === 'failed'
      ? snapshot(input.graph, graphStatus, undefined, { code: 'DRIVER_ERROR', message: 'Codex failed before producing clarification.' })
      : snapshot(input.graph, graphStatus, initial === 'complete' ? output : undefined)
    graphs.set(input.graph.id, value)
    return value
  })
  const control = vi.fn(async () => { throw new Error('control must not be called') })
  return {
    submitted,
    graphs,
    inspect,
    submit,
    control,
    api: { protocolVersion: 1, submit, inspect, control } as unknown as ResidentApi,
  }
}

function options(rootPath: string, resident: ResidentApi, overrides: Partial<NativeClarifierOptions> = {}): NativeClarifierOptions {
  return { root: rootPath, resident: () => resident, waitMs: 20, pollMs: 1, ...overrides }
}

describe('native Codex clarification binding', () => {
  it('submits one stable graph with the exact profile, full prompt, strict protocol and preserved multi-question output', async () => {
    const rootPath = await root()
    const fake = fakeResident('complete', '```json\n{"brief":"完整简报","questions":[{"id":"scope","text":"需要确认范围吗？"},{"id":"deadline","text":"需要确认截止时间吗？"}]}\n```')
    const log: Array<{ readonly sessionId: string; readonly text: string }> = []
    const clarifier = createNativeClarifier(options(rootPath, fake.api, {
      logRequest: async (sessionId, text) => { log.push({ sessionId, text }) },
    }))

    const result = await clarifier.clarify(request())
    expect(result).toMatchObject({
      kind: 'complete',
      resource: { provider: 'codex', id: 'resource-clarifier' },
      observed: { availability: 'not-exposed' },
      clarification: {
        brief: '完整简报',
        questions: [
          { id: 'scope', text: '需要确认范围吗？' },
          { id: 'deadline', text: '需要确认截止时间吗？' },
        ],
      },
    })
    expect(result.kind === 'complete' ? result.artifact.text : '').toContain('"deadline"')
    expect(fake.submitted).toHaveLength(1)
    const submitted = fake.submitted[0]
    if (!submitted) throw new Error('submission was not captured')
    expect(submitted.commandId).toMatch(/^native-clarifier-submit-[a-f0-9]{64}$/)
    expect(submitted.graph.id).toMatch(/^native-clarifier-graph-[a-f0-9]{64}$/)
    expect(submitted.graph.cwd).toBe(join(rootPath, 'clarifier-workspace'))
    expect(submitted.graph.bridgeId).toBeUndefined()
    expect(submitted.graph.nodes).toEqual([expect.objectContaining({
      executor: 'codex',
      profile: { model: 'gpt-codex-exact', reasoningEffort: 'high' },
      scope: { read: [], write: [] },
    })])
    const prompt = submitted.graph.nodes[0]?.prompt ?? ''
    expect(prompt.startsWith('完整 rendered input\n包含之前阶段的全部内容。')).toBe(true)
    expect(prompt).toContain('Return exactly one JSON object with exactly these fields:')
    expect(prompt).toContain('Do not read or write files, run commands')
    expect(prompt).toContain('scope is a declaration only')
    expect(log).toEqual([{ sessionId: 'session-clarifier', text: prompt }])
    await access(join(rootPath, 'clarifier-workspace'))
    expect(result.kind === 'complete' ? result.resource.remoteId : undefined).toBe(submitted.graph.id)
  })

  it('does not submit twice for the same command and uses only inspect after a restart', async () => {
    const rootPath = await root()
    const fake = fakeResident()
    const first = createNativeClarifier(options(rootPath, fake.api))
    const firstRequest = request({ commandId: 'stable-command' })
    const firstResult = await first.clarify(firstRequest)
    const graphId = firstResult.resource.remoteId
    expect(graphId).toBeDefined()
    await first.clarify(firstRequest)
    expect(fake.submit).toHaveBeenCalledTimes(1)

    const restarted = createNativeClarifier(options(rootPath, fake.api))
    const observed = await restarted.observe({
      ...firstRequest,
      resource: { ...firstRequest.resource, remoteId: graphId },
      phase: 'clarify',
    } as StudioExternalPortRequest)
    expect(observed.kind).toBe('complete')
    expect(fake.submit).toHaveBeenCalledTimes(1)
    expect(fake.inspect).toHaveBeenCalledWith(graphId)
  })

  it('returns strict parse failures as settled failures and keeps known Resident failures out of quota handling', async () => {
    const rootPath = await root()
    const malformed = fakeResident('complete', '{"brief":"ok","questions":[{"id":"dup","text":"one"},{"id":"dup","text":"two"}]}')
    const malformedResult = await createNativeClarifier(options(rootPath, malformed.api)).clarify(request({ commandId: 'malformed-command' }))
    expect(malformedResult).toMatchObject({ kind: 'failed', code: 'NATIVE_CLARIFIER_OUTPUT_INVALID', certainty: 'settled' })
    expect(malformed.submit).toHaveBeenCalledTimes(1)

    const failedResident = fakeResident('failed')
    const failedResult = await createNativeClarifier(options(rootPath, failedResident.api)).clarify(request({ commandId: 'known-failed-command' }))
    expect(failedResult).toMatchObject({ kind: 'failed', code: 'DRIVER_ERROR', certainty: 'settled' })
    expect(failedResult.kind).not.toBe('quota-exhausted')
  })

  it('stops only the local wait on abort, never calls Resident control, and requires an explicit model id', async () => {
    const rootPath = await root()
    const fake = fakeResident('running')
    const controller = new AbortController()
    const pending = createNativeClarifier(options(rootPath, fake.api, { waitMs: 1_000, pollMs: 50 })).clarify(request({ signal: controller.signal }))
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort()
    await expect(pending).resolves.toMatchObject({ kind: 'unknown' })
    expect(fake.control).not.toHaveBeenCalled()

    const missingModel = await createNativeClarifier(options(rootPath, fake.api)).clarify(request({ commandId: 'missing-model', requested: { provider: 'codex', modelLabel: 'Codex display' } }))
    expect(missingModel).toMatchObject({ kind: 'failed', code: 'NATIVE_CLARIFIER_REQUEST_INVALID', certainty: 'no-active-effect' })
    expect(fake.submit).toHaveBeenCalledTimes(1)
  })
})
