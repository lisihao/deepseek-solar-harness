/**
 * Experiment file parsing: YAML with `id`, `suite`, `profile`, `repetitions`,
 * optional `tasks`, and `variants` (each with optional `patches` relative to
 * the file and `env`).
 * @module @deepseek-ai/dsh-bench-runner/experiment
 */

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { BenchSuiteId, BenchTaskId } from '@deepseek-ai/dsh-bench'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import type { Experiment, ExperimentId, VariantId } from './types.ts'

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dots, dashes, and underscores')

const experimentFile = z.object({
  id: key,
  suite: z.string().min(1),
  profile: key,
  repetitions: z.number().int().min(1),
  tasks: z.array(z.string().min(1)).min(1).optional(),
  variants: z.array(z.object({
    id: key,
    patches: z.array(z.string().min(1)).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  }).strict()).min(1),
}).strict()

/**
 * Read and validate an experiment file.
 * @param file - path to the YAML file; relative patch paths resolve against its directory.
 * @returns the resolved experiment with absolute patch paths.
 */
export async function readExperiment(file: string): Promise<Experiment> {
  const path = resolve(file)
  const parsed = experimentFile.safeParse(parseYaml(await readFile(path, 'utf8')))
  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`)
  const data = parsed.data
  const ids = new Set<string>()
  for (const variant of data.variants) {
    if (ids.has(variant.id)) throw new Error(`${path}: duplicate variant id ${JSON.stringify(variant.id)}`)
    ids.add(variant.id)
  }
  const base = dirname(path)
  const experiment: Experiment = {
    id: data.id as ExperimentId,
    suite: data.suite as BenchSuiteId,
    profile: data.profile,
    repetitions: data.repetitions,
    variants: data.variants.map(variant => ({
      id: variant.id as VariantId,
      patches: (variant.patches ?? []).map(patch => isAbsolute(patch) ? patch : resolve(base, patch)),
      env: variant.env ?? {},
    })),
  }
  if (data.tasks !== undefined) experiment.tasks = data.tasks as BenchTaskId[]
  return experiment
}
