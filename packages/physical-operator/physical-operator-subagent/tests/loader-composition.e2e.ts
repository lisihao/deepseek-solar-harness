import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/physical-operator/subagent/',
  import.meta.url,
))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'cordis.yml')
const productDriver = join(fixtureDir, 'product-driver.ts')
const productConfigPath = join(fixtureDir, 'product-cordis.yml')
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('physical-operator public Loader composition', () => {
  it('loads and invokes the complete seam through one scripted subagent provider', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'physical-operator Loader composition',
      tempDirPrefix: 'dsh-physical-operator-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      tool: {
        name: 'physical_operator',
        parameterNames: ['action', 'description', 'operator_id', 'prompt'],
        required: ['action'],
      },
      list: {
        kind: 'list',
        operators: [{
          operatorId: 'physics-solver',
          displayName: 'Physics Solver',
          description: 'Solves one bounded physics problem.',
          tags: ['physics', 'reasoning'],
          state: 'available',
          active: 0,
          maxConcurrency: 1,
        }],
      },
      run: {
        kind: 'run',
        operatorId: 'physics-solver',
        executionId: '<uuid>',
        output: [{ type: 'text', text: 'fixture computed: derive period' }],
      },
      finalStatus: {
        id: 'physics-solver',
        displayName: 'Physics Solver',
        description: 'Solves one bounded physics problem.',
        tags: ['physics', 'reasoning'],
        maxConcurrency: 1,
        state: 'available',
        active: 0,
      },
      lifecycle: { physicalStart: 1, physicalEnd: 1, subagentStart: 1, subagentEnd: 1 },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('maps stable ids to the real Codex and Claude Code providers without eager product startup', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'physical-operator real product mapping',
      tempDirPrefix: 'dsh-physical-operator-products-',
      binScript: productDriver,
      libBinScript: productDriver,
      configPath: productConfigPath,
      tsconfigPath: repoTsconfig,
      env: {
        // Registration and discovery must not probe either product executable.
        PATH: '',
      },
    })

    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
      providers: ['codex', 'claude-code'],
      operators: [
        { id: 'physics-codex', state: 'available', active: 0, maxConcurrency: 1 },
        { id: 'physics-claude-code', state: 'available', active: 0, maxConcurrency: 1 },
      ],
      tool: 'physical_operator',
      starts: { subagent: 0, physicalOperator: 0 },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
