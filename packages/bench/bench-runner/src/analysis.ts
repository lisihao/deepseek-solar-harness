/**
 * Experiment analysis: per-variant summaries and paired comparisons against
 * the baseline, computed from ledger records alone.
 *
 * A comparison averages per-task differences (variant − baseline) over the
 * tasks both sides ran validly, so every task weighs the same whatever its
 * repetition count. Intervals come from a seeded percentile bootstrap over
 * tasks. Invalid runs are excluded from success rates but are counted, and a
 * variant that invalidates more runs than the baseline is marked
 * `unreliable` instead of looking better for losing its failures.
 *
 * @module @deepseek-ai/dsh-bench-runner/analysis
 */

import type { BenchTaskId } from '@deepseek-ai/dsh-bench'
import type {
  AnalysisOptions,
  Comparison,
  Estimate,
  Experiment,
  ExperimentAnalysis,
  RunMetrics,
  RunRecord,
  TimeShare,
  ToolTotals,
  Verdict,
  VariantId,
  VariantSummary,
} from './types.ts'

/** Two-sided standard-normal quantiles of the supported confidence levels. */
const Z: Readonly<Record<AnalysisOptions['confidence'], number>> = { 0.9: 1.6449, 0.95: 1.96, 0.99: 2.5758 }
/** Standard-normal quantile for 80% power, the conventional MDE target. */
const Z_POWER = 0.8416

/**
 * Student-t quantile from the normal quantile by the Cornish-Fisher expansion;
 * within 1% of the exact value from 3 degrees of freedom up.
 * @param z - standard-normal quantile.
 * @param df - degrees of freedom, at least 1.
 * @returns the t quantile.
 */
function tQuantile(z: number, df: number): number {
  const z3 = z ** 3
  const z5 = z ** 5
  const z7 = z ** 7
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2) + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
}

/**
 * Deterministic 32-bit generator (mulberry32).
 * @param seed - initial state.
 * @returns a function yielding uniform values in [0, 1).
 */
function generator(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

const mean = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * Interval and MDE of the mean of per-task differences.
 * @param diffs - one difference per paired task; non-empty.
 * @param options - confidence, resamples, and seed.
 * @returns the estimate.
 */
function estimate(diffs: readonly number[], options: AnalysisOptions): Estimate {
  const n = diffs.length
  const delta = mean(diffs)
  const random = generator(options.seed)
  const means: number[] = []
  for (let r = 0; r < options.resamples; r += 1) {
    let sum = 0
    for (let i = 0; i < n; i += 1) sum += diffs[Math.floor(random() * n)] as number
    means.push(sum / n)
  }
  means.sort((a, b) => a - b)
  const tail = (1 - options.confidence) / 2
  const at = (q: number): number => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))] as number
  let mde: number | null = null
  if (n >= 2) {
    const sd = Math.sqrt(diffs.reduce((sum, value) => sum + (value - delta) ** 2, 0) / (n - 1))
    mde = (tQuantile(Z[options.confidence], n - 1) + tQuantile(Z_POWER, n - 1)) * sd / Math.sqrt(n)
  }
  return { delta, low: at(tail), high: at(1 - tail), mde, tasks: n }
}

/** Valid-run tallies of one (variant, task). */
interface TaskCell {
  valid: number
  passed: number
  cost: number[]
  tokens: number[]
  wall: number[]
}

const success = (record: RunRecord): boolean => record.status === 'graded' && record.grade?.pass === true
const totalTokens = (metrics: RunMetrics): number => metrics.tokens.input + metrics.tokens.cacheRead + metrics.tokens.output

/**
 * Fold one variant's records into its per-task cells and summary.
 * @param variant - the variant.
 * @param records - that variant's records.
 * @param tasks - every task id in the experiment, in order.
 * @returns the cells keyed by task and the summary.
 */
