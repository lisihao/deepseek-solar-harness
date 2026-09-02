import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DebateTurnRequestV1 } from '@deepseek-ai/dsh-debate-local'
import {
  OrchestrationArtifactRef,
  OrchestrationRunId,
} from '@deepseek-ai/dsh-orchestration'
import type {
  OrchestrationCompilationV1,
  OrchestrationCompileRequest,
  OrchestrationExecutionEvidenceV1,
  OrchestrationRunSnapshot,
  OrchestrationStartRequest,
} from '@deepseek-ai/dsh-orchestration'
import { Config, DebateTaskGraphRoundExecutor, apply } from '../src/index.ts'
import type { DebateTaskGraphOrchestrations } from '../src/types.ts'

function turn(
  slotId: DebateTurnRequestV1['slotId'],
  role: DebateTurnRequestV1['role'],
  operatorId: string,
  model: string,
  fallbackOperatorIds?: readonly string[],
): DebateTurnRequestV1 {
  return {
    version: 1,
    runId: 'debate-1',
    workspace: '/workspace',
    round: 1,
    slotId,
    role,
    persona: {
      title: role,
      mandate: `perform ${role}`,
      stance: 'evidence-first',
      instructions: ['Return calibrated structured claims.'],
    },
    operatorId,
    ...(fallbackOperatorIds === undefined ? {} : { fallbackOperatorIds }),
    model,
    tier: role === 'decision-judge' ? 'high' : 'medium',
    source: 'native-subscription',
    phase: 'blind-independent',
    prompt: 'Choose the strongest supported option.',
    objective: 'Reach a bounded evidence-based decision.',
    sourceRefs: [{ version: 1, ref: 'artifact:brief', kind: 'artifact' }],
    execution: { version: 1, kind: 'taskgraph-node', runId: 'parent-run', nodeId: 'parent-node' },
    sourceSessionId: 'session-1',
    priorLedger: { version: 1, claims: [], coverage: 0, digest: 'sha256:empty' },
    priorDissent: [],
    priorUnresolved: [],
  }
}

const turns = [
  turn('constructive-proposer', 'constructive-proposer', 'codex', 'gpt-5.6-luna'),
  turn('skeptical-falsifier', 'skeptical-falsifier', 'claude-code', 'claude-sonnet-4-6', ['codex']),
  turn('decision-judge', 'decision-judge', 'codex', 'gpt-5.6-sol'),
]

function resultJson(slotId: string): string {
  return JSON.stringify({
    confidence: 0.9,
    outputPreview: `settled ${slotId}`,
    claims: [{
      version: 1,
      claimId: 'claim:decision',
      statement: 'The reversible option is preferred.',
      status: 'supported',
      severity: 'medium',
      confidence: 0.9,
      supportingSlotIds: [slotId],
      opposingSlotIds: [],
      evidenceRefs: [{ version: 1, ref: 'artifact:brief', kind: 'artifact' }],
    }],
    dissent: [],
    unresolved: [],
    evidenceRefs: [{ version: 1, ref: 'artifact:brief', kind: 'artifact' }],
  })
}

