import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

describe('Ego Lite browser bundle', () => {
  it('ships one self-contained Service/Provider/Consumer composition', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
    const rows = (parsed as Array<{ insert?: Array<{ id?: string; name?: string; config?: unknown }> }>)
      .flatMap(patch => patch.insert ?? [])
    expect(rows.map(row => row.id)).toEqual(['browser', 'browser-ego-lite', 'tool-browser'])
    expect(rows.find(row => row.id === 'browser')?.config).toEqual({ provider: 'ego-lite' })
    for (const row of rows) expect(manifest.dependencies).toHaveProperty(row.name as string)
  })
})