function summarize(
  variant: VariantId,
  records: readonly RunRecord[],
  tasks: readonly BenchTaskId[],
): { cells: Map<BenchTaskId, TaskCell>; summary: VariantSummary } {
  const cells = new Map<BenchTaskId, TaskCell>()
  const time: TimeShare = { llmMs: 0, toolCriticalMs: 0, overheadMs: 0 }
  const tools = new Map<string, ToolTotals>()
  const costs: number[] = []
  const tokens: number[] = []
  const walls: number[] = []
  let graded = 0
  let timeouts = 0
  let invalid = 0
  let passed = 0
  for (const record of records) {
    if (record.status === 'invalid') {
      invalid += 1
      continue
    }
    if (record.status === 'graded') graded += 1
    else timeouts += 1
    const cell = cells.get(record.cell.task) ?? { valid: 0, passed: 0, cost: [], tokens: [], wall: [] }
    cells.set(record.cell.task, cell)
    cell.valid += 1
    if (success(record)) {
      cell.passed += 1
      passed += 1
    }
    const metrics = record.metrics
    if (metrics === undefined) continue
    if (metrics.costUsd !== undefined) {
      costs.push(metrics.costUsd)
      cell.cost.push(metrics.costUsd)
    }
    const total = totalTokens(metrics)
    tokens.push(total)
    cell.tokens.push(total)
    if (record.status !== 'graded') continue
    walls.push(metrics.timing.wallMs)
    cell.wall.push(metrics.timing.wallMs)
    time.llmMs += metrics.timing.llmMs
    time.toolCriticalMs += metrics.timing.toolCriticalMs
    time.overheadMs += metrics.timing.overheadMs
    for (const [name, stats] of Object.entries(metrics.tools)) {
      const totals = tools.get(name) ?? { name, calls: 0, errors: 0, totalMs: 0 }
      tools.set(name, totals)
      totals.calls += stats.calls
      totals.errors += stats.errors
      totals.totalMs += stats.totalMs
    }
  }
  const validTasks = tasks.filter(task => cells.has(task))
  const rateOf = (count: number): number | null => validTasks.length === 0 ? null : count / validTasks.length
  const valid = graded + timeouts
  const summary: VariantSummary = {
    variant,
    runs: records.length,
    graded,
    timeouts,
    invalid,
    invalidRate: records.length === 0 ? 0 : invalid / records.length,
    successRate: valid === 0 ? null : passed / valid,
    passAnyRate: rateOf(validTasks.filter(task => (cells.get(task) as TaskCell).passed > 0).length),
    passAllRate: rateOf(validTasks.filter((task) => {
      const cell = cells.get(task) as TaskCell
      return cell.passed === cell.valid
    }).length),
    meanCostUsd: costs.length === 0 ? null : mean(costs),
    pricedRuns: costs.length,
    meanTokens: tokens.length === 0 ? null : mean(tokens),
    meanWallMs: walls.length === 0 ? null : mean(walls),
    time,
    tools: [...tools.values()].sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name)),
    flakyTasks: validTasks.filter((task) => {
      const cell = cells.get(task) as TaskCell
      return cell.passed > 0 && cell.passed < cell.valid
    }),
  }
  return { cells, summary }
}

/**
 * Paired estimate of one per-task quantity, over tasks where both sides have values.
 * @param tasks - candidate tasks.
 * @param base - baseline cells.
 * @param other - variant cells.
 * @param pick - the per-cell values to average.
 * @param options - statistical settings.
 * @returns the estimate, or `null` when no task has values on both sides.
 */
function paired(
  tasks: readonly BenchTaskId[],
  base: ReadonlyMap<BenchTaskId, TaskCell>,
  other: ReadonlyMap<BenchTaskId, TaskCell>,
  pick: (cell: TaskCell) => readonly number[],
  options: AnalysisOptions,
): Estimate | null {
  const diffs: number[] = []
  for (const task of tasks) {
    const a = base.get(task)
    const b = other.get(task)
    if (a === undefined || b === undefined || pick(a).length === 0 || pick(b).length === 0) continue
    diffs.push(mean(pick(b)) - mean(pick(a)))
  }
  return diffs.length === 0 ? null : estimate(diffs, options)
}

