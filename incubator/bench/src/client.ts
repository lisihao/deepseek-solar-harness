import { createElement, useSyncExternalStore, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { BenchDetailInput, BenchExperimentDetail, BenchExperimentList, BenchLedgersApi } from './contracts.js'
import type { BenchT } from './format.js'
import { currentLanguage, en, zh } from './locales.js'
import { RPC_REMOTE } from './remote.js'
import type { BenchJobStatus, BenchRunChoices, BenchStartInput } from './runs.js'
import { BenchSidebar, type BenchRunsApi } from './view.js'

export const name = 'solar-bench'
export const inject = ['slots', 'remote', 'connection', 'sidebarRightTabs']

/** Identity of this tab type; also the key its body registers under. */
const TAB_ID = '@lisihao/dsh-solar-bench/benchmarks'
/** Kind the guide entry opens. */
const TAB_KIND = 'solar-bench'

/** The wire-facing shapes returned by the rc.2 Client Remote carrier. */
interface BenchLedgersWire {
  list(): Promise<RemoteResult<BenchExperimentList>>
  detail(input: BenchDetailInput): Promise<RemoteResult<BenchExperimentDetail>>
}
interface BenchRunsWire {
  choices(): Promise<RemoteResult<BenchRunChoices>>
  start(input: BenchStartInput): Promise<RemoteResult<{ experimentId: string }>>
  status(): Promise<RemoteResult<BenchJobStatus>>
  stop(): Promise<RemoteResult<BenchJobStatus>>
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw result.error
}

interface Snapshot {
  readonly ledgers: BenchLedgersApi | undefined
  readonly runs: BenchRunsApi | undefined
  readonly error: string | undefined
}

class RemoteStore {
  private snapshot: Snapshot = { ledgers: undefined, runs: undefined, error: undefined }
  private readonly listeners = new Set<() => void>()
  getSnapshot = (): Snapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  set(snapshot: Snapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

/**
 * The page's dictionary follows the app's document language, read on every
 * call: in the installed app a read at apply time chose English although
 * `<html lang>` was `zh-CN` when the page rendered.
 */
export function translator(): BenchT {
  return key => (currentLanguage() === 'zh' ? zh : en)[key]
}

/** Mount the owner-only Remote namespaces, then register the Benchmarks tab of the right sidebar. */
export function apply(ctx: Context): void {
  const store = new RemoteStore()
  const t = translator()
  let disposed = false
  let disposeRemote: (() => Promise<void>) | undefined

  ctx.effect(() => {
    void ctx.remote.$mount(RPC_REMOTE).then(async (disposer) => {
      if (disposed) {
        await disposer()
        return
      }
      const ledgers = ctx.get('remote.solarBenchLedgers') as unknown as BenchLedgersWire | undefined
      const runs = ctx.get('remote.solarBenchRuns') as unknown as BenchRunsWire | undefined
      if (ledgers === undefined || runs === undefined) {
        await disposer()
        store.set({ ledgers: undefined, runs: undefined, error: t('serviceMissing') })
        return
      }
      disposeRemote = disposer
      store.set({
        ledgers: {
          list: async () => unwrap(await ledgers.list()),
          detail: async input => unwrap(await ledgers.detail(input)),
        },
        runs: {
          choices: async () => unwrap(await runs.choices()),
          start: async input => unwrap(await runs.start(input)),
          status: async () => unwrap(await runs.status()),
          stop: async () => unwrap(await runs.stop()),
        },
        error: undefined,
      })
    }).catch((error: unknown) => {
      if (!disposed) store.set({ ledgers: undefined, runs: undefined, error: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      disposed = true
      store.set({ ledgers: undefined, runs: undefined, error: undefined })
      if (disposeRemote !== undefined) void disposeRemote()
    }
  }, 'solar-bench: remote')

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => t('nav'),
    guide: [{ id: 'benchmarks', order: 90, title: () => t('nav'), description: () => t('guideDescription') }],
  }), 'solar-bench: tab type')

  const Body = ({ useTabInfo }: { readonly useTabInfo: UseSidebarRightTabInfo }): ReactElement => {
    const { tab } = useTabInfo()
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    return createElement(BenchSidebar, { ledgers: snapshot.ledgers, runs: snapshot.runs, mountError: snapshot.error, visible: tab.visible, t })
  }
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, Body)), 'solar-bench: tab body')
}
