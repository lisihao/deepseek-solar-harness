/** Read-only Settings page for benchmark experiments: comparisons with the baseline, variants, time, cost, and per-task results. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BenchExperimentDetail, BenchExperimentList } from '../contracts.ts'
import { BENCH_API_PATH } from '../contracts.ts'
import { ParetoChart, PassMatrix, TimeBars } from './charts.tsx'
import { describeComparison, dollars, fill, percent, seconds, type BenchT } from './format.ts'
import styles from './BenchSection.module.css'

/** Values the registration injects into the page. */
export interface BenchSectionInjected {
  /** Server connection whose authenticated `request` reaches the Host API. */
  readonly connection: Pick<ConnectionHandle, 'request'>
  /** Translator bound to this page's dictionary. */
  readonly t: BenchT
}

/**
 * GET a JSON body from the benchmark API.
 * @param connection - the server connection.
 * @param path - path under {@link BENCH_API_PATH}.
 * @returns the parsed body.
 * @throws Error naming the HTTP status when the response is not 2xx.
 */
async function getJson<T>(connection: BenchSectionInjected['connection'], path: string): Promise<T> {
  const response = await connection.request(`${BENCH_API_PATH}${path}`)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.json() as T
}

/**
 * One experiment's results.
 * @param props.detail - the experiment, records, and analysis.
 * @param props.t - translator.
 * @returns the results.
 */
