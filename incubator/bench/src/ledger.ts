/**
 * Append-only experiment ledger: `<root>/<experimentId>/experiment.json`
 * pins the experiment definition, and `runs.jsonl` holds one
 * {@link RunRecord} per finished run. A run whose record exists is never
 * repeated, so a crashed or cancelled experiment resumes where it stopped.
 * @module @lisihao/dsh-solar-bench/ledger
 */

import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { CellKey, Experiment, ExperimentId, RunRecord } from './types.js'

/** The ledger format version this build reads and writes, in `experiment.json` and every run record. */
export const LEDGER_FORMAT_VERSION = 1

/** `experiment.json`: the pinned definition plus the ledger format version. */
const pinnedFile = z.object({
  formatVersion: z.literal(LEDGER_FORMAT_VERSION),
  id: z.string(),
  suite: z.string(),
  profile: z.string(),
  repetitions: z.number().int().min(1),
  tasks: z.array(z.string()).optional(),
  variants: z.array(z.object({ id: z.string(), patches: z.array(z.string()), env: z.record(z.string(), z.string()) }).strict()).min(1),
}).strict()

const toolStats = z.object({ calls: z.number().int().nonnegative(), errors: z.number().int().nonnegative(), totalMs: z.number().nonnegative() }).strict()

/** One `runs.jsonl` line; every field the analysis reads is checked, so a malformed record fails at read with its line number. */
const runRecordLine = z.object({
  formatVersion: z.literal(LEDGER_FORMAT_VERSION),
  cell: z.object({ variant: z.string().min(1), task: z.string().min(1), rep: z.number().int().nonnegative() }).strict(),
  status: z.enum(['graded', 'timeout', 'invalid']),
  grade: z.object({ pass: z.boolean(), score: z.number().min(0).max(1), details: z.string() }).strict().optional(),
  grader: z.object({ kind: z.string().min(1), version: z.number().int() }).strict().optional(),
  metrics: z.object({
    turns: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative(),
    tokens: z.object({
      input: z.number().nonnegative(),
      output: z.number().nonnegative(),
      cacheRead: z.number().nonnegative(),
      unreportedMessages: z.number().int().nonnegative(),
    }).strict(),
    timing: z.object({
      wallMs: z.number().nonnegative(),
      llmMs: z.number().nonnegative(),
      toolCriticalMs: z.number().nonnegative(),
      overheadMs: z.number().nonnegative(),
    }).strict(),
    tools: z.record(z.string(), toolStats),
    retries: z.number().int().nonnegative(),
    sessions: z.number().int().min(1),
    costUsd: z.number().nonnegative().optional(),
  }).strict().optional(),
  exitCode: z.number().int().nullable(),
  error: z.string().optional(),
  models: z.array(z.string()),
  suiteVersion: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
}).strict().refine(record => record.status !== 'graded' || (record.grade !== undefined && record.grader !== undefined), 'a graded record carries grade and grader')

/** File pinning the experiment definition. */
const EXPERIMENT_FILE = 'experiment.json'
/** File holding one run record per line. */
const RUNS_FILE = 'runs.jsonl'

/**
 * Stable string key of a cell.
 * @param cell - run coordinates.
 * @returns `variant/task/rep`.
 */
export function cellKey(cell: CellKey): string {
  return `${cell.variant}/${cell.task}/${String(cell.rep)}`
}

/**
 * Read a file, mapping a missing file to `undefined`.
 * @param path - file path.
 * @returns the text, or `undefined` when the file does not exist.
 */
async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** One experiment's ledger directory. */
export class ExperimentLedger {
  /** Absolute ledger directory of this experiment. */
  readonly dir: string

  /**
   * @param root - absolute ledger root holding one directory per experiment.
   * @param experiment - the experiment this ledger records.
   */
  constructor(private readonly root: string, private readonly experiment: Experiment) {
    this.dir = join(root, experiment.id)
  }

