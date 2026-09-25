import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { name } from '../src/index.js'

type PatchRow = { id?: string; name?: string; config?: unknown }

function bundleRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url))
}

function patchRows(root: string): PatchRow[] {
  const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new TypeError('ChatGPT Web bundle patch must be a list')
  return parsed.flatMap((patch): PatchRow[] =>
    typeof patch === 'object' && patch !== null && 'insert' in patch
      ? ((patch as { insert?: PatchRow[] }).insert ?? [])
      : [],
  )
}

describe('ChatGPT Web physical-operator bundle', () => {
  it('ships one parseable provider-only overlay for the existing public seams', () => {
    expect(name).toBe('chatgpt-web-operator-bundle')
    const root = bundleRoot()
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const rows = patchRows(root)
    expect(rows.map(row => row.id)).toEqual(['physical-operator-chatgpt-web'])
    for (const row of rows) {
      expect(row.name).toMatch(/^@deepseek-ai\/dsh-/)
      expect(manifest.dependencies).toHaveProperty(row.name as string)
    }
  })

  it('keeps the ChatGPT provider on public seams without a private Ego Lite dependency', () => {
    const root = bundleRoot()
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-ego-lite-browser')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-resident-operator-local')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-physical-operator-resident')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-browser-ego-lite')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-browser')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-physical-operator')
    expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/dsh-tool-physical-operator')
    const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('ctx.browser')
    expect(patch).not.toContain('ego-browser')
    expect(patch).not.toContain('dangerously')
  })
})
