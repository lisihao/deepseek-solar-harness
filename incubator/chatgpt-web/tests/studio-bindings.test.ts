import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GeminiPort, GeminiPortOptions, GeminiPortRequest, GeminiSemanticSelectors } from '../src/gemini-port.js'
import type { NativeClarifier, NativeClarifierOptions } from '../src/native-clarifier.js'
import type { WebRunRecord, WebRunRequest } from '../src/store.js'
import {
  createStudioBoundPorts,
  type StudioBoundPortsFactories,
  type StudioWebControllerFactoryInput,
} from '../src/studio-bindings.js'
import {
  versionedTemplate,
  type InsightStageOutcome,
} from '../src/insight-contract.js'
import type {
  StudioClarifyPortRequest,
  StudioExternalPortRequest,
} from '../src/studio-provider.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-studio-bindings-'))
  roots.push(directory)
  return directory
}

const signal = (): AbortSignal => new AbortController().signal

function external(overrides: Partial<StudioExternalPortRequest> = {}): StudioExternalPortRequest {
  return {
    runId: randomUUID(),
    sessionId: 'session-studio',
    nodeId: 'node-web',
    nodeKind: 'chatgpt-web',
    phase: 'web',
    commandId: 'studio:command:web:1',
    resource: { provider: 'chatgpt', id: 'studio:command:web:1' },
    requested: { provider: 'chatgpt', modelLabel: 'GPT-6', effortLabel: 'high' },
    template: versionedTemplate('web', '1', 'Answer exactly.'),
    renderedInput: '完整 Markdown 输入。\n\n请保留这段文字。',
    assets: [],
    signal: signal(),
    ...overrides,
  }
}

