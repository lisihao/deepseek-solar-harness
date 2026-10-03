// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, GouziAvatarImage, GouziEntry, inject, loadGouzi } from '../src/client/index.ts'
import { GOUZI_AVATARS, GOUZI_CONTROL_HEADER, type GouziDashboardV1, type GouziMemberProjection } from '../src/contracts.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function member(patch: Partial<GouziMemberProjection> = {}): GouziMemberProjection {
  return {
    gouziId: 'g1', name: 'Mochi', avatarId: 'shiba', role: 'development', membership: 'enabled',
    connection: 'online', activity: 'resting', state: 'resting', createdAt: '2026-10-03T12:00:00.000Z', ...patch,
  }
}

function dashboard(members: GouziMemberProjection[], patch: Partial<GouziDashboardV1> = {}): GouziDashboardV1 {
  return {
    version: 1, generatedAt: '2026-10-03T12:00:00.000Z', limit: 10, used: members.length,
    canManage: true, hostAvailable: true, members, ...patch,
  }
}

/** A fetch whose GET returns the current roster and whose POST records the body and applies `reply`. */
function fakeRequest(state: { roster: GouziDashboardV1; reply?: () => Response }) {
  const posts: Array<{ body: Record<string, unknown>; header: string | null }> = []
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void input
    if (init?.method === 'POST') {
      posts.push({
        body: JSON.parse(init.body as string) as Record<string, unknown>,
        header: new Headers(init.headers).get(GOUZI_CONTROL_HEADER),
      })
      return state.reply?.() ?? Response.json(member())
    }
    return Response.json(state.roster)
  })
  return { request: request as never, posts, calls: request }
}

describe('Gouzi avatars', () => {
  it('draws six distinct, named avatars at the sizes the sidebar and roster use', () => {
    const markup = new Set<string>()
    for (const avatarId of GOUZI_AVATARS) {
      const { container, unmount } = render(<GouziAvatarImage avatarId={avatarId} size={24} />)
      const svg = container.querySelector('svg')!
      expect(svg.getAttribute('width')).toBe('24')
      expect(svg.getAttribute('role')).toBe('img')
      expect(svg.getAttribute('aria-label')).toBeTruthy()
      markup.add(svg.innerHTML)
      unmount()
    }
    expect(markup.size).toBe(GOUZI_AVATARS.length)
    for (const size of [40, 64, 128]) {
      const { container, unmount } = render(<GouziAvatarImage avatarId="mixed" size={size} />)
      expect(container.querySelector('svg')!.getAttribute('height')).toBe(String(size))
      unmount()
    }
  })
})