/**
 * Verdict of a success estimate.
 * @param success - the estimate.
 * @param invalidGap - variant invalid rate minus baseline invalid rate.
 * @param options - thresholds.
 * @returns the verdict.
 */
function verdictOf(success: Estimate, invalidGap: number, options: AnalysisOptions): Verdict {
  if (invalidGap > options.invalidTolerance) return 'unreliable'
  if (success.tasks < options.minTasks) return 'insufficient'
  if (success.low > 0) return 'improved'
  if (success.high < 0) return 'regressed'
  if (success.low >= -options.margin && success.high <= options.margin) return 'equivalent'
  return 'underpowered'
}

/**
 * Reject settings that would produce meaningless intervals.
 * @param options - the settings.
 */
function validate(options: AnalysisOptions): void {
  if (!Number.isInteger(options.resamples) || options.resamples < 100) throw new Error('analysis resamples must be an integer of at least 100')
  if (!Number.isInteger(options.minTasks) || options.minTasks < 3) throw new Error('analysis minTasks must be an integer of at least 3')
  if (!(options.margin >= 0 && options.margin < 1)) throw new Error('analysis margin must be in [0, 1)')
  if (!(options.invalidTolerance >= 0 && options.invalidTolerance <= 1)) throw new Error('analysis invalidTolerance must be in [0, 1]')
  if (!Number.isInteger(options.seed)) throw new Error('analysis seed must be an integer')
}

/**
 * Analyze an experiment's records.
 * @param experiment - the experiment definition; its first variant is the baseline.
 * @param records - the ledger records.
 * @param options - statistical settings.
 * @returns summaries, comparisons, the pass-rate matrix, and the Pareto set.
 * @throws Error on invalid settings.
 */
export function analyzeExperiment(experiment: Experiment, records: readonly RunRecord[], options: AnalysisOptions): ExperimentAnalysis {
  validate(options)
  const tasks = [...new Set(records.map(record => record.cell.task))]
  const folded = experiment.variants.map(variant =>
    summarize(variant.id, records.filter(record => record.cell.variant === variant.id), tasks))
  const [baseline, ...others] = folded as [(typeof folded)[number], ...typeof folded]
  const comparisons: Comparison[] = others.map(({ cells, summary }) => {
    const pairedTasks = tasks.filter(task => baseline.cells.has(task) && cells.has(task))
    const droppedTasks = tasks.filter(task => !pairedTasks.includes(task))
    const success = paired(pairedTasks, baseline.cells, cells, cell => [cell.passed / cell.valid], options)
      ?? { delta: 0, low: 0, high: 0, mde: null, tasks: 0 }
    return {
      variant: summary.variant,
      success,
      costUsd: paired(pairedTasks, baseline.cells, cells, cell => cell.cost, options),
      tokens: paired(pairedTasks, baseline.cells, cells, cell => cell.tokens, options),
      wallMs: paired(pairedTasks, baseline.cells, cells, cell => cell.wall, options),
      droppedTasks,
      verdict: verdictOf(success, summary.invalidRate - baseline.summary.invalidRate, options),
    }
  })
  const priced = folded.map(entry => entry.summary).flatMap(summary =>
    summary.meanCostUsd === null || summary.successRate === null
      ? []
      : [{ variant: summary.variant, success: summary.successRate, cost: summary.meanCostUsd }])
  // A point is dominated when another is at least as good on both axes and strictly better on one.
  const pareto = priced.filter(candidate => !priced.some(other =>
    other.success >= candidate.success && other.cost <= candidate.cost
    && (other.success > candidate.success || other.cost < candidate.cost)))
  return {
    baseline: baseline.summary.variant,
    variants: folded.map(entry => entry.summary),
    comparisons,
    matrix: tasks.map(task => ({
      task,
      rates: Object.fromEntries(folded.map(({ cells, summary }) => {
        const cell = cells.get(task)
        return [summary.variant, cell === undefined ? null : cell.passed / cell.valid]
      })),
    })),
    pareto: pareto.map(point => point.variant),
    options,
  }
}
