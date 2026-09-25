import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  '../../../../examples/acp-agent/tests/fixtures/physical-operator/resident/',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('resident physical-operator Loader composition', () => {
  it('keeps ephemeral as the default-compatible path and reuses resident continuity', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'resident physical-operator Loader composition',
      tempDirPrefix: 'dsh-resident-operator-loader-',
      binScript: join(fixtureDir, 'driver.ts'),
      libBinScript: join(fixtureDir, 'driver.ts'),
      configPath: join(fixtureDir, 'cordis.yml'),
      tsconfigPath: repoTsconfig,
    })
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({
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
          executionModes: ['ephemeral', 'resident'],
        }],
      },
      ephemeral: {
        kind: 'run', operatorId: 'physics-solver', executionId: '<uuid>',
        output: [{ type: 'text', text: 'fixture computed: derive period one' }],
      },
      residentOne: {
        kind: 'run', operatorId: 'physics-solver', executionId: '<uuid>',
        output: [{ type: 'text', text: 'resident turn 1: derive period two' }],
        continuity: { sessionId: 'resident:loader-session', stateRevision: 1 },
      },
      residentTwo: {
        kind: 'run', operatorId: 'physics-solver', executionId: '<uuid>',
        output: [{ type: 'text', text: 'resident turn 2: derive period three' }],
        continuity: { sessionId: 'resident:loader-session', stateRevision: 2 },
      },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
