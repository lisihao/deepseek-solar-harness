import { createElement, useSyncExternalStore, type ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { BenchDetailInput, BenchExperimentDetail, BenchExperimentList, BenchLedgersApi } from './contracts.js'
import type { BenchT } from './format.js'
import { en, zh } from './locales.js'
import { RPC_REMOTE } from './remote.js'
import { BenchPage } from './view.js'

export const name = 'solar-bench'
export const inject = ['slots', 'remote', 'connection']

/** The wire-facing shape returned by the rc.2 Client Remote carrier. */
interface BenchLedgersWire {
  list(): Promise<RemoteResult<BenchExperimentList>>
  detail(input: BenchDetailInput): Promise<RemoteResult<BenchExperimentDetail>>
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  throw result.error
}

interface Snapshot {
  readonly api: BenchLedgersApi | undefined
  readonly error: string | undefined
}

class RemoteStore {
  private snapshot: Snapshot = { api: undefined, error: undefined }
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

/** The page's dictionary follows the app's document language. */
function translator(): BenchT {
  const language = (globalThis.document?.documentElement.lang || globalThis.navigator?.language || 'en').toLowerCase()
  const dictionary = language.startsWith('zh') ? zh : en
  return key => dictionary[key]
}

/** Mount the owner-only Remote namespace, then register the Settings → Benchmarks page. */
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
      const wire = ctx.get('remote.solarBenchLedgers') as unknown as BenchLedgersWire | undefined
      if (wire === undefined) {
        await disposer()
        store.set({ api: undefined, error: t('serviceMissing') })
        return
      }
      disposeRemote = disposer
      store.set({
        api: {
          list: async () => unwrap(await wire.list()),
          detail: async input => unwrap(await wire.detail(input)),
        },
        error: undefined,
      })
    }).catch((error: unknown) => {
      if (!disposed) store.set({ api: undefined, error: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      disposed = true
      store.set({ api: undefined, error: undefined })
      if (disposeRemote !== undefined) void disposeRemote()
    }
  }, 'solar-bench: remote')

  const Section = (): ReactElement => {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    return createElement(BenchPage, { api: snapshot.api, mountError: snapshot.error, t })
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'solar-bench', order: 47, label: () => t('nav') }, Section))
}
