/** Read-only Benchmarks page: comparisons with the baseline, variants, time, cost, and per-task results. Pure render functions of the read API. */

import { createElement as h, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { BenchExperimentDetail, BenchExperimentList, BenchLedgersApi } from './contracts.js'
import { describeComparison, dollars, fill, percent, seconds, type BenchT } from './format.js'
import type { ExperimentAnalysis } from './types.js'

const pageStyle: CSSProperties = {
  display: 'grid',
  gap: 14,
  minWidth: 0,
  width: '100%',
  boxSizing: 'border-box',
  padding: 16,
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-base)',
}

const cardStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
  minWidth: 0,
  padding: 14,
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 10,
  background: 'var(--dsw-alias-settings-card-fill)',
}

const headingStyle: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600, overflowWrap: 'anywhere' }

const mutedStyle: CSSProperties = { margin: 0, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' }

const buttonStyle: CSSProperties = {
  minHeight: 32,
  maxWidth: '100%',
  padding: '6px 10px',
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'inherit',
  cursor: 'pointer',
  overflowWrap: 'anywhere',
}

const tableWrapStyle: CSSProperties = { minWidth: 0, maxWidth: '100%', overflowX: 'auto' }
const tableStyle: CSSProperties = { borderCollapse: 'collapse', width: '100%', fontSize: 13 }
const cellStyle: CSSProperties = { padding: '6px 8px', borderBottom: '1px solid var(--dsw-alias-settings-card-stroke)', textAlign: 'left', whiteSpace: 'nowrap' }
const numStyle: CSSProperties = { ...cellStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

const SEGMENTS = [
  { key: 'llmMs', label: 'timeModel', color: 'var(--dsw-alias-brand-primary)' },
  { key: 'toolCriticalMs', label: 'timeTools', color: 'var(--dsw-alias-state-success-primary)' },
  { key: 'overheadMs', label: 'timeHarness', color: 'var(--dsw-alias-state-warning-primary)' },
] as const

function card(key: string, title: string, children: ReactNode): ReactElement {
  return h('section', { key, style: cardStyle, 'aria-label': title }, [h('h3', { key: 'title', style: headingStyle }, title), children])
}

/** Success rate against mean cost per run, one point per priced variant. */
export function ParetoChart({ analysis, t }: { readonly analysis: ExperimentAnalysis; readonly t: BenchT }): ReactElement {
  const points = analysis.variants.flatMap(entry =>
    entry.meanCostUsd === null || entry.successRate === null ? [] : [{ id: entry.variant, cost: entry.meanCostUsd, success: entry.successRate }])
  if (points.length === 0) return h('p', { style: mutedStyle }, t('paretoEmpty'))
  const width = 320
  const height = 200
  const pad = 36
  const maxCost = Math.max(...points.map(point => point.cost)) || 1
  const x = (cost: number) => pad + (cost / maxCost) * (width - pad * 2)
  const y = (success: number) => height - pad - success * (height - pad * 2)
  const front = new Set<string>(analysis.pareto)
  const tick = { fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' }
  const axis = { stroke: 'var(--dsw-alias-settings-card-stroke)' }
  return h('figure', { style: { margin: 0, display: 'grid', gap: 6, minWidth: 0 } }, [
    h('svg', { key: 'svg', viewBox: `0 0 ${String(width)} ${String(height)}`, role: 'img', 'aria-label': t('paretoTitle'), style: { width: '100%', maxWidth: 420, height: 'auto' } }, [
      h('line', { key: 'x', x1: pad, y1: height - pad, x2: width - pad, y2: height - pad, ...axis }),
      h('line', { key: 'y', x1: pad, y1: pad, x2: pad, y2: height - pad, ...axis }),
      h('text', { key: 't1', x: pad - 6, y: y(1) + 4, textAnchor: 'end', ...tick }, '100%'),
      h('text', { key: 't0', x: pad - 6, y: y(0) + 4, textAnchor: 'end', ...tick }, '0%'),
      h('text', { key: 'tc', x: x(maxCost), y: height - pad + 16, textAnchor: 'end', ...tick }, dollars(maxCost)),
      ...points.map((point) => {
        const onFront = front.has(point.id)
        // Labels on the right half sit left of their point, so they stay inside the chart.
        const right = x(point.cost) > width / 2
        return h('g', { key: point.id }, [
          h('circle', { key: 'dot', cx: x(point.cost), cy: y(point.success), r: onFront ? 6 : 4, fill: onFront ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-tertiary)' },
            h('title', {}, `${point.id}: ${percent(point.success)}, ${dollars(point.cost)}${onFront ? ` · ${t('paretoFront')}` : ''}`)),
          h('text', { key: 'label', x: right ? x(point.cost) - 10 : x(point.cost) + 10, y: y(point.success) + 4, textAnchor: right ? 'end' : 'start', fontSize: 11, fill: 'var(--dsw-alias-label-primary)' }, point.id),
        ])
      }),
    ]),
    h('figcaption', { key: 'caption', style: mutedStyle }, t('paretoCaption')),
  ])
}

/** Share of model, tool, and harness time per variant, as stacked bars. */
export function TimeBars({ analysis, t }: { readonly analysis: ExperimentAnalysis; readonly t: BenchT }): ReactElement {
  const rows = analysis.variants.filter(entry => entry.time.llmMs + entry.time.toolCriticalMs + entry.time.overheadMs > 0)
  if (rows.length === 0) return h('p', { style: mutedStyle }, t('timeEmpty'))
  return h('div', { style: { display: 'grid', gap: 8, minWidth: 0 } }, [
    h('ul', { key: 'legend', style: { display: 'flex', flexWrap: 'wrap', gap: 12, margin: 0, padding: 0, listStyle: 'none', fontSize: 12 } },
      SEGMENTS.map(segment => h('li', { key: segment.key, style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
        h('span', { key: 'swatch', style: { width: 10, height: 10, borderRadius: 2, background: segment.color } }),
        t(segment.label),
      ]))),
    ...rows.map((entry) => {
      const total = entry.time.llmMs + entry.time.toolCriticalMs + entry.time.overheadMs
      const share = (value: number) => `${((value / total) * 100).toFixed(1)}%`
      const label = SEGMENTS.map(segment => `${t(segment.label)} ${share(entry.time[segment.key])}`).join(', ')
      return h('div', { key: entry.variant, style: { display: 'grid', gridTemplateColumns: 'minmax(0, 8em) minmax(0, 1fr)', gap: 8, alignItems: 'center' } }, [
        h('span', { key: 'name', style: { overflowWrap: 'anywhere', fontSize: 13 } }, entry.variant),
        h('div', { key: 'bar', role: 'img', 'aria-label': `${entry.variant}: ${label}`, title: label, style: { display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', background: 'var(--dsw-alias-bg-module-platform)' } },
          SEGMENTS.map(segment => h('span', { key: segment.key, style: { width: share(entry.time[segment.key]), background: segment.color } }))),
      ])
    }),
  ])
}

/** Pass rate per task and variant; cell shade follows the rate. */
export function PassMatrix({ analysis, t }: { readonly analysis: ExperimentAnalysis; readonly t: BenchT }): ReactElement {
  const variants = analysis.variants.map(entry => entry.variant)
  return h('div', { style: tableWrapStyle }, h('table', { style: tableStyle }, [
    h('thead', { key: 'head' }, h('tr', {}, [
      h('th', { key: 'task', scope: 'col', style: cellStyle }, t('task')),
      ...variants.map(id => h('th', { key: id, scope: 'col', style: numStyle }, id)),
    ])),
    h('tbody', { key: 'body' }, analysis.matrix.map(row => h('tr', { key: row.task }, [
      h('th', { key: 'task', scope: 'row', style: { ...cellStyle, fontWeight: 400 } }, h('code', {}, row.task)),
      ...variants.map((id) => {
        // The analysis writes every variant into every row, null where the variant never ran the task.
        const rate = row.rates[id] ?? null
        if (rate === null) return h('td', { key: id, style: numStyle }, h('span', { style: mutedStyle }, t('notRun')))
        const shade = `color-mix(in srgb, var(--dsw-alias-state-success-primary) ${String(Math.round(rate * 45))}%, transparent)`
        return h('td', { key: id, style: { ...numStyle, background: shade } }, percent(rate))
      }),
    ]))),
  ]))
}

/** One experiment's results. */
export function Detail({ detail, t }: { readonly detail: BenchExperimentDetail; readonly t: BenchT }): ReactElement {
  const { analysis, experiment } = detail
  const flaky = analysis.variants.filter(entry => entry.flakyTasks.length > 0)
  const columns = ['variant', 'runs', 'success', 'anyRep', 'everyRep', 'unmeasurable', 'costPerRun', 'timePerRun'] as const
  return h('div', { style: { display: 'grid', gap: 14, minWidth: 0 } }, [
    h('header', { key: 'head', style: { display: 'grid', gap: 4 } }, [
      h('h2', { key: 'title', style: { ...headingStyle, fontSize: 17 } }, fill(t('experimentHeading'), { id: experiment.id, suite: experiment.suite })),
      h('p', { key: 'baseline', style: mutedStyle }, fill(t('baselineNote'), { variant: analysis.baseline })),
    ]),
    card('comparisons', t('comparisonsTitle'), analysis.comparisons.length === 0
      ? h('p', { key: 'none', style: mutedStyle }, t('noComparisons'))
      : h('ul', { key: 'list', style: { display: 'grid', gap: 10, margin: 0, padding: 0, listStyle: 'none' } }, analysis.comparisons.map((comparison) => {
        const text = describeComparison(comparison, analysis, t)
        return h('li', { key: comparison.variant, 'data-verdict': comparison.verdict, style: { display: 'grid', gap: 4, minWidth: 0 } }, [
          h('div', { key: 'head', style: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' } }, [
            h('strong', { key: 'variant', style: { overflowWrap: 'anywhere' } }, comparison.variant),
            h('span', { key: 'headline' }, text.headline),
          ]),
          h('p', { key: 'detail', style: { margin: 0, overflowWrap: 'anywhere' } }, text.detail),
          text.extras.length === 0 ? null : h('p', { key: 'extras', style: mutedStyle }, text.extras.join(' · ')),
        ])
      }))),
    card('variants', t('variantsTitle'), h('div', { key: 'table', style: tableWrapStyle }, h('table', { style: tableStyle }, [
      h('thead', { key: 'head' }, h('tr', {}, columns.map((column, index) => h('th', { key: column, scope: 'col', style: index === 0 ? cellStyle : numStyle }, t(column))))),
      h('tbody', { key: 'body' }, analysis.variants.map(entry => h('tr', { key: entry.variant }, [
        h('th', { key: 'variant', scope: 'row', style: { ...cellStyle, fontWeight: 400 } }, entry.variant),
        h('td', { key: 'runs', style: numStyle }, String(entry.runs)),
        h('td', { key: 'success', style: numStyle }, percent(entry.successRate)),
        h('td', { key: 'any', style: numStyle }, percent(entry.passAnyRate)),
        h('td', { key: 'every', style: numStyle }, percent(entry.passAllRate)),
        h('td', { key: 'invalid', style: numStyle }, percent(entry.invalidRate)),
        h('td', { key: 'cost', style: numStyle }, dollars(entry.meanCostUsd)),
        h('td', { key: 'time', style: numStyle }, seconds(entry.meanWallMs)),
      ]))),
    ]))),
    h('div', { key: 'charts', style: { display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', minWidth: 0 } }, [
      card('time', t('timeTitle'), h(TimeBars, { key: 'bars', analysis, t })),
      card('pareto', t('paretoTitle'), h(ParetoChart, { key: 'chart', analysis, t })),
    ]),
    card('matrix', t('matrixTitle'), h(PassMatrix, { key: 'matrix', analysis, t })),
    flaky.length === 0 ? null : card('flaky', t('flakyTitle'), h('ul', { key: 'list', style: { margin: 0, paddingLeft: 18 } },
      flaky.map(entry => h('li', { key: entry.variant, style: { overflowWrap: 'anywhere' } }, fill(t('flakyEntry'), { variant: entry.variant, tasks: entry.flakyTasks.join(', ') }))))),
  ])
}

/** The whole page, given the read API once the Remote namespace is mounted. */
export function BenchPage({ api, mountError, t }: { readonly api: BenchLedgersApi | undefined; readonly mountError: string | undefined; readonly t: BenchT }): ReactElement {
  const [list, setList] = useState<BenchExperimentList>()
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<BenchExperimentDetail>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const epoch = useRef(0)

  const load = useCallback((choose?: string) => {
    if (api === undefined) return
    epoch.current += 1
    const mine = epoch.current
    setLoading(true)
    setError(undefined)
    void (async () => {
      try {
        const next = await api.list()
        // Default to the experiment that recorded a run most recently.
        const ended = (entry: BenchExperimentList['experiments'][number]) => entry.lastEndedAt ?? 0
        const newest = next.experiments.reduce<BenchExperimentList['experiments'][number] | undefined>(
          (best, entry) => best === undefined || ended(entry) > ended(best) ? entry : best, undefined)
        const id = choose ?? newest?.id
        const body = id === undefined ? undefined : await api.detail({ id })
        if (mine !== epoch.current) return
        setList(next)
        setSelected(id)
        setDetail(body)
      } catch (cause) {
        if (mine !== epoch.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      if (mine === epoch.current) setLoading(false)
    })()
  }, [api])

  useEffect(() => {
    load()
    return () => { epoch.current += 1 }
  }, [load])

  const failure = mountError ?? error
  return h('main', { style: pageStyle, 'aria-busy': loading }, [
    h('header', { key: 'hero', style: { display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'flex-start' } }, [
      h('div', { key: 'copy', style: { display: 'grid', gap: 4, minWidth: 0, flex: '1 1 260px' } }, [
        h('h1', { key: 'title', style: { margin: 0, fontSize: 20 } }, t('title')),
        h('p', { key: 'intro', style: mutedStyle }, t('intro')),
      ]),
      h('button', { key: 'refresh', type: 'button', style: buttonStyle, disabled: loading || api === undefined, onClick: () => { load(selected) } }, loading && api !== undefined ? t('refreshing') : t('refresh')),
    ]),
    failure === undefined ? null : h('p', { key: 'error', role: 'alert', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' } }, `${t('loadFailed')}: ${failure}`),
    list === undefined
      ? (failure === undefined ? h('p', { key: 'loading', role: 'status', style: mutedStyle }, t('loading')) : null)
      : h('div', { key: 'body', style: { display: 'grid', gap: 14, minWidth: 0 } }, [
        list.unreadable.length === 0 ? null : h('div', { key: 'unreadable', role: 'note', style: { ...cardStyle, borderColor: 'var(--dsw-alias-state-warning-primary)' } }, [
          h('p', { key: 'title', style: { margin: 0 } }, t('unreadable')),
          h('ul', { key: 'list', style: { margin: 0, paddingLeft: 18 } }, list.unreadable.map(entry => h('li', { key: entry.id, style: { overflowWrap: 'anywhere' } }, [h('code', { key: 'id' }, entry.id), ` — ${entry.message}`]))),
        ]),
        list.experiments.length === 0
          ? h('p', { key: 'empty', style: mutedStyle }, t('empty'))
          : h('nav', { key: 'picker', 'aria-label': t('title'), style: { display: 'flex', flexWrap: 'wrap', gap: 8 } }, list.experiments.map(entry => h('button', {
            key: entry.id,
            type: 'button',
            'aria-pressed': entry.id === selected,
            onClick: () => { load(entry.id) },
            style: { ...buttonStyle, borderRadius: 999, ...entry.id === selected ? { borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)' } : {} },
          }, `${entry.id} · ${fill(t('runsCount'), { count: entry.runs })}`))),
        detail === undefined ? null : h(Detail, { key: 'detail', detail, t }),
      ]),
  ])
}
