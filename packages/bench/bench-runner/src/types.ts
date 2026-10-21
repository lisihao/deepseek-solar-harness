/**
 * Experiment definitions and the durable run record the benchmark runner
 * appends to its ledger.
 * @module @deepseek-ai/dsh-bench-runner/types
 */

import type { BenchSuiteId, BenchTaskId, GradeResult } from '@deepseek-ai/dsh-bench'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Experiment key; also the experiment's directory name under the ledger root. */
export type ExperimentId = Branded<'ExperimentId'>

/** Variant key, unique within one experiment. */
export type VariantId = Branded<'VariantId'>

/** One DSH composition under test. */
export interface Variant {
  /** Variant key. */
  id: VariantId
  /** Absolute `--patch` overlay paths, applied in order after the profile layer. */
  patches: readonly string[]
  /**
   * Extra child environment. `{cell}` in a value expands to the run's private
   * state directory, which redirects plugin state kept outside `$DSH_HOME`
   * (for example `MNEMON_DATA_DIR: '{cell}/mnemon'`).
   */
  env: Readonly<Record<string, string>>
}

/** A resolved experiment: suite × variants × repetitions. */
export interface Experiment {
  /** Experiment key. */
  id: ExperimentId
  /** Suite whose tasks are run. */
  suite: BenchSuiteId
  /** Profile booted for every run (`dsh --profile <profile>`). */
  profile: string
  /** Runs per (task, variant). */
  repetitions: number
  /** Task subset in suite order; absent runs every task. */
  tasks?: readonly BenchTaskId[]
  /** Compositions under test; the first is the baseline. */
  variants: readonly Variant[]
}

/** Coordinates of one run inside an experiment. */
export interface CellKey {
  /** Variant under test. */
  variant: VariantId
  /** Task being run. */
  task: BenchTaskId
  /** Zero-based repetition index. */
  rep: number
}

/** Token totals over every session of one run, subagent children included. */
export interface RunTokens {
  /** Provider-reported prompt tokens not served from cache. */
  input: number
  /** Provider-reported completion tokens. */
  output: number
  /** Prompt tokens served from the provider cache. */
  cacheRead: number
  /** Assistant messages that carried no usage report and are missing from the totals. */
  unreportedMessages: number
}

/** Wall-time split of one run's root session, in milliseconds. */
export interface RunTiming {
  /** First to last root-session event. */
  wallMs: number
  /** Sum over steps of `step/start` → `assistant/message`. */
  llmMs: number
  /**
   * Sum over steps of the longest `tool/call` → `tool/result` interval in the
   * step: parallel calls overlap, so the step waits for the slowest one.
   */
  toolCriticalMs: number
  /** `wallMs - llmMs - toolCriticalMs`, floored at 0: time spent in the harness and its plugins. */
  overheadMs: number
}

/** Per-tool counts over the root session. */
export interface ToolStats {
  /** Calls issued. */
  calls: number
  /** Results that carried an error. */
  errors: number
  /** Sum of call → result intervals. */
  totalMs: number
}

/** Metrics folded from one run's session logs. */
export interface RunMetrics {
  /** Distinct turns in the root session. */
  turns: number
  /** `step/end` events in the root session. */
  steps: number
  /** Token totals. */
  tokens: RunTokens
  /** Time split. */
  timing: RunTiming
  /** Per-tool stats keyed by tool name. */
  tools: Readonly<Record<string, ToolStats>>
  /** `llm/retry` events in the root session. */
  retries: number
  /** Sessions in the run, root included. */
  sessions: number
  /** Cost from the configured price table; absent when a used model has no price row. */
  costUsd?: number
}

/** Terminal state of one run. */
export type RunStatus =
  /** The child exited and the grader scored the run. */
  | 'graded'
  /** The child exceeded the run timeout and was killed; ungraded, counted as a failure. */
  | 'timeout'
  /** The run could not be measured (no session log, grader error); excluded from success rates. */
  | 'invalid'

/** One ledger line: everything needed to analyze and reproduce one run. */
export interface RunRecord {
  /** Ledger format version; readers refuse records with another value. */
  formatVersion: 1
  /** Run coordinates. */
  cell: CellKey
  /** Terminal state. */
  status: RunStatus
  /** Grader verdict; present when `status` is `graded`. */
  grade?: GradeResult
  /** Grader kind and version that produced `grade`. */
  grader?: { kind: string; version: number }
  /** Folded metrics; absent when no session log could be read (an `invalid` run, or a `timeout` killed before persisting). */
  metrics?: RunMetrics
  /** Child exit code; `null` when killed. */
  exitCode: number | null
  /** Why the run is `invalid`. */
  error?: string
  /** Models named by assistant messages, sorted. */
  models: readonly string[]
  /** Suite content version at run time. */
  suiteVersion: string
  /** Epoch milliseconds when the run started and ended. */
  startedAt: number
  /** Epoch milliseconds when the run ended. */
  endedAt: number
}

/** Progress notification for one finished run. */
export interface RunProgress {
  /** The run just recorded. */
  record: RunRecord
  /** Runs recorded so far, including earlier resumed ones. */
  done: number
  /** Runs in the whole experiment. */
  total: number
}

