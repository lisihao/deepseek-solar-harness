import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  collaborationPolicyLabel,
  controlOrchestration,
  eventDetail,
  loadOrchestrationDashboard,
} from '../src/client/OrchestrationsPanel.tsx'

afterEach(() => { vi.unstubAllGlobals() })

describe('orchestration Desktop panel transport', () => {
  it('loads a selected run from the same-origin bounded projection', async () => {
    const dashboard = { generatedAt: '2026-08-18T00:00:00.000Z', runs: [], selectedRunId: 'run-1', events: [] }
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify(dashboard), { status: 200 })
    ))
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3080' } })
    vi.stubGlobal('fetch', fetch)

    await expect(loadOrchestrationDashboard('run-1')).resolves.toEqual(dashboard)
    const url = fetch.mock.calls[0]?.[0]
    expect(String(url)).toBe('http://127.0.0.1:3080/api/orchestrations?run_id=run-1')
  })

  it('sends revision-checked controls with the trusted local header', async () => {
    const run = { runId: 'run-1', revision: 4 }
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(JSON.stringify(run), { status: 200 })
    ))
    vi.stubGlobal('fetch', fetch)

    await expect(controlOrchestration({
      action: 'pause',
      runId: 'run-1',
      expectedRevision: 3,
      reason: 'test',
    })).resolves.toEqual(run)
    expect(fetch).toHaveBeenCalledWith('/api/orchestrations', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-DSH-Orchestration-Control': '1' }),
      body: JSON.stringify({ action: 'pause', runId: 'run-1', expectedRevision: 3, reason: 'test' }),
    }))
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
  })
})
