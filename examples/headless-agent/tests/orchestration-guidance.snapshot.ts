/** Real Loader regression for the complete model-visible orchestration graph template. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import type { LogicalTaskGraphV1 } from '@deepseek-ai/dsh-orchestration'
import { validateGraph } from '@deepseek-ai/dsh-orchestration-local'
import type { EpochHeader } from '@deepseek-ai/dsh-session'
import { orchestrationGraphGuidance } from '@deepseek-ai/dsh-tool-orchestration'
import { describe, expect, it } from 'vitest'

const fixtureDir = fileURLToPath(new URL('./orchestration-guidance-snapshots/', import.meta.url))
const replayOverride = join(fixtureDir, 'replay.override.json')
const schemaExpected = join(fixtureDir, 'schema.expected.json')
const configPath = fileURLToPath(new URL('../orchestration-guidance.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const refreshing = process.env.DSH_SNAPSHOT === 'refresh'

/** Persisted request projection inspected after the real agent turn. */
interface RequestHeaderRecord {
  readonly type: string
  readonly data?: { readonly header?: EpochHeader }
}

describe('orchestration graph guidance snapshot', () => {
  it('sends a complete valid graph template in the assembled model request', async () => {
    const result = await runLoaderSmoke({
      label: 'orchestration guidance headless request snapshot',
      tempDirPrefix: 'dsh-orchestration-guidance-',
      processTimeoutMs: 60_000,
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'Reply ORCHESTRATION_GUIDANCE_DONE without calling tools.'],
      tsconfigPath,
      env: { DSH_SNAPSHOT_FILE: replayOverride, DSH_SNAPSHOT_OVERRIDE: replayOverride },
      inspect: async (runCwd) => {
        const sessionsDir = join(runCwd, '.sessions')
        const files = (await readdir(sessionsDir, { recursive: true })).filter(file => file.endsWith('.jsonl'))
        expect(files).toHaveLength(1)
        const log = await readFile(join(sessionsDir, files[0]!), 'utf8')
        const records = log.trimEnd().split('\n').map(line => JSON.parse(line) as RequestHeaderRecord)
        const headers = records.filter(record => record.type === 'request/header')
        expect(headers).toHaveLength(1)
        const schema = headers[0]?.data?.header?.tools?.find(tool => tool.name === 'orchestration')
        if (schema === undefined) throw new Error('missing orchestration schema in persisted model request')
        const properties = schema.parameters.properties as Record<string, { readonly description?: string }>
        const description = properties.graph_json?.description
        expect(description).toBe(orchestrationGraphGuidance)
        if (typeof description !== 'string') throw new Error('missing graph_json description')
        const graph = JSON.parse(description.slice(description.indexOf('{"version":1'))) as LogicalTaskGraphV1
        expect(validateGraph(graph)).toEqual(['read-readme'])
        expect(() => validateGraph({ ...graph, nodes: graph.nodes.map(node => ({ ...node, task: undefined })) }))
          .toThrow('graph.nodes[0].task')
        expect(graph).toMatchObject({
          title: 'Read the repository README', workspace: '/absolute/path/to/clean/repository', risk: 'low',
          nodes: [{
            title: 'Read README', task: 'Read README.md and summarize its contents. Do not modify files.',
            effectBudget: { read: ['README.md'], write: [], execute: [], network: [], cost: [], risk: [] },
            readScopes: ['README.md'], retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
          }],
        })
        expect(records.some(record => record.type === 'tool/call')).toBe(false)
        const serialized = `${JSON.stringify(schema, null, 2)}\n`
        if (refreshing) await writeFile(schemaExpected, serialized)
        expect(serialized).toBe(await readFile(schemaExpected, 'utf8'))
      },
    })
    expect(result.stderr).toBe('')
    const records = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(records.at(-1)).toMatchObject({ type: 'result', output: 'ORCHESTRATION_GUIDANCE_DONE' })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS + 30_000)
})
