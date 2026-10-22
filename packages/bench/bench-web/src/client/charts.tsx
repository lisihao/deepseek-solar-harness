/** SVG and CSS charts for the benchmark page; pure functions of the analysis. */

import type { CSSProperties } from 'react'
import type { ExperimentAnalysis } from '@deepseek-ai/dsh-bench-runner'
import { dollars, percent, type BenchT } from './format.ts'
import styles from './BenchSection.module.css'

const WIDTH = 320
const HEIGHT = 200
const PAD = 36

/**
 * Success rate against mean cost per run, one point per priced variant.
 * @param props.analysis - the experiment analysis.
 * @param props.t - translator.
 * @returns the chart, or an explanation when no variant is priced.
 */
export function ParetoChart({ analysis, t }: { readonly analysis: ExperimentAnalysis; readonly t: BenchT }) {
  const points = analysis.variants.flatMap(entry =>
    entry.meanCostUsd === null || entry.successRate === null
      ? []
      : [{ id: entry.variant, cost: entry.meanCostUsd, success: entry.successRate }])
  if (points.length === 0) return <p className={styles.muted}>{t('paretoEmpty')}</p>
  const maxCost = Math.max(...points.map(point => point.cost)) || 1
  const x = (cost: number) => PAD + (cost / maxCost) * (WIDTH - PAD * 2)
  const y = (success: number) => HEIGHT - PAD - success * (HEIGHT - PAD * 2)
  const front = new Set<string>(analysis.pareto)
  return <figure className={styles.figure}>
    <svg viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`} role="img" aria-label={t('paretoTitle')} className={styles.chart}>
      <line x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} className={styles.axis} />
      <line x1={PAD} y1={PAD} x2={PAD} y2={HEIGHT - PAD} className={styles.axis} />
      <text x={PAD - 6} y={y(1) + 4} textAnchor="end" className={styles.tick}>100%</text>
      <text x={PAD - 6} y={y(0) + 4} textAnchor="end" className={styles.tick}>0%</text>
      <text x={x(maxCost)} y={HEIGHT - PAD + 16} textAnchor="end" className={styles.tick}>{dollars(maxCost)}</text>
      {points.map(point => <g key={point.id}>
        <circle
          cx={x(point.cost)}
          cy={y(point.success)}
          r={front.has(point.id) ? 6 : 4}
          className={front.has(point.id) ? styles.front : styles.dot}
        >
          <title>{`${point.id}: ${percent(point.success)}, ${dollars(point.cost)}${front.has(point.id) ? ` · ${t('paretoFront')}` : ''}`}</title>
        </circle>
        {/* Labels on the right half sit left of their point, so they stay inside the chart. */}
        <text
          x={x(point.cost) > WIDTH / 2 ? x(point.cost) - 10 : x(point.cost) + 10}
          y={y(point.success) + 4}
          textAnchor={x(point.cost) > WIDTH / 2 ? 'end' : 'start'}
          className={styles.pointLabel}
        >{point.id}</text>
      </g>)}
    </svg>
    <figcaption className={styles.muted}>{t('paretoCaption')}</figcaption>
  </figure>
}

/**
 * Share of model, tool, and harness time per variant, as stacked bars.
 * @param props.analysis - the experiment analysis.
 * @param props.t - translator.
 * @returns the bars, or an explanation when nothing was measured.
 */
export function TimeBars({ analysis, t }: { readonly analysis: ExperimentAnalysis; readonly t: BenchT }) {
  const rows = analysis.variants.filter(entry => entry.time.llmMs + entry.time.toolCriticalMs + entry.time.overheadMs > 0)
  if (rows.length === 0) return <p className={styles.muted}>{t('timeEmpty')}</p>
  return <div className={styles.bars}>
    <ul className={styles.legend}>
      <li><span className={styles.swatchModel} />{t('timeModel')}</li>
      <li><span className={styles.swatchTools} />{t('timeTools')}</li>
      <li><span className={styles.swatchHarness} />{t('timeHarness')}</li>
    </ul>
    {rows.map((entry) => {
      const total = entry.time.llmMs + entry.time.toolCriticalMs + entry.time.overheadMs
      const share = (value: number) => `${((value / total) * 100).toFixed(1)}%`
      return <div key={entry.variant} className={styles.barRow}>
        <span className={styles.barLabel}>{entry.variant}</span>
        <div className={styles.bar} role="img" aria-label={`${entry.variant}: ${t('timeModel')} ${share(entry.time.llmMs)}, ${t('timeTools')} ${share(entry.time.toolCriticalMs)}, ${t('timeHarness')} ${share(entry.time.overheadMs)}`}>
          <span className={styles.segModel} style={{ width: share(entry.time.llmMs) }} />
          <span className={styles.segTools} style={{ width: share(entry.time.toolCriticalMs) }} />
          <span className={styles.segHarness} style={{ width: share(entry.time.overheadMs) }} />
        </div>
      </div>
    })}
  </div>
}

/**
 * Pass rate per task and variant; cell shade follows the rate.
 * @param props.analysis - the experiment analysis.
 * @param props.t - translator.
 * @returns the table.
 */
export function PassMatrix({ analysis, t }: { readonly analysis: ExperimentAnalysis; readonly t: BenchT }) {
  const variants = analysis.variants.map(entry => entry.variant)
  return <div className={styles.tableWrap}>
    <table className={styles.table}>
      <thead>
        <tr><th scope="col">{t('task')}</th>{variants.map(id => <th key={id} scope="col" className={styles.num}>{id}</th>)}</tr>
      </thead>
      <tbody>
        {analysis.matrix.map(row => <tr key={row.task}>
          <th scope="row"><code>{row.task}</code></th>
          {variants.map((id) => {
            // The analysis writes every variant into every row, null where the variant never ran the task.
            const rate = row.rates[id] as number | null
            return rate === null
              ? <td key={id} className={styles.num}><span className={styles.muted}>{t('notRun')}</span></td>
              : <td key={id} className={styles.heat} style={{ '--rate': String(rate) } as CSSProperties}>{percent(rate)}</td>
          })}
        </tr>)}
      </tbody>
    </table>
  </div>
}
