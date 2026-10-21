/**
 * HTTP response bodies served under {@link BENCH_API_PATH}.
 * @module @deepseek-ai/dsh-bench-web/contracts
 */

import type { Experiment, ExperimentAnalysis, RunRecord } from '@deepseek-ai/dsh-bench-runner'

/** Route prefix of the benchmark read API. */
export const BENCH_API_PATH = '/api/bench'

/** One row of `GET /api/bench/experiments`. */
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

/** Body of `GET /api/bench/experiments`. */
export interface BenchExperimentList {
  /** Readable experiments in id order. */
  experiments: BenchExperimentListItem[]
  /** Ledgers whose files could not be read, with the reason; listed instead of failing the whole response. */
  unreadable: { id: string; message: string }[]
}

/** Body of `GET /api/bench/experiments/<id>`. */
export interface BenchExperimentDetail {
  /** The pinned definition. */
  experiment: Experiment
  /** Every record in append order. */
  records: RunRecord[]
  /** Analysis of `records` with the plugin's configured settings. */
  analysis: ExperimentAnalysis
}

/** Body of every non-2xx response. */
export interface BenchApiError {
  /** Stable error code. */
  error: 'UNAUTHORIZED' | 'REMOTE_AUTH_UNAVAILABLE' | 'NOT_FOUND' | 'METHOD_NOT_ALLOWED' | 'READ_FAILED'
  /** Human-readable detail. */
  message?: string
}
