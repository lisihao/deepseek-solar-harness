/**
 * HMR teardown against a watcher that never reports ready: a pending
 * config registration must fail with INACTIVE_EFFECT instead of waiting
 * forever on a watcher teardown already closed.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Hmr from '@deepseek-ai/cordis-plugin-hmr'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('chokidar', async () => {
  const { EventEmitter } = await import('node:events')
  class SilentWatcher extends EventEmitter {
    close(): Promise<void> {
      return Promise.resolve()
    }
  }
  return { FSWatcher: SilentWatcher, watch: () => new SilentWatcher() }
})

describe('HMR teardown with a watcher that never becomes ready', () => {
  it('fails the pending config registration', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-teardown-'))
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(dir).href + '/'
    await ctx.plugin(Loader)
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    const hmr = ctx.hmr
    const internals = hmr as unknown as { configs: Map<string, unknown> }
    try {
      const pending = hmr.registerConfig(join(dir, 'home.yml'), () => {})
        .then(() => 'registered', (error: unknown) => (error as { code?: string }).code)
      while (internals.configs.size === 0) await new Promise(resolve => setImmediate(resolve))
      await ctx.fiber.dispose()
      expect(await pending).toBe('INACTIVE_EFFECT')
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
