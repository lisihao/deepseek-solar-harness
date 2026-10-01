/** Read-only Settings page for the scheduling evidence store. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {
  SchedulingEvidencePageV1,
  SchedulingEvidenceRpcChannel,
} from '@deepseek-ai/dsh-scheduling-evidence-rpc/shared'
import type { OverviewModel } from '@deepseek-ai/dsh-scheduling-evidence/overview'
import type { SchedulingEvidenceLocaleKey } from './locales.ts'
import styles from './SchedulingEvidenceSection.module.css'

/** Trusted Host RPC channel; the Host package owns the matching value constant. */
const SCHEDULING_EVIDENCE_RPC_CHANNEL = '/scheduling-evidence' satisfies SchedulingEvidenceRpcChannel

/** Localized translator bound to this page's dictionary. */
export type SchedulingEvidenceT = (key: SchedulingEvidenceLocaleKey) => string

/** Values the registration injects into the page. */
export interface SchedulingEvidenceSectionInjected {
  readonly connection: ConnectionHandle
  readonly t: SchedulingEvidenceT
}

/** Props the slot system hands the page. */
export type SchedulingEvidenceSectionProps = SchedulingEvidenceSectionInjected

const SNIPPET = [
  'scheduling-evidence:',
  '  radarEnabled: true',
  '  personalUseConsent: true',
  '  python: /opt/homebrew/bin/python3.12',
  'model-allocation:',
  '  publicEvidence: shadow',
].join('\n')

function when(value: string | null): string {
  if (value === null) return '—'
  const time = Date.parse(value)
  return Number.isNaN(time) ? value : `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function span(seconds: number | null, t: SchedulingEvidenceT): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${String(Math.round(seconds))} ${t('seconds')}`
  if (seconds < 3_600) return `${String(Math.round(seconds / 60))} ${t('minutes')}`
  if (seconds < 86_400) return `${String(Math.round(seconds / 3_600))} ${t('hours')}`
  return `${String(Math.round(seconds / 86_400))} ${t('days')}`
}

