import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('orchestrations bundle', () => {
  it('ships one parseable removable composition', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    const rows = (parsed as Array<{
      insert?: Array<{ id?: string; name?: string; config?: Record<string, unknown> }>
    }>).flatMap(value => value.insert ?? [])
    expect(rows.map(value => value.id)).toEqual([
      'orchestration-local',
      'debate-orchestration',
      'tool-orchestration',
      'tool-debate',
      'ui-debate',
      'ui-orchestration',
    ])
    expect(rows[0]?.config).toMatchObject({ autoStart: true, connectTimeoutMs: 15_000 })
    for (const row of rows) expect(manifest.dependencies).toHaveProperty(String(row.name))
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-rlm-runtime')
    expect(manifest.dependencies).toHaveProperty('@deepseek-ai/dsh-rlm-runtime-local')
  })

  it('keeps Service Definitions, Providers, and Consumers on one-way seams', () => {
    const bundleRoot = fileURLToPath(new URL('..', import.meta.url))
    const orchestrationRoot = resolve(bundleRoot, '..', '..', 'orchestration')
    const dependencies = (name: string): Set<string> => {
      const manifest = JSON.parse(readFileSync(resolve(orchestrationRoot, name, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      return new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
    }
    const local = '@deepseek-ai/dsh-orchestration-local'
    const seams = [
      '@deepseek-ai/dsh-intent-compiler',
      '@deepseek-ai/dsh-context-compiler',
      '@deepseek-ai/dsh-capability-capsule',
      '@deepseek-ai/dsh-orchestration',
      '@deepseek-ai/dsh-rlm-runtime',
    ]
    for (const definition of ['intent-compiler', 'context-compiler', 'capability-capsule', 'orchestration', 'rlm-runtime']) {
      expect(dependencies(definition)).not.toContain(local)
      expect(dependencies(definition)).not.toContain('@deepseek-ai/dsh-rlm-runtime-local')
    }
    for (const consumer of ['tool-orchestration', 'ui-orchestration']) {
      const values = dependencies(consumer)
      expect(values).toContain('@deepseek-ai/dsh-orchestration')
      expect(values).not.toContain(local)
      expect(values).not.toContain('@deepseek-ai/dsh-resident-operator-local')
    }
    const debateBinding = dependencies('debate-orchestration')
    expect(debateBinding).toContain('@deepseek-ai/dsh-debate')
    expect(debateBinding).toContain('@deepseek-ai/dsh-debate-local')
    expect(debateBinding).toContain('@deepseek-ai/dsh-orchestration')
    expect(debateBinding).not.toContain('@deepseek-ai/dsh-physical-operator')
    expect(debateBinding).not.toContain('@deepseek-ai/dsh-orchestration-local')
    const debateConsumer = dependencies('tool-debate')
    expect(debateConsumer).toContain('@deepseek-ai/dsh-debate')
    expect(debateConsumer).not.toContain('@deepseek-ai/dsh-debate-local')
    expect(debateConsumer).not.toContain('@deepseek-ai/dsh-physical-operator')
    const debateUi = dependencies('ui-debate')
    expect(debateUi).toContain('@deepseek-ai/dsh-debate')
    expect(debateUi).not.toContain('@deepseek-ai/dsh-debate-local')
    expect(debateUi).not.toContain('@deepseek-ai/dsh-orchestration-local')
    expect(debateUi).not.toContain('@deepseek-ai/dsh-physical-operator')
    const provider = dependencies('orchestration-local')
    for (const seam of seams) expect(provider).toContain(seam)
  })
})
