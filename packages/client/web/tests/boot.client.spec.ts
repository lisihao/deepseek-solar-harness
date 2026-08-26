/** Web boot immediately-tier transport recovery. */

import { describe, expect, it, vi } from 'vitest'
import type { BootManifest, ClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import { AppWebEntry } from '../src/boot.tsx'

interface BootInternals {
  manifest: BootManifest
  modules: Pick<ClientModuleSystem, 'prefetch'>
  prefetchImmediateTier(): Promise<void>
}

function bootWith(prefetch: (id: string) => Promise<void>): BootInternals {
  const boot = new AppWebEntry({} as HTMLElement) as unknown as BootInternals
  boot.manifest = {
    rev: 'fixture',
    modules: [],
    plugins: [
      { id: 'runtime', inject: [], immediately: true },
      { id: 'theme', inject: ['runtime'], immediately: true },
      { id: 'lazy', inject: ['runtime'], immediately: false },
    ],
  }
  boot.modules = { prefetch }
  return boot
}

describe('web boot immediately-tier barrier', () => {
  it('retries a transient bundle failure before dependants can materialize', async () => {
    const attempts = new Map<string, number>()
    const prefetch = vi.fn(async (id: string) => {
      const attempt = (attempts.get(id) ?? 0) + 1
      attempts.set(id, attempt)
      if (id === 'runtime' && attempt === 1) throw new Error('temporary network failure')
    })

    await expect(bootWith(prefetch).prefetchImmediateTier()).resolves.toBeUndefined()
    expect(prefetch.mock.calls.map(([id]) => id)).toEqual(['runtime', 'theme', 'runtime'])
    expect(prefetch).not.toHaveBeenCalledWith('lazy')
  })

  it('fails at the barrier when an immediate bundle misses both attempts', async () => {
    const prefetch = vi.fn(async (id: string) => {
      if (id === 'runtime') throw new Error('network unavailable')
    })

    await expect(bootWith(prefetch).prefetchImmediateTier()).rejects.toThrow(
      'immediately-tier module "runtime" failed both bundle-load attempts',
    )
    expect(prefetch.mock.calls.filter(([id]) => id === 'runtime')).toHaveLength(2)
  })
})
