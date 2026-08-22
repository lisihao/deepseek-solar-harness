import { describe, expect, it } from 'vitest'

// @ts-expect-error The executable acceptance script is intentionally plain ESM.
import { assertParallelWorkerEvents } from '../scripts/verify-installed-orchestration-e2e.mjs'

describe('installed orchestration E2E event assertions', () => {
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
})
