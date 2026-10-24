/**
 * Type vocabulary of the benchmark plugin: suites of tasks, the graders that
 * score one finished run, experiment definitions, and the durable run record
 * appended to the experiment ledger.
 * @module @lisihao/dsh-solar-bench/types
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Registry key of one benchmark suite; unique within `ctx.solarBenchmarks`. */
export type BenchSuiteId = string

/** Task key; unique within its suite and stable across suite versions. */
export type BenchTaskId = string

/** Experiment key; also the experiment's directory name under the ledger root. */
export type ExperimentId = string

/** Variant key, unique within one experiment. */
export type VariantId = string

/**
 * Grader selection plus its parameters. `kind` names a registered grader; the
 * remaining fields are that grader's parameters, checked by its `validate`.
 */
export interface GraderSpec {
  /** Registered grader kind. */
  kind: string
  /** Grader-specific parameters. */
  [parameter: string]: unknown
}

/** One benchmark task: what the agent is asked and how its run is scored. */
export interface BenchTask {
  /** Task key, unique within the suite. */
  id: BenchTaskId
  /** The user message sent as the run's single turn. */
  prompt: string
  /**
   * Absolute directory whose contents seed the run workspace. Absent means
   * the run starts in an empty workspace.
   */
  fixture?: string
  /** How the finished run is scored. */
  grader: GraderSpec
  /** Free-form labels for filtering and per-group reporting. */
  tags: readonly string[]
}

/** A named, versioned set of tasks contributed by a plugin. */
export interface BenchSuite {
  /** Registry key. */
  id: BenchSuiteId
  /**
   * Content version recorded with every run. Change it whenever a task's
   * prompt, fixture, or grader changes, so results from different task
   * contents are never compared as one population.
   */
  version: string
  /** One-sentence description shown when choosing a suite. */
  description: string
  /**
   * Materialize the task list. Task ids must be unique.
   * @param signal - aborts a slow load.
   * @returns the suite's tasks in a stable order.
   */
  load(signal?: AbortSignal): Promise<readonly BenchTask[]>
}

/** Everything a grader may inspect about one finished run. */
export interface GradeInput {
  /** Absolute path of the run workspace after the agent finished. */
  workspace: string
  /** The run's complete session log, in seq order. */
  events: readonly SessionEvent[]
  /** Aborts grading, for example when the experiment is cancelled. */
  signal?: AbortSignal
}

/** A grader's verdict on one run. */
export interface GradeResult {
  /** Whether the run meets the task's success condition. */
  pass: boolean
  /** Partial credit in [0, 1]; binary graders return 0 or 1. */
  score: number
  /** Short human-readable reason, shown in run details. */
  details: string
}

/** Scores finished runs for every task whose spec names its `kind`. */
export interface BenchGrader {
  /** Registry key referenced by {@link GraderSpec.kind}. */
  kind: string
  /**
   * Scoring-semantics version recorded with every graded run. Bump it when a
   * spec would now grade differently, so old and new grades are not pooled.
   */
  version: number
  /**
   * Reject malformed parameters before any run starts.
   * @param spec - the task's grader spec.
   * @throws Error naming the bad parameter when the spec is invalid.
   */
  validate(spec: GraderSpec): void
  /**
   * Score one finished run. Called only with specs that passed `validate`.
   * @param spec - the task's grader spec.
   * @param input - workspace and session log of the finished run.
   * @returns the verdict.
   */
  grade(spec: GraderSpec, input: GradeInput): Promise<GradeResult>
}
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
  /** Invalid-rate difference from the baseline, in either direction, above which a comparison is `unreliable`. */
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
 * - `unreliable`: the variant's and the baseline's invalid rates differ by more than `invalidTolerance`.
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
