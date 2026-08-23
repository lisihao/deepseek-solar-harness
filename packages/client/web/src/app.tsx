/**
 * Real-UI assembly closure, invoked by the app-shell plugin once its inject
 * set is active: the whole layout tree hangs off the built-in 'root' slot
 * (ui-layout registers AppFrame there and renders the child slots
 * internally) — the shell's render is the one ctx-level renderSlot call in
 * the program.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { ConnectionBanner } from '@deepseek-ai/dsh-client-ui-primitives'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { DocumentTitle } from './DocumentTitle.tsx'
// Type-only: pulls the runtime's SlotMap declaration merge (the 'root' key) into this program.
import type {} from '@deepseek-ai/dsh-client-runtime/client'

/** Assembly inputs: the active app-shell plugin ctx (slots/sessions/layout services provided). */
export interface AssemblyDeps {
  /** Client context with the assembly's inject set active. */
  ctx: Context
}

/**
 * Build the renderApp factory the app-shell plugin provides to AppRoot.
 * @param deps - assembly inputs.
 * @returns factory producing the real UI tree (called once per AppRoot render after settled).
 */
export function buildRenderApp(deps: AssemblyDeps): () => ReactNode {
  const { ctx } = deps
  const sessions = ctx.get('sessions')
  if (sessions === undefined) throw new Error('shell assembly: sessions service unavailable')
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) throw new Error('shell assembly: connection service unavailable')
  const useSessions = bindSnapshotSelector(sessions.list)
  const SessionDocumentTitle = (): ReactNode => {
    const title = useSessions((state) => {
      const id = state.current
      return id === undefined ? undefined : state.byId[id]?.title
    })
    return <DocumentTitle {...title === undefined ? {} : { title }} />
  }
  const ConnectionStatus = (): ReactNode => {
    const state = useSyncExternalStore(
      listener => connection.state.subscribe(listener),
      () => connection.state.getSnapshot(),
    )
    return (
      <ConnectionBanner
        reconnecting={state === 'reconnecting'}
        label={connection.transport === 'remote-projection'
          ? '与 DSH Server 的连接已断开；当前显示上次同步结果，正在重连…'
          : '连接已断开，正在重连…'}
      />
    )
  }
  return () => (
    <>
      <SessionDocumentTitle />
      <ConnectionStatus />
      {ctx.slots.renderSlot('root', {})}
    </>
  )
}
