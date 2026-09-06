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
    const rows = (parsed as Array<{ insert?: Array<{ id?: string; name?: string }> }>).flatMap(value => value.insert ?? [])
    expect(rows.map(value => value.id)).toEqual(['orchestration-local', 'tool-orchestration', 'ui-orchestration'])
    for (const row of rows) expect(manifest.dependencies).toHaveProperty(String(row.name))
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
    ]
    for (const definition of ['intent-compiler', 'context-compiler', 'capability-capsule', 'orchestration']) {
      expect(dependencies(definition)).not.toContain(local)
    }
    for (const consumer of ['tool-orchestration', 'ui-orchestration']) {
      const values = dependencies(consumer)
      expect(values).toContain('@deepseek-ai/dsh-orchestration')
      expect(values).not.toContain(local)
      expect(values).not.toContain('@deepseek-ai/dsh-resident-operator-local')
    }
    const provider = dependencies('orchestration-local')
    for (const seam of seams) expect(provider).toContain(seam)
  })
})
