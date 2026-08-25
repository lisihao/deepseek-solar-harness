import { describe, expect, it } from 'vitest'

// @ts-expect-error The executable acceptance script is intentionally plain ESM.
import { assertParallelWorkerEvents, assertRecursiveRlmEvents, assertSerializedScopeWorkerEvents, buildBlindRlmQualityRecording, countNativeSubscriptionTurns, resolveSubscriptionE2EMode } from '../scripts/verify-installed-orchestration-e2e.mjs'

describe('installed orchestration E2E event assertions', () => {
  it('requires explicit authorization and defaults to the minimal subscription matrix', () => {
    expect(() => resolveSubscriptionE2EMode({})).toThrow('DSH_ALLOW_SUBSCRIPTION_E2E=1')
    expect(resolveSubscriptionE2EMode({ DSH_ALLOW_SUBSCRIPTION_E2E: '1' })).toBe('minimal')
    expect(resolveSubscriptionE2EMode({
      DSH_ALLOW_SUBSCRIPTION_E2E: '1',
      DSH_SUBSCRIPTION_E2E_FULL_MATRIX: '1',
    })).toBe('full')
  })

  it('counts physical RLM turns instead of one composite Scheduler node', () => {
    expect(countNativeSubscriptionTurns([
      { type: 'node.dispatched', data: { executor: 'resident-rlm' } },
      { type: 'rlm.root.dispatched', data: {} },
      { type: 'rlm.child.dispatched', data: {} },
      { type: 'rlm.child.dispatched', data: {} },
      { type: 'rlm.message.continuation.settled', data: {} },
      { type: 'node.dispatched', data: {} },
      { type: 'node.dispatched', data: { executor: 'model-worker' } },
    ])).toBe(5)
  })

  it('requires an enabled RLM candidate to settle a child before accepting final Evidence', () => {
    const events = [
      { sequence: 1, type: 'rlm.execution.started', nodeId: 'candidate-b', data: {} },
      { sequence: 2, type: 'rlm.child.dispatched', nodeId: 'candidate-b', data: { childId: 'one' } },
      { sequence: 3, type: 'rlm.child.settled', nodeId: 'candidate-b', data: { childId: 'one' } },
      { sequence: 4, type: 'rlm.execution.settled', nodeId: 'candidate-b', data: { childCount: 1 } },
      { sequence: 5, type: 'node.evidence.accepted', nodeId: 'candidate-b', data: {} },
    ]
    expect(assertRecursiveRlmEvents(events, 'candidate-b')).toMatchObject({
      children: [{ type: 'rlm.child.dispatched' }],
      continuations: [],
    })
    expect(() => assertRecursiveRlmEvents(events.filter(event => event.type !== 'rlm.child.dispatched'), 'candidate-b'))
      .toThrow('dispatched no recursive child')
    expect(() => assertRecursiveRlmEvents(events.map(event => (
      event.type === 'node.evidence.accepted' ? { ...event, sequence: 3 } : event
    )), 'candidate-b')).toThrow('accepted final Evidence before a recursive child settled')
  })

  it('freezes a real blind quality recording and reveals the assignment after the judge', () => {
    const recording = buildBlindRlmQualityRecording({
      events: [
        { sequence: 2, type: 'node.evidence.accepted', nodeId: 'candidate-a', data: { evidenceRef: 'sha256:a', outputPreview: 'direct' } },
        { sequence: 3, type: 'node.evidence.accepted', nodeId: 'candidate-b', data: { evidenceRef: 'sha256:b', outputPreview: 'recursive' } },
        { sequence: 4, type: 'node.evidence.accepted', nodeId: 'verify', data: { evidenceRef: 'sha256:v', outputPreview: 'review\nPREFERRED_B' } },
      ],
      directCandidateId: 'candidate-a',
      rlmCandidateId: 'candidate-b',
      nonce: '0123abcd',
      productVersion: '3.6.0',
      sourceCommit: 'a'.repeat(40),
      recordedAt: '2026-08-26T00:00:00.000Z',
    }) as {
      passed: boolean
      supportsQualityClaim: boolean
      reveal: { revealedAfterSequence: number }
      evidence: { kind: string }
    }

    expect(recording).toMatchObject({
      passed: true,
      supportsQualityClaim: true,
      evidence: { kind: 'real-subscription' },
      reveal: { revealedAfterSequence: 4 },
    })
  })

  it('accepts parallel workers that retry on a different quota pool', () => {
    const events = [
      { sequence: 1, nodeId: 'worker-a', attempt: 0, type: 'model.allocated', data: { quotaPoolId: 'spark' } },
      { sequence: 2, nodeId: 'worker-a', attempt: 1, type: 'node.dispatched', data: {} },
      { sequence: 3, nodeId: 'worker-b', attempt: 0, type: 'model.allocated', data: { quotaPoolId: 'spark' } },
      { sequence: 4, nodeId: 'worker-b', attempt: 1, type: 'node.dispatched', data: {} },
      { sequence: 5, nodeId: 'worker-a', attempt: 1, type: 'node.retry_scheduled', data: { code: 'QUOTA_EXHAUSTED' } },
      { sequence: 6, nodeId: 'worker-b', attempt: 1, type: 'node.retry_scheduled', data: { code: 'QUOTA_EXHAUSTED' } },
      { sequence: 7, nodeId: 'worker-a', attempt: 1, type: 'model.allocated', data: { quotaPoolId: 'codex' } },
      { sequence: 8, nodeId: 'worker-b', attempt: 1, type: 'model.allocated', data: { quotaPoolId: 'codex' } },
      { sequence: 9, nodeId: 'worker-a', attempt: 2, type: 'node.dispatched', data: {} },
      { sequence: 10, nodeId: 'worker-b', attempt: 2, type: 'node.dispatched', data: {} },
      { sequence: 11, nodeId: 'worker-a', attempt: 2, type: 'node.evidence.accepted', data: {} },
      { sequence: 12, nodeId: 'worker-b', attempt: 2, type: 'node.evidence.accepted', data: {} },
    ]

    const result = assertParallelWorkerEvents(events, ['worker-a', 'worker-b']) as {
      workerAttempts: unknown[]
      workerDispatches: Array<{ sequence: number }>
      quotaFailovers: Array<{ nodeId: string, from: string, to: string }>
    }

    expect(result.workerAttempts).toHaveLength(4)
    expect(result.workerDispatches.map(event => event.sequence)).toEqual([9, 10])
    expect(result.quotaFailovers).toEqual([
      { nodeId: 'worker-a', from: 'spark', to: 'codex' },
      { nodeId: 'worker-b', from: 'spark', to: 'codex' },
    ])
  })

  it('rejects a quota retry that reuses the exhausted allocation', () => {
    const events = [
      { sequence: 1, nodeId: 'worker-a', attempt: 0, type: 'model.allocated', data: { quotaPoolId: 'spark' } },
      { sequence: 2, nodeId: 'worker-a', attempt: 1, type: 'node.dispatched', data: {} },
      { sequence: 3, nodeId: 'worker-a', attempt: 1, type: 'node.retry_scheduled', data: { code: 'QUOTA_EXHAUSTED' } },
      { sequence: 4, nodeId: 'worker-a', attempt: 1, type: 'model.allocated', data: { quotaPoolId: 'spark' } },
      { sequence: 5, nodeId: 'worker-a', attempt: 2, type: 'node.dispatched', data: {} },
      { sequence: 6, nodeId: 'worker-a', attempt: 2, type: 'node.evidence.accepted', data: {} },
    ]

    expect(() => assertParallelWorkerEvents(events, ['worker-a'])).toThrow('retried the exhausted allocation spark')
  })

  it('accepts serialized scope workers that retry on exhausted quota', () => {
    const events = [
      { sequence: 1, nodeId: 'conflict-a', attempt: 1, type: 'node.dispatched', data: {} },
      { sequence: 2, nodeId: 'conflict-a', attempt: 1, type: 'node.retry_scheduled', data: { code: 'QUOTA_EXHAUSTED' } },
      { sequence: 3, nodeId: 'conflict-b', attempt: 1, type: 'node.dispatched', data: {} },
      { sequence: 4, nodeId: 'conflict-b', attempt: 1, type: 'node.retry_scheduled', data: { code: 'QUOTA_EXHAUSTED' } },
      { sequence: 5, nodeId: 'conflict-a', attempt: 2, type: 'node.dispatched', data: {} },
      { sequence: 6, nodeId: 'conflict-a', attempt: 2, type: 'node.evidence.accepted', data: {} },
      { sequence: 7, nodeId: 'conflict-b', attempt: 2, type: 'node.dispatched', data: {} },
      { sequence: 8, nodeId: 'conflict-b', attempt: 2, type: 'node.evidence.accepted', data: {} },
    ]

    const result = assertSerializedScopeWorkerEvents(events, ['conflict-a', 'conflict-b']) as {
      attemptIntervals: Array<{ dispatchSequence: number, endSequence: number }>
      successfulDispatches: Array<{ sequence: number }>
    }

    expect(result.attemptIntervals).toEqual([
      { nodeId: 'conflict-a', attempt: 1, dispatchSequence: 1, endSequence: 2, endType: 'node.retry_scheduled' },
      { nodeId: 'conflict-b', attempt: 1, dispatchSequence: 3, endSequence: 4, endType: 'node.retry_scheduled' },
      { nodeId: 'conflict-a', attempt: 2, dispatchSequence: 5, endSequence: 6, endType: 'node.evidence.accepted' },
      { nodeId: 'conflict-b', attempt: 2, dispatchSequence: 7, endSequence: 8, endType: 'node.evidence.accepted' },
    ])
    expect(result.successfulDispatches.map(event => event.sequence)).toEqual([5, 7])
  })

  it('rejects overlapping scope-attempt intervals', () => {
    const events = [
      { sequence: 1, nodeId: 'conflict-a', attempt: 1, type: 'node.dispatched', data: {} },
      { sequence: 2, nodeId: 'conflict-b', attempt: 1, type: 'node.dispatched', data: {} },
      { sequence: 3, nodeId: 'conflict-a', attempt: 1, type: 'node.evidence.accepted', data: {} },
      { sequence: 4, nodeId: 'conflict-b', attempt: 1, type: 'node.evidence.accepted', data: {} },
    ]

    expect(() => assertSerializedScopeWorkerEvents(events, ['conflict-a', 'conflict-b']))
      .toThrow('overlapping scope attempts executed concurrently')
  })
})
