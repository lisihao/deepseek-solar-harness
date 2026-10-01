// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SchedulingEvidencePageV1 } from '@deepseek-ai/dsh-scheduling-evidence-rpc/shared'
import { SchedulingEvidenceSection } from '../src/client/SchedulingEvidenceSection.tsx'
import { en, zh, type SchedulingEvidenceLocaleKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = (key: SchedulingEvidenceLocaleKey): string => en[key]

const MODELS = [
  { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high', passRate: 0.736, sampleCount: 140, iq: 110.36, avgCostUsd: 2.81, avgRuntimeSeconds: 826, usedForEvidence: true },
  { provider: 'codex', model: 'gpt-6-sol', reasoningEffort: 'max', passRate: 0.649, sampleCount: 154, iq: 97.4, avgCostUsd: 1.27, avgRuntimeSeconds: 40, usedForEvidence: true },
  { provider: 'claude', model: 'claude-opus-5', reasoningEffort: 'low', passRate: null, sampleCount: null, iq: null, avgCostUsd: null, avgRuntimeSeconds: null, usedForEvidence: false },
]

function page(overrides: Partial<SchedulingEvidencePageV1> = {}): SchedulingEvidencePageV1 {
  return {
    version: 1,
    radar: { enabled: true, personalUseConsent: true, python: '/opt/homebrew/bin/python3.12', refreshIntervalMs: 14_400_000 },
    lastCycle: { startedAt: '2026-10-01T14:00:40.123Z', finishedAt: '2026-10-01T14:03:40.000Z', collection: 'ok', reload: 'ok' },
    store: {
      available: true, snapshotId: 'codex-radar-v1-724e', digest: 'sha256:abc', state: 'fresh', fetchedAt: '2026-10-01T14:05:07Z',
      sourceUpdatedAt: '2026-10-01T14:04:43+00:00', ageSeconds: 1898, staleAfterSeconds: 604_800, authorization: 'consented',
      rowCounts: { radar_models: 89, radar_snapshots: 1 }, loaded: true,
    },
    models: MODELS,
    publicEvidence: 'shadow',
    ...overrides,
  }
}

type Reply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly message: string } }

function connection(replies: Array<Reply | Error | Promise<Reply>>) {
  const call = vi.fn((_channel: string, _endpoint: string, _payload: unknown) => {
    const next = replies.shift()
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve(next as Reply)
  })
  return { handle: { rpc: { call } } as unknown as ConnectionHandle, call }
}

const ok = (value: unknown): Reply => ({ ok: true, value })