  /**
   * Create the ledger, or reopen it when it pins the same definition.
   * @throws Error when an existing ledger pins a different definition, which would mix populations.
   */
  async open(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const pinned = JSON.stringify({ formatVersion: LEDGER_FORMAT_VERSION, ...this.experiment }, undefined, 2)
    const existing = await readOptional(join(this.dir, EXPERIMENT_FILE))
    if (existing === undefined) {
      await writeFile(join(this.dir, EXPERIMENT_FILE), `${pinned}\n`)
      return
    }
    if (existing.trimEnd() !== pinned) {
      // A ledger in another format must say so, not claim the definition changed.
      await readPinnedExperiment(this.root, this.experiment.id)
      throw new Error(`experiment ${JSON.stringify(this.experiment.id)} already has a ledger with a different definition at ${this.dir}; use a new experiment id`)
    }
  }

  /**
   * Read every recorded run.
   * @param repair - truncate a torn final line from the file. Only the runtime that
   *   appends may repair: for any other reader the last line may be an append in progress.
   * @returns the records in append order; a torn final line is ignored.
   * @throws Error on a record with an unknown format version or a corrupt interior line.
   */
  async records(repair: boolean): Promise<RunRecord[]> {
    const text = await readOptional(join(this.dir, RUNS_FILE)) ?? ''
    const lines = text.split('\n')
    // A crash mid-append leaves at most the last line without its newline.
    const torn = lines.pop() as string
    const records: RunRecord[] = []
    for (const [index, line] of lines.entries()) {
      if (line === '') continue
      let record: { formatVersion?: unknown }
      try {
        record = JSON.parse(line) as { formatVersion?: unknown }
      } catch (error) {
        throw new Error(`${join(this.dir, RUNS_FILE)}:${String(index + 1)}: corrupt run record`, { cause: error })
      }
      if (record.formatVersion !== LEDGER_FORMAT_VERSION) {
        throw new Error(`${join(this.dir, RUNS_FILE)}:${String(index + 1)}: run record format ${String(record.formatVersion)} is not readable by this build (expects ${String(LEDGER_FORMAT_VERSION)})`)
      }
      const parsed = runRecordLine.safeParse(record)
      if (!parsed.success) throw new Error(`${join(this.dir, RUNS_FILE)}:${String(index + 1)}: ${z.prettifyError(parsed.error)}`)
      records.push(parsed.data as RunRecord)
    }
    if (repair && torn !== '') await writeFile(join(this.dir, RUNS_FILE), lines.map(line => `${line}\n`).join(''))
    return records
  }

  /**
   * Append one finished run.
   * @param record - the run record.
   */
  async append(record: RunRecord): Promise<void> {
    await appendFile(join(this.dir, RUNS_FILE), `${JSON.stringify(record)}\n`)
  }
}

/** Experiment ids that are safe directory names under the ledger root. */
const EXPERIMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Read the pinned definition of one ledger without creating anything.
 * @param root - absolute ledger root.
 * @param id - experiment id; ids that are not safe directory names read as absent.
 * @returns the definition, or `undefined` when no ledger exists under `id`.
 * @throws Error when the file is malformed or carries another format version.
 */
export async function readPinnedExperiment(root: string, id: string): Promise<Experiment | undefined> {
  if (!EXPERIMENT_ID.test(id)) return undefined
  const file = join(root, id, EXPERIMENT_FILE)
  const text = await readOptional(file)
  if (text === undefined) return undefined
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new Error(`${file}: not valid JSON`, { cause: error })
  }
  const version = (json as { formatVersion?: unknown } | null)?.formatVersion
  if (version !== LEDGER_FORMAT_VERSION) {
    throw new Error(`${file}: ledger format ${String(version)} is not readable by this build (expects ${String(LEDGER_FORMAT_VERSION)})`)
  }
  const parsed = pinnedFile.safeParse(json)
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`)
  const { formatVersion: _version, ...experiment } = parsed.data
  // The schema checked every field; the brands only retag the validated id strings.
  return experiment as unknown as Experiment
}

/**
 * List the experiment ids that have a pinned definition.
 * @param root - absolute ledger root.
 * @returns the ids in name order; empty when the root does not exist.
 */
export async function listExperimentIds(root: string): Promise<ExperimentId[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const ids: ExperimentId[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Listing only checks presence; a malformed definition fails when that ledger is read.
    const pinned = entry.isDirectory() && EXPERIMENT_ID.test(entry.name)
      && await readOptional(join(root, entry.name, EXPERIMENT_FILE)) !== undefined
    if (pinned) {
      ids.push(entry.name as ExperimentId)
    }
  }
  return ids
}