function clarify(overrides: Partial<StudioClarifyPortRequest> = {}): StudioClarifyPortRequest {
  return {
    runId: randomUUID(),
    sessionId: 'session-clarify',
    nodeId: 'clarifier',
    nodeKind: 'clarify',
    phase: 'clarify',
    stage: 'clarify',
    round: 1,
    commandId: 'studio:command:clarify:1',
    resource: { provider: 'codex', id: 'studio:command:clarify:1' },
    requested: { provider: 'codex', modelId: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol' },
    template: versionedTemplate('clarify', '1', 'Clarify exactly.'),
    renderedInput: '需要澄清的完整输入。',
    assets: [],
    signal: signal(),
    ...overrides,
  }
}

function completeRecord(id: string, request: WebRunRequest, overrides: Partial<WebRunRecord> = {}): WebRunRecord {
  return {
    formatVersion: 1,
    id,
    revision: 2,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:01.000Z',
    request,
    stage: 'completed',
    resource: { spaceId: 71, pageLabel: 'p2', conversationUrl: 'https://chatgpt.com/c/studio-test' },
    observed: { modelLabel: request.modelLabel, effortLabel: request.effortLabel, webSearchActive: request.webSearch },
    output: {
      text: '完整可见答复 https://example.test/source',
      markdown: '# 完整可见答复\n\n[来源](https://example.test/source)',
    },
    ...overrides,
  }
}

class FakeController {
  readonly read = vi.fn(async (_id: string): Promise<WebRunRecord | undefined> => undefined)
  readonly start = vi.fn(async (id: string, request: WebRunRequest): Promise<WebRunRecord> => completeRecord(id, request))
  readonly observe = vi.fn(async (id: string): Promise<WebRunRecord> => completeRecord(id, { prompt: 'unused', modelLabel: 'GPT-6', effortLabel: 'high', webSearch: false }))
  readonly dispose = vi.fn(async (): Promise<void> => undefined)
}

function baseOptions(rootValue: string, factories: StudioBoundPortsFactories) {
  const logRequest = vi.fn(async (_sessionId: string, _text: string): Promise<void> => undefined)
  return {
    root: rootValue,
    executable: '/usr/local/bin/ego-browser',
    commandTimeoutMs: 1_000,
    runTimeoutMs: 2_000,
    pollMs: 0,
    maxOutputBytes: 64 * 1024,
    resident: () => ({}) as never,
    logRequest,
    askQuestions: vi.fn(async () => ({ kind: 'pending' as const })),
    confirmPlan: vi.fn(async () => ({ kind: 'pending' as const })),
    factories,
  }
}

describe('Studio provider bindings', () => {
  it('submits the exact rendered ChatGPT request once with the requested model, effort, and semantic webpage search', async () => {
    const rootValue = await root()
    const flow = { forRun: vi.fn(async () => 71), finish: vi.fn(async () => undefined) }
    const controllers: Array<{ readonly input: StudioWebControllerFactoryInput; readonly controller: FakeController }> = []
    const factories: StudioBoundPortsFactories = {
      createFlowSpaces: () => flow,
      createWebController: input => {
        const controller = new FakeController()
        controllers.push({ input, controller })
        return controller
      },
    }
    const options = baseOptions(rootValue, factories)
    const ports = createStudioBoundPorts(options)
    const request = external({
      nodeKind: 'chatgpt-search',
      phase: 'search',
      commandId: 'studio:search:exact-selection',
      resource: { provider: 'chatgpt', id: 'studio:search:exact-selection' },
      requested: { provider: 'chatgpt', modelLabel: 'GPT-6 Astra Pro', effortLabel: 'xhigh', modeLabel: 'Web search and analysis' },
    })

    const result = await ports.execute(request)

    expect(result).toMatchObject({
      kind: 'complete',
      artifact: {
        text: '# 完整可见答复\n\n[来源](https://example.test/source)',
        provenance: { citations: ['https://example.test/source'] },
      },
      observed: { modelLabel: 'GPT-6 Astra Pro', effortLabel: 'xhigh', modeLabel: 'Web search and analysis' },
    })
    expect(flow.forRun).toHaveBeenCalledWith(request.runId, expect.any(AbortSignal))
    const execution = controllers.find(({ input }) => input.createPage)
    expect(execution?.input).toMatchObject({
      root: expect.stringMatching(/external-web\/[0-9a-f-]{36}$/),
      spaceId: 71,
      createPage: true,
      retainSpace: true,
    })
    expect(execution?.controller.start).toHaveBeenCalledWith(
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      {
        prompt: request.renderedInput,
        modelLabel: 'GPT-6 Astra Pro',
        effortLabel: 'xhigh',
        webSearch: true,
      },
      expect.any(AbortSignal),
    )
    expect(options.logRequest).toHaveBeenCalledWith(request.sessionId, expect.stringContaining(request.renderedInput))
    expect(options.logRequest.mock.calls[0]?.[1]).toContain('"modelLabel":"GPT-6 Astra Pro"')

    await ports.finished(request.runId, request.sessionId)
    await ports.finished(request.runId, request.sessionId)
    expect(flow.finish).toHaveBeenCalledTimes(1)
  })

  it.each(['gemini-research', 'gemini-thinking'] as const)('routes the %s search fallback through the exact ChatGPT webpage-search boundary', async nodeKind => {
    const rootValue = await root()
    const flow = { forRun: vi.fn(async () => 71), finish: vi.fn(async () => undefined) }
    const controller = new FakeController()
    const ports = createStudioBoundPorts(baseOptions(rootValue, {
      createFlowSpaces: () => flow,
      createWebController: () => controller,
    }))
    const request = external({
      nodeKind,
      phase: 'search',
      commandId: `studio:${nodeKind}:fallback-search`,
      resource: { provider: 'chatgpt', id: `studio:${nodeKind}:fallback-search` },
      requested: { provider: 'chatgpt', modelLabel: 'GPT-6 Astra Pro', effortLabel: 'high', modeLabel: 'Web search and analysis' },
    })

    await expect(ports.execute(request)).resolves.toMatchObject({ kind: 'complete' })

    expect(controller.start).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        prompt: request.renderedInput,
        modelLabel: 'GPT-6 Astra Pro',
        effortLabel: 'high',
        webSearch: true,
      }),
      expect.any(AbortSignal),
    )
  })

  it('observes an existing ChatGPT receipt without allocating a TaskSpace or starting a replacement request', async () => {
    const rootValue = await root()
    const flow = { forRun: vi.fn(async () => 71), finish: vi.fn(async () => undefined) }
    const controllers: FakeController[] = []
    const factories: StudioBoundPortsFactories = {
      createFlowSpaces: () => flow,
      createWebController: () => {
        const controller = new FakeController()
        controllers.push(controller)
        return controller
      },
    }
    const options = baseOptions(rootValue, factories)
    const ports = createStudioBoundPorts(options)
    const request = external({ commandId: 'studio:observe:only', resource: { provider: 'chatgpt', id: 'studio:observe:only' } })

    const result = await ports.observe(request)

    expect(result.kind).toBe('complete')
    expect(flow.forRun).not.toHaveBeenCalled()
    expect(controllers).toHaveLength(1)
    expect(controllers[0]?.start).not.toHaveBeenCalled()
    expect(controllers[0]?.observe).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal))
    expect(options.logRequest).not.toHaveBeenCalled()
  })

  it.each([
    ['blocked', 'failed', 'no-active-effect'],
    ['failed', 'failed', 'settled'],
    ['indeterminate', 'unknown', undefined],
  ] as const)('maps a %s controller receipt without retrying it', async (stage, expectedKind, certainty) => {
    const rootValue = await root()
    const flow = { forRun: vi.fn(async () => 71), finish: vi.fn(async () => undefined) }
    const factories: StudioBoundPortsFactories = {
      createFlowSpaces: () => flow,
      createWebController: () => {
        const controller = new FakeController()
        controller.start.mockImplementation(async (id, request) => completeRecord(id, request, {
          stage,
          error: { code: `WEB_${stage.toUpperCase()}`, message: `known ${stage}` },
          output: undefined,
        }))
        return controller
      },
    }
    const ports = createStudioBoundPorts(baseOptions(rootValue, factories))
    const request = external({ commandId: `studio:${stage}:mapping`, resource: { provider: 'chatgpt', id: `studio:${stage}:mapping` } })

    const result = await ports.execute(request)

    expect(result.kind).toBe(expectedKind)
    if (result.kind === 'failed') expect(result.certainty).toBe(certainty)
    if (result.kind === 'unknown') expect(result.reason).toContain(`WEB_${stage.toUpperCase()}`)
  })

  it('uses the original native clarifier for clarify and clarification observation, preserving its exact model id', async () => {
    const rootValue = await root()
    const nativeClarify = vi.fn(async (request: StudioClarifyPortRequest): Promise<InsightStageOutcome> => ({
        kind: 'complete',
        resource: request.resource,
        observed: { availability: 'not-exposed' },
        artifact: { text: 'raw', provenance: { provider: 'codex', source: 'fake', visibleEvidence: [], citations: [], limitations: [] } },
        clarification: { brief: 'brief', questions: [] },
      }))
    const nativeObserve = vi.fn(async (request: StudioExternalPortRequest): Promise<InsightStageOutcome> => ({
        kind: 'unknown',
        resource: request.resource,
        reason: 'original resident graph remains running',
      }))
    const clarifyPort: NativeClarifier = {
      clarify: nativeClarify,
      observe: nativeObserve,
    }
    const nativeOptions: NativeClarifierOptions[] = []
    const ports = createStudioBoundPorts(baseOptions(rootValue, {
      createNativeClarifier: options => {
        nativeOptions.push(options)
        return clarifyPort
      },
      createFlowSpaces: () => ({ forRun: vi.fn(), finish: vi.fn() }),
    }))
    const request = clarify()

    await expect(ports.clarify(request)).resolves.toMatchObject({ kind: 'complete' })
    const observation = external({
      runId: request.runId,
      sessionId: request.sessionId,
      nodeId: request.nodeId,
      nodeKind: 'clarify',
      phase: 'clarify',
      commandId: request.commandId,
      resource: request.resource,
      requested: request.requested,
      template: request.template,
      renderedInput: request.renderedInput,
      assets: [],
    })
    await expect(ports.observe(observation)).resolves.toMatchObject({ kind: 'unknown' })

    expect(nativeClarify.mock.calls[0]?.[0].requested.modelId).toBe('gpt-6.1-sol')
    expect(clarifyPort.observe).toHaveBeenCalledTimes(1)
    expect(nativeOptions).toHaveLength(1)
  })

  it('snapshots Gemini selectors once per Studio run and does not read global selectors again during observation', async () => {
    const rootValue = await root()
    const semantics: GeminiSemanticSelectors = { submitSelector: '#submit', promptReceiptSelector: '#receipt', planReadyMarker: '#plan' }
    const semanticsForRun = vi.fn(async () => semantics)
    const waitMsForRun = vi.fn(async () => 3_600_000)
    const geminiOptions: GeminiPortOptions[] = []
    const geminiPort: GeminiPort = {
      execute: vi.fn(async (request: GeminiPortRequest): Promise<InsightStageOutcome> => ({
        kind: 'complete',
        resource: request.resource,
        observed: { availability: 'observed', modelLabel: request.requested.modelLabel, modeLabel: request.requested.modeLabel },
        artifact: { text: '# plan', provenance: { provider: 'gemini', source: 'fake', visibleEvidence: [], citations: [], limitations: [] } },
      })),
      observe: vi.fn(async (request: GeminiPortRequest): Promise<InsightStageOutcome> => ({ kind: 'unknown', resource: request.resource, reason: 'original page only' })),
    }
    const ports = createStudioBoundPorts({
      ...baseOptions(rootValue, {
        createGeminiPort: options => {
          geminiOptions.push(options)
          return geminiPort
        },
        createFlowSpaces: () => ({ forRun: vi.fn(async () => 71), finish: vi.fn() }),
      }),
      semanticsForRun,
      waitMsForRun,
    })
    const request = external({
      nodeId: 'research',
      nodeKind: 'gemini-research',
      phase: 'plan',
      commandId: 'studio:gemini:plan',
      resource: { provider: 'gemini', id: 'studio:gemini:plan' },
      requested: { provider: 'gemini', modelLabel: '4 Argon', modeLabel: 'Deep Research' },
    })

    await ports.execute(request)
    await ports.observe(request)

    expect(semanticsForRun).toHaveBeenCalledTimes(1)
    expect(waitMsForRun).toHaveBeenCalledTimes(1)
    expect(geminiOptions).toHaveLength(1)
    expect(geminiOptions[0]?.semantics).toEqual(semantics)
    expect(geminiOptions[0]?.waitMs).toBe(3_600_000)
    expect(geminiPort.observe).toHaveBeenCalledTimes(1)
  })

  it('rejects an oversized Web input before logging, TaskSpace allocation, or a controller start', async () => {
    const rootValue = await root()
    const flow = { forRun: vi.fn(async () => 71), finish: vi.fn(async () => undefined) }
    const controller = new FakeController()
    const options = baseOptions(rootValue, {
      createFlowSpaces: () => flow,
      createWebController: () => controller,
    })
    const ports = createStudioBoundPorts(options)
    const request = external({ renderedInput: 'x'.repeat(128 * 1024 + 1) })

    await expect(ports.execute(request)).resolves.toMatchObject({
      kind: 'failed',
      code: 'WEB_RENDERED_INPUT_TOO_LARGE',
      certainty: 'no-active-effect',
    })
    expect(options.logRequest).not.toHaveBeenCalled()
    expect(flow.forRun).not.toHaveBeenCalled()
    expect(controller.start).not.toHaveBeenCalled()
  })

  it('stops only local waits on disposal and refuses later observation without closing the shared TaskSpace', async () => {
    const rootValue = await root()
    const flow = { forRun: vi.fn(async () => 71), finish: vi.fn(async () => undefined) }
    const controller = new FakeController()
    const ports = createStudioBoundPorts(baseOptions(rootValue, {
      createFlowSpaces: () => flow,
      createWebController: () => controller,
    }))

    await ports.observe(external({ commandId: 'studio:dispose:first', resource: { provider: 'chatgpt', id: 'studio:dispose:first' } }))
    ports.dispose()
    await expect(ports.observe(external({ commandId: 'studio:dispose:second', resource: { provider: 'chatgpt', id: 'studio:dispose:second' } }))).resolves.toMatchObject({
      kind: 'failed',
      code: 'STUDIO_BINDING_DISPOSED',
      certainty: 'no-active-effect',
    })
    expect(controller.dispose).toHaveBeenCalledTimes(1)
    expect(flow.finish).not.toHaveBeenCalled()
  })
})
