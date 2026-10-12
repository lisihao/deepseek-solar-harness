import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ResidentProviderStatus } from '@deepseek-ai/dsh-resident-operator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clientMock = vi.hoisted(() => ({
  authenticate: vi.fn(),
  instances: [] as unknown[],
  providers: vi.fn(),
  ready: vi.fn(),
}))

vi.mock('../src/client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client.ts')>()
  class MockResidentDaemonClient {
    constructor(..._args: unknown[]) {
      clientMock.instances.push(this)
    }

    authenticate(operatorId: string): Promise<ResidentProviderStatus> {
      return clientMock.authenticate(operatorId) as Promise<ResidentProviderStatus>
    }

    providers(options?: unknown): Promise<ResidentProviderStatus[]> {
      return clientMock.providers(options) as Promise<ResidentProviderStatus[]>
    }

    ready(): Promise<void> {
      return clientMock.ready() as Promise<void>
    }
  }
  return { ...actual, ResidentDaemonClient: MockResidentDaemonClient }
})

import { apply, type Config } from '../src/index.ts'

const roots: string[] = []

function provider(model: string): ResidentProviderStatus {
  return {
    operatorId: 'codex',
    product: 'codex',
    displayName: 'Codex',
    description: 'Test Resident provider.',
    tags: ['coding'],
    maxConcurrency: 1,
    injectionBoundaries: ['pre-dispatch'],
    available: true,
    authentication: 'native-subscription',
    productVersion: 'test',
    protocolHash: 'test',
    models: [{
      model,
      displayName: model,
      description: `${model} test model`,
      supportedEfforts: ['medium'],
      defaultEffort: 'medium',
      isDefault: true,
      supportsAdaptiveThinking: false,
    }],
  }
}

function config(dshHome: string): Config {
  return {
    dshHome,
    autoStart: false,
    connectTimeoutMs: 1_000,
    pollIntervalMs: 10,
    driverModules: [],
    headlessNodeExecutable: process.execPath,
    cliRegistryUrl: 'https://registry.example.test',
    cliDownloadTimeoutMs: 1_000,
  }
}

async function startService(): Promise<NonNullable<Context['residentOperators']>> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-resident-snapshot-'))
  roots.push(root)
  const ctx = new Context()
  await apply(ctx, config(root))
  return ctx.residentOperators
}

beforeEach(() => {
  clientMock.authenticate.mockReset()
  clientMock.instances.length = 0
  clientMock.providers.mockReset()
  clientMock.ready.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Local Resident provider snapshots', () => {
  it('starts empty, records a completed provider query, and invalidates after authentication', async () => {
    const service = await startService()
    const current = provider('gpt-before-auth')
    const authenticated = provider('gpt-after-auth')
    clientMock.providers.mockResolvedValueOnce([current])
    clientMock.authenticate.mockResolvedValueOnce(authenticated)

    expect(service.providerSnapshot()).toBeUndefined()
    await expect(service.providers()).resolves.toEqual([current])
    expect(service.providerSnapshot()).toEqual(expect.objectContaining({ providers: [current] }))

    await expect(service.authenticate('codex')).resolves.toEqual(authenticated)
    expect(service.providerSnapshot()).toBeUndefined()
    expect(clientMock.authenticate).toHaveBeenCalledWith('codex')
  })

  it('fences a late provider query so it cannot replace a newer snapshot', async () => {
    const service = await startService()
    const first = Promise.withResolvers<ResidentProviderStatus[]>()
    const second = Promise.withResolvers<ResidentProviderStatus[]>()
    const oldCatalog = provider('gpt-old')
    const newCatalog = provider('gpt-new')
    clientMock.providers
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const firstQuery = service.providers()
    const secondQuery = service.providers()
    second.resolve([newCatalog])
    await expect(secondQuery).resolves.toEqual([newCatalog])
    expect(service.providerSnapshot()).toEqual(expect.objectContaining({ providers: [newCatalog] }))

    first.resolve([oldCatalog])
    await expect(firstQuery).resolves.toEqual([oldCatalog])
    expect(service.providerSnapshot()).toEqual(expect.objectContaining({ providers: [newCatalog] }))
  })
})
