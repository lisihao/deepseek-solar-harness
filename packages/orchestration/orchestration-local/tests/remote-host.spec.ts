/** The remote-host entry mounts the execution host service and nothing that schedules. */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, Config, name } from '../src/remote-host.ts'

describe('orchestration-local/remote-host', () => {
  it('provides remoteOperatorHost and no orchestration service', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ name, apply }, Config({ dshHome: '/tmp/dsh-remote-host-fixture' }))
    await fiber.await()
    expect(ctx.get('remoteOperatorHost')).toBeDefined()
    expect(ctx.get('orchestrations')).toBeUndefined()
    await fiber.dispose()
  })

  it('applies the shared defaults', () => {
    expect(Config({ dshHome: '/tmp/x' })).toMatchObject({
      remoteMaterializationTimeoutMs: 120_000,
      remoteArtifactReadTimeoutMs: 15_000,
      remoteWorkspaceLeaseMs: 24 * 60 * 60_000,
    })
  })
})
