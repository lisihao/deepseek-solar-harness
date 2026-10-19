import { describe, expect, it, vi } from 'vitest'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { disposeOwnedActivations, trackOwnedActivation } from '../src/lifecycle.js'

function activation(stopReason: string = 'completed'): SubagentActivation & { dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn(async () => undefined)
  return {
    childId: `child-${stopReason}`,
    result: Promise.resolve({ stopReason, output: [] }),
    dispose,
  } as unknown as SubagentActivation & { dispose: ReturnType<typeof vi.fn> }
}

describe('activation ownership', () => {
  it('logs a non-success child result and removes it after settlement', async () => {
    const owned = new Set<any>()
    const warnings: string[] = []
    const child = activation('interrupted')
    trackOwnedActivation(owned, child, (message) => warnings.push(message))
    await child.result
    await vi.waitFor(() => expect(owned.size).toBe(0))
    expect(warnings).toEqual(['child child-interrupted ended with interrupted'])
  })

  it('disposes only owned activations and propagates cleanup failures', async () => {
    const owned = new Set<any>()
    const first = activation()
    const second = activation()
    owned.add(first)
    owned.add(second)
    await disposeOwnedActivations(owned)
    expect(owned.size).toBe(0)
    expect(first.dispose).toHaveBeenCalledOnce()
    expect(second.dispose).toHaveBeenCalledOnce()

    const failing = activation()
    failing.dispose.mockRejectedValueOnce(new Error('cleanup failed'))
    owned.add(failing)
    await expect(disposeOwnedActivations(owned)).rejects.toThrow('cleanup failed')
    expect(owned.size).toBe(0)
  })
})
