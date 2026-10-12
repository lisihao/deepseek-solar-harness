// @vitest-environment jsdom
/** The session list filter through the real slot renderer: a registered rule removes the row from the assembled browser. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}</>
}

describe('the assembled workspace browser and ctx.sessionListFilters', () => {
  it('removes a hidden session from the rendered list, and brings it back when the rule is released', async () => {
    const runtime = await SlotTestRuntime.create()
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const keep = 'keep' as SessionId
    const room = 'room' as SessionId
    await runtime.sessions.add({ id: keep, summary: { title: '普通会话', displayTitle: '普通会话', cwd: '/w/alpha' }, session: {} })
    await runtime.sessions.add({ id: room, summary: { title: '狗窝话题', displayTitle: '狗窝话题', cwd: '/w/alpha', agentPreset: 'kennel' }, session: {} })
    await runtime.workspaces.update((draft) => {
      draft.items = [{
        workspaceId: 'w1' as WorkspaceId, title: 'alpha', path: '/w/alpha', sessionIds: [keep, room],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }] as never
    })
    await runtime.root.declare({ 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never, SidebarFrame as never)
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()
    await view.findByText('普通会话')
    await view.findByText('狗窝话题')

    let release = () => {}
    act(() => { release = (runtime.ctx as unknown as { sessionListFilters: { hide: (rule: (s: { agentPreset?: string }) => boolean) => () => void } }).sessionListFilters.hide(s => s.agentPreset === 'kennel') })
    await waitFor(() => { expect(view.queryByText('狗窝话题')).toBeNull() })
    expect(view.queryByText('普通会话')).not.toBeNull()

    act(() => { release() })
    await view.findByText('狗窝话题')
  })
})
