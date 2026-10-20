import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  defaultInsightConfig,
  versionedTemplate,
  type InsightStageOutcome,
} from '../src/insight-contract.js'
import {
  buildInsightStudioGraph,
  buildWebStudioGraph,
  createInsightStudioProvider,
  createWebStudioProvider,
  type StudioBoundPorts,
  type StudioExternalPortRequest,
} from '../src/studio-provider.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-studio-provider-'))
  roots.push(directory)
  return directory
}

function webConfig() {
  return {
    requested: { provider: 'chatgpt' as const, modelLabel: 'ChatGPT Web' },
    template: versionedTemplate('web', '1', 'Reply to the ordinary conversation without web search.'),
  }
}

function completion(request: Pick<StudioExternalPortRequest, 'resource' | 'requested'>, text: string, clarification?: { readonly brief?: string; readonly questions: readonly { readonly id: string; readonly text: string }[] }): InsightStageOutcome {
  return {
    kind: 'complete',
    resource: { ...request.resource, remoteId: `remote:${request.resource.id}` },
    observed: { availability: 'not-exposed' },
    artifact: {
      text,
      provenance: {
        provider: request.requested.provider,
        source: `${request.requested.provider} visible result`,
        visibleEvidence: ['visible status'],
        citations: ['https://example.test/source'],
        limitations: ['No hidden chain of thought retained.'],
      },
    },
    ...(clarification === undefined ? {} : { clarification }),
  }
}

function ports(overrides: Partial<StudioBoundPorts> = {}): StudioBoundPorts {
  return {
    async clarify(request) {
      return completion(request, 'clarifier raw', { brief: '完整研究简报：42 [1] https://example.test/source', questions: [] })
    },
    async askQuestions() {
      return { kind: 'pending' }
    },
    async confirmPlan() {
      return { kind: 'confirmed' }
    },
    async execute(request) {
      return completion(request, `${request.nodeKind}/${request.phase}: 42 [1] https://example.test/source`)
    },
    async observe(request) {
      return completion(request, `observed ${request.nodeKind}/${request.phase}: 42 [1] https://example.test/source`)
    },
    ...overrides,
  }
}

