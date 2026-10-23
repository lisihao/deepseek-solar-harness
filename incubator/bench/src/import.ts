/**
 * Explicit import of a DSH 3.x experiment ledger (`~/.dsh/bench/<id>`) into
 * this plugin's ledger root. DSH 3.x wrote ledger format 1, the format this
 * build reads, so the import validates the source with the same reader and
 * copies only `experiment.json` and `runs.jsonl`; per-run directories stay
 * behind. The source is never modified.
 * @module @lisihao/dsh-solar-bench/import
 */

import { copyFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { ExperimentLedger, LEDGER_FORMAT_VERSION, readPinnedExperiment } from './ledger.js'

/** Outcome of {@link importLegacyLedger}. */
export interface LedgerImport {
  /** Experiment id. */
  id: string
  /** Absolute target ledger directory. */
  target: string
  /** Validated run records copied. */
  records: number
  /** `copied` on a new import, `unchanged` when the target already held identical files. */
  outcome: 'copied' | 'unchanged'
  /** Ledger format of the source. */
  formatVersion: typeof LEDGER_FORMAT_VERSION
}

const FILES = ['experiment.json', 'runs.jsonl'] as const

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Validate a DSH 3.x ledger directory and copy it under `root`.
 * @param source - the legacy ledger directory; its name is the experiment id.
 * @param root - this plugin's ledger root.
 * @returns what was imported.
 * @throws Error when the source is not a readable format-1 ledger, has a torn
 *   final record, or the target already holds a different ledger of that id.
 */
export async function importLegacyLedger(source: string, root: string): Promise<LedgerImport> {
  const dir = resolve(source)
  const id = basename(dir)
  const experiment = await readPinnedExperiment(dirname(dir), id)
  if (experiment === undefined) throw new Error(`${dir} holds no experiment.json`)
  if (experiment.id !== id) throw new Error(`${dir}: experiment.json names ${JSON.stringify(experiment.id)}, not the directory name`)
  const runs = await readOptional(join(dir, 'runs.jsonl')) ?? ''
  if (runs !== '' && !runs.endsWith('\n')) throw new Error(`${dir}/runs.jsonl ends with a torn record; finish or repair the experiment before importing`)
  const records = await new ExperimentLedger(dirname(dir), experiment).records(false)
  const target = join(resolve(root), id)
  const sourceText = await Promise.all(FILES.map(async file => await readOptional(join(dir, file)) ?? ''))
  const targetText = await Promise.all(FILES.map(file => readOptional(join(target, file))))
  if (targetText.some(text => text !== undefined)) {
    if (targetText.every((text, index) => (text ?? '') === sourceText[index])) {
      return { id, target, records: records.length, outcome: 'unchanged', formatVersion: LEDGER_FORMAT_VERSION }
    }
    throw new Error(`${target} already holds a different ledger for ${JSON.stringify(id)}; nothing was copied`)
  }
  await mkdir(target, { recursive: true })
  // runs.jsonl first and experiment.json last: the ledger is listed only once experiment.json exists.
  for (const file of ['runs.jsonl', 'experiment.json'] as const) {
    const from = join(dir, file)
    if (!await stat(from).then(() => true, () => false)) continue
    await copyFile(from, `${join(target, file)}.importing`)
    await rename(`${join(target, file)}.importing`, join(target, file))
  }
  return { id, target, records: records.length, outcome: 'copied', formatVersion: LEDGER_FORMAT_VERSION }
}