describe('Gouzi sidebar entry and roster', () => {
  it('shows the member count, opens the roster, and describes each member in one primary state', async () => {
    const { request } = fakeRequest({ roster: dashboard([member(), member({ gouziId: 'g2', name: 'Pixel', state: 'working', activity: 'working' })]) })
    render(<GouziEntry wide request={request} />)
    await screen.findByText('2/10')
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    const dialog = await screen.findByRole('dialog', { name: '狗子' })
    expect(within(dialog).getByText('2 / 10 个名额')).toBeTruthy()
    expect(within(dialog).getByText('Mochi')).toBeTruthy()
    expect(within(dialog).getByText('休息中')).toBeTruthy()
    expect(within(dialog).getByText('工作中')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('walks the four adoption steps and posts one adopt request with the control header', async () => {
    const harness = fakeRequest({ roster: dashboard([]) })
    render(<GouziEntry wide request={harness.request} />)
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    fireEvent.click(await screen.findByRole('button', { name: '领养狗子' }))

    fireEvent.click(screen.getByRole('radio', { name: /贵宾/ }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Pixel  ' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    fireEvent.click(screen.getByRole('radio', { name: /测试/ }))
    const projects = screen.getByPlaceholderText('/Users/你/Projects/某个仓库')
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
    fireEvent.change(projects, { target: { value: 'relative/path' } })
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
    fireEvent.change(projects, { target: { value: '/work/alpha\n/work/beta' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    expect(screen.getByText('领养后 1 / 10')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    await waitFor(() => { expect(harness.posts).toHaveLength(1) })
    expect(harness.posts[0]).toEqual({
      header: '1',
      body: { action: 'adopt', name: 'Pixel', avatarId: 'poodle', role: 'testing', projects: ['/work/alpha', '/work/beta'] },
    })
    await waitFor(() => { expect(screen.queryByLabelText('领养一只狗子')).toBeNull() })
  })

  it('keeps the wizard open and shows the Host explanation when adoption fails', async () => {
    const harness = fakeRequest({
      roster: dashboard([]),
      reply: () => Response.json({ error: 'GOUZI_START_FAILED', message: 'Mochi 已创建，但还没能启动：端口被占用' }, { status: 502 }),
    })
    render(<GouziEntry wide request={harness.request} />)
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    fireEvent.click(await screen.findByRole('button', { name: '领养狗子' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mochi' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.change(screen.getByPlaceholderText('/Users/你/Projects/某个仓库'), { target: { value: '/work/alpha' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    expect((await screen.findByRole('alert')).textContent).toContain('端口被占用')
    expect(screen.getByLabelText('领养一只狗子')).toBeTruthy()
  })

  it('disables adoption when the roster is full or the Host cannot start members', async () => {
    const full = fakeRequest({ roster: dashboard(Array.from({ length: 10 }, (_, index) => member({ gouziId: `g${String(index)}` }))) })
    const { unmount } = render(<GouziEntry wide request={full.request} />)
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    expect(await screen.findByRole('button', { name: '领养狗子' })).toHaveProperty('disabled', true)
    unmount()

    const noHost = fakeRequest({ roster: dashboard([], { hostAvailable: false }) })
    render(<GouziEntry wide request={noHost.request} />)
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    expect(await screen.findByRole('button', { name: '领养狗子' })).toHaveProperty('disabled', true)
    expect(await screen.findByText('这台机器还不能启动狗子，只能查看。')).toBeTruthy()
  })

  it('offers wake only to a member that is not reachable, and keeps retire away from a working one', async () => {
    const harness = fakeRequest({
      roster: dashboard([
        member({ gouziId: 'gone', name: 'Gone', state: 'unreachable', connection: 'unreachable' }),
        member({ gouziId: 'busy', name: 'Busy', state: 'working', activity: 'working' }),
      ]),
    })
    render(<GouziEntry wide request={harness.request} />)
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    const dialog = await screen.findByRole('dialog')
    const cards = await within(dialog).findAllByRole('listitem')
    expect(within(cards[0]!).getByRole('button', { name: '唤醒' })).toBeTruthy()
    expect(within(cards[0]!).queryByRole('button', { name: '休息' })).toBeNull()
    expect(within(cards[1]!).getByRole('button', { name: '退役' })).toHaveProperty('disabled', true)
    fireEvent.click(within(cards[0]!).getByRole('button', { name: '唤醒' }))
    await waitFor(() => { expect(harness.posts[0]!.body).toEqual({ action: 'wake', gouziId: 'gone' }) })
  })

  it('asks before retiring and sends nothing when the user declines', async () => {
    const harness = fakeRequest({ roster: dashboard([member()]) })
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    vi.stubGlobal('confirm', confirm)
    render(<GouziEntry wide request={harness.request} />)
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    const retire = await screen.findByRole('button', { name: '退役' })
    fireEvent.click(retire)
    expect(harness.posts).toEqual([])
    fireEvent.click(retire)
    await waitFor(() => { expect(harness.posts[0]!.body).toEqual({ action: 'retire', gouziId: 'g1' }) })
  })

  it('edits the name, avatar, and role of a member', async () => {
    const harness = fakeRequest({ roster: dashboard([member()]) })
    render(<GouziEntry wide request={harness.request} />)
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    fireEvent.click(await screen.findByRole('button', { name: '修改' }))
    fireEvent.change(screen.getByDisplayValue('Mochi'), { target: { value: 'Pixel' } })
    fireEvent.click(screen.getByRole('radio', { name: /比熊/ }))
    fireEvent.click(screen.getByRole('radio', { name: /研究/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(harness.posts).toHaveLength(1) })
    expect(harness.posts[0]!.body).toEqual({ action: 'edit', gouziId: 'g1', name: 'Pixel', avatarId: 'bichon', role: 'research' })
  })

  it('hides every control from a read-only device and says so', async () => {
    const harness = fakeRequest({ roster: dashboard([member()], { canManage: false }) })
    render(<GouziEntry wide request={harness.request} />)
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    expect(await screen.findByText('这个设备只能查看狗子。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '领养狗子' })).toBeNull()
    expect(screen.queryByRole('button', { name: '退役' })).toBeNull()
  })

  it('shows an empty roster invitation and a load failure', async () => {
    const empty = fakeRequest({ roster: dashboard([]) })
    const { unmount } = render(<GouziEntry wide request={empty.request} />)
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    expect(await screen.findByText(/还没有狗子/u)).toBeTruthy()
    unmount()

    const failing = vi.fn(async () => Response.json({ error: 'GOUZI_UNAVAILABLE', message: '当前编排服务不管理狗子' }, { status: 503 }))
    render(<GouziEntry wide request={failing as never} />)
    fireEvent.click(screen.getByRole('button', { name: '狗子' }))
    expect((await screen.findByRole('alert')).textContent).toContain('当前编排服务不管理狗子')
  })

  it('renders the rail form without a label when the sidebar is collapsed', async () => {
    const harness = fakeRequest({ roster: dashboard([member()]) })
    render(<GouziEntry wide={false} request={harness.request} />)
    expect(screen.getByRole('button', { name: '狗子' }).textContent).toBe('')
  })

  it('wraps a malformed failure body in a generic explanation', async () => {
    const request = vi.fn(async () => new Response('<html>', { status: 500 }))
    await expect(loadGouzi(request as never)).rejects.toMatchObject({ code: 'GOUZI_FAILED', status: 500 })
  })
})

describe('Gouzi client registration', () => {
  it('registers one sidebar footer action that hands the connection fetch to the entry', async () => {
    expect(inject).toEqual(['slots', 'connection'])
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({ name: 'root', children: { 'sidebar.footer.action': { kind: 'list', scope: 'root' } } } as never, () => null)
    const fetchStub = vi.fn()
    ctx.provide('connection', { request: fetchStub } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entries = slots.entries('sidebar.footer.action')
    expect(entries.map(entry => [entry.options.id, entry.options.order])).toEqual([['gouzi', 90]])
    expect((entries[0]!.inject as () => { request: unknown })().request).toBe(fetchStub)
    await fiber.dispose()
    expect(slots.entries('sidebar.footer.action')).toEqual([])
  })
})
