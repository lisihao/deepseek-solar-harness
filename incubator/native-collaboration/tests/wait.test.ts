import { describe, expect, it, vi } from 'vitest'
import type { GraphSnapshot } from '../../native-resident/src/contracts.js'
import { waitForGraph } from '../src/wait.js'
const snapshot = (status: GraphSnapshot['status']): GraphSnapshot => ({ formatVersion: 1, graph: { formatVersion: 1, id: 'original', label: '任务', cwd: '/private/tmp', maxParallel: 1, nodes: [] }, status, revision: 1, createdAt: 1, updatedAt: 1, nodes: [] })
describe('local graph wait', () => {
  it('observes the original graph until settlement without a replacement submission', async () => {
    const inspect = vi.fn().mockResolvedValueOnce(snapshot('running')).mockResolvedValue(snapshot('completed'))
    const result = await waitForGraph({ inspect }, 'original', 3000, new AbortController().signal)
    expect(result.status).toBe('completed'); expect(inspect.mock.calls).toEqual([['original'], ['original']])
  })
  it('returns a still-running snapshot at the local boundary', async () => {
    const inspect = vi.fn().mockResolvedValue(snapshot('running'))
    expect((await waitForGraph({ inspect }, 'original', 0, new AbortController().signal)).status).toBe('running')
    expect(inspect).toHaveBeenCalledTimes(1)
  })
  it('local cancellation stops observation without a graph control call', async () => {
    const abort = new AbortController()
    const inspect = vi.fn().mockImplementation(async () => { abort.abort(new Error('stop local waiting')); return snapshot('running') })
    await expect(waitForGraph({ inspect }, 'original', 1000, abort.signal)).rejects.toThrow('stop local waiting')
    expect(inspect).toHaveBeenCalledTimes(1)
  })
})
