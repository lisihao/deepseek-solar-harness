import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { MemoryBodyRegistry } from '../src/memory-bodies.ts'
import type { ProcessRunner } from '../src/process.ts'
import { ByteRoverProvider } from '../src/providers/byterover.ts'
import { HolographicProvider } from '../src/providers/holographic.ts'
import { createRunner } from '../src/runner.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function registryAt(dataDir: string): MemoryBodyRegistry {
  const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon', dataDir }), vi.fn<ProcessRunner>())
  return new MemoryBodyRegistry(runner, true)
}

describe('third-party local memory providers', () => {
  it('stores Holographic facts locally with trust, entities, graph projection, related recall, and hard forget', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-holographic-'))
    temporaryDirectories.push(dataDir)
    const dataPath = join(dataDir, 'facts', 'memory.json')
    const registry = registryAt(dataDir)
    const body = await registry.create({
      name: 'Holographic knowledge',
      description: 'Local structured facts with shared entities.',
      active: true,
      providerId: 'holographic',
      connection: { dataPath, defaultTrust: 0.7, minTrust: 0.3 },
    })
    const provider = new HolographicProvider(registry)

    const first = await provider.remember(body, {
      content: 'TypeScript service uses SQLite for durable state.',
      category: 'decision',
      tags: ['architecture'],
      entities: ['TypeScript', 'SQLite'],
    }) as { id: string }
    const second = await provider.remember(body, {
      content: 'SQLite backups run daily before deployment.',
      category: 'fact',
      entities: ['SQLite'],
    }) as { id: string }

    await expect(provider.remember(body, { content: 'TypeScript service uses SQLite for durable state.' })).resolves.toMatchObject({ action: 'skipped', id: first.id })
    await expect(provider.search(body, { query: 'TypeScript storage', limit: 5 })).resolves.toEqual({
      results: [expect.objectContaining({ id: first.id, category: 'decision', entities: ['TypeScript', 'SQLite'] })],
    })
    await expect(provider.related(body, first.id, 2)).resolves.toEqual([expect.objectContaining({ id: second.id })])
    await expect(provider.graph(body)).resolves.toMatchObject({
      nodes: expect.arrayContaining([expect.objectContaining({ id: 'entity:SQLite', kind: 'entity' })]),
      edges: expect.arrayContaining([expect.objectContaining({ sourceId: first.id, targetId: 'entity:SQLite', type: 'entity' })]),
    })
    await expect(provider.status(body)).resolves.toMatchObject({ healthy: true, stats: { totalInsights: 2, edgeCount: 3 } })
    expect(statSync(dataPath).mode & 0o777).toBe(0o600)
    await expect(provider.forget(body, first.id)).resolves.toMatchObject({ action: 'deleted' })
    await expect(provider.list(body, {})).resolves.toHaveLength(1)
  })

  it('runs ByteRover through a shell-free scoped CLI boundary', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dsh-mnemon-byterover-'))
    temporaryDirectories.push(dataDir)
    const calls: Array<{ command: string; args: readonly string[]; options: Parameters<ProcessRunner>[2] }> = []
    const process = vi.fn<ProcessRunner>(async (command, args, options) => {
      calls.push({ command, args, options })
      if (args[0] === 'status') return { stdout: 'ByteRover ready', stderr: '', exitCode: 0 }
      if (args[0] === 'query') return { stdout: 'Past context: use a staged rollout before production deployment.', stderr: '', exitCode: 0 }
      if (args[0] === 'curate') return { stdout: 'Curated', stderr: '', exitCode: 0 }
      return { stdout: '', stderr: 'unknown', exitCode: 1 }
    })
    const registry = registryAt(dataDir)
    const body = await registry.create({
      name: 'ByteRover tree',
      description: 'Local-first hierarchical project knowledge.',
      active: true,
      providerId: 'byterover',
      connection: { cliPath: '/opt/byterover/bin/brv', workingDirectory: 'brv-space', apiKey: 'brv-secret' },
    })
    const provider = new ByteRoverProvider(registry, { process, queryTimeoutMs: 1_000, curateTimeoutMs: 2_000 })

    await expect(provider.status(body)).resolves.toEqual({ healthy: true })
    await expect(provider.status(body)).resolves.toEqual({ healthy: true })
    expect(calls.filter(call => call.args[0] === 'status')).toHaveLength(1)
    const recalled = await provider.search(body, { query: 'How should we deploy?' })
    expect(recalled.results).toEqual([expect.objectContaining({ id: expect.stringMatching(/^byterover:/), category: 'context', score: 1 })])
    expect(JSON.stringify(recalled)).not.toContain('brv-secret')
    await expect(provider.remember(body, { content: 'Always use staged rollout.' })).resolves.toMatchObject({ action: 'stored' })
    await expect(provider.graph(body)).resolves.toMatchObject({ nodes: [], edges: [] })

    expect(calls[1]).toMatchObject({ command: '/opt/byterover/bin/brv', args: ['query', '--', 'How should we deploy?'] })
    expect(calls[1]?.options.cwd).toBe(resolve(dataDir, 'brv-space'))
    expect(calls[1]?.options.env?.BRV_API_KEY).toBe('brv-secret')
    expect(calls[1]?.options.label).toBe('ByteRover')
    provider.invalidateStatus(body.id)
    await expect(provider.status(body)).resolves.toEqual({ healthy: true })
    expect(calls.filter(call => call.args[0] === 'status')).toHaveLength(2)
  })
})
