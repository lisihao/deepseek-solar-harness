/**
 * REAL-composition proof of the opt-in setup: a `cordis.yml` that mounts the
 * local subprocess service, the allocation Provider in `apply` mode, and the
 * evidence gateway with Radar settings boots through the Loader. A Radar store
 * seeded by the real Python CLI then flows through the real collector, the
 * gateway, and the allocator, and the evidence changes the choice between two
 * offers that tie. Only the owner-authorized network refresh is absent.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { ModelAllocationRequest, ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import * as ModelAllocationLocal from '@deepseek-ai/dsh-model-allocation-local'
import * as FileSettings from '@deepseek-ai/dsh-settings-file'
import * as LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import * as SchedulingEvidence from '../src/index.ts'
import { COLLECTOR_SOURCES, findPython, seedRadarStore } from './support.ts'

const python = findPython()

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  const directory = root as string
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(directory).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-settings-file', FileSettings],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocess],
    ['@deepseek-ai/dsh-model-allocation-local', ModelAllocationLocal],
    ['@deepseek-ai/dsh-scheduling-evidence', SchedulingEvidence],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

const offer = (model: string, rank: number): ModelExecutionOffer => ({
  offerId: `codex:${model}`, operatorId: 'codex', provider: 'codex', model, displayName: model,
  source: 'native-subscription', tier: 'high', available: true, maxConcurrency: 4, activeCount: 0, tags: ['coding'],
  profile: { model, effort: 'max' }, rank,
})

const request = (evidence: ModelAllocationRequest['evidence']): ModelAllocationRequest => ({
  runId: 'composition', nodeId: 'n', phase: 'execution', role: 'implementation', task: 'fix the build', preferredOperatorIds: [],
  objective: 'quality', rlm: 'disabled', graphMaxParallel: 1, offers: [offer('gpt-5.6-luna', 0), offer('gpt-5.6-sol', 1)],
  now: new Date().toISOString(), ...evidence === undefined ? {} : { evidence },
})

describe.skipIf(python === undefined)(`real Loader composition (python: ${python ?? 'none with Python 3.11+ on PATH'})`, () => {
  it('lets stored Radar evidence choose between tied offers through the shipped YAML shape', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduling-evidence-loader-'))
    await seedRadarStore(python as string, root)
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-model-allocation-local'",
      '  config:',
      '    publicEvidence: apply',
      "- name: '@deepseek-ai/dsh-scheduling-evidence'",
      '  config:',
      `    python: ${JSON.stringify(python)}`,
      `    sourceRoot: ${JSON.stringify(COLLECTOR_SOURCES)}`,
      `    stateRoot: ${JSON.stringify(root)}`,
      '    radar: {}',
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    await loaded.schedulingEvidence.runCycle()

    const offers = request(undefined).offers
    const withoutEvidence = await loaded.modelAllocation.allocate(request(undefined))
    const evidence = loaded.schedulingEvidence.evidenceFor(offers, 'coding')
    const withEvidence = await loaded.modelAllocation.allocate(request(evidence))

    expect(withoutEvidence.offerId).toBe('codex:gpt-5.6-luna')
    expect(withEvidence.offerId).toBe('codex:gpt-5.6-sol')
    expect(withEvidence.rationale).toContain('public-evidence-tiebreak')
    expect(withEvidence.evidence).toMatchObject({ mode: 'apply', status: 'used', applied: true, snapshots: [{ source: 'radar' }] })
  })

  it('lets the owner turn Radar evidence and its use on from the settings document alone', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduling-evidence-loader-'))
    await seedRadarStore(python as string, root)
    const settingsPath = join(root, 'settings.yaml')
    await writeFile(settingsPath, [
      'scheduling-evidence:',
      '  radarEnabled: true',
      `  python: ${JSON.stringify(python)}`,
      'model-allocation:',
      '  publicEvidence: apply',
      '',
    ].join('\n'))
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-settings-file'",
      '  config:',
      `    path: ${JSON.stringify(settingsPath)}`,
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-model-allocation-local'",
      "- name: '@deepseek-ai/dsh-scheduling-evidence'",
      '  config:',
      '    python: definitely-not-a-python-interpreter',
      `    sourceRoot: ${JSON.stringify(COLLECTOR_SOURCES)}`,
      `    stateRoot: ${JSON.stringify(root)}`,
    ])
    await loaded.schedulingEvidence.runCycle()

    const offers = request(undefined).offers
    const plan = await loaded.modelAllocation.allocate(request(loaded.schedulingEvidence.evidenceFor(offers, 'coding')))

    expect(plan.offerId).toBe('codex:gpt-5.6-sol')
    expect(plan.evidence).toMatchObject({ mode: 'apply', applied: true })
    const descriptors = loaded.settings.describe().map(descriptor => String(descriptor.ns))
    expect(descriptors).toEqual(expect.arrayContaining(['scheduling-evidence', 'model-allocation']))
  })

  it('fails the load loudly for a Radar setting outside its bounds', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-scheduling-evidence-loader-'))

    await expect(loadYaml([
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-scheduling-evidence'",
      '  config:',
      '    python: python3',
      `    sourceRoot: ${JSON.stringify(COLLECTOR_SOURCES)}`,
      `    stateRoot: ${JSON.stringify(root)}`,
      '    radar:',
      '      refreshIntervalMs: 1000',
    ])).rejects.toThrow(/\$\.radar\.refreshIntervalMs expected number >= 1800000 but got 1000/u)
  })
})