describe('editable Studio Web/Insight providers', () => {
  it('captures an edited/reordered/deleted Insight graph exactly and labels omitted stages', async () => {
    const stateRoot = await root()
    const base = buildInsightStudioGraph({
      sessionId: 'session-a',
      context: '完整上下文，不应被截断。',
      question: '比较方案 A 和 B。',
      config: defaultInsightConfig(),
    })
    const clarify = base.nodes.find((node) => node.kind === 'clarify')
    const output = base.nodes.find((node) => node.kind === 'output')
    if (!clarify || !output) throw new Error('default graph fixture is invalid')
    const completeReport = '完整简报：42 [1] https://example.test/source\n\n- 保留引用：https://example.test/source#evidence'
    const outputLayout = '# 本地交付标题\n\n{report}\n\n> 本地排版尾注'
    expect(output.prompt).toBe('{report}')
    const edited = {
      ...base,
      title: 'edited graph',
      nodes: [
        { ...output, prompt: outputLayout, metadata: { ...output.metadata, editorNote: 'kept exactly' } },
        { ...clarify, prompt: 'Edited clarification prompt', metadata: { ...clarify.metadata, edited: true } },
      ],
      edges: [{ id: 'clarify-to-output', source: clarify.id, target: output.id }],
    }
    const received: StudioExternalPortRequest[] = []
    let finished = 0
    const provider = createInsightStudioProvider({
      root: stateRoot,
      ports: ports({
        clarify: async (request) => {
          expect(request.renderedInput).toContain('Edited clarification prompt')
          return completion(request, 'clarifier raw', { brief: completeReport, questions: [] })
        },
        execute: async (request) => {
          received.push(request)
          return completion(request, 'must not execute deleted node')
        },
        finished: async () => { finished += 1 },
      }),
    })

    const run = await provider.execute({ commandId: randomUUID(), sessionId: 'session-a', graph: edited })

    expect(run.status).toBe('completed')
    expect(received).toHaveLength(0)
    expect(run.output).toContain('研究阶段已省略')
    expect(run.output).toContain('独立复核阶段已省略')
    expect(run.output).toContain('润色阶段已省略')
    expect(run.output).toContain('# 本地交付标题')
    expect(run.output).toContain(completeReport)
    expect(run.output).toContain('> 本地排版尾注')
    expect(run.output).toContain('## 流程说明')
    const stored = await provider.store.read('session-a', run.id)
    expect(stored?.graph.nodes.map((node) => node.id)).toEqual([output.id, clarify.id])
    expect(stored?.graph.nodes.find((node) => node.id === clarify.id)?.metadata).toMatchObject({ edited: true })
    expect(stored?.graph.nodes.find((node) => node.id === output.id)?.metadata).toMatchObject({ editorNote: 'kept exactly' })
    expect(finished).toBe(1)
    await provider.inspect('session-a', run.id)
    expect(finished).toBe(1)
  })

  it('does not resend an unknown ordinary Web effect; repeated execute only inspects and explicit resume observes it', async () => {
    const stateRoot = await root()
    const graph = buildWebStudioGraph({ sessionId: 'session-web', context: 'context', question: 'ordinary question', config: webConfig() })
    const executions: StudioExternalPortRequest[] = []
    const observations: StudioExternalPortRequest[] = []
    let resolveObservation = false
    const provider = createWebStudioProvider({
      root: stateRoot,
      ports: ports({
        execute: async (request) => {
          executions.push(request)
          return { kind: 'unknown', resource: { ...request.resource, remoteId: 'unknown-original' }, reason: 'network outcome is unknown' }
        },
        observe: async (request) => {
          observations.push(request)
          if (!resolveObservation) return { kind: 'unknown', resource: { ...request.resource }, reason: 'still unknown' }
          return {
            ...completion(request, 'observed ordinary answer: 42 [1] https://example.test/source'),
            resource: { ...request.resource },
          }
        },
      }),
    })
    const commandId = randomUUID()
    const first = await provider.execute({ commandId, sessionId: 'session-web', graph })
    expect(first.status).toBe('unknown')
    expect(executions).toHaveLength(1)
    expect(executions[0]?.nodeKind).toBe('chatgpt-web')
    expect(executions[0]?.phase).toBe('web')
    expect(executions[0]?.requested.modeLabel).toBeUndefined()

    const repeated = await provider.execute({ commandId, sessionId: 'session-web', graph })
    expect(repeated.status).toBe('unknown')
    expect(executions).toHaveLength(1)
    expect(observations).toHaveLength(1)
    expect(observations[0]?.resource.remoteId).toBe('unknown-original')

    resolveObservation = true
    const resumed = await provider.resume('session-web', commandId)
    expect(resumed.status).toBe('completed')
    expect(executions).toHaveLength(1)
    expect(observations).toHaveLength(2)
  })

  it('reruns a complete ordinary Web request verbatim and appends only JSON-bounded predecessor outputs', async () => {
    const stateRoot = await root()
    const completeRequest = 'r'.repeat(127 * 1024)
    const sourceConfig = {
      requested: { provider: 'chatgpt' as const, modelLabel: 'ChatGPT Web' },
      template: versionedTemplate('web-source', '1', completeRequest),
      parameters: { inputForm: 'complete-request' as const },
    }
    const captured = buildWebStudioGraph({
      sessionId: 'session-complete-request',
      context: 'frozen context remains in the captured graph',
      question: completeRequest,
      config: sourceConfig,
    })
    const source = captured.nodes[0]
    if (!source) throw new Error('default Web graph fixture is invalid')
    const dependentPrompt = 'Use only the complete predecessor output below.'
    const rerunGraph = {
      ...captured,
      nodes: [
        source,
        {
          ...source,
          id: 'chatgpt-web-dependent',
          label: 'Dependent Web node',
          prompt: dependentPrompt,
          parameters: { ...source.parameters, inputForm: 'complete-request' },
          position: { x: source.position.x + 260, y: source.position.y },
        },
      ],
      edges: [{ id: 'web-dependency', source: source.id, target: 'chatgpt-web-dependent' }],
    }
    const requests: StudioExternalPortRequest[] = []
    const upstream = '完整前驱输出：42 [1] https://example.test/source'
    const provider = createWebStudioProvider({
      root: stateRoot,
      ports: ports({
        execute: async (request) => {
          requests.push(request)
          return completion(request, request.nodeId === source.id ? upstream : 'dependent answer')
        },
      }),
    })

    const run = await provider.execute({ commandId: randomUUID(), sessionId: 'session-complete-request', graph: rerunGraph })

    expect(run.status).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.renderedInput).toBe(completeRequest)
    expect(Buffer.byteLength(requests[0]?.renderedInput ?? '', 'utf8')).toBe(127 * 1024)
    expect(requests[1]?.renderedInput).toBe(`${dependentPrompt}\n\n${JSON.stringify({ predecessorOutputs: [upstream] })}`)
    const stored = await provider.store.read('session-complete-request', run.id)
    expect(stored?.graph.metadata).toMatchObject({
      context: 'frozen context remains in the captured graph',
      question: completeRequest,
    })
    expect(stored?.graph.nodes[0]?.parameters.inputForm).toBe('complete-request')
    expect(stored?.artifacts[0]?.provenance).toMatchObject({
      provider: 'chatgpt',
      citations: ['https://example.test/source'],
    })
  })

  it('preserves every branch-terminal artifact in graph order without including intermediate history', async () => {
    const stateRoot = await root()
    const base = buildWebStudioGraph({ sessionId: 'session-branch-terminals', context: 'context', question: 'source prompt', config: webConfig() })
    const source = base.nodes[0]
    if (!source) throw new Error('default Web graph fixture is invalid')
    const branchB = { ...source, id: 'branch-b', label: 'Branch B', prompt: 'branch B prompt', position: { x: 340, y: 40 } }
    const branchA = { ...source, id: 'branch-a', label: 'Branch A', prompt: 'branch A prompt', position: { x: 340, y: 180 } }
    const graph = {
      ...base,
      nodes: [source, branchB, branchA],
      edges: [
        { id: 'source-to-b', source: source.id, target: branchB.id },
        { id: 'source-to-a', source: source.id, target: branchA.id },
      ],
    }
    const provider = createWebStudioProvider({
      root: stateRoot,
      ports: ports({
        execute: async (request) => completion(request, request.nodeId === source.id
          ? 'intermediate source history must not be final output'
          : request.nodeId === branchB.id ? 'branch B terminal report' : 'branch A terminal report'),
      }),
    })

    const run = await provider.execute({ commandId: randomUUID(), sessionId: 'session-branch-terminals', graph })

    expect(run.status).toBe('completed')
    expect(run.output).toContain('branch B terminal report')
    expect(run.output).toContain('branch A terminal report')
    expect(run.output).not.toContain('intermediate source history must not be final output')
    expect(run.output?.indexOf('branch B terminal report')).toBeLessThan(run.output?.indexOf('branch A terminal report') ?? -1)
    expect(run.output).toContain('## 流程说明')
  })

  it('uses only the remaining terminal artifact after an output node is deleted', async () => {
    const stateRoot = await root()
    const base = buildInsightStudioGraph({
      sessionId: 'session-deleted-output',
      context: 'context',
      question: 'question',
      config: defaultInsightConfig(),
    })
    const clarify = base.nodes.find((node) => node.kind === 'clarify')
    if (!clarify) throw new Error('default graph fixture is invalid')
    const graph = { ...base, nodes: [clarify], edges: [] }
    const provider = createInsightStudioProvider({
      root: stateRoot,
      ports: ports({
        clarify: async (request) => completion(request, 'intermediate clarification history', {
          brief: 'remaining terminal brief: 42 [1] https://example.test/source',
          questions: [],
        }),
      }),
    })

    const run = await provider.execute({ commandId: randomUUID(), sessionId: 'session-deleted-output', graph })

    expect(run.status).toBe('completed')
    expect(run.output).toContain('remaining terminal brief: 42 [1] https://example.test/source')
    expect(run.output).not.toContain('intermediate clarification history')
  })

  it('falls back only after a known Gemini research quota outcome and reuses the plan resource for research', async () => {
    const stateRoot = await root()
    const insightConfig = defaultInsightConfig()
    const graph = buildInsightStudioGraph({
      sessionId: 'session-insight',
      context: 'context',
      question: 'research question',
      config: insightConfig,
    })
    const graphResearchNode = graph.nodes.find((node) => node.kind === 'gemini-research')
    if (!graphResearchNode) throw new Error('default graph fixture is invalid')
    const editedResearchGraph = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === graphResearchNode.id ? { ...node, prompt: 'Edited main research template only.' } : node),
    }
    const external: StudioExternalPortRequest[] = []
    const provider = createInsightStudioProvider({
      root: stateRoot,
      ports: ports({
        execute: async (request) => {
          external.push(request)
          if (request.phase === 'plan') return completion(request, 'research plan')
          if (request.phase === 'research') {
            return {
              kind: 'quota-exhausted',
              resource: { ...request.resource },
              evidence: 'Gemini shows quota exhausted for research.',
              certainty: 'no-active-effect',
            }
          }
          if (request.phase === 'search') return completion(request, 'fallback report: 42 [1] https://example.test/source')
          if (request.phase === 'review') return completion(request, 'reviewed fallback: 42 [1] https://example.test/source')
          if (request.phase === 'thinking') return completion(request, 'polished fallback: 42 [1] https://example.test/source')
          throw new Error(`unexpected ${request.phase}`)
        },
      }),
    })

    const run = await provider.execute({ commandId: randomUUID(), sessionId: 'session-insight', graph: editedResearchGraph })

    expect(run.status).toBe('completed')
    const plan = external.find((request) => request.phase === 'plan')
    const research = external.find((request) => request.phase === 'research')
    const fallback = external.find((request) => request.phase === 'search')
    expect(plan).toBeDefined()
    expect(research?.commandId).not.toBe(plan?.commandId)
    const completedPlanResource = { ...plan?.resource, remoteId: `remote:${plan?.resource.id}` }
    expect(research?.resource).toEqual(completedPlanResource)
    expect(plan?.template.text).toBe(insightConfig.plan.template.text)
    expect(research?.template.text).toBe('Edited main research template only.')
    expect(fallback?.nodeKind).toBe('chatgpt-search')
    expect(fallback?.template.text).toBe(insightConfig.fallbackResearch.template.text)
    expect(fallback?.renderedInput).toContain('回落报告')
    expect(run.output).toContain('回落报告')
    expect(run.output).toContain('同一提供方复核')
    const stored = await provider.store.read('session-insight', run.id)
    const researchNode = stored?.nodes.find((node) => node.nodeId === 'gemini-research')
    expect(researchNode?.phases.find((phase) => phase.phase === 'research')?.sourceResource).toEqual(completedPlanResource)
    expect(stored?.artifacts.some((artifact) => artifact.provenance.fallback)).toBe(true)
    expect(stored?.artifacts.find((artifact) => artifact.provenance.fallback)?.provenance.citations).toEqual(['https://example.test/source'])
    expect(researchNode?.phases.find((phase) => phase.phase === 'plan')?.observed).toEqual({ availability: 'not-exposed' })
  })

  it('falls back from a known Gemini plan quota using the complete clarified brief without confirmation or Deep Research', async () => {
    const stateRoot = await root()
    const graph = buildInsightStudioGraph({
      sessionId: 'session-plan-quota',
      context: 'context',
      question: 'research question',
      config: defaultInsightConfig(),
    })
    const completeBrief = '完整澄清简报：42 [1] https://example.test/source\n\n- 证据：https://example.test/source#brief'
    const completeReport = '完整回落报告：42 [1] https://example.test/source\n\n- 引用：https://example.test/source#report'
    const external: StudioExternalPortRequest[] = []
    let confirmations = 0
    const provider = createInsightStudioProvider({
      root: stateRoot,
      ports: ports({
        clarify: async (request) => completion(request, 'clarifier raw', { brief: completeBrief, questions: [] }),
        confirmPlan: async () => {
          confirmations += 1
          throw new Error('a quota-exhausted plan must not ask for confirmation')
        },
        execute: async (request) => {
          external.push(request)
          if (request.phase === 'plan') {
            return {
              kind: 'quota-exhausted',
              resource: { ...request.resource },
              evidence: 'Gemini shows quota exhausted before a plan was admitted.',
              certainty: 'no-active-effect',
            }
          }
          if (request.phase === 'search') return completion(request, completeReport)
          if (request.phase === 'review') return completion(request, `${completeReport}\n\n已完成同一提供方复核。`)
          if (request.phase === 'thinking') return completion(request, `${completeReport}\n\n已完成文字润色。`)
          throw new Error(`unexpected ${request.phase}`)
        },
      }),
    })

    const run = await provider.execute({ commandId: randomUUID(), sessionId: 'session-plan-quota', graph })

    expect(run.status).toBe('completed')
    expect(confirmations).toBe(0)
    expect(external.map((request) => request.phase)).toEqual(['plan', 'search', 'review', 'thinking'])
    expect(external.some((request) => request.phase === 'research')).toBe(false)
    const fallback = external.find((request) => request.phase === 'search')
    expect(fallback?.nodeKind).toBe('chatgpt-search')
    expect(fallback?.renderedInput).toContain(completeBrief)
    expect(fallback?.renderedInput).toContain('回落报告')
    expect(run.output).toContain(completeReport)
    expect(run.output).toContain('回落报告')
    expect(run.output).toContain('同一提供方复核')
    const stored = await provider.store.read('session-plan-quota', run.id)
    const researchNode = stored?.nodes.find((node) => node.nodeId === 'gemini-research')
    expect(researchNode?.phases.map((phase) => phase.phase)).toEqual(['plan', 'search'])
    expect(researchNode?.phases[0]).toMatchObject({
      status: 'quota-exhausted',
      quotaEvidence: 'Gemini shows quota exhausted before a plan was admitted.',
    })
  })

  it('never starts a GPT fallback after an unknown Gemini research effect', async () => {
    const stateRoot = await root()
    const graph = buildInsightStudioGraph({
      sessionId: 'session-unknown-gemini',
      context: 'context',
      question: 'question',
      config: defaultInsightConfig(),
    })
    const external: StudioExternalPortRequest[] = []
    const provider = createInsightStudioProvider({
      root: stateRoot,
      ports: ports({
        execute: async (request) => {
          external.push(request)
          if (request.phase === 'plan') return completion(request, 'plan')
          if (request.phase === 'research') return { kind: 'unknown', resource: { ...request.resource, remoteId: 'pending-research' }, reason: 'network outcome is unknown' }
          throw new Error(`must not execute ${request.phase}`)
        },
        observe: async (request) => ({ kind: 'unknown', resource: { ...request.resource }, reason: 'still pending' }),
      }),
    })

    const run = await provider.execute({ commandId: randomUUID(), sessionId: 'session-unknown-gemini', graph })

    expect(run.status).toBe('unknown')
    expect(external.map((request) => request.phase)).toEqual(['plan', 'research'])
    expect(external.some((request) => request.phase === 'search')).toBe(false)
  })

  it('keeps a known Web preflight failure terminal instead of observing or replaying it', async () => {
    const stateRoot = await root()
    const graph = buildWebStudioGraph({ sessionId: 'session-known-failure', context: 'context', question: 'question', config: webConfig() })
    const external: StudioExternalPortRequest[] = []
    const observed: StudioExternalPortRequest[] = []
    const provider = createWebStudioProvider({
      root: stateRoot,
      ports: ports({
        execute: async (request) => {
          external.push(request)
          return {
            kind: 'failed',
            resource: { ...request.resource },
            code: 'WEB_MODEL_UNAVAILABLE',
            reason: 'The selected displayed model is unavailable before submission.',
            certainty: 'no-active-effect',
          }
        },
        observe: async (request) => {
          observed.push(request)
          throw new Error('known failure must not be observed')
        },
      }),
    })
    const commandId = randomUUID()

    const first = await provider.execute({ commandId, sessionId: 'session-known-failure', graph })
    const repeated = await provider.execute({ commandId, sessionId: 'session-known-failure', graph })
    const resumed = await provider.resume('session-known-failure', commandId)

    expect(first.status).toBe('failed')
    expect(repeated.status).toBe('failed')
    expect(resumed.status).toBe('failed')
    expect(external).toHaveLength(1)
    expect(observed).toHaveLength(0)
    const stored = await provider.store.read('session-known-failure', commandId)
    expect(stored?.nodes[0]?.phases[0]).toMatchObject({ status: 'failed', failureCode: 'WEB_MODEL_UNAVAILABLE' })
  })

  it('rejects a session mismatch before admitting a graph', async () => {
    const stateRoot = await root()
    const graph = buildWebStudioGraph({ sessionId: 'session-owned', context: 'context', question: 'question', config: webConfig() })
    const provider = createWebStudioProvider({ root: stateRoot, ports: ports() })

    await expect(provider.execute({ commandId: randomUUID(), sessionId: 'other-session', graph })).rejects.toMatchObject({ code: 'STUDIO_SESSION_MISMATCH' })
  })

  it('rejects empty, cyclic, and provider-incompatible edited graphs before any port call', async () => {
    const stateRoot = await root()
    const graph = buildWebStudioGraph({ sessionId: 'session-invalid', context: 'context', question: 'question', config: webConfig() })
    const provider = createWebStudioProvider({ root: stateRoot, ports: ports() })
    const empty = { ...graph, nodes: [], edges: [] }
    const incompatible = { ...graph, nodes: [{ ...graph.nodes[0]!, kind: 'clarify' as const }] }
    const first = graph.nodes[0]!
    const second = { ...first, id: 'chatgpt-web-second', label: 'Second Web node' }
    const cyclic = {
      ...graph,
      nodes: [first, second],
      edges: [
        { id: 'one', source: first.id, target: second.id },
        { id: 'two', source: second.id, target: first.id },
      ],
    }

    await expect(provider.execute({ commandId: randomUUID(), sessionId: 'session-invalid', graph: empty })).rejects.toMatchObject({ code: 'STUDIO_GRAPH_INVALID' })
    await expect(provider.execute({ commandId: randomUUID(), sessionId: 'session-invalid', graph: incompatible })).rejects.toMatchObject({ code: 'STUDIO_GRAPH_INVALID' })
    await expect(provider.execute({ commandId: randomUUID(), sessionId: 'session-invalid', graph: cyclic })).rejects.toMatchObject({ code: 'STUDIO_GRAPH_INVALID' })
  })

  it('rejects an output node with an outgoing edge before any port call', async () => {
    const stateRoot = await root()
    const graph = buildInsightStudioGraph({
      sessionId: 'session-output-not-sink',
      context: 'context',
      question: 'question',
      config: defaultInsightConfig(),
    })
    const output = graph.nodes.find((node) => node.kind === 'output')
    if (!output) throw new Error('default graph fixture is invalid')
    const afterOutput = { ...output, id: 'output-successor', label: 'Invalid output successor', position: { x: output.position.x + 180, y: output.position.y } }
    const invalid = {
      ...graph,
      nodes: [...graph.nodes, afterOutput],
      edges: [...graph.edges, { id: 'output-to-successor', source: output.id, target: afterOutput.id }],
    }
    let portCalls = 0
    const provider = createInsightStudioProvider({
      root: stateRoot,
      ports: ports({
        clarify: async () => {
          portCalls += 1
          throw new Error('invalid graph must not call a port')
        },
        execute: async () => {
          portCalls += 1
          throw new Error('invalid graph must not call a port')
        },
      }),
    })

    await expect(provider.validate(invalid)).resolves.toContainEqual({
      nodeId: output.id,
      field: 'edges',
      message: 'Output nodes must be DAG sinks',
    })
    await expect(provider.execute({ commandId: randomUUID(), sessionId: 'session-output-not-sink', graph: invalid })).rejects.toMatchObject({ code: 'STUDIO_GRAPH_INVALID' })
    expect(portCalls).toBe(0)
  })

  it('rejects an output layout that omits the literal report placeholder before any port call', async () => {
    const stateRoot = await root()
    const graph = buildInsightStudioGraph({
      sessionId: 'session-output-layout',
      context: 'context',
      question: 'question',
      config: defaultInsightConfig(),
    })
    const output = graph.nodes.find((node) => node.kind === 'output')
    if (!output) throw new Error('default graph fixture is invalid')
    const invalid = {
      ...graph,
      nodes: graph.nodes.map((node) => node.id === output.id ? { ...node, prompt: 'A caption without a report insertion.' } : node),
    }
    let portCalls = 0
    const provider = createInsightStudioProvider({
      root: stateRoot,
      ports: ports({
        clarify: async () => {
          portCalls += 1
          throw new Error('invalid graph must not call a port')
        },
        execute: async () => {
          portCalls += 1
          throw new Error('invalid graph must not call a port')
        },
      }),
    })

    await expect(provider.validate(invalid)).resolves.toContainEqual({
      nodeId: output.id,
      field: 'prompt',
      message: 'Output layout template must contain literal {report}',
    })
    await expect(provider.execute({ commandId: randomUUID(), sessionId: 'session-output-layout', graph: invalid })).rejects.toMatchObject({ code: 'STUDIO_GRAPH_INVALID' })
    expect(portCalls).toBe(0)
  })
})