describe('SchedulingEvidenceSection', () => {
  it('asks the trusted channel for the overview and shows the switches, the stored data, and the last cycle', async () => {
    const { handle, call } = connection([ok(page())])

    render(<SchedulingEvidenceSection connection={handle} t={t} />)

    expect(screen.getByRole('status').textContent).toBe('Loading…')
    await screen.findByText('Your switches')
    expect(call).toHaveBeenCalledWith('/scheduling-evidence', 'overview', {})
    expect(screen.getByText('Radar evidence').nextSibling?.textContent).toBe('On')
    expect(screen.getByText('Personal-use collection').nextSibling?.textContent).toBe('Consented')
    expect(screen.getByText('Allocator mode').nextSibling?.textContent).toBe('Shadow: recorded, not used')
    expect(screen.getByText('/opt/homebrew/bin/python3.12')).toBeTruthy()
    expect(screen.getByText('Cycle interval').nextSibling?.textContent).toBe('4 h')
    expect(screen.getByText('Freshness').nextSibling?.textContent).toBe('Fresh')
    expect(screen.getByText('Collected at').nextSibling?.textContent).toBe('2026-10-01 14:05 UTC')
    expect(screen.getByText('Age').nextSibling?.textContent).toBe('32 min')
    expect(screen.getByText('codex-radar-v1-724e')).toBeTruthy()
    expect(screen.getByText('Loaded for the allocator').nextSibling?.textContent).toBe('Yes')
    expect(screen.getByText('Table rows').nextSibling?.textContent).toBe('models 89 · snapshots 1')
    expect(screen.getByText('Started').nextSibling?.textContent).toBe('2026-10-01 14:00 UTC')
    expect(screen.getByText('Collection').nextSibling?.textContent).toBe('Succeeded')
    expect(screen.getByText('Reading the store').nextSibling?.textContent).toBe('Succeeded')
    expect(screen.queryByText('How to turn it on')).toBeNull()
  })

  it('lists the rows the allocator can use, sorted as received, and filters them', async () => {
    const { handle } = connection([ok(page())])
    render(<SchedulingEvidenceSection connection={handle} t={t} />)
    await screen.findByText('Model results')

    const body = screen.getAllByRole('rowgroup')[1]!
    expect(within(body).getAllByRole('row')).toHaveLength(2)
    const astra = within(body).getAllByRole('row')[0]!
    expect(astra.textContent).toBe('gpt-6-astrahigh73.6%140110.4$2.8114 minYes')
    expect(within(body).getAllByRole('row')[1]!.textContent).toContain('40 s')
    expect(screen.getByText('2 rows shown')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: ' SOL ' } })
    expect(within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Filter models'), { target: { value: 'nothing' } })
    expect(screen.getByText('No rows match.')).toBeTruthy()
  })

  it('shows rows the allocator cannot use when the owner asks, with dashes for missing values', async () => {
    const { handle } = connection([ok(page())])
    render(<SchedulingEvidenceSection connection={handle} t={t} />)
    await screen.findByText('Model results')

    fireEvent.click(screen.getByRole('checkbox'))

    const rows = within(screen.getAllByRole('rowgroup')[1]!).getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(rows[2]!.textContent).toBe(`claude-opus-5low${'—'.repeat(6)}`)
  })

  it('explains why nothing is stored, how to turn Radar on, and shows an unknown mode', async () => {
    const { handle } = connection([ok(page({
      radar: { enabled: false, personalUseConsent: false, python: 'python3', refreshIntervalMs: null },
      lastCycle: null,
      store: { available: false, reason: 'No generation is stored yet.' },
      models: [],
      publicEvidence: null,
    }))])

    render(<SchedulingEvidenceSection connection={handle} t={t} />)

    await screen.findByText('How to turn it on')
    expect(screen.getByText('Radar evidence').nextSibling?.textContent).toBe('Off')
    expect(screen.getByText('Personal-use collection').nextSibling?.textContent).toBe('Not consented')
    expect(screen.getByText('Allocator mode').nextSibling?.textContent).toBe('Unknown')
    expect(screen.getByText('Cycle interval').nextSibling?.textContent).toBe('—')
    expect(screen.getByText('No generation is stored yet.')).toBeTruthy()
    expect(screen.getByText('No cycle has run since the app started.')).toBeTruthy()
    expect(screen.getByText(/radarEnabled: true/u)).toBeTruthy()
    expect(screen.getByText('No rows match.')).toBeTruthy()
  })

  it('falls back to a generic line when the store gives no reason', async () => {
    const { handle } = connection([ok(page({ store: { available: false, reason: '' }, models: [] }))])

    render(<SchedulingEvidenceSection connection={handle} t={t} />)

    await screen.findByText('Nothing stored yet.')
  })

  it.each([
    ['off', 'Off: evidence is ignored'],
    ['apply', 'Apply: breaks ties'],
  ] as const)('names the %s allocator mode', async (mode, label) => {
    const { handle } = connection([ok(page({ publicEvidence: mode }))])

    render(<SchedulingEvidenceSection connection={handle} t={t} />)

    await screen.findByText(label)
  })

  it.each([
    ['cache', 'Fresh'],
    ['stale', 'Stale'],
    ['stale-cache', 'Stale'],
    ['mystery', 'Unknown'],
  ] as const)('labels the %s freshness state', async (state, label) => {
    const base = page()
    const { handle } = connection([ok(page({ store: { ...base.store, state } as never }))])

    render(<SchedulingEvidenceSection connection={handle} t={t} />)

    await screen.findByText('Freshness')
    expect(screen.getByText('Freshness').nextSibling?.textContent).toBe(label)
  })

  it.each([
    [30, '30 s'],
    [7_200, '2 h'],
    [172_800, '2 d'],
    [null, '—'],
  ] as const)('formats an age of %s seconds', async (seconds, text) => {
    const base = page()
    const { handle } = connection([ok(page({ store: { ...base.store, ageSeconds: seconds } as never }))])

    render(<SchedulingEvidenceSection connection={handle} t={t} />)

    await screen.findByText('Freshness')
    expect(screen.getByText('Age').nextSibling?.textContent).toBe(text)
  })

  it('keeps an unparseable time as it came and shows a missing one as a dash', async () => {
    const base = page()
    const { handle } = connection([ok(page({
      store: { ...base.store, fetchedAt: 'last tuesday', sourceUpdatedAt: null, loaded: false } as never,
    }))])

    render(<SchedulingEvidenceSection connection={handle} t={t} />)

    await screen.findByText('Freshness')
    expect(screen.getByText('Collected at').nextSibling?.textContent).toBe('last tuesday')
    expect(screen.getByText('Source updated').nextSibling?.textContent).toBe('—')
    expect(screen.getByText('Loaded for the allocator').nextSibling?.textContent).toBe('Not yet')
  })

  it.each([
    ['skipped', 'ok', 'Skipped (no consent)', 'Succeeded', undefined],
    ['failed', 'failed', 'Failed', 'Failed', 'Python 3.9 is too old'],
  ] as const)('reports a %s collection', async (collection, reload, collectionText, reloadText, message) => {
    const { handle } = connection([ok(page({
      lastCycle: { startedAt: '2026-10-01T14:00:40Z', finishedAt: '2026-10-01T14:00:41Z', collection, reload, ...message === undefined ? {} : { message } },
    }))])

    render(<SchedulingEvidenceSection connection={handle} t={t} />)

    await screen.findByText('Last cycle')
    expect(screen.getByText('Collection').nextSibling?.textContent).toBe(collectionText)
    expect(screen.getByText('Reading the store').nextSibling?.textContent).toBe(reloadText)
    if (message !== undefined) expect(screen.getByText(message)).toBeTruthy()
  })

  it('disables Refresh while reading and reads again once the first reply has arrived', async () => {
    const first = Promise.withResolvers<Reply>()
    const { handle, call } = connection([first.promise, ok(page({ publicEvidence: 'apply' }))])
    render(<SchedulingEvidenceSection connection={handle} t={t} />)
    expect(screen.getByRole('button', { name: 'Refreshing…' }).hasAttribute('disabled')).toBe(true)

    first.resolve(ok(page()))
    await screen.findByText('Your switches')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByText('Apply: breaks ties')
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('drops a reply that arrives after the page unmounted', async () => {
    const pending = Promise.withResolvers<Reply>()
    const { handle } = connection([pending.promise])
    const view = render(<SchedulingEvidenceSection connection={handle} t={t} />)

    view.unmount()
    pending.resolve(ok(page()))
    await Promise.resolve()

    expect(screen.queryByText('Your switches')).toBeNull()
  })

  it('drops a rejection that arrives after the page unmounted', async () => {
    const pending = Promise.withResolvers<Reply>()
    const { handle } = connection([pending.promise])
    const view = render(<SchedulingEvidenceSection connection={handle} t={t} />)

    view.unmount()
    pending.reject(new Error('late'))
    await Promise.resolve()

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a server error and lets the owner retry', async () => {
    const { handle } = connection([{ ok: false, error: { message: 'store locked' } }, ok(page())])
    render(<SchedulingEvidenceSection connection={handle} t={t} />)

    expect((await screen.findByRole('alert')).textContent).toBe('Could not read the evidence store: store locked')
    expect(screen.queryByText('Loading…')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByText('Your switches')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows a transport failure, whether it is an Error or another value', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- transports may reject with a bare string.
    const failing = { handle: { rpc: { call: vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce('gone') } } as unknown as ConnectionHandle }
    render(<SchedulingEvidenceSection connection={failing.handle} t={t} />)

    expect((await screen.findByRole('alert')).textContent).toContain('offline')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('gone') })
  })

  it('has Chinese copy for every key the page uses', () => {
    expect(zh.title).toBe('调度证据')
    expect(Object.keys(zh)).toEqual(Object.keys(en))
  })
})
