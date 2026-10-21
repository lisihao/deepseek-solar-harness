/**
 * Type vocabulary of the benchmark capability: suites of tasks, the graders
 * that score one finished run, and the result a grader returns.
 * @module @deepseek-ai/dsh-bench/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Registry key of one benchmark suite; unique within `ctx.benchmarks`. */
export type BenchSuiteId = Branded<'BenchSuiteId'>

/** Task key; unique within its suite and stable across suite versions. */
export type BenchTaskId = Branded<'BenchTaskId'>

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