function percent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`
}

function plain(value: number | null, digits: number): string {
  return value === null ? '—' : value.toFixed(digits)
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <div className={styles.fact}><dt>{label}</dt><dd>{children}</dd></div>
}

function Card({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <section className={styles.card}><h2>{title}</h2>{children}</section>
}

function modeLabel(mode: SchedulingEvidencePageV1['publicEvidence'], t: SchedulingEvidenceT): string {
  if (mode === 'off') return t('modeOff')
  if (mode === 'shadow') return t('modeShadow')
  if (mode === 'apply') return t('modeApply')
  return t('modeUnknown')
}

function costModeLabel(mode: SchedulingEvidencePageV1['costAware'], t: SchedulingEvidenceT): string {
  if (mode === 'off') return t('costModeOff')
  if (mode === 'shadow') return t('costModeShadow')
  if (mode === 'apply') return t('costModeApply')
  return t('modeUnknown')
}

function stateLabel(state: string, t: SchedulingEvidenceT): string {
  if (state === 'fresh' || state === 'cache') return t('fresh')
  if (state === 'stale' || state === 'stale-cache') return t('stale')
  return t('unknown')
}

function cycleCard(page: SchedulingEvidencePageV1, t: SchedulingEvidenceT): ReactNode {
  const cycle = page.lastCycle
  if (cycle === null) return <p className={styles.muted}>{t('cycleNone')}</p>
  const collection = cycle.collection === 'ok'
    ? t('collectionOk')
    : cycle.collection === 'failed' ? t('collectionFailed') : t('collectionSkipped')
  return <>
    <dl className={styles.facts}>
      <Fact label={t('startedAt')}>{when(cycle.startedAt)}</Fact>
      <Fact label={t('collection')}>{collection}</Fact>
      <Fact label={t('reload')}>{cycle.reload === 'ok' ? t('reloadOk') : t('reloadFailed')}</Fact>
    </dl>
    {cycle.message === undefined ? null : <p className={styles.error}>{cycle.message}</p>}
  </>
}

function storeCard(page: SchedulingEvidencePageV1, t: SchedulingEvidenceT): ReactNode {
  const { store } = page
  if (!store.available) {
    return <p className={styles.muted}>{store.reason === '' ? t('storeEmpty') : store.reason}</p>
  }
  return <dl className={styles.facts}>
    <Fact label={t('state')}>{stateLabel(store.state, t)}</Fact>
    <Fact label={t('fetchedAt')}>{when(store.fetchedAt)}</Fact>
    <Fact label={t('sourceAt')}>{when(store.sourceUpdatedAt)}</Fact>
    <Fact label={t('age')}>{span(store.ageSeconds, t)}</Fact>
    <Fact label={t('snapshot')}><code>{store.snapshotId}</code></Fact>
    <Fact label={t('inMemory')}>{store.loaded ? t('yes') : t('no')}</Fact>
    <Fact label={t('tables')}>
      {Object.entries(store.rowCounts).map(([table, count]) => `${table.replace('radar_', '')} ${String(count)}`).join(' · ')}
    </Fact>
  </dl>
}

function ModelTable({ models, t }: { readonly models: readonly OverviewModel[]; readonly t: SchedulingEvidenceT }) {
  const [query, setQuery] = useState('')
  const [onlyUsed, setOnlyUsed] = useState(true)
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return models.filter(row => (!onlyUsed || row.usedForEvidence)
      && (needle === '' || `${row.provider} ${row.model} ${row.reasoningEffort}`.toLowerCase().includes(needle)))
  }, [models, query, onlyUsed])
  return <section className={styles.models} aria-labelledby="scheduling-evidence-models">
    <div className={styles.toolbar}>
      <h2 id="scheduling-evidence-models">{t('modelsTitle')}</h2>
      <input
        type="search"
        className={styles.search}
        aria-label={t('filter')}
        placeholder={t('filter')}
        value={query}
        onChange={(event) => { setQuery(event.target.value) }}
      />
    </div>
    <label className={styles.check}>
      <input type="checkbox" checked={onlyUsed} onChange={(event) => { setOnlyUsed(event.target.checked) }} />
      <span>{t('onlyUsed')}</span>
      <small>{String(rows.length)} {t('count')}</small>
    </label>
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('model')}</th>
            <th scope="col">{t('effort')}</th>
            <th scope="col" className={styles.num}>{t('passRate')}</th>
            <th scope="col" className={styles.num}>{t('samples')}</th>
            <th scope="col" className={styles.num}>{t('iq')}</th>
            <th scope="col" className={styles.num}>{t('cost')}</th>
            <th scope="col" className={styles.num}>{t('runtime')}</th>
            <th scope="col">{t('used')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => <tr key={`${row.provider}/${row.model}/${row.reasoningEffort}`}>
            <th scope="row"><code>{row.model}</code></th>
            <td>{row.reasoningEffort}</td>
            <td className={styles.num}>{percent(row.passRate)}</td>
            <td className={styles.num}>{plain(row.sampleCount, 0)}</td>
            <td className={styles.num}>{plain(row.iq, 1)}</td>
            <td className={styles.num}>{row.avgCostUsd === null ? '—' : `$${row.avgCostUsd.toFixed(2)}`}</td>
            <td className={styles.num}>{span(row.avgRuntimeSeconds, t)}</td>
            <td>{row.usedForEvidence ? t('yes') : '—'}</td>
          </tr>)}
        </tbody>
      </table>
      {rows.length === 0 ? <p className={styles.empty}>{t('noRows')}</p> : null}
    </div>
  </section>
}

/**
 * Render the scheduling evidence page.
 * @param props.connection - Server connection that carries the trusted RPC.
 * @param props.t - translator bound to this page's dictionary.
 * @returns the page.
 */
export function SchedulingEvidenceSection({ connection, t }: SchedulingEvidenceSectionProps) {
  const [page, setPage] = useState<SchedulingEvidencePageV1>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const epoch = useRef(0)
  const load = useCallback(() => {
    epoch.current += 1
    const mine = epoch.current
    setLoading(true)
    setError(undefined)
    void connection.rpc.call(SCHEDULING_EVIDENCE_RPC_CHANNEL, 'overview', {}).then(
      (response) => {
        if (mine !== epoch.current) return
        setLoading(false)
        if (response.ok) setPage(response.value as SchedulingEvidencePageV1)
        else setError(response.error.message)
      },
      (cause: unknown) => {
        if (mine !== epoch.current) return
        setLoading(false)
        setError(cause instanceof Error ? cause.message : String(cause))
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
      <button type="button" className={styles.secondary} disabled={loading} onClick={load}>
        {loading ? t('refreshing') : t('refresh')}
      </button>
    </header>
    {error === undefined ? null : <p className={styles.error} role="alert">{t('loadFailed')}: {error}</p>}
    {page === undefined ? (error === undefined ? <p className={styles.muted} role="status">{t('loading')}</p> : null) : <>
      <div className={styles.cards}>
        <Card title={t('switchesTitle')}>
          <dl className={styles.facts}>
            <Fact label={t('radar')}>{page.radar.enabled ? t('on') : t('off')}</Fact>
            <Fact label={t('consent')}>{page.radar.personalUseConsent ? t('consentGiven') : t('consentMissing')}</Fact>
            <Fact label={t('mode')}>{modeLabel(page.publicEvidence, t)}</Fact>
            <Fact label={t('costMode')}>{costModeLabel(page.costAware, t)}</Fact>
            <Fact label={t('python')}><code>{page.radar.python}</code></Fact>
            <Fact label={t('every')}>{span(page.radar.refreshIntervalMs === null ? null : page.radar.refreshIntervalMs / 1_000, t)}</Fact>
          </dl>
        </Card>
        <Card title={t('storeTitle')}>{storeCard(page, t)}</Card>
        <Card title={t('cycleTitle')}>{cycleCard(page, t)}</Card>
      </div>
      <ModelTable models={page.models} t={t} />
      {page.radar.enabled ? null : <section className={styles.how}>
        <h2>{t('howTitle')}</h2>
        <p>{t('how')}</p>
        <pre><code>{SNIPPET}</code></pre>
      </section>}
    </>}
  </main>
}
