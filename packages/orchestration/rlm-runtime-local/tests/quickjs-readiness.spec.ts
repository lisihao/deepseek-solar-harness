import type { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KernelHooks } from '../src/kernel.ts'

const state = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & { messages: Array<{ executionId: number }>; terminated: boolean }> }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: class extends EventEmitter {
      messages: Array<{ executionId: number }> = []
      terminated = false
      constructor() { super(); state.workers.push(this) }
      postMessage(message: { executionId: number }) { this.messages.push(message) }
      terminate(): Promise<number> { this.terminated = true; return Promise.resolve(0) }
    },
  }
})
import { PersistentQuickJSKernel } from '../src/quickjs-kernel.ts'
const limits = { memoryLimitBytes: 32 * 1024 * 1024, maxStackBytes: 256 * 1024, maxInterruptChecks: 100,
  maxBridgeBytes: 1024 * 1024, maxLogBytes: 4096, maxCellSourceBytes: 65536, maxHostCalls: 4, maxPendingHostCalls: 1, jobBatchSize: 4 }
const snapshots = { maxBytes: 4096, maxVariableBytes: 4096 }

beforeEach(() => { state.workers.length = 0 })
describe('QuickJS parent lifecycle', () => {
  it('times out a Worker that never initializes or answers', async () => {
    const vm = new PersistentQuickJSKernel({}, {} as KernelHooks, [], limits, snapshots)
    await expect(vm.execute('1', 20)).rejects.toMatchObject({ code: 'RLM_CELL_TIMEOUT' })
    await vm.dispose()
    expect(state.workers[0]?.terminated).toBe(true)
  })

  it('ignores old cell calls while a later cell is active', async () => {
    const list = vi.fn(async () => [])
    const vm = new PersistentQuickJSKernel({}, { listChildren: list } as unknown as KernelHooks, [], limits, snapshots)
    const result = (id: number, value: number) => ({ type: 'result', executionId: id,
      result: JSON.stringify({ value, display: String(value), variables: [], degradedVariables: [], logs: [], context: {} }) })
    try {
      const first = vm.execute('1', 2000)
      const worker = state.workers[0]!
      worker.emit('message', result(1, 1))
      expect((await first).value).toBe(1)
      const second = vm.execute('2', 2000)
      worker.emit('message', { type: 'host-call', executionId: 1, callId: 1, method: 'listChildren', args: '[]' })
      worker.emit('message', result(1, 999))
      worker.emit('message', result(2, 2))
      expect((await second).value).toBe(2)
      expect(list).not.toHaveBeenCalled()
    } finally { await vm.dispose() }
  })
})