/** Statistical settings of {@link analyzeExperiment}; every value is an explicit choice of the caller. */
export interface AnalysisOptions {
  /** Two-sided confidence level of the intervals. */
  confidence: 0.9 | 0.95 | 0.99
  /** Bootstrap resamples per interval. */
  resamples: number
  /** Seed of the bootstrap generator; equal inputs and seed give equal intervals. */
  seed: number
  /** Success-rate difference treated as practically zero, for the `equivalent` verdict. */
  margin: number
  /** Paired tasks below which a comparison is `insufficient`. At least 3. */
  minTasks: number
  /** Invalid-rate excess over the baseline above which a comparison is `unreliable`. */
  invalidTolerance: number
}

/** A paired difference against the baseline, averaged over tasks. */
export interface Estimate {
  /** Mean over paired tasks of (variant − baseline). */
  delta: number
  /** Lower bound of the bootstrap percentile interval. */
  low: number
  /** Upper bound of the bootstrap percentile interval. */
  high: number
  /** Smallest difference detectable at 80% power with this many tasks and this spread; `null` below 2 tasks. */
  mde: number | null
  /** Tasks contributing a difference. */
  tasks: number
}

/**
 * How a variant's success rate compares with the baseline.
 * - `improved` / `regressed`: the interval excludes 0.
 * - `equivalent`: the interval lies inside ±margin.
 * - `underpowered`: neither; more tasks or repetitions are needed.
 * - `insufficient`: fewer paired tasks than `minTasks`.
 * - `unreliable`: the variant invalidates runs more often than the baseline by more than `invalidTolerance`.
 */
export type Verdict = 'improved' | 'regressed' | 'equivalent' | 'underpowered' | 'insufficient' | 'unreliable'

/** Time spent in one bucket summed over measured runs. */
export interface TimeShare {
  /** Model wait. */
  llmMs: number
  /** Slowest tool call per step. */
  toolCriticalMs: number
  /** Harness and plugin time. */
  overheadMs: number
}

/** Per-tool totals over a variant's measured runs. */
export interface ToolTotals extends ToolStats {
  /** Tool name. */
  name: string
}

/** One variant's runs, before any comparison. */
export interface VariantSummary {
  /** Variant key. */
  variant: VariantId
  /** Recorded runs. */
  runs: number
  /** Runs per terminal state. */
  graded: number
  /** Runs killed at the timeout; counted as failures. */
  timeouts: number
  /** Runs that could not be measured; excluded from success rates and reported here. */
  invalid: number
  /** `invalid / runs`. */
  invalidRate: number
  /** Passing runs over graded and timed-out runs; `null` when there are none. */
  successRate: number | null
  /** Tasks with at least one passing run, over tasks with a valid run. */
  passAnyRate: number | null
  /** Tasks whose every valid run passed, over tasks with a valid run. */
  passAllRate: number | null
  /** Mean cost over runs carrying `costUsd`. */
  meanCostUsd: number | null
  /** Runs carrying `costUsd`. */
  pricedRuns: number
  /** Mean of input + cache-read + output tokens over runs carrying metrics. */
  meanTokens: number | null
  /** Mean wall time over graded runs; timeouts are excluded because their time is truncated. */
  meanWallMs: number | null
  /** Time buckets summed over graded runs. */
  time: TimeShare
  /** Tools by descending total time. */
  tools: readonly ToolTotals[]
  /** Tasks whose valid runs disagree. */
  flakyTasks: readonly BenchTaskId[]
}

/** One non-baseline variant against the baseline. */
export interface Comparison {
  /** The compared variant. */
  variant: VariantId
  /** Success-rate difference. */
  success: Estimate
  /** Cost difference in USD, over tasks priced on both sides; `null` when none are. */
  costUsd: Estimate | null
  /** Token difference. */
  tokens: Estimate | null
  /** Wall-time difference in milliseconds, over graded runs. */
  wallMs: Estimate | null
  /** Tasks without a valid run on both sides, left out of `success`. */
  droppedTasks: readonly BenchTaskId[]
  /** The success verdict. */
  verdict: Verdict
}

/** The full analysis of one experiment. */
export interface ExperimentAnalysis {
  /** The baseline variant (the experiment's first). */
  baseline: VariantId
  /** Every variant, in experiment order. */
  variants: readonly VariantSummary[]
  /** Every non-baseline variant against the baseline. */
  comparisons: readonly Comparison[]
  /** Pass rate per task and variant; `null` where a variant has no valid run of the task. */
  matrix: readonly { task: BenchTaskId; rates: Readonly<Record<string, number | null>> }[]
  /** Variants not beaten on both success rate and mean cost by another priced variant. */
  pareto: readonly VariantId[]
  /** The settings used. */
  options: AnalysisOptions
}

/** One experiment's ledger as read by a consumer. */
export interface LedgerSnapshot {
  /** The pinned definition. */
  experiment: Experiment
  /** Records in append order. */
  records: RunRecord[]
}
