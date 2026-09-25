import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { apply } from '../src/index.ts'

describe('plugin console startup', () => {
  it('registers routes without scheduling a background registry scan', () => {
    const originalSetTimeout = globalThis.setTimeout
    let scheduled = 0
    globalThis.setTimeout = ((..._args: Parameters<typeof setTimeout>) => {
      scheduled += 1
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

    try {
      let dispose: (() => void) | undefined
      apply({
        effect(callback: () => void | (() => void)) {
          const result = callback()
          if (typeof result === 'function') dispose = result
        },
        webServer: { register: () => () => undefined },
      } as never)

      assert.equal(scheduled, 0)
      dispose?.()
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })
})
