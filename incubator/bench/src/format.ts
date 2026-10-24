/** Pure formatting for the benchmark page: numbers, deltas, and the plain-language verdict of a comparison. */

import type { Comparison, ExperimentAnalysis, Verdict } from './types.js'
import type { BenchLocaleKey } from './locales.js'

/** Translator bound to the page's dictionary. */
export type BenchT = (key: BenchLocaleKey) => string

/**
 * Fill `{name}` placeholders.
 * @param template - translated text.
 * @param values - replacement per placeholder.
 * @returns the filled text; unknown placeholders stay as written.
 */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => key in values ? String(values[key]) : match)
}

/**
 * A rate as a percentage.
 * @param value - rate in [0, 1], or `null` when unmeasured.
 * @returns e.g. `42.5%`, or an em dash.
 */
export const percent = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`

/**
 * A signed difference of rates in percentage points.
 * @param value - difference of rates.
 * @returns e.g. `+12.0 pts`.
 */
export const points = (value: number): string => `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)} pts`

/**
 * A dollar amount.
 * @param value - USD, or `null` when unpriced.
 * @returns e.g. `$0.0123`, or an em dash.
 */
export const dollars = (value: number | null): string => value === null ? '—' : `$${value.toFixed(4)}`

/**
 * A duration in seconds.
 * @param ms - milliseconds, or `null` when unmeasured.
 * @returns e.g. `12.3 s`, or an em dash.
 */
export const seconds = (ms: number | null): string => ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`

/**
 * A signed value with a unit formatter.
 * @param value - the difference.
 * @param unit - formats the magnitude.
 * @returns e.g. `+$0.0100`.
 */
const signed = (value: number, unit: (magnitude: number) => string): string => `${value >= 0 ? '+' : '−'}${unit(Math.abs(value))}`

const HEADLINE: Readonly<Record<Verdict, BenchLocaleKey>> = {
  improved: 'verdictImproved',
  regressed: 'verdictRegressed',
  equivalent: 'verdictEquivalent',
  underpowered: 'verdictUnderpowered',
  insufficient: 'verdictInsufficient',
  unreliable: 'verdictUnreliable',
}

const EXPLANATION: Readonly<Record<Verdict, BenchLocaleKey>> = {
  improved: 'explainImproved',
  regressed: 'explainRegressed',
  equivalent: 'explainEquivalent',
  underpowered: 'explainUnderpowered',
  insufficient: 'explainInsufficient',
  unreliable: 'explainUnreliable',
}

/** A comparison in words. */
export interface ComparisonText {
  /** Short verdict, e.g. "Better than the baseline". */
  headline: string
  /** One sentence with the numbers behind it. */
  detail: string
  /** Cost and time differences, when measured. */
  extras: string[]
}

/**
 * Describe a comparison for people.
 * @param comparison - the comparison.
 * @param analysis - the whole analysis, for the baseline and settings.
 * @param t - translator.
 * @returns headline, detail, and extra lines.
 */
export function describeComparison(comparison: Comparison, analysis: ExperimentAnalysis, t: BenchT): ComparisonText {
  const { success } = comparison
  const rate = (id: string) => percent(analysis.variants.find(entry => entry.variant === id)?.invalidRate ?? null)
  const detail = fill(t(EXPLANATION[comparison.verdict]), {
    delta: points(success.delta),
    tasks: success.tasks,
    level: analysis.options.confidence * 100,
    low: points(success.low),
    high: points(success.high),
    margin: points(analysis.options.margin).slice(1),
    mde: success.mde === null ? '—' : points(success.mde).slice(1),
    min: analysis.options.minTasks,
    variant: comparison.variant,
    here: rate(comparison.variant),
    base: rate(analysis.baseline),
  })
  const extras: string[] = []
  if (comparison.costUsd !== null) extras.push(fill(t('costDelta'), { value: signed(comparison.costUsd.delta, magnitude => dollars(magnitude)) }))
  if (comparison.wallMs !== null) extras.push(fill(t('timeDelta'), { value: signed(comparison.wallMs.delta, magnitude => seconds(magnitude)) }))
  return { headline: t(HEADLINE[comparison.verdict]), detail, extras }
}
