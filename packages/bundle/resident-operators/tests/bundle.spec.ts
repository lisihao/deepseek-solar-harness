/** Distribution-level proof for the opt-in Resident bundle patch. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('resident-operators bundle', () => {
  it('ships one parseable, self-contained opt-in patch', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    expect(Array.isArray(parsed)).toBe(true)
    const rows = (parsed as Array<{ insert?: Array<{ id?: string; name?: string; config?: unknown }> }>)
      .flatMap(patch => patch.insert ?? [])
    expect(rows.map(row => row.id)).toEqual([
      'physical-operators',
      'resident-operators',
      'ui-physical-operator',
      'subagent-codex-native-subscription',
      'subagent-claude-code-native-subscription',
      'physical-operator-dual-mode',
      'tool-physical-operator',
    ])
    for (const row of rows) {
      expect(row.name).toMatch(/^@deepseek-ai\/dsh-/)
      expect(manifest.dependencies).toHaveProperty(row.name as string)
    }
    expect(rows.find(row => row.id === 'physical-operator-dual-mode')?.config).toMatchObject({
      operators: [
        { id: 'codex', ephemeralProvider: 'codex', residentProvider: 'codex' },
        { id: 'claude-code', ephemeralProvider: 'claude-code', residentProvider: 'claude-code' },
      ],
    })
    expect(rows.find(row => row.id === 'resident-operators')?.config).toMatchObject({
      driverModules: [],
    })
  })
})
