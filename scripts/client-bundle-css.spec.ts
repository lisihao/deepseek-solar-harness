/**
 * CSS Modules enter client bundles through virtual modules, so the loader must
 * explicitly register the underlying stylesheet as a watch dependency.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clientBundle } from '../packages/client/tsdown.client.ts'

interface CssPlugin {
  name: string
  resolveId?: (source: string, importer?: string) => string | null
  load?: (this: { addWatchFile(id: string): void }, id: string) => Promise<string | null>
}

function cssPlugin(): CssPlugin {
  const configs = clientBundle(
    '@deepseek-ai/dsh-client-test',
    ['lib/types/index.js', 'lib/types/invariant.js'],
  )({ env: { DSH_BUILD_FACE: 'client' } })
  const client = configs.find(config => config.platform === 'browser')
  if (client === undefined) throw new Error('client config missing')
  const plugins = (client as { plugins: CssPlugin[] }).plugins
  const plugin = plugins.find(candidate => candidate.name === 'dsh-css-modules-inline')
  if (plugin === undefined) throw new Error('CSS Modules plugin missing from client config')
  return plugin
}

async function loadFixture(
  root: string,
  source: string,
  addWatchFile: (id: string) => void = () => {},
): Promise<{ output: string; stylesheet: string; virtualId: string }> {
  const stylesheet = join(root, 'Fixture.module.css')
  await writeFile(stylesheet, source)
  const plugin = cssPlugin()
  const virtualId = plugin.resolveId?.('./Fixture.module.css', join(root, 'index.ts'))
  if (typeof virtualId !== 'string' || plugin.load === undefined) {
    throw new Error('CSS Modules plugin hooks are incomplete')
  }
  const output = await plugin.load.call({ addWatchFile }, virtualId)
  if (output === null) throw new Error('CSS Modules plugin returned no output')
  return { output, stylesheet, virtualId }
}

describe('client bundle CSS Modules', () => {
  it('registers the source stylesheet as a watch dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-watch-'))
    try {
      const watched: string[] = []
      const { output, stylesheet } = await loadFixture(
        root,
        '.root { color: red; }\n',
        id => watched.push(id),
      )

      expect(watched).toEqual([stylesheet])
      expect(output).toContain('data-plugin-css')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('emits the same virtual module and class map from different worktree paths', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'dsh-client-css-first-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'dsh-client-css-second-'))
    try {
      const outputs: string[] = []
      const virtualIds: string[] = []
      for (const root of [firstRoot, secondRoot]) {
        const { output, virtualId } = await loadFixture(root, '.root { color: red; }\n')
        virtualIds.push(virtualId)
        outputs.push(output)
      }

      expect(new Set(virtualIds).size).toBe(1)
      expect(new Set(outputs).size).toBe(1)
    } finally {
      await Promise.all([
        rm(firstRoot, { recursive: true, force: true }),
        rm(secondRoot, { recursive: true, force: true }),
      ])
    }
  })

  it('serializes the Lightning CSS export map in a deterministic order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-client-css-order-'))
    try {
      const { output } = await loadFixture(
        root,
        '.zebra { color: red; } .alpha { color: blue; }\n',
      )
      const serialized = output.split('\n').at(-1)?.replace(/^export default /, '').replace(/;$/, '')
      if (serialized === undefined) throw new Error('CSS Modules export missing')
      const classMap: unknown = JSON.parse(serialized)
      if (typeof classMap !== 'object' || classMap === null) {
        throw new Error('CSS Modules export is not an object')
      }

      expect(Object.keys(classMap)).toEqual(['alpha', 'zebra'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
