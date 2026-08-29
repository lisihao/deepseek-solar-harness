import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collaborationPolicyLabel,
  controlOrchestration,
  eventDetail,
  executionPreferenceLabel,
  plannerVerifierPreferenceLabel,
  GraphView,
  loadOrchestrationDashboard,
} from '../src/client/OrchestrationsPanel.tsx'
import { controlRlmAgents, loadRlmAgentsDashboard } from '../src/client/RlmAgentsView.tsx'
import { formatLocalTimestamp } from '../src/client/timestamp.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('orchestration Desktop panel transport', () => {
  it('renders canonical timestamps in the browser-selected zone', () => {
    expect(formatLocalTimestamp(
      '2026-08-16T23:18:28.617Z',
      '2026-08-17T01:05:03.000Z',
      'America/Toronto',
    )).toEqual({
      absolute: '今天 19:18:28 GMT-4',
      relative: '1 小时 46 分钟前',
    })
  })

  it('loads a selected run from the same-origin bounded projection', async () => {
    const dashboard = { generatedAt: '2026-08-18T00:00:00.000Z', runs: [], diagnosticRunCount: 0, diagnosticsIncluded: true, selectedRunId: 'run-1', events: [] }
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify(dashboard), { status: 200 })
    ))
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3080' } })
    vi.stubGlobal('fetch', fetch)

    await expect(loadOrchestrationDashboard('run-1')).resolves.toEqual(dashboard)
    const url = fetch.mock.calls[0]?.[0]
    expect(url).toBeInstanceOf(URL)
    if (!(url instanceof URL)) throw new Error('dashboard request must use URL')
    expect(url.href).toBe('http://127.0.0.1:3080/api/orchestrations?run_id=run-1&include_diagnostics=1')
  })

  it('can hide acceptance runs without deleting their persisted count', async () => {
    const dashboard = { generatedAt: '2026-08-18T00:00:00.000Z', runs: [], diagnosticRunCount: 8, diagnosticsIncluded: false }
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify(dashboard), { status: 200 })
    ))
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3080' } })
    vi.stubGlobal('fetch', fetch)

    await expect(loadOrchestrationDashboard(undefined, undefined, false)).resolves.toEqual(dashboard)
    const url = fetch.mock.calls[0]?.[0]
    expect(url).toBeInstanceOf(URL)
    if (!(url instanceof URL)) throw new Error('dashboard request must use URL')
    expect(url.href).toBe('http://127.0.0.1:3080/api/orchestrations?include_diagnostics=0')
  })

  it('sends revision-checked controls with the trusted local header', async () => {
    const run = { runId: 'run-1', revision: 4 }
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify(run), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetch)

    await expect(controlOrchestration({
      commandId: 'command-pause-1',
      action: 'pause',
      runId: 'run-1',
      expectedRevision: 3,
      reason: 'test',
    })).resolves.toEqual(run)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/orchestrations')
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('POST')
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-DSH-Orchestration-Control': '1',
    })
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ commandId: 'command-pause-1', action: 'pause', runId: 'run-1', expectedRevision: 3, reason: 'test' }))
  })

  it('uses the versioned RLM Agents projection and never puts a lease in the browser request', async () => {
    const dashboard = {
      version: 1,
      generatedAt: '2026-08-28T00:00:00.000Z',
      sessions: [],
      selectedSessionId: 'rlm:root',
      messages: [],
    }
    const receipt = {
      version: 1,
      action: 'attach',
      sessionId: 'rlm:root',
      attachment: 'attached',
      eventCursor: 3,
    }
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      new Response(JSON.stringify(init?.method === 'POST' ? receipt : dashboard), { status: 200 })
    ))
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3080' } })
    vi.stubGlobal('fetch', fetch)

    await expect(loadRlmAgentsDashboard('rlm:root')).resolves.toEqual(dashboard)
    const readUrl = fetch.mock.calls[0]?.[0]
    expect(readUrl).toBeInstanceOf(URL)
    if (!(readUrl instanceof URL)) throw new Error('RLM Agents request must use URL')
    expect(readUrl.href).toBe('http://127.0.0.1:3080/api/orchestrations/rlm-agents?session_id=rlm%3Aroot')

    const intent = { version: 1 as const, action: 'attach' as const, commandId: 'attach-1', sessionId: 'rlm:root' }
    await expect(controlRlmAgents(intent)).resolves.toEqual(receipt)
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/orchestrations/rlm-agents')
    expect(fetch.mock.calls[1]?.[1]?.method).toBe('POST')
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual({
      'Content-Type': 'application/json',
      'X-DSH-Orchestration-Control': '1',
    })
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify(intent))
    expect(fetch.mock.calls[1]?.[1]?.body).not.toContain('lease')
  })

  it('renders the persisted Luna-first adaptive execution route', () => {
    const markup = renderToStaticMarkup(createElement(GraphView, {
      run: {
        runId: 'run-1',
        title: 'Adaptive execution',
        workspace: '/tmp/workspace',
        state: 'running',
        revision: 1,
        graphRevision: 1,
        admission: {
          policy: 'codex',
          route: 'taskgraph',
          sourceSessionId: 'source-1',
          plannerVerifierPreference: 'codex-sol',
          executionPreference: 'luna-first',
        },
        certificate: {
          certificateSha256: 'a'.repeat(64),
          graphSha256: 'b'.repeat(64),
          maximumRisk: 'low',
          requiresApproval: false,
        },
        nodes: [],
        blockers: [],
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
      },
      events: [],
      browserRequest: async () => new Response(),
      controlPending: false,
      onControl: async () => {},
    }))
    expect(markup).toContain('低风险首轮 Luna，失败/中高风险升级 Terra · Codex Sol 规划验证')
    expect(executionPreferenceLabel('luna-first')).toBe('低风险首轮 Luna，失败/中高风险升级 Terra')
    expect(executionPreferenceLabel('claude-sonnet')).toBe('Claude Sonnet 优先执行')
    expect(plannerVerifierPreferenceLabel('claude-frontier')).toBe('Claude Opus/Fable 规划验证')
  })

  it('makes every collaboration preference and worker dispatch visible in Trace', () => {
    expect(['auto', 'direct', 'codex', 'claude-code'].map(policy => collaborationPolicyLabel(policy as 'auto')))
      .toEqual(['智能协作', '仅主模型', '优先 Codex', '优先 Claude Code'])
    expect(eventDetail({
      sequence: 1,
      runId: 'run-1',
      type: 'run.started',
      time: '2026-08-20T00:00:00.000Z',
      data: { admission: { policy: 'codex' }, maxParallel: 4 },
    })).toBe('优先 Codex · 并行上限 4')
    expect(eventDetail({
      sequence: 2,
      runId: 'run-1',
      type: 'capsule.resolved',
      time: '2026-08-20T00:00:01.000Z',
      data: { cleanContext: true },
    })).toBe('Clean-task Context Capsule 已注入')
    expect(eventDetail({
      sequence: 3,
      runId: 'run-1',
      type: 'node.dispatched',
      time: '2026-08-20T00:00:02.000Z',
      data: { operatorId: 'codex', contextIsolation: 'fresh-native-thread', laneId: 'orch:run:node:1' },
    })).toBe('codex · fresh-native-thread · lane 1')
    expect(eventDetail({
      sequence: 31,
      runId: 'run-1',
      type: 'execution_plan.sealed',
      time: '2026-08-20T00:00:02.000Z',
      data: { ref: 'sha256:plan1234567890', taskContractRef: 'sha256:contract1234567890' },
    })).toBe('Task Contract contract12 · Plan plan123456')
    expect(eventDetail({
      sequence: 4,
      runId: 'run-1',
      type: 'model.allocated',
      time: '2026-08-20T00:00:02.000Z',
      data: { operatorId: 'codex', model: 'gpt-5.6-luna', tier: 'low', source: 'native-subscription', quotaPoolId: 'codex-standard' },
    })).toBe('codex · gpt-5.6-luna · 低阶 · 订阅套餐 · 配额池 codex-standard')
    expect(eventDetail({
      sequence: 5,
      runId: 'run-1',
      type: 'rlm.worker.allocated',
      time: '2026-08-20T00:00:02.000Z',
      data: { operatorId: 'codex', model: 'gpt-5.6-luna', tier: 'low', source: 'native-subscription' },
    })).toBe('codex · gpt-5.6-luna · 低阶 · 订阅套餐')
    expect(eventDetail({
      sequence: 6,
      runId: 'run-1',
      type: 'rlm.execution.settled',
      time: '2026-08-20T00:00:02.000Z',
      data: { childCount: 2, stateRevision: 5, stopReason: 'completed' },
    })).toBe('2 个直接子 Agent · state rev 5 · completed')
    expect(eventDetail({
      sequence: 61,
      runId: 'run-1',
      type: 'rlm.child.dispatched',
      time: '2026-08-20T00:00:02.000Z',
      data: { depth: 1, name: 'reviewer', operatorId: 'codex', model: 'gpt-5.6-luna' },
    })).toBe('深度 1 · reviewer · codex/gpt-5.6-luna')
    expect(eventDetail({
      sequence: 62,
      runId: 'run-1',
      type: 'rlm.message.continuation.settled',
      time: '2026-08-20T00:00:02.000Z',
      data: { artifactRef: 'sha256:message123456789', stopReason: 'completed' },
    })).toBe('Agent 消息已续接 · Artifact message123 · completed')
    expect(eventDetail({
      sequence: 7,
      runId: 'run-1',
      type: 'scheduler.waiting.updated',
      time: '2026-08-20T00:00:02.000Z',
      data: { activeWorkers: 1, maxParallel: 2, waiting: [{ nodeId: 'review', code: 'SCOPE_CONFLICT' }] },
    })).toBe('review：读写或 effect 冲突，串行执行')
    expect(eventDetail({
      sequence: 8,
      runId: 'run-1',
      type: 'node.operator.progress',
      time: '2026-08-20T00:00:03.000Z',
      data: { operatorId: 'claude-code', phase: 'tool_activity' },
    })).toBe('claude-code · 正在使用工具')
    expect(eventDetail({
      sequence: 9,
      runId: 'run-1',
      type: 'node.evidence.accepted',
      time: '2026-08-20T00:00:04.000Z',
      data: {
        operatorId: 'codex',
        stopReason: 'completed',
        evidenceRef: 'sha256:12345678901234567890',
        outputPreview: 'implemented and tested',
        outputTruncated: false,
      },
    })).toBe('codex · completed · Evidence 1234567890\nimplemented and tested')
  })
})