function Detail({ detail, t }: { readonly detail: BenchExperimentDetail; readonly t: BenchT }) {
  const { analysis, experiment } = detail
  const flaky = analysis.variants.filter(entry => entry.flakyTasks.length > 0)
  return <>
    <header className={styles.subhead}>
      <h2>{fill(t('experimentHeading'), { id: experiment.id, suite: experiment.suite })}</h2>
      <p className={styles.muted}>{fill(t('baselineNote'), { variant: analysis.baseline })}</p>
    </header>
    <section className={styles.card} aria-labelledby="bench-comparisons">
      <h3 id="bench-comparisons">{t('comparisonsTitle')}</h3>
      {analysis.comparisons.length === 0
        ? <p className={styles.muted}>{t('noComparisons')}</p>
        : <ul className={styles.verdicts}>
          {analysis.comparisons.map((comparison) => {
            const text = describeComparison(comparison, analysis, t)
            return <li key={comparison.variant} className={styles.verdict} data-verdict={comparison.verdict}>
              <div className={styles.verdictHead}><strong>{comparison.variant}</strong><span>{text.headline}</span></div>
              <p>{text.detail}</p>
              {text.extras.length === 0 ? null : <p className={styles.muted}>{text.extras.join(' · ')}</p>}
            </li>
          })}
        </ul>}
    </section>
    <section className={styles.card} aria-labelledby="bench-variants">
      <h3 id="bench-variants">{t('variantsTitle')}</h3>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('variant')}</th>
              <th scope="col" className={styles.num}>{t('runs')}</th>
              <th scope="col" className={styles.num}>{t('success')}</th>
              <th scope="col" className={styles.num}>{t('anyRep')}</th>
              <th scope="col" className={styles.num}>{t('everyRep')}</th>
              <th scope="col" className={styles.num}>{t('unmeasurable')}</th>
              <th scope="col" className={styles.num}>{t('costPerRun')}</th>
              <th scope="col" className={styles.num}>{t('timePerRun')}</th>
            </tr>
          </thead>
          <tbody>
            {analysis.variants.map(entry => <tr key={entry.variant}>
              <th scope="row">{entry.variant}</th>
              <td className={styles.num}>{entry.runs}</td>
              <td className={styles.num}>{percent(entry.successRate)}</td>
              <td className={styles.num}>{percent(entry.passAnyRate)}</td>
              <td className={styles.num}>{percent(entry.passAllRate)}</td>
              <td className={styles.num}>{percent(entry.invalidRate)}</td>
              <td className={styles.num}>{dollars(entry.meanCostUsd)}</td>
              <td className={styles.num}>{seconds(entry.meanWallMs)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>
    <div className={styles.cards}>
      <section className={styles.card} aria-labelledby="bench-time">
        <h3 id="bench-time">{t('timeTitle')}</h3>
        <TimeBars analysis={analysis} t={t} />
      </section>
      <section className={styles.card} aria-labelledby="bench-pareto">
        <h3 id="bench-pareto">{t('paretoTitle')}</h3>
        <ParetoChart analysis={analysis} t={t} />
      </section>
    </div>
    <section className={styles.card} aria-labelledby="bench-matrix">
      <h3 id="bench-matrix">{t('matrixTitle')}</h3>
      <PassMatrix analysis={analysis} t={t} />
    </section>
    {flaky.length === 0 ? null : <section className={styles.card} aria-labelledby="bench-flaky">
      <h3 id="bench-flaky">{t('flakyTitle')}</h3>
      <ul className={styles.plainList}>
        {flaky.map(entry => <li key={entry.variant}>{fill(t('flakyEntry'), { variant: entry.variant, tasks: entry.flakyTasks.join(', ') })}</li>)}
      </ul>
    </section>}
  </>
}

/**
 * Render the benchmark page.
 * @param props.connection - Server connection that carries the authenticated request.
 * @param props.t - translator bound to this page's dictionary.
 * @returns the page.
 */
export function BenchSection({ connection, t }: BenchSectionInjected) {
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
      const next = await getJson<BenchExperimentList>(connection, '/experiments')
      // Default to the experiment that recorded a run most recently.
      const ended = (entry: BenchExperimentList['experiments'][number]) => entry.lastEndedAt ?? 0
      const newest = next.experiments.reduce<BenchExperimentList['experiments'][number] | undefined>(
        (best, entry) => best === undefined || ended(entry) > ended(best) ? entry : best, undefined)
      const id = choose ?? newest?.id
      const body = id === undefined ? undefined : await getJson<BenchExperimentDetail>(connection, `/experiments/${encodeURIComponent(id)}`)
      return { next, id, body }
    })().then(
      ({ next, id, body }) => {
        if (mine !== epoch.current) return
        setList(next)
        setSelected(id)
        setDetail(body)
        setLoading(false)
      },
      (cause: unknown) => {
        if (mine !== epoch.current) return
        setError(cause instanceof Error ? cause.message : String(cause))
        setLoading(false)
      },
    )
  }, [connection])

  useEffect(() => {
    load()
    return () => { epoch.current += 1 }
  }, [load])

  return <main className={styles.page} aria-busy={loading}>
    <header className={styles.hero}>
      <div><h1>{t('title')}</h1><p>{t('intro')}</p></div>
      <Button variant="outline" size="sm" className={styles.action} disabled={loading} onClick={() => { load(selected) }}>
        {loading ? t('refreshing') : t('refresh')}
      </Button>
    </header>
    {error === undefined ? null : <p className={styles.error} role="alert">{t('loadFailed')}: {error}</p>}
    {list === undefined
      ? (error === undefined ? <p className={styles.muted} role="status">{t('loading')}</p> : null)
      : <>
        {list.unreadable.length === 0 ? null : <div className={styles.warning} role="note">
          <p>{t('unreadable')}</p>
          <ul className={styles.plainList}>
            {list.unreadable.map(entry => <li key={entry.id}><code>{entry.id}</code> — {entry.message}</li>)}
          </ul>
        </div>}
        {list.experiments.length === 0
          ? <p className={styles.empty}>{t('empty')}</p>
          : <nav className={styles.picker} aria-label={t('title')}>
            {list.experiments.map(entry => <Pill key={entry.id} active={entry.id === selected} onClick={() => { load(entry.id) }}>
              {entry.id} · {fill(t('runsCount'), { count: entry.runs })}
            </Pill>)}
          </nav>}
        {detail === undefined ? null : <Detail detail={detail} t={t} />}
      </>}
  </main>
}
