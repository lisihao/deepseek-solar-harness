/** Root-scoped configuration store shared by every Web page instance. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { WebpageInstanceView } from '../contract.ts'

/** Browser lifecycle for the Host-published plugin roster. */
export interface WebpageModulesState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  requestId: number
  instances: WebpageInstanceView[]
  error: string | null
}

/** Declared writes used by the browser controller. */
export type WebpageModulesActions = {
  begin: (draft: WebpageModulesState, requestId: number) => void
  succeed: (draft: WebpageModulesState, requestId: number, instances: WebpageInstanceView[]) => void
  fail: (draft: WebpageModulesState, requestId: number, message: string) => void
}

/**
 * Create the package-owned store for dynamic instance configuration.
 * @returns A fresh declarative store handle for one browser plugin fiber.
 */
export function createWebpageModulesStore(): EngineStoreHandle<WebpageModulesState, WebpageModulesActions> {
  return defineStore({
    init: (): WebpageModulesState => ({ phase: 'idle', requestId: 0, instances: [], error: null }),
    actions: {
      begin: (draft, requestId) => {
        draft.phase = 'loading'
        draft.requestId = requestId
        draft.error = null
      },
      succeed: (draft, requestId, instances) => {
        if (draft.requestId !== requestId) return
        draft.phase = 'ready'
        draft.instances = instances
        draft.error = null
      },
      fail: (draft, requestId, message) => {
        if (draft.requestId !== requestId) return
        draft.phase = 'error'
        draft.error = message
      },
    },
  })
}
