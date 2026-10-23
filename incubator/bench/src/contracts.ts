/**
 * Bodies returned by the owner-only `solarBenchLedgers` Remote service that
 * the Settings page reads.
 * @module @lisihao/dsh-solar-bench/contracts
 */

import type { Experiment, ExperimentAnalysis, RunRecord } from './types.js'

/** One row of {@link BenchExperimentList}. */
export interface BenchExperimentListItem {
  /** Experiment id. */
  id: string
  /** Suite id. */
  suite: string
  /** Variant ids in experiment order; the first is the baseline. */
  variants: string[]
  /** Runs per (task, variant). */
  repetitions: number
  /** Recorded runs. */
  runs: number
  /** End time of the latest recorded run, epoch milliseconds; `null` before the first run. */
  lastEndedAt: number | null
}

/** Result of `solarBenchLedgers.list()`. */
export interface BenchExperimentList {
  /** Absolute ledger root that was listed. */
  root: string
  /** Readable experiments in id order. */
  experiments: BenchExperimentListItem[]
  /** Ledgers whose files could not be read, with the reason; listed instead of failing the whole result. */
  unreadable: { id: string; message: string }[]
}

/** Result of `solarBenchLedgers.detail({ id })`. */
export interface BenchExperimentDetail {
  /** The pinned definition. */
  experiment: Experiment
  /** Every record in append order. */
  records: RunRecord[]
  /** Analysis of `records` with the plugin's configured settings. */
  analysis: ExperimentAnalysis
}

/** Input of `solarBenchLedgers.detail`. */
export interface BenchDetailInput {
  /** Experiment id. */
  id: string
}

/** What the Settings page calls. */
export interface BenchLedgersApi {
  list(): Promise<BenchExperimentList>
  detail(input: BenchDetailInput): Promise<BenchExperimentDetail>
}