describe('Debate TaskGraph round adapter', () => {
  it('derives durable Debate state from the deployment DSH home', () => {
    const installed: unknown[] = []
    const ctx = {
      orchestrations: {},
      plugin(_plugin: unknown, config: unknown) { installed.push(config) },
    }

    apply(ctx as never, Config({ dshHome: '/tmp/dsh-debate-home' }))

    expect(installed).toEqual([
      expect.objectContaining({ root: join(resolve('/tmp/dsh-debate-home'), 'debates') }),
    ])
  })

  it('plans participants in parallel and fences the judge behind every participant', () => {
    const executor = new DebateTaskGraphRoundExecutor({} as DebateTaskGraphOrchestrations, { maxParallel: 4 })
    const plan = executor.plan({ version: 1, runId: 'debate-1', round: 1, turns, maxParallel: 4 })
    const proposer = plan.graph.nodes.find(node => node.id.endsWith('constructive-proposer'))
    const falsifier = plan.graph.nodes.find(node => node.id.endsWith('skeptical-falsifier'))
    const judge = plan.graph.nodes.find(node => node.id.endsWith('decision-judge'))

    expect(plan.graph.maxParallel).toBe(2)
    expect(proposer?.dependsOn).toEqual([])
    expect(falsifier?.dependsOn).toEqual([])
    expect(judge?.dependsOn).toEqual([proposer?.id, falsifier?.id])
    expect(plan.graph.nodes.every(node => node.rlm?.mode === 'disabled' && node.autonomous?.mode === 'disabled')).toBe(true)
    expect(plan.graph.nodes.map(node => node.operator)).toEqual([
      { preferredIds: ['codex'], profile: { model: 'gpt-5.6-luna' } },
      { preferredIds: ['claude-code'], fallbackIds: ['codex'], profile: { model: 'claude-sonnet-4-6' } },
      { preferredIds: ['codex'], profile: { model: 'gpt-5.6-sol' } },
    ])
  })

  it('uses one TaskGraph run, reads its Evidence, and preserves unknown account cost', async () => {
    const compileRequests: OrchestrationCompileRequest[] = []
    const startRequests: OrchestrationStartRequest[] = []
    const artifacts = new Map<string, unknown>()
    const refs = new Map(turns.map(entry => [entry.slotId, OrchestrationArtifactRef(`sha256:${entry.slotId}`)]))
    for (const entry of turns) {
      artifacts.set(String(refs.get(entry.slotId)), {
        version: 1,
        executionId: `execution:${entry.slotId}` as OrchestrationExecutionEvidenceV1['executionId'],
        stopReason: 'completed',
        output: [{ type: 'text', text: resultJson(entry.slotId) }],
        usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 },
      })
    }
    const snapshot = (): OrchestrationRunSnapshot => ({
      runId: OrchestrationRunId('taskgraph-run-1'),
      title: 'Debate',
      workspace: '/workspace',
      state: 'completed',
      revision: 4,
      graphRevision: 1,
      maxParallel: 2,
      effectiveParallelism: 2,
      certificate: {
        version: 1,
        graphSha256: 'graph',
        certificateSha256: 'certificate',
        nodeIds: turns.map(entry => `debate-r1-${entry.slotId}`),
        maximumRisk: 'low',
        requiresApproval: false,
        generatedAt: '2026-08-29T00:00:00.000Z',
      },
      nodes: turns.map(entry => ({
        id: `debate-r1-${entry.slotId}`,
        title: entry.slotId,
        role: `debate:${entry.role}`,
        dependsOn: entry.role === 'decision-judge'
          ? ['debate-r1-constructive-proposer', 'debate-r1-skeptical-falsifier']
          : [],
        state: 'passed',
        attempt: 1,
        capabilityGeneration: 1,
        operatorId: entry.slotId === 'skeptical-falsifier' ? 'codex' : entry.operatorId,
        model: entry.slotId === 'skeptical-falsifier' ? 'gpt-5.6-luna' : entry.model,
        ...(entry.slotId === 'skeptical-falsifier'
          ? { executionPlanRef: OrchestrationArtifactRef('sha256:plan:skeptical-falsifier') }
          : {}),
        evidenceRefs: [refs.get(entry.slotId)!],
        blockers: [],
        updatedAt: '2026-08-29T00:00:00.000Z',
      })),
      blockers: [],
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    })
    artifacts.set('sha256:plan:skeptical-falsifier', {
      allocationPlanRef: OrchestrationArtifactRef('sha256:allocation:skeptical-falsifier'),
      allocationPlan: {
        fallback: {
          fromOperatorId: 'claude-code',
          fromModel: 'claude-sonnet-4-6',
          reasonCode: 'AUTHENTICATION_UNQUALIFIED',
        },
      },
    })
    const orchestrations: DebateTaskGraphOrchestrations = {
      async compile(request) {
        compileRequests.push(request)
        return {
          version: 1,
          compilationId: 'cmp-1',
          intent: {} as OrchestrationCompilationV1['intent'],
          intentRef: OrchestrationArtifactRef('sha256:intent'),
          graphRef: OrchestrationArtifactRef('sha256:graph'),
          graph: request.graph,
          ...(request.admission === undefined ? {} : { admission: request.admission }),
          certificate: snapshot().certificate,
          requiresClarification: false,
          blockers: [],
        }
      },
      async start(request) { startRequests.push(request); return snapshot() },
      async inspect() { return snapshot() },
      async control() { return snapshot() },
      async readArtifact(ref) {
        const artifact = artifacts.get(String(ref))
        if (artifact === undefined) throw new Error(`missing ${String(ref)}`)
        return artifact
      },
    }
    const executor = new DebateTaskGraphRoundExecutor(orchestrations)
    const result = await executor.executeRound({ version: 1, runId: 'debate-1', round: 1, turns, maxParallel: 2 })

    expect(compileRequests).toHaveLength(1)
    expect(startRequests).toEqual([{ commandId: 'debate:debate-1:round:1', compilationId: 'cmp-1' }])
    expect(compileRequests[0]?.admission).toMatchObject({ rlm: 'disabled', autonomous: 'disabled', continualHarness: 'off' })
    expect(result.resultsBySlot['decision-judge']).toMatchObject({
      confidence: 0.9,
      outputRef: 'sha256:decision-judge',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2 },
    })
    expect(result.resultsBySlot['decision-judge']?.usage?.costUsd).toBeUndefined()
    expect(result.resultsBySlot['skeptical-falsifier']?.routing).toEqual({
      version: 1,
      requestedOperatorId: 'claude-code',
      requestedModel: 'claude-sonnet-4-6',
      actualOperatorId: 'codex',
      actualModel: 'gpt-5.6-luna',
      fallbackReasonCode: 'AUTHENTICATION_UNQUALIFIED',
      allocationPlanRef: 'sha256:allocation:skeptical-falsifier',
    })
  })

  it('keeps valid participant results when another Evidence, JSON, or usage payload is malformed', async () => {
    const refs = new Map(turns.map(entry => [entry.slotId, OrchestrationArtifactRef(`sha256:${entry.slotId}`)]))
    const artifacts = new Map<string, unknown>([
      [String(refs.get('constructive-proposer')), {
        version: 1,
        executionId: 'execution:constructive-proposer',
        stopReason: 'completed',
        output: [{ type: 'text', text: resultJson('constructive-proposer') }],
        usage: { inputTokens: 10, outputTokens: 5 },
      }],
      [String(refs.get('skeptical-falsifier')), {
        version: 1,
        executionId: 'execution:skeptical-falsifier',
        stopReason: 'completed',
        output: [{ type: 'text', text: '{not-json' }],
      }],
      [String(refs.get('decision-judge')), {
        version: 1,
        executionId: 'execution:decision-judge',
        stopReason: 'completed',
        output: [{ type: 'text', text: resultJson('decision-judge') }],
        usage: { inputTokens: -1, outputTokens: 5 },
      }],
    ])
    const run: OrchestrationRunSnapshot = {
      runId: OrchestrationRunId('taskgraph-run-malformed-evidence'),
      title: 'Malformed participant Evidence',
      workspace: '/workspace',
      state: 'completed',
      revision: 4,
      graphRevision: 1,
      maxParallel: 2,
      effectiveParallelism: 2,
      certificate: {
        version: 1,
        graphSha256: 'graph-malformed',
        certificateSha256: 'certificate-malformed',
        nodeIds: turns.map(entry => `debate-r1-${entry.slotId}`),
        maximumRisk: 'low',
        requiresApproval: false,
        generatedAt: '2026-08-29T00:00:00.000Z',
      },
      nodes: turns.map(entry => ({
        id: `debate-r1-${entry.slotId}`,
        title: entry.slotId,
        role: `debate:${entry.role}`,
        dependsOn: entry.role === 'decision-judge'
          ? ['debate-r1-constructive-proposer', 'debate-r1-skeptical-falsifier']
          : [],
        state: 'passed',
        attempt: 1,
        capabilityGeneration: 1,
        evidenceRefs: [refs.get(entry.slotId)!],
        blockers: [],
        updatedAt: '2026-08-29T00:00:00.000Z',
      })),
      blockers: [],
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    }
    const orchestrations: DebateTaskGraphOrchestrations = {
      async compile(request) { return { version: 1, compilationId: 'cmp-malformed', graph: request.graph } as OrchestrationCompilationV1 },
      async start() { return run },
      async inspect() { return run },
      async control() { return run },
      async readArtifact(ref) {
        const artifact = artifacts.get(String(ref))
        if (artifact === undefined) throw new Error(`missing artifact ${String(ref)}`)
        return artifact
      },
    }

    const result = await new DebateTaskGraphRoundExecutor(orchestrations).executeRound({
      version: 1, runId: 'debate-malformed-evidence', round: 1, turns, maxParallel: 2,
    })

    expect(result.resultsBySlot).toHaveProperty('constructive-proposer')
    expect(result.resultsBySlot).not.toHaveProperty('skeptical-falsifier')
    expect(result.resultsBySlot).not.toHaveProperty('decision-judge')
    expect(result.failuresBySlot).toMatchObject({
      'skeptical-falsifier': { state: 'failed', errorCode: 'DEBATE_INVALID' },
      'decision-judge': { state: 'failed', errorCode: 'DEBATE_INVALID' },
    })
    expect(result.failuresBySlot?.['skeptical-falsifier']?.blockers[0]?.message).toContain('invalid JSON')
    expect(result.failuresBySlot?.['decision-judge']?.blockers[0]?.message).toContain('usage is invalid')
  })

  it('preserves settled and blocked slot outcomes when the TaskGraph fails partially', async () => {
    const proposerRef = OrchestrationArtifactRef('sha256:constructive-proposer')
    const failedRun: OrchestrationRunSnapshot = {
      runId: OrchestrationRunId('taskgraph-run-partial'),
      title: 'Partial Debate failure',
      workspace: '/workspace',
      state: 'failed',
      revision: 4,
      graphRevision: 1,
      maxParallel: 2,
      effectiveParallelism: 2,
      certificate: {
        version: 1,
        graphSha256: 'graph-partial',
        certificateSha256: 'certificate-partial',
        nodeIds: turns.map(entry => `debate-r1-${entry.slotId}`),
        maximumRisk: 'low',
        requiresApproval: false,
        generatedAt: '2026-08-29T00:00:00.000Z',
      },
      nodes: [
        {
          id: 'debate-r1-constructive-proposer', title: 'constructive-proposer', role: 'debate:constructive-proposer',
          dependsOn: [], state: 'passed', attempt: 1, capabilityGeneration: 1,
          operatorId: 'codex', model: 'gpt-5.6-luna', evidenceRefs: [proposerRef], blockers: [],
          updatedAt: '2026-08-29T00:00:00.000Z',
        },
        {
          id: 'debate-r1-skeptical-falsifier', title: 'skeptical-falsifier', role: 'debate:skeptical-falsifier',
          dependsOn: [], state: 'blocked', attempt: 0, capabilityGeneration: 1,
          evidenceRefs: [], blockers: [{ code: 'EXPLICIT_MODEL_UNAVAILABLE', message: 'Claude subscription unavailable' }],
          updatedAt: '2026-08-29T00:00:00.000Z',
        },
        {
          id: 'debate-r1-decision-judge', title: 'decision-judge', role: 'debate:decision-judge',
          dependsOn: ['debate-r1-constructive-proposer', 'debate-r1-skeptical-falsifier'],
          state: 'blocked', attempt: 0, capabilityGeneration: 1,
          evidenceRefs: [], blockers: [{ code: 'DEPENDENCY_FAILED', message: 'A required participant did not settle' }],
          updatedAt: '2026-08-29T00:00:00.000Z',
        },
      ],
      blockers: [],
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    }
    const orchestrations: DebateTaskGraphOrchestrations = {
      async compile(request) {
        return { version: 1, compilationId: 'cmp-partial', graph: request.graph } as OrchestrationCompilationV1
      },
      async start() { return failedRun },
      async inspect() { return failedRun },
      async control() { return failedRun },
      async readArtifact(ref) {
        if (String(ref) !== String(proposerRef)) throw new Error(`unexpected artifact ${String(ref)}`)
        return {
          version: 1,
          executionId: 'execution:constructive-proposer',
          stopReason: 'completed',
          output: [{ type: 'text', text: resultJson('constructive-proposer') }],
        }
      },
    }

    const result = await new DebateTaskGraphRoundExecutor(orchestrations).executeRound({
      version: 1, runId: 'debate-partial', round: 1, turns, maxParallel: 2,
    })

    expect(result.resultsBySlot['constructive-proposer']).toMatchObject({
      outputRef: 'sha256:constructive-proposer', attempt: 1,
      routing: { requestedOperatorId: 'codex', actualOperatorId: 'codex' },
    })
    expect(result.failuresBySlot?.['skeptical-falsifier']).toMatchObject({
      state: 'blocked', attempt: 0, errorCode: 'EXPLICIT_MODEL_UNAVAILABLE',
    })
    expect(result.failuresBySlot?.['decision-judge']).toMatchObject({
      state: 'blocked', attempt: 0, errorCode: 'DEPENDENCY_FAILED',
    })
  })

  it('cancels the existing TaskGraph when the caller stops an active Debate round', async () => {
    const controls: Array<{ commandId: string; action: string; expectedRevision: number }> = []
    const running = {
      runId: OrchestrationRunId('taskgraph-run-stop'),
      state: 'running',
      revision: 7,
    } as OrchestrationRunSnapshot
    const orchestrations: DebateTaskGraphOrchestrations = {
      async compile(request) {
        return {
          version: 1,
          compilationId: 'cmp-stop',
          graph: request.graph,
        } as OrchestrationCompilationV1
      },
      async start() { return running },
      async inspect() { return running },
      async control(request) {
        controls.push({
          commandId: request.commandId,
          action: request.action,
          expectedRevision: request.expectedRevision,
        })
        return { ...running, state: 'cancelled', revision: 8 }
      },
      async readArtifact() { throw new Error('cancelled run must not read Evidence') },
    }
    const controller = new AbortController()
    controller.abort('fixture stop')
    const executor = new DebateTaskGraphRoundExecutor(orchestrations)

    await expect(executor.executeRound({
      version: 1,
      runId: 'debate-stop',
      round: 1,
      turns,
      maxParallel: 2,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'DEBATE_INTERRUPTED' })
    expect(controls).toEqual([{
      commandId: 'debate:debate-stop:round:1:cancel:7',
      action: 'cancel',
      expectedRevision: 7,
    }])
  })
})
