/** Read-only Benchmarks page: comparisons with the baseline, variants, time, cost, and per-task results. Pure render functions of the read API. */

import { createElement as h, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { BenchExperimentDetail, BenchExperimentList, BenchLedgersApi } from './contracts.js'
import { currentLanguage } from './locales.js'
import type { BenchJobStatus, BenchRunChoices, BenchStartInput } from './runs.js'
import { describeComparison, dollars, fill, percent, seconds, type BenchT } from './format.js'
import type { ExperimentAnalysis, VariantId } from './types.js'

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
  { key: 'overheadMs', label: 'timeHarness', color: 'var(--dsw-alias-state-warn-primary, #e8a33d)' },
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
      ...points.map((point, index) => {
        const onFront = front.has(point.id)
        // Labels on the right half sit left of their point, so they stay inside the chart.
        const right = x(point.cost) > width / 2
        // Variants with nearly equal success and cost would print their labels on top of each other; stack them instead.
        const stacked = points.slice(0, index).filter(other => Math.abs(x(other.cost) - x(point.cost)) < 60 && Math.abs(y(other.success) - y(point.success)) < 12).length
        return h('g', { key: point.id }, [
          h('circle', { key: 'dot', cx: x(point.cost), cy: y(point.success), r: onFront ? 6 : 4, fill: onFront ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-tertiary)' },
            h('title', {}, `${point.id}: ${percent(point.success)}, ${dollars(point.cost)}${onFront ? ` · ${t('paretoFront')}` : ''}`)),
          h('text', { key: 'label', x: right ? x(point.cost) - 10 : x(point.cost) + 10, y: y(point.success) + 4 + stacked * 13, textAnchor: right ? 'end' : 'start', fontSize: 11, fill: 'var(--dsw-alias-label-primary)' }, point.id),
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
/**
 * The analysis with variant ids replaced by display names.
 * @param detail - the experiment detail.
 * @param t - translator.
 * @returns the renamed analysis.
 */
export function namedAnalysis(detail: BenchExperimentDetail, t: BenchT): ExperimentAnalysis {
  const language = currentLanguage()
  const name = (id: VariantId): VariantId => {
    const title = detail.titles[id]
    if (title === undefined) return id
    if (title.baseline === true) return t('baselineName')
    return title[language] ?? title.zh ?? title.en ?? id
  }
  const { analysis } = detail
  return {
    ...analysis,
    baseline: name(analysis.baseline),
    variants: analysis.variants.map(entry => ({ ...entry, variant: name(entry.variant) })),
    comparisons: analysis.comparisons.map(entry => ({ ...entry, variant: name(entry.variant) })),
    matrix: analysis.matrix.map(row => ({ task: row.task, rates: Object.fromEntries(Object.entries(row.rates).map(([id, rate]) => [name(id), rate])) })),
    pareto: analysis.pareto.map(name),
  }
}

export function Detail({ detail, t }: { readonly detail: BenchExperimentDetail; readonly t: BenchT }): ReactElement {
  const { experiment } = detail
  const analysis = namedAnalysis(detail, t)
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

const inputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  minWidth: 0,
  padding: '6px 8px',
  border: '1px solid var(--dsw-alias-settings-card-stroke)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'inherit',
  font: 'inherit',
}

const labelStyle: CSSProperties = { display: 'grid', gap: 4, minWidth: 0, fontSize: 13 }

const checkRowStyle: CSSProperties = { display: 'flex', gap: 8, alignItems: 'flex-start', minWidth: 0, fontSize: 13, overflowWrap: 'anywhere' }

const OUTCOME_KEY = { pass: 'outcomePass', fail: 'outcomeFail', timeout: 'outcomeTimeout', invalid: 'outcomeInvalid' } as const
const OUTCOME_COLOR = {
  pass: 'var(--dsw-alias-state-success-primary)',
  fail: 'var(--dsw-alias-state-error-primary)',
  timeout: 'var(--dsw-alias-state-warn-primary, #e8a33d)',
  invalid: 'var(--dsw-alias-label-tertiary)',
} as const
const STATE_KEY = { running: 'stateRunning', finished: 'stateFinished', stopped: 'stateStopped', failed: 'stateFailed' } as const

/** Operations the run panel calls. */
export interface BenchRunsApi {
  choices(): Promise<BenchRunChoices>
  start(input: BenchStartInput): Promise<{ experimentId: string }>
  status(): Promise<BenchJobStatus>
  stop(): Promise<BenchJobStatus>
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause)).replace(/^[A-Z][A-Z0-9_]+:\s*/, '')

/** The new-experiment form and the live progress of the current or last job. */
export function RunPanel({ api, visible, t, onSettled }: {
  readonly api: BenchRunsApi
  readonly visible: boolean
  readonly t: BenchT
  readonly onSettled: (experimentId: string) => void
}): ReactElement {
  const [choices, setChoices] = useState<BenchRunChoices>()
  const [suite, setSuite] = useState<string>()
  const [tasks, setTasks] = useState<ReadonlySet<string>>(new Set())
  const [plugins, setPlugins] = useState<ReadonlySet<string>>(new Set())
  const [repetitions, setRepetitions] = useState(1)
  const [maxUsd, setMaxUsd] = useState(1)
  const [job, setJob] = useState<BenchJobStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const settled = useRef<string>()
  const logRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const next = await api.choices()
        if (!live) return
        setChoices(next)
        const first = next.suites[0]
        if (first !== undefined) {
          setSuite(first.id)
          setTasks(new Set(first.tasks.map(task => task.id)))
        }
      } catch (cause) {
        if (live) setError(errorText(cause))
      }
    })()
    return () => { live = false }
  }, [api])

  const running = job?.state === 'running'
  useEffect(() => {
    if (!visible) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await api.status()
        if (!live) return
        setJob(next)
        if (next.state !== 'running' && next.state !== 'idle' && next.experimentId !== undefined && settled.current !== `${next.experimentId}:${next.state}`) {
          settled.current = `${next.experimentId}:${next.state}`
          onSettled(next.experimentId)
        }
        if (next.state === 'running') timer = setTimeout(() => { void poll() }, 1000)
      } catch (cause) {
        if (live) setError(errorText(cause))
      }
    }
    void poll()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [api, visible, running, onSettled])

  useEffect(() => {
    const log = logRef.current
    if (log !== null) log.scrollTop = log.scrollHeight
  }, [job?.log.length])

  const current = choices?.suites.find(entry => entry.id === suite)
  const variants = plugins.size + 1
  const runs = tasks.size * variants * repetitions
  const canStart = choices !== undefined && choices.credential && current !== undefined && tasks.size > 0 && plugins.size > 0 && maxUsd > 0 && !running && !busy

  const start = (): void => {
    if (!canStart || suite === undefined) return
    setBusy(true)
    setError(undefined)
    void (async () => {
      try {
        await api.start({ suite, tasks: [...tasks], plugins: [...plugins], repetitions, maxUsd })
        setJob(await api.status())
      } catch (cause) {
        setError(errorText(cause))
      }
      setBusy(false)
    })()
  }

  const stop = (): void => {
    setBusy(true)
    void (async () => {
      try {
        setJob(await api.stop())
      } catch (cause) {
        setError(errorText(cause))
      }
      setBusy(false)
    })()
  }

  const toggle = (set: ReadonlySet<string>, value: string, update: (next: ReadonlySet<string>) => void): void => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    update(next)
  }

  const language = currentLanguage()
  const form = choices === undefined
    ? h('p', { key: 'loading', role: 'status', style: mutedStyle }, t('loading'))
    : h('div', { key: 'form', style: { display: 'grid', gap: 12, minWidth: 0 } }, [
      h('label', { key: 'suite', style: labelStyle }, [
        t('suite'),
        h('select', { key: 'select', value: suite, disabled: running, style: inputStyle, onChange: (event: { target: { value: string } }) => {
          const next = choices.suites.find(entry => entry.id === event.target.value)
          setSuite(event.target.value)
          setTasks(new Set(next?.tasks.map(task => task.id) ?? []))
        } }, choices.suites.map(entry => h('option', { key: entry.id, value: entry.id }, `${entry.id} · ${entry.description}`))),
      ]),
      current === undefined ? null : h('fieldset', { key: 'tasks', disabled: running, style: { ...labelStyle, border: 0, padding: 0, margin: 0 } }, [
        h('legend', { key: 'legend', style: { padding: 0, marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
          fill(t('tasksLabel'), { selected: tasks.size, total: current.tasks.length }),
          h('button', { key: 'all', type: 'button', style: { ...buttonStyle, minHeight: 24, padding: '2px 8px' }, onClick: () => { setTasks(new Set(current.tasks.map(task => task.id))) } }, t('selectAll')),
          h('button', { key: 'none', type: 'button', style: { ...buttonStyle, minHeight: 24, padding: '2px 8px' }, onClick: () => { setTasks(new Set()) } }, t('selectNone')),
        ]),
        h('div', { key: 'list', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 4 } }, current.tasks.map(task => h('label', { key: task.id, style: checkRowStyle }, [
          h('input', { key: 'box', type: 'checkbox', checked: tasks.has(task.id), onChange: () => { toggle(tasks, task.id, setTasks) } }),
          h('code', { key: 'id' }, task.id),
        ]))),
      ]),
      h('fieldset', { key: 'plugins', disabled: running, style: { ...labelStyle, border: 0, padding: 0, margin: 0 } }, [
        h('legend', { key: 'legend', style: { padding: 0, marginBottom: 4 } }, t('pluginsLabel')),
        choices.plugins.length === 0
          ? h('p', { key: 'none', style: mutedStyle }, t('noPlugins'))
          : h('div', { key: 'list', style: { display: 'grid', gap: 4, maxHeight: 220, overflowY: 'auto' } }, choices.plugins.map(plugin => h('label', { key: plugin.name, style: checkRowStyle }, [
            h('input', { key: 'box', type: 'checkbox', checked: plugins.has(plugin.name), onChange: () => { toggle(plugins, plugin.name, setPlugins) } }),
            h('span', { key: 'text', style: { display: 'grid', minWidth: 0 } }, [
              h('span', { key: 'title' }, plugin.title[language] ?? plugin.title.zh ?? plugin.title.en ?? plugin.name),
              h('span', { key: 'name', style: { ...mutedStyle, fontSize: 11 } }, `${plugin.name} ${plugin.version}`),
            ]),
          ]))),
      ]),
      h('div', { key: 'numbers', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8 } }, [
        h('label', { key: 'reps', style: labelStyle }, [t('repetitions'), h('input', { key: 'input', type: 'number', min: 1, max: 10, value: repetitions, disabled: running, style: inputStyle, onChange: (event: { target: { value: string } }) => { setRepetitions(Math.max(1, Math.min(10, Math.round(Number(event.target.value)) || 1))) } })]),
        h('label', { key: 'usd', style: labelStyle }, [t('maxUsd'), h('input', { key: 'input', type: 'number', min: 0.01, step: 0.5, value: maxUsd, disabled: running, style: inputStyle, onChange: (event: { target: { value: string } }) => { setMaxUsd(Math.max(0, Number(event.target.value) || 0)) } })]),
      ]),
      h('p', { key: 'plan', style: { margin: 0, fontSize: 13 } }, fill(t('plan'), { runs, tasks: tasks.size, variants, plugins: plugins.size, reps: repetitions })),
      tasks.size > 0 && tasks.size < choices.minTasks ? h('p', { key: 'few', style: { ...mutedStyle, fontSize: 12 } }, fill(t('fewTasks'), { min: choices.minTasks })) : null,
      choices.credential ? null : h('p', { key: 'credential', role: 'alert', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)' } }, t('noCredential')),
      h('div', { key: 'actions', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
        h('button', { key: 'start', type: 'button', disabled: !canStart, onClick: start, style: { ...buttonStyle, borderColor: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-brand-primary)', opacity: canStart ? 1 : 0.5 } }, busy && !running ? t('starting') : t('start')),
      ]),
    ])

  const progress = job === undefined || job.state === 'idle' ? null : card('progress', `${t('progressTitle')} · ${t(STATE_KEY[job.state])}`, h('div', { key: 'body', style: { display: 'grid', gap: 8, minWidth: 0 } }, [
    h('p', { key: 'count', style: { margin: 0, fontSize: 13 } }, fill(t('progress'), { done: job.done, total: job.total, spent: job.spentUsd.toFixed(4), max: job.maxUsd.toFixed(2) })),
    h('div', { key: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': job.total, 'aria-valuenow': job.done, style: { height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--dsw-alias-bg-module-platform)' } },
      h('span', { style: { display: 'block', height: '100%', width: `${job.total === 0 ? 0 : Math.round((job.done / job.total) * 100)}%`, background: 'var(--dsw-alias-brand-primary)' } })),
    job.running.length === 0 ? null : h('p', { key: 'now', style: { ...mutedStyle, fontSize: 12 } }, fill(t('runningNow'), { cells: job.running.map(cell => `${cell.variant} · ${cell.task} #${String(cell.rep + 1)}`).join(', ') })),
    job.reason === undefined ? null : h('p', { key: 'reason', role: 'alert', style: { margin: 0, fontSize: 13, color: job.state === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'inherit', overflowWrap: 'anywhere' } }, job.reason),
    running ? h('div', { key: 'stop' }, h('button', { type: 'button', disabled: busy, onClick: stop, style: buttonStyle }, busy ? t('stopping') : t('stop'))) : null,
    job.runs.length === 0 ? null : h('ul', { key: 'runs', style: { margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 2, fontSize: 12, maxHeight: 160, overflowY: 'auto' } }, job.runs.slice(-30).reverse().map(entry => h('li', { key: `${entry.variant}/${entry.task}/${String(entry.rep)}`, style: { display: 'flex', gap: 6, minWidth: 0 }, title: entry.reason }, [
      h('span', { key: 'outcome', style: { color: OUTCOME_COLOR[entry.outcome], flex: '0 0 auto' } }, t(OUTCOME_KEY[entry.outcome])),
      h('span', { key: 'cell', style: { overflowWrap: 'anywhere', minWidth: 0 } }, `${entry.variant} · ${entry.task} #${String(entry.rep + 1)} · ${String(entry.seconds)} s${entry.costUsd === null ? '' : ` · $${entry.costUsd.toFixed(4)}`}`),
    ]))),
    h('details', { key: 'log', open: running }, [
      h('summary', { key: 'summary', style: { cursor: 'pointer', fontSize: 13 } }, t('logTitle')),
      h('pre', { key: 'text', ref: logRef, style: { margin: '6px 0 0', maxHeight: 220, overflow: 'auto', padding: 8, borderRadius: 6, background: 'var(--dsw-alias-bg-module-platform)', fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, job.log.join('\n')),
    ]),
  ]))

  return h('div', { style: { display: 'grid', gap: 14, minWidth: 0 } }, [
    card('run', t('runTitle'), form),
    error === undefined ? null : h('p', { key: 'error', role: 'alert', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' } }, error),
    progress,
  ])
}

/** Recorded experiments with their analysis. */
export function Results({ api, t, focus }: { readonly api: BenchLedgersApi; readonly t: BenchT; readonly focus: string | undefined }): ReactElement {
  const [list, setList] = useState<BenchExperimentList>()
  const [selected, setSelected] = useState<string>()
  const [detail, setDetail] = useState<BenchExperimentDetail>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const epoch = useRef(0)

  const load = useCallback((choose?: string) => {
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
        const id = choose !== undefined && next.experiments.some(entry => entry.id === choose) ? choose : newest?.id
        const body = id === undefined ? undefined : await api.detail({ id })
        if (mine !== epoch.current) return
        setList(next)
        setSelected(id)
        setDetail(body)
      } catch (cause) {
        if (mine !== epoch.current) return
        setError(errorText(cause))
      }
      if (mine === epoch.current) setLoading(false)
    })()
  }, [api])

  useEffect(() => {
    load(focus)
    return () => { epoch.current += 1 }
  }, [load, focus])

  return h('section', { style: { display: 'grid', gap: 12, minWidth: 0 }, 'aria-busy': loading }, [
    h('header', { key: 'head', style: { display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' } }, [
      h('h2', { key: 'title', style: { ...headingStyle, fontSize: 17 } }, t('resultsTitle')),
      h('button', { key: 'refresh', type: 'button', style: buttonStyle, disabled: loading, onClick: () => { load(selected) } }, loading ? t('refreshing') : t('refresh')),
    ]),
    error === undefined ? null : h('p', { key: 'error', role: 'alert', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' } }, `${t('loadFailed')}: ${error}`),
    list === undefined
      ? (error === undefined ? h('p', { key: 'loading', role: 'status', style: mutedStyle }, t('loading')) : null)
      : h('div', { key: 'body', style: { display: 'grid', gap: 14, minWidth: 0 } }, [
        list.unreadable.length === 0 ? null : h('div', { key: 'unreadable', role: 'note', style: { ...cardStyle, borderColor: 'var(--dsw-alias-state-warn-primary, #e8a33d)' } }, [
          h('p', { key: 'title', style: { margin: 0 } }, t('unreadable')),
          h('ul', { key: 'list', style: { margin: 0, paddingLeft: 18 } }, list.unreadable.map(entry => h('li', { key: entry.id, style: { overflowWrap: 'anywhere' } }, [h('code', { key: 'id' }, entry.id), ` — ${entry.message}`]))),
        ]),
        list.experiments.length === 0
          ? h('p', { key: 'empty', style: mutedStyle }, t('empty'))
          : h('label', { key: 'picker', style: labelStyle }, [
            t('title'),
            h('select', { key: 'select', value: selected, style: inputStyle, onChange: (event: { target: { value: string } }) => { load(event.target.value) } },
              [...list.experiments].sort((a, b) => (b.lastEndedAt ?? 0) - (a.lastEndedAt ?? 0)).map(entry => h('option', { key: entry.id, value: entry.id }, `${entry.id} · ${fill(t('runsCount'), { count: entry.runs })}`))),
          ]),
        detail === undefined ? null : h(Detail, { key: 'detail', detail, t }),
      ]),
  ])
}

/** The Benchmarks tab of the right sidebar. */
export function BenchSidebar({ ledgers, runs, mountError, visible, t }: {
  readonly ledgers: BenchLedgersApi | undefined
  readonly runs: BenchRunsApi | undefined
  readonly mountError: string | undefined
  readonly visible: boolean
  readonly t: BenchT
}): ReactElement {
  const [focus, setFocus] = useState<string>()
  const onSettled = useCallback((id: string) => { setFocus(id) }, [])
  return h('main', { style: { ...pageStyle, padding: 12 } }, [
    h('header', { key: 'hero', style: { display: 'grid', gap: 4 } }, [
      h('h1', { key: 'title', style: { margin: 0, fontSize: 18 } }, t('title')),
      h('p', { key: 'intro', style: { ...mutedStyle, fontSize: 13 } }, t('intro')),
    ]),
    mountError === undefined ? null : h('p', { key: 'error', role: 'alert', style: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' } }, `${t('loadFailed')}: ${mountError}`),
    ledgers === undefined || runs === undefined
      ? (mountError === undefined ? h('p', { key: 'loading', role: 'status', style: mutedStyle }, t('loading')) : null)
      : h('div', { key: 'body', style: { display: 'grid', gap: 16, minWidth: 0 } }, [
        h(RunPanel, { key: 'run', api: runs, visible, t, onSettled }),
        h(Results, { key: 'results', api: ledgers, t, focus }),
      ]),
  ])
}
