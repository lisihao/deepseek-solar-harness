// @vitest-environment jsdom
/**
 * buildRenderApp on SlotTestRuntime: the fail-loud sessions precondition, the
 * one ctx-level renderSlot('root') call, and the document-title projection
 * arms over the real slot stack.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { buildRenderApp } from '@deepseek-ai/dsh-client-web/src/app.tsx'

let runtime: SlotTestRuntime | undefined

afterEach(async () => {
  cleanup()
  await runtime?.dispose()
  runtime = undefined
  document.title = ''
})

async function bench(connection: object = {
  state: { getSnapshot: () => 'connected', subscribe: () => () => {} },
}) {
  runtime = await SlotTestRuntime.create()
  runtime.provide('connection', connection)
  await runtime.root.declare({}, () => <div data-testid="frame" />)
  return { runtime, renderApp: buildRenderApp({ ctx: runtime.ctx }) }
}

describe('buildRenderApp', () => {
  it('fails loud when the sessions service is unavailable', () => {
    expect(() => buildRenderApp({ ctx: new Context() })).toThrow('sessions service unavailable')
  })

  it('keeps the stale projection visible and surfaces remote reconnecting state', async () => {
    let state: 'connected' | 'reconnecting' = 'connected'
    const listeners = new Set<() => void>()
    const b = await bench({
      transport: 'remote-projection',
      state: {
        getSnapshot: () => state,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    })
    const view = render(<>{buildRenderApp({ ctx: b.runtime.ctx })()}</>)
    expect(view.queryByText(/当前显示上次同步结果/)).toBeNull()
    await act(async () => {
      state = 'reconnecting'
      for (const listener of listeners) listener()
    })
    expect(await view.findByText(/当前显示上次同步结果/)).toBeTruthy()
    expect(view.getByTestId('frame')).toBeTruthy()
  })

  it('renders the root slot tree through the one ctx-level renderSlot call', async () => {
    const b = await bench()
    const view = render(<>{b.renderApp()}</>)
    expect(view.getByTestId('frame')).toBeTruthy()
  })

  it('projects the current session durable title and falls back to the product title', async () => {
    document.title = 'Product'
    const b = await bench()
    render(<>{b.renderApp()}</>)
    // No current session: the product title stands.
    expect(document.title).toBe('Product')
    await b.runtime.sessions.add({ id: 's1', summary: { title: 'First' } })
    expect(document.title).toBe('First — Product')
    await b.runtime.sessions.setCurrent(undefined)
    expect(document.title).toBe('Product')
    // A session without a durable title keeps the product title.
    await b.runtime.sessions.add({ id: 's2' })
    expect(document.title).toBe('Product')
  })

  it('a current id without a list row falls back (selection/list arbitration transient)', async () => {
    document.title = 'Product'
    const b = await bench()
    await b.runtime.sessions.add({ id: 's1', summary: { title: 'First' } })
    render(<>{b.renderApp()}</>)
    expect(document.title).toBe('First — Product')
    b.runtime.sessions.list.update((draft) => { draft.current = 'ghost' as SessionId })
    await b.runtime.flush()
    expect(document.title).toBe('Product')
  })
})
