import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExperimentLedger, readExperiment } from '@deepseek-ai/dsh-bench-runner'
import type { Experiment, RunRecord } from '@deepseek-ai/dsh-bench-runner'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-bench-exp-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readExperiment', () => {
  it('resolves relative patches against the file and keeps absolute ones', async () => {
    const file = join(dir, 'exp.yml')
    await writeFile(file, [
      'id: mnemon-ablation',
      'suite: dsh-native',
      'profile: headless',
      'repetitions: 3',
      'tasks: [a, b]',
      'variants:',
      '  - id: baseline',
      '  - id: mnemon',
      '    patches: [patches/mnemon.yml, /abs/extra.yml]',
      "    env: { MNEMON_DATA_DIR: '{cell}/mnemon' }",
      '',
    ].join('\n'))
    expect(await readExperiment(file)).toEqual({
      id: 'mnemon-ablation', suite: 'dsh-native', profile: 'headless', repetitions: 3, tasks: ['a', 'b'],
      variants: [
        { id: 'baseline', patches: [], env: {} },
        { id: 'mnemon', patches: [join(dir, 'patches', 'mnemon.yml'), '/abs/extra.yml'], env: { MNEMON_DATA_DIR: '{cell}/mnemon' } },
      ],
    })
  })

  it('omits an absent task subset and refuses duplicates and invalid fields', async () => {
    const file = join(dir, 'exp.yml')
    await writeFile(file, 'id: e\nsuite: s\nprofile: headless\nrepetitions: 1\nvariants: [{ id: a }]\n')
    expect((await readExperiment(file)).tasks).toBeUndefined()
    await writeFile(file, 'id: e\nsuite: s\nprofile: headless\nrepetitions: 1\nvariants: [{ id: a }, { id: a }]\n')
    await expect(readExperiment(file)).rejects.toThrow(/duplicate variant id "a"/)
    await writeFile(file, 'id: e\nsuite: s\nprofile: headless\nrepetitions: 0\nvariants: [{ id: a }]\n')
    await expect(readExperiment(file)).rejects.toThrow(/repetitions/)
  })
})

const experiment = { id: 'exp', suite: 's', profile: 'headless', repetitions: 1, variants: [{ id: 'a', patches: [], env: {} }] } as unknown as Experiment
const record = (rep: number): RunRecord => ({
  formatVersion: 1, cell: { variant: 'a', task: 't', rep } as RunRecord['cell'], status: 'invalid', exitCode: 1, models: [], suiteVersion: '1', startedAt: 0, endedAt: 1,
})

describe('ExperimentLedger', () => {
  it('appends records and reopens the same definition', async () => {
    const ledger = new ExperimentLedger(dir, experiment)
    await ledger.open()
    expect(await ledger.records()).toEqual([])
    await ledger.append(record(0))
    await ledger.append(record(1))
    const reopened = new ExperimentLedger(dir, experiment)
    await reopened.open()
    expect((await reopened.records()).map(entry => entry.cell.rep)).toEqual([0, 1])
    await expect(new ExperimentLedger(dir, { ...experiment, repetitions: 2 }).open()).rejects.toThrow(/different definition/)
  })

  it('drops a torn final line and refuses foreign formats and corrupt interior lines', async () => {
    const ledger = new ExperimentLedger(dir, experiment)
    await ledger.open()
    const runs = join(ledger.dir, 'runs.jsonl')
    await writeFile(runs, `${JSON.stringify(record(0))}\n\n{"formatVer`)
    expect(await ledger.records()).toHaveLength(1)
    expect(await readFile(runs, 'utf8')).toBe(`${JSON.stringify(record(0))}\n\n`)
    await writeFile(runs, `${JSON.stringify({ ...record(0), formatVersion: 2 })}\n`)
    await expect(ledger.records()).rejects.toThrow(/runs\.jsonl:1: run record format 2 is not readable/)
    await writeFile(runs, '{bad\n')
    await expect(ledger.records()).rejects.toThrow(/runs\.jsonl:1: corrupt run record/)
  })

  it('surfaces read errors other than a missing file', async () => {
    const ledger = new ExperimentLedger(dir, experiment)
    await ledger.open()
    await rm(join(ledger.dir, 'experiment.json'))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(ledger.dir, 'experiment.json'))
    await expect(ledger.open()).rejects.toThrow(/EISDIR/)
  })
})
