// @vitest-environment jsdom
import { useState } from 'react'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRuntime, SlotRegistry, WorkspaceRuntime } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, GouziAvatarImage, GouziManager, inject, KennelEntry, KENNEL_PRESET, loadGouzi, openKennel } from '../src/client/index.ts'
import type { GouziFolders } from '../src/client/index.ts'
import { GOUZI_AVATARS, GOUZI_CONTROL_HEADER, type GouziDashboardV1, type GouziMemberProjection, type GouziRoomSnapshotV1 } from '../src/contracts.ts'

import { decodeKennelMessage, encodeKennelMessage } from '../src/recipient-message.ts'
import { RemoteFolderPicker } from '../src/client/RemoteFolderPicker.tsx'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const LOCAL_HOST = { hostId: 'local', label: '这台 Mac', kind: 'local' } as const
const MINI_HOST = { hostId: 'ssh-1', label: 'Mac mini', kind: 'ssh', address: 'lisihao@mini.local:22', appVersion: '3.36.0' } as const

function member(patch: Partial<GouziMemberProjection> = {}): GouziMemberProjection {
  return {
    gouziId: 'g1', name: 'Mochi', avatarId: 'shiba', role: 'development', hostId: 'local', hostLabel: '这台 Mac', membership: 'enabled',
    connection: 'online', activity: 'resting', state: 'resting', createdAt: '2026-10-03T12:00:00.000Z', ...patch,
  }
}

function dashboard(members: GouziMemberProjection[], patch: Partial<GouziDashboardV1> = {}): GouziDashboardV1 {
  return {
    version: 1, generatedAt: '2026-10-03T12:00:00.000Z', limit: 10, used: members.length,
    canManage: true, hostAvailable: true, hosts: [LOCAL_HOST], members, ...patch,
  }
}

/** A fetch whose GET returns the current roster and whose POST records the body and applies `reply`. */
function fakeRequest(state: {
  roster: GouziDashboardV1
  reply?: (body: Record<string, unknown>) => Response
  checkReply?: (body: Record<string, unknown>) => Response | Promise<Response>
}) {
  const posts: Array<{ body: Record<string, unknown>; header: string | null }> = []
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void input
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      posts.push({ body, header: new Headers(init.headers).get(GOUZI_CONTROL_HEADER) })
      if (body.action === 'check-projects') return await state.checkReply?.(body) ?? Response.json({ projects: (body.projects as string[]).map(path => ({ path, usable: true })) })
      return state.reply?.(body) ?? Response.json(member())
    }
    return Response.json(state.roster)
  })
  return { request: request as never, posts, calls: request }
}

interface FakeWorkspace { workspaceId: string; path: string; title: string; updatedAt: string }

/** The workspace slice the wizard reads: a fixed list, a recency pointer, and a scripted native picker. */
function fakeFolders(
  items: FakeWorkspace[] = [],
  pick: () => Promise<string | null> = async () => null,
  recentWorkspaceId: string | null = null,
) {
  const state = { items, recentWorkspaceId }
  const pickDirectory = vi.fn(pick)
  const folders = {
    list: { getSnapshot: () => state, subscribe: () => () => undefined },
    pickDirectory,
  } as unknown as GouziFolders
  return { folders, pickDirectory }
}

const ALPHA: FakeWorkspace = { workspaceId: 'w1', path: '/work/alpha', title: 'alpha', updatedAt: '2026-10-01T00:00:00.000Z' }
const BETA: FakeWorkspace = { workspaceId: 'w2', path: '/work/beta', title: 'beta', updatedAt: '2026-10-02T00:00:00.000Z' }

/** Walk the wizard to the project step with the avatar and name filled in. */
async function openProjectStep(harness: ReturnType<typeof fakeRequest>, folders: GouziFolders): Promise<void> {
  render(<GouziManager request={harness.request} folders={folders} />)
  fireEvent.click(await screen.findByRole('button', { name: '领养狗子' }))
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pixel' } })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
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
  it('shows the member count and describes each member in one primary state', async () => {
    const { request } = fakeRequest({ roster: dashboard([member(), member({ gouziId: 'g2', name: 'Pixel', state: 'working', activity: 'working' })]) })
    render(<GouziManager request={request} folders={fakeFolders().folders} />)
    const page = await screen.findByRole('region', { name: '狗子' })
    expect(await within(page).findByText('2 / 10 个名额')).toBeTruthy()
    expect(within(page).getByText('Mochi')).toBeTruthy()
    expect(within(page).getByText('休息中')).toBeTruthy()
    expect(within(page).getByText('工作中')).toBeTruthy()
  })

  it('walks the four adoption steps, suggesting the recent project, and posts one adopt request with the control header', async () => {
    const harness = fakeRequest({ roster: dashboard([]) })
    const { folders } = fakeFolders([ALPHA, BETA], async () => null, 'w1')
    render(<GouziManager request={harness.request} folders={folders} />)
    fireEvent.click(await screen.findByRole('button', { name: '领养狗子' }))

    fireEvent.click(screen.getByRole('radio', { name: /贵宾/ }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Pixel  ' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    expect(screen.getByRole('radio', { name: /这台 Mac/ })).toHaveProperty('ariaChecked', 'true')
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    fireEvent.click(screen.getByRole('radio', { name: /测试/ }))
    expect(screen.queryByRole('textbox')).toBeNull()
    await waitFor(() => { expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('checked', true) })
    expect(screen.getByRole('checkbox', { name: /beta/ })).toHaveProperty('checked', false)
    fireEvent.click(screen.getByRole('checkbox', { name: /beta/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /alpha/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /alpha/ }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    expect(screen.getByText('领养后 1 / 10')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    await waitFor(() => { expect(harness.posts.filter(post => post.body.action === 'adopt')).toHaveLength(1) })
    expect(harness.posts.find(post => post.body.action === 'adopt')).toEqual({
      header: '1',
      body: { action: 'adopt', name: 'Pixel', avatarId: 'poodle', role: 'testing', hostId: 'local', projects: ['/work/beta', '/work/alpha'] },
    })
    await waitFor(() => { expect(screen.queryByLabelText('领养一只狗子')).toBeNull() })
  })

  it('preselects the newest project when no recent workspace is known and blocks next when none is selected', async () => {
    const harness = fakeRequest({ roster: dashboard([]) })
    await openProjectStep(harness, fakeFolders([ALPHA, BETA]).folders)
    await waitFor(() => { expect(screen.getByRole('checkbox', { name: /beta/ })).toHaveProperty('checked', true) })
    fireEvent.click(screen.getByRole('checkbox', { name: /beta/ }))
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
  })

  it('lets the user add a project with the folder picker and ignores a cancelled pick', async () => {
    const harness = fakeRequest({ roster: dashboard([]) })
    const picks: Array<string | null> = [null, '/work/picked', '/work/picked']
    const { folders, pickDirectory } = fakeFolders([], async () => picks.shift() ?? null)
    await openProjectStep(harness, folders)
    expect(screen.getByText(/还没有打开过项目/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() => { expect(pickDirectory).toHaveBeenCalledTimes(1) })
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(harness.posts.filter(post => post.body.action === 'adopt')).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() => { expect(screen.getByRole('checkbox', { name: /picked/ })).toHaveProperty('checked', true) })
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() => { expect(pickDirectory).toHaveBeenCalledTimes(3) })
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    await waitFor(() => { expect(harness.posts.find(post => post.body.action === 'adopt')?.body.projects).toEqual(['/work/picked']) })
  })

  it.each([{ items: [] }, { items: [ALPHA] }])('keeps a native-picked project after returning from confirmation with history $items', async ({ items }) => {
    const harness = fakeRequest({ roster: dashboard([]) })
    await openProjectStep(harness, fakeFolders(items, async () => '/work/outside').folders)
    if (items.length > 0) {
      await waitFor(() => { expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('checked', true) })
      fireEvent.click(screen.getByRole('checkbox', { name: /alpha/ }))
    }
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() => { expect(screen.getByRole('checkbox', { name: /outside/ })).toHaveProperty('checked', true) })
    await waitFor(() => { expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('outside')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '上一步' }))
    await waitFor(() => { expect(screen.getByRole('checkbox', { name: /outside/ })).toHaveProperty('checked', true) })
    await waitFor(() => { expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', false) })
    if (items.length > 0) expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('checked', false)
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    await waitFor(() => { expect(harness.posts.find(post => post.body.action === 'adopt')?.body.projects).toEqual(['/work/outside']) })
  })

  it('accepts accessible plain and no-origin project check results and shows the persisted default before adoption', async () => {
    const plain = { ...ALPHA, workspaceId: 'plain', path: '/work/plain', title: 'plain' }
    const noOrigin = { ...BETA, workspaceId: 'no-origin', path: '/work/no-origin', title: 'no-origin' }
    const harness = fakeRequest({ roster: dashboard([]), checkReply: body => Response.json({
      projects: (body.projects as string[]).map(path => ({ path, usable: true })),
    }) })
    await openProjectStep(harness, fakeFolders([plain, noOrigin], async () => null, 'plain').folders)
    await waitFor(() => { expect(screen.getByRole('checkbox', { name: /plain/ })).toHaveProperty('checked', true) })
    fireEvent.click(screen.getByRole('checkbox', { name: /no-origin/ }))
    expect(screen.getByText(/不要求已有 Git 仓库或 origin/)).toBeTruthy()
    expect(harness.posts.every(post => post.body.action === 'check-projects')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    const defaultRow = screen.getByText('默认项目').parentElement!
    const remainingRow = screen.getByText('其它项目').parentElement!
    expect(within(defaultRow).getByText('plain')).toBeTruthy()
    expect(within(remainingRow).getByText('no-origin')).toBeTruthy()
    expect(screen.getByText('如果所选目录还不是 Git 仓库，确认领养时会初始化 Git；现有文件不会自动提交。')).toBeTruthy()
    expect(harness.posts.filter(post => post.body.action === 'adopt')).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    await waitFor(() => { expect(harness.posts.find(post => post.body.action === 'adopt')?.body.projects).toEqual(['/work/plain', '/work/no-origin']) })
  })

  it('selects an arbitrary plain native directory but does not adopt when the confirmation is cancelled', async () => {
    const harness = fakeRequest({ roster: dashboard([]) })
    await openProjectStep(harness, fakeFolders([], async () => '/outside/plain').folders)
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() => { expect(screen.getByRole('checkbox', { name: /plain/ })).toHaveProperty('checked', true) })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText(/确认领养时会初始化 Git/)).toBeTruthy()
    for (let step = 0; step < 4; step++) fireEvent.click(screen.getByRole('button', { name: '上一步' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByLabelText('领养一只狗子')).toBe(null)
    expect(harness.posts.some(post => post.body.action === 'check-projects')).toBe(true)
    expect(harness.posts.filter(post => post.body.action === 'adopt')).toEqual([])
  })

  it('checks candidates before selecting and refuses inaccessible directories', async () => {
    let finish!: (response: Response) => void
    const harness = fakeRequest({ roster: dashboard([]), checkReply: (body) => {
      if ((body.projects as string[]).includes('/work/plain')) return Response.json({ projects: (body.projects as string[]).map(path => path === '/work/plain'
        ? { path, usable: false, message: '目录不可访问' } : { path, usable: true }) })
      return new Promise<Response>((resolve) => { finish = resolve })
    } })
    await openProjectStep(harness, fakeFolders([ALPHA, BETA], async () => '/work/plain', 'w1').folders)
    expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('checked', false)
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
    finish(Response.json({ projects: [{ path: BETA.path, usable: true }, { path: ALPHA.path, usable: false, message: '目录不存在' }] }))
    await waitFor(() => { expect(screen.getByRole('checkbox', { name: /beta/ })).toHaveProperty('checked', true) })
    expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('disabled', true)
    expect(screen.getByText('目录不存在')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await screen.findByText('目录不可访问')
    expect(screen.getByRole('checkbox', { name: /plain/ })).toHaveProperty('checked', false)
    expect(screen.getByRole('checkbox', { name: /plain/ })).toHaveProperty('disabled', true)
    expect(harness.posts.filter(post => post.body.action === 'adopt')).toEqual([])
  })

  it('keeps next disabled on a failed project check and ignores a check that finishes after leaving the step', async () => {
    let finish!: (response: Response) => void
    let count = 0
    const harness = fakeRequest({ roster: dashboard([]), checkReply: () => {
      if (++count === 1) return Response.json({ error: 'GOUZI_FAILED', message: 'Directory inspection timed out' }, { status: 502 })
      return new Promise<Response>((resolve) => { finish = resolve })
    } })
    await openProjectStep(harness, fakeFolders([ALPHA]).folders)
    expect((await screen.findByRole('alert')).textContent).toContain('Directory inspection timed out')
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '上一步' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '上一步' }))
    finish(Response.json({ projects: [{ path: ALPHA.path, usable: true }] }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('checked', false)
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
  })

  it.each([
    { projects: [{ path: ALPHA.path, usable: false, message: '目录不存在' }] },
    { projects: [{ path: '/wrong/path', usable: true }] },
    { projects: [{ path: ALPHA.path, usable: false }] },
    {},
  ])('does not select an unavailable or malformed check result %j', async (reply) => {
    const harness = fakeRequest({ roster: dashboard([]), checkReply: () => Response.json(reply) })
    await openProjectStep(harness, fakeFolders([ALPHA]).folders)
    if ('projects' in reply && reply.projects?.[0]?.usable === false && 'message' in reply.projects[0]) {
      await screen.findByText('目录不存在')
    } else await screen.findByRole('alert')
    expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('disabled', true)
    expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('checked', false)
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
  })

  it('ignores a native folder pick that completes after leaving the project step', async () => {
    let picked!: (path: string) => void
    const harness = fakeRequest({ roster: dashboard([]) })
    const { folders } = fakeFolders([], () => new Promise<string>((resolve) => { picked = resolve }))
    await openProjectStep(harness, folders)
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    fireEvent.click(screen.getByRole('button', { name: '上一步' }))
    picked('/work/late')
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await waitFor(() => { expect(screen.queryByRole('checkbox')).toBeNull() })
    expect(harness.posts.filter(post => post.body.action === 'check-projects')).toEqual([])
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
  })

  it('shows why the folder picker failed without losing the wizard', async () => {
    const harness = fakeRequest({ roster: dashboard([]) })
    const { folders } = fakeFolders([], async () => { throw new Error('picker unavailable') })
    await openProjectStep(harness, folders)
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    expect((await screen.findByRole('alert')).textContent).toContain('picker unavailable')
  })

  it('keeps the wizard open and shows the Host explanation when adoption fails', async () => {
    const harness = fakeRequest({
      roster: dashboard([]),
      reply: () => Response.json({ error: 'GOUZI_START_FAILED', message: 'Mochi 已创建，但还没能启动：端口被占用' }, { status: 502 }),
    })
    render(<GouziManager request={harness.request} folders={fakeFolders([ALPHA]).folders} />)
    fireEvent.click(await screen.findByRole('button', { name: '领养狗子' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Mochi' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', false) })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    expect((await screen.findByRole('alert')).textContent).toContain('端口被占用')
    expect(screen.getByLabelText('领养一只狗子')).toBeTruthy()
  })

  it('disables adoption when the roster is full or the Host cannot start members', async () => {
    const full = fakeRequest({ roster: dashboard(Array.from({ length: 10 }, (_, index) => member({ gouziId: `g${String(index)}` }))) })
    const { unmount } = render(<GouziManager request={full.request} folders={fakeFolders().folders} />)
    expect(await screen.findByRole('button', { name: '领养狗子' })).toHaveProperty('disabled', true)
    unmount()

    const noHost = fakeRequest({ roster: dashboard([], { hostAvailable: false }) })
    render(<GouziManager request={noHost.request} folders={fakeFolders().folders} />)
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
    render(<GouziManager request={harness.request} folders={fakeFolders().folders} />)
    const dialog = await screen.findByRole('region')
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
    render(<GouziManager request={harness.request} folders={fakeFolders().folders} />)
    const retire = await screen.findByRole('button', { name: '退役' })
    fireEvent.click(retire)
    expect(harness.posts).toEqual([])
    fireEvent.click(retire)
    await waitFor(() => { expect(harness.posts[0]!.body).toEqual({ action: 'retire', gouziId: 'g1' }) })
  })

  it('edits the name, avatar, and role of a member', async () => {
    const harness = fakeRequest({ roster: dashboard([member()]) })
    render(<GouziManager request={harness.request} folders={fakeFolders().folders} />)
    fireEvent.click(await screen.findByRole('button', { name: '修改' }))
    fireEvent.change(screen.getByDisplayValue('Mochi'), { target: { value: 'Pixel' } })
    fireEvent.click(screen.getByRole('radio', { name: /比熊/ }))
    fireEvent.click(screen.getByRole('radio', { name: /研究/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(harness.posts).toHaveLength(2) })
    expect(harness.posts[0]!.body).toEqual({ action: 'models', gouziId: 'g1' })
    expect(harness.posts[1]!.body).toEqual({ action: 'edit', gouziId: 'g1', name: 'Pixel', avatarId: 'bichon', role: 'research', model: null })
  })

  it('pins a model chosen from the ones the member\'s runtimes offer, and returns to Smart Auto on request', async () => {
    const harness = fakeRequest({
      roster: dashboard([member({ model: 'gpt-5.5' })]),
      reply: body => body.action === 'models' ? Response.json({ models: ['gpt-5.5', 'claude-opus-5-5'] }) : Response.json(member()),
    })
    render(<GouziManager request={harness.request} folders={fakeFolders().folders} />)
    expect(await screen.findByText(/模型 gpt-5\.5/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '修改' }))
    const select = await screen.findByDisplayValue('gpt-5.5')
    await waitFor(() => { expect(screen.getByRole('option', { name: 'claude-opus-5-5' })).toBeTruthy() })
    fireEvent.change(select, { target: { value: 'claude-opus-5-5' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(harness.posts).toHaveLength(2) })
    expect(harness.posts[1]!.body).toMatchObject({ action: 'edit', model: 'claude-opus-5-5' })

    fireEvent.click(await screen.findByRole('button', { name: '修改' }))
    fireEvent.change(await screen.findByDisplayValue('gpt-5.5'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(harness.posts).toHaveLength(4) })
    expect(harness.posts[3]!.body).toMatchObject({ action: 'edit', model: null })
  })

  it('keeps a pinned model that no runtime offers selectable, and still saves when the models request fails', async () => {
    const stale = fakeRequest({
      roster: dashboard([member({ model: 'retired-model' })]),
      reply: body => body.action === 'models' ? Response.json({ models: ['gpt-5.5'] }) : Response.json(member()),
    })
    const { unmount } = render(<GouziManager request={stale.request} folders={fakeFolders().folders} />)
    fireEvent.click(await screen.findByRole('button', { name: '修改' }))
    expect(await screen.findByRole('option', { name: 'retired-model（当前不可用）' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(stale.posts).toHaveLength(2) })
    expect(stale.posts[1]!.body).toMatchObject({ action: 'edit', model: 'retired-model' })
    unmount()

    const failing = fakeRequest({
      roster: dashboard([member()]),
      reply: body => body.action === 'models' ? new Response('{}', { status: 500 }) : Response.json(member()),
    })
    render(<GouziManager request={failing.request} folders={fakeFolders().folders} />)
    fireEvent.click(await screen.findByRole('button', { name: '修改' }))
    await waitFor(() => { expect(failing.posts).toHaveLength(1) })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => { expect(failing.posts).toHaveLength(2) })
    expect(failing.posts[1]!.body).toMatchObject({ action: 'edit', model: null })
  })

  it('hides every control from a read-only device and says so', async () => {
    const harness = fakeRequest({ roster: dashboard([member()], { canManage: false }) })
    render(<GouziManager request={harness.request} folders={fakeFolders().folders} />)
    expect(await screen.findByText('这个设备只能查看狗子。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '领养狗子' })).toBeNull()
    expect(screen.queryByRole('button', { name: '退役' })).toBeNull()
  })

  it('shows an empty roster invitation and a load failure', async () => {
    const empty = fakeRequest({ roster: dashboard([]) })
    const { unmount } = render(<GouziManager request={empty.request} folders={fakeFolders().folders} />)
    expect(await screen.findByText(/还没有狗子/u)).toBeTruthy()
    unmount()

    const failing = vi.fn(async () => Response.json({ error: 'GOUZI_UNAVAILABLE', message: '当前编排服务不管理狗子' }, { status: 503 }))
    render(<GouziManager request={failing as never} folders={fakeFolders().folders} />)
    expect((await screen.findByRole('alert')).textContent).toContain('当前编排服务不管理狗子')
  })

  it('wraps a malformed failure body in a generic explanation', async () => {
    const request = vi.fn(async () => new Response('<html>', { status: 500 }))
    await expect(loadGouzi(request as never)).rejects.toMatchObject({ code: 'GOUZI_FAILED', status: 500 })
  })
})

describe('Gouzi remote directory picker', () => {
  it('allows the filesystem root and every child directory independently of the Git badge', async () => {
    const harness = fakeRequest({ roster: dashboard([]), reply: () => Response.json({
      path: '/', entries: [{ name: 'plain', path: '/plain', git: false }, { name: 'repository', path: '/repository', git: true }],
    }) })
    function Picker() {
      const [selected, setSelected] = useState<readonly string[]>([])
      return <RemoteFolderPicker request={harness.request} hostId="ssh-1" selected={selected} onChange={setSelected} />
    }
    render(<Picker />)
    const current = await screen.findByRole('checkbox', { name: '选择当前目录' })
    expect(screen.getByRole('button', { name: '上一级' })).toHaveProperty('disabled', true)
    fireEvent.click(current)
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 plain' }))
    expect(current).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: '选择 plain' })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: '选择 repository' })).toBeTruthy()
    expect(screen.getByText('Git')).toBeTruthy()
    expect(screen.getByLabelText('已选择的项目').textContent).toContain('/plain')
    expect(harness.posts.every(post => post.body.action === 'browse')).toBe(true)
  })
})

describe('Gouzi remote hosts in the adoption wizard', () => {
  const FINGERPRINT = 'SHA256:abc123'

  function remoteReply(posts: { added?: boolean } = {}) {
    return (body: Record<string, unknown>): Response => {
      switch (body.action) {
        case 'host-inspect': return Response.json({ keyType: 'ssh-ed25519', fingerprint: FINGERPRINT })
        case 'host-add': posts.added = true; return Response.json(MINI_HOST)
        case 'browse': {
          const base = typeof body.path === 'string' ? body.path : undefined
          if (base === undefined) {
            return Response.json({ path: '/Users/lisihao', parent: '/Users', entries: [{ name: 'project', path: '/Users/lisihao/project', git: false }] })
          }
          return Response.json({
            path: base,
            parent: '/Users/lisihao',
            entries: [{ name: 'PetGoGo', path: `${base}/PetGoGo`, git: true }, { name: 'notes', path: `${base}/notes`, git: false }],
          })
        }
        default: return Response.json(member({ hostId: 'ssh-1', hostLabel: 'Mac mini' }))
      }
    }
  }

  it('adds a machine: shows its fingerprint first, then logs in once with the password and selects it', async () => {
    const state = { added: false }
    const harness = fakeRequest({ roster: dashboard([]), reply: remoteReply(state) })
    render(<GouziManager request={harness.request} folders={fakeFolders().folders} />)
    fireEvent.click(await screen.findByRole('button', { name: '领养狗子' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pixel' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    fireEvent.click(screen.getByRole('button', { name: /添加另一台机器/ }))
    const check = screen.getByRole('button', { name: '检查这台机器' })
    expect(check).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByPlaceholderText(/mini.local/), { target: { value: ' mini.local ' } })
    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'lisihao' } })
    fireEvent.change(screen.getByLabelText(/登录密码/), { target: { value: 'secret-pw' } })
    expect(screen.getByLabelText(/登录密码/)).toHaveProperty('type', 'password')
    fireEvent.change(screen.getByLabelText('端口'), { target: { value: '0' } })
    expect(check).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('端口'), { target: { value: '22' } })
    fireEvent.click(check)

    expect((await screen.findByRole('status')).textContent).toContain(FINGERPRINT)
    expect(harness.posts.map(post => post.body.action)).toEqual(['host-inspect'])
    expect(harness.posts[0]!.body).toEqual({ action: 'host-inspect', address: 'mini.local', port: 22, user: 'lisihao' })
    fireEvent.click(screen.getByRole('button', { name: '指纹对，连接并安装' }))
    await waitFor(() => { expect(state.added).toBe(true) })
    expect(harness.posts[1]!.body).toEqual({
      action: 'host-add', address: 'mini.local', port: 22, user: 'lisihao', password: 'secret-pw', fingerprint: FINGERPRINT,
    })
    await waitFor(() => { expect(screen.queryByLabelText(/登录密码/)).toBeNull() })
  })

  it('shows why a machine could not be reached and keeps the form', async () => {
    const harness = fakeRequest({
      roster: dashboard([]),
      reply: () => Response.json({ error: 'GOUZI_FAILED', message: '连不上 mini.local:22' }, { status: 502 }),
    })
    render(<GouziManager request={harness.request} folders={fakeFolders().folders} />)
    fireEvent.click(await screen.findByRole('button', { name: '领养狗子' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pixel' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: /添加另一台机器/ }))
    fireEvent.change(screen.getByPlaceholderText(/mini.local/), { target: { value: 'mini.local' } })
    fireEvent.change(screen.getByLabelText(/用户名/), { target: { value: 'lisihao' } })
    fireEvent.change(screen.getByLabelText(/登录密码/), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: '检查这台机器' }))
    expect((await screen.findByRole('alert')).textContent).toContain('连不上 mini.local:22')
    expect(screen.getByLabelText(/登录密码/)).toHaveProperty('value', 'pw')
  })

  it('browses the remote machine and adopts with both Git and plain directory paths', async () => {
    const harness = fakeRequest({ roster: dashboard([], { hosts: [LOCAL_HOST, MINI_HOST] }), reply: remoteReply() })
    render(<GouziManager request={harness.request} folders={fakeFolders([ALPHA]).folders} />)
    fireEvent.click(await screen.findByRole('button', { name: '领养狗子' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pixel' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('radio', { name: /Mac mini/ }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    expect(screen.queryByRole('checkbox', { name: /alpha/ })).toBeNull()
    fireEvent.click(await screen.findByRole('button', { name: 'project' }))
    expect(await screen.findByRole('checkbox', { name: '选择 PetGoGo' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: '选择 notes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 PetGoGo' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 notes' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '选择当前目录' }))
    expect(screen.getByLabelText('已选择的项目').textContent).toContain('/Users/lisihao/project/PetGoGo')
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('Mac mini')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    await waitFor(() => { expect(harness.posts.at(-1)!.body.action).toBe('adopt') })
    expect(harness.posts.at(-1)!.body).toEqual({
      action: 'adopt', name: 'Pixel', avatarId: 'shiba', role: 'development', hostId: 'ssh-1', projects: ['/Users/lisihao/project/PetGoGo', '/Users/lisihao/project/notes', '/Users/lisihao/project'],
    })
  })

  it('clears the chosen projects when the machine changes, and names the machine on each roster card', async () => {
    const harness = fakeRequest({
      roster: dashboard([member({ hostId: 'ssh-1', hostLabel: 'Mac mini' })], { hosts: [LOCAL_HOST, MINI_HOST] }),
      reply: remoteReply(),
    })
    render(<GouziManager request={harness.request} folders={fakeFolders([ALPHA]).folders} />)
    expect((await screen.findByText(/住在 Mac mini/)).textContent).toContain('开发')
    fireEvent.click(screen.getByRole('button', { name: '领养狗子' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pixel' } })
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    await waitFor(() => { expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('checked', true) })
    fireEvent.click(screen.getByRole('button', { name: '上一步' }))
    fireEvent.click(screen.getByRole('radio', { name: /Mac mini/ }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
  })
})

describe('the kennel row', () => {
  it('shows the dogs and how many are awake, and opens the kennel on click', async () => {
    const harness = fakeRequest({ roster: dashboard([member(), member({ gouziId: 'g2', name: 'Pixel', connection: 'unreachable', state: 'unreachable' })]) })
    const open = vi.fn(async () => undefined)
    render(<KennelEntry wide request={harness.request} open={open} />)
    expect(await screen.findByText('1/2')).toBeTruthy()
    expect(screen.getAllByRole('img')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '狗窝' }))
    await waitFor(() => { expect(open).toHaveBeenCalledTimes(1) })
  })

  it('invites the user to adopt when there are no dogs, and keeps the collapsed form label-free', async () => {
    const harness = fakeRequest({ roster: dashboard([]) })
    render(<KennelEntry wide={false} request={harness.request} open={vi.fn(async () => undefined)} />)
    await waitFor(() => { expect(harness.calls).toHaveBeenCalled() })
    expect(screen.getByRole('button', { name: '狗窝' }).textContent).toBe('')
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })

  it('stays disabled while opening and shows why it could not open', async () => {
    const harness = fakeRequest({ roster: dashboard([member()]) })
    let release: (() => void) | undefined
    const open = vi.fn(() => new Promise<void>((resolveOpen, rejectOpen) => { release = () => { rejectOpen(new Error('没能新建狗窝会话')) }; void resolveOpen }))
    render(<KennelEntry wide request={harness.request} open={open} />)
    fireEvent.click(screen.getByRole('button', { name: '狗窝' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: '狗窝' })).toHaveProperty('disabled', true) })
    release?.()
    expect((await screen.findByRole('alert')).textContent).toContain('没能新建狗窝会话')
    expect(screen.getByRole('button', { name: '狗窝' })).toHaveProperty('disabled', false)
  })
})

type Summary = { id: string; blank: boolean; updatedAt: number; agentPreset?: string }

/** A session list the test moves by hand; `subscribe` returns the unsubscribe function. */
function fakeSessions(initial: { ids: string[]; byId: Record<string, Summary>; current?: string | undefined }) {
  let state = { ...initial }
  const listeners = new Set<() => void>()
  const sessions = {
    list: { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } } },
    create: vi.fn(async (_input: { workspaceId: string }) => 'n'),
    open: vi.fn((id: string) => { state = { ...state, current: id } }),
    noteAgentPreset: vi.fn(),
  }
  return {
    sessions: sessions as never,
    raw: sessions,
    set(next: typeof state) { state = next; for (const fn of [...listeners]) fn() },
    listeners,
  }
}

function kennelWorkspaces(
  items: Array<{ workspaceId: string; sessionIds: string[]; updatedAt: string }>,
  recentWorkspaceId: string | null = null,
  archivedSessionIds: string[] = [],
) {
  return { list: { getSnapshot: () => ({ items, recentWorkspaceId, archivedSessionIds }), subscribe: () => () => undefined } } as never
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function fakeApi(result: unknown) {
  const select = vi.fn(async () => ({ result }))
  return { api: { agentPresets: { select } } as never, select }
}

describe('openKennel', () => {
  const workspace = (workspaceId: string, sessionIds: string[], updatedAt = '2026-10-01') => ({ workspaceId, sessionIds, updatedAt })
  const origin = () => fakeSessions({ ids: ['old'], byId: { old: { id: 'old', blank: true, updatedAt: 1, agentPreset: 'standard' } }, current: 'old' })

  it('keeps the current workspace ahead of a newer recent workspace and composes the exact created session', async () => {
    const fake = origin()
    const { api, select } = fakeApi({ ok: true, value: { agentPreset: KENNEL_PRESET } })
    const workspaces = kennelWorkspaces([workspace('a', ['old']), workspace('b', [], '2026-10-03')], 'b')
    await openKennel({ sessions: fake.sessions, workspaces, api })
    expect(fake.raw.create).toHaveBeenCalledWith({ workspaceId: 'a' })
    expect(select).toHaveBeenCalledWith({ sessionId: 'n', agentPreset: KENNEL_PRESET })
    expect(fake.raw.noteAgentPreset).toHaveBeenCalledWith('n', KENNEL_PRESET)
    expect(fake.raw.open).toHaveBeenCalledWith('n')
    expect(fake.raw.list.getSnapshot().byId.old?.agentPreset).toBe('standard')
    expect(fake.listeners.size).toBe(0)
  })

  it('keeps the original view through deferred create and preset selection', async () => {
    const fake = origin()
    const creation = deferred<string>()
    fake.raw.create.mockReturnValue(creation.promise)
    const preset = deferred<{ result: { ok: true; value: { agentPreset: string } } }>()
    const select = vi.fn(() => preset.promise)
    const pending = openKennel({ sessions: fake.sessions, workspaces: kennelWorkspaces([workspace('a', ['old'])]), api: { agentPresets: { select } } as never })
    expect(fake.raw.list.getSnapshot().current).toBe('old')
    expect(select).not.toHaveBeenCalled()
    creation.resolve('new-kennel')
    await waitFor(() => { expect(select).toHaveBeenCalledWith({ sessionId: 'new-kennel', agentPreset: KENNEL_PRESET }) })
    expect(fake.raw.open).not.toHaveBeenCalled()
    expect(fake.raw.list.getSnapshot().current).toBe('old')
    preset.resolve({ result: { ok: true, value: { agentPreset: KENNEL_PRESET } } })
    await pending
    expect(fake.raw.noteAgentPreset).toHaveBeenCalledWith('new-kennel', KENNEL_PRESET)
    expect(fake.raw.list.getSnapshot().current).toBe('new-kennel')
  })

  it('reuses only the latest unarchived kennel in the target workspace with its history intact', async () => {
    const fake = fakeSessions({
      ids: ['old', 'a1', 'a2', 'archived', 'other'], current: 'old',
      byId: {
        old: { id: 'old', blank: false, updatedAt: 1, agentPreset: 'standard' },
        a1: { id: 'a1', blank: false, updatedAt: 10, agentPreset: KENNEL_PRESET },
        a2: { id: 'a2', blank: false, updatedAt: 20, agentPreset: KENNEL_PRESET },
        archived: { id: 'archived', blank: false, updatedAt: 30, agentPreset: KENNEL_PRESET },
        other: { id: 'other', blank: false, updatedAt: 99, agentPreset: KENNEL_PRESET },
      },
    })
    const before = fake.raw.list.getSnapshot().byId
    const { api, select } = fakeApi({ ok: true })
    await openKennel({ sessions: fake.sessions, workspaces: kennelWorkspaces([workspace('a', ['old', 'a1', 'a2', 'archived']), workspace('b', ['other'])], 'b', ['archived']), api })
    expect(fake.raw.open).toHaveBeenCalledWith('a2')
    expect(fake.raw.create).not.toHaveBeenCalled()
    expect(select).not.toHaveBeenCalled()
    expect(fake.raw.list.getSnapshot().byId).toBe(before)
  })

  it('preserves another workspace kennel while creating the target workspace kennel', async () => {
    const fake = origin()
    fake.set({ ...fake.raw.list.getSnapshot(), ids: ['old', 'other'], byId: { ...fake.raw.list.getSnapshot().byId, other: { id: 'other', blank: false, updatedAt: 99, agentPreset: KENNEL_PRESET } } })
    await openKennel({ sessions: fake.sessions, workspaces: kennelWorkspaces([workspace('a', ['old']), workspace('b', ['other'])], 'b'), api: fakeApi({ ok: true, value: { agentPreset: KENNEL_PRESET } }).api })
    expect(fake.raw.create).toHaveBeenCalledWith({ workspaceId: 'a' })
    expect(fake.raw.list.getSnapshot().byId.other).toMatchObject({ blank: false, agentPreset: KENNEL_PRESET })
  })

  it.each([['a', 'a'], ['missing', 'b'], [null, 'b']])('uses a valid recent workspace or the newest when the current session has no membership (%s)', async (recent, target) => {
    const fake = origin()
    await openKennel({ sessions: fake.sessions, workspaces: kennelWorkspaces([workspace('a', []), workspace('b', [], '2026-10-03')], recent), api: fakeApi({ ok: true, value: { agentPreset: KENNEL_PRESET } }).api })
    expect(fake.raw.create).toHaveBeenCalledWith({ workspaceId: target })
  })

  it.each(['no-workspace', 'create', 'preset-refusal', 'preset-transport'])('preserves the original view when %s fails', async (failure) => {
    const fake = origin()
    const { api, select } = fakeApi(failure === 'preset-refusal' ? { ok: false, error: { message: 'agent-preset-locked' } } : { ok: true, value: { agentPreset: KENNEL_PRESET } })
    if (failure === 'create') fake.raw.create.mockRejectedValue(new Error('workspace unavailable'))
    if (failure === 'preset-transport') select.mockRejectedValue(new Error('preset transport lost'))
    const workspaces = kennelWorkspaces(failure === 'no-workspace' ? [] : [workspace('a', ['old'])])
    const explanation = failure === 'no-workspace' ? '请先在侧栏添加一个工作区'
      : failure === 'create' ? 'workspace unavailable'
        : failure === 'preset-refusal' ? 'agent-preset-locked' : 'preset transport lost'
    await expect(openKennel({ sessions: fake.sessions, workspaces, api })).rejects.toThrow(explanation)
    expect(fake.raw.list.getSnapshot().current).toBe('old')
    expect(fake.raw.open).not.toHaveBeenCalled()
    expect(fake.raw.noteAgentPreset).not.toHaveBeenCalled()
    if (failure === 'no-workspace') expect(fake.raw.create).not.toHaveBeenCalled()
  })
})

describe('openKennel with the real client runtime', () => {
  it('creates and binds an independent session before composing and opening it, keeping the original blank selected until ready', async () => {
    localStorage.clear()
    const old = 'runtime-old' as SessionId
    const created = 'runtime-kennel' as SessionId
    const target = 'runtime-alpha' as WorkspaceId
    const creation = deferred<{ rpcId: never; result: { ok: true; value: { sessionId: SessionId } } }>()
    const composition = deferred<{ rpcId: never; result: { ok: true; value: { agentPreset: string } } }>()
    const ok = <T,>(value: T) => ({ rpcId: 'fixture' as never, result: { ok: true as const, value } })
    const transitions: string[] = []
    const create = vi.fn((_payload: { workspaceId?: WorkspaceId }) => { transitions.push('create independent session'); return creation.promise })
    const select = vi.fn((_payload: { sessionId: SessionId; agentPreset: string }) => { transitions.push('compose exact created session'); return composition.promise })
    const api = {
      sessions: {
        list: async () => ok({ items: [{ sessionId: old, blank: true, running: false, updatedAt: 1, cwd: '/work/alpha', agentPreset: 'standard' }] }),
        create,
        history: async () => ok({ events: [], hasMore: false }),
        models: async () => ok({ current: { provider: 'fixture', model: 'fixture' }, routable: true, groups: [], failures: [] }),
      },
      workspace: { list: async () => ok({ items: [{ workspaceId: target, path: '/work/alpha', title: 'alpha', createdAt: '2026-10-01', updatedAt: '2026-10-01', sessionIds: [old] }], archivedSessionIds: [] }) },
      agentPresets: { select },
    }
    const remote = { commands: { list: async () => ({ ok: true, value: [] }), execute: async () => ({ ok: true, value: undefined }) } }
    const ctx = new Context()
    const sessions = new SessionRuntime(ctx, api as unknown as ConstructorParameters<typeof SessionRuntime>[1], remote as never)
    const workspaces = new WorkspaceRuntime(ctx, api as unknown as ConstructorParameters<typeof WorkspaceRuntime>[1], sessions)
    await Promise.all([sessions.refresh(), workspaces.refresh()])
    sessions.open(old)
    const originalOpen = sessions.open.bind(sessions)
    vi.spyOn(sessions, 'open').mockImplementation((id) => { transitions.push('open kennel session'); originalOpen(id) })
    const originalNote = sessions.noteAgentPreset.bind(sessions)
    vi.spyOn(sessions, 'noteAgentPreset').mockImplementation((id, preset) => { transitions.push('record confirmed composition'); originalNote(id, preset) })
    const opening = openKennel({ sessions, workspaces, api: api as never })
    expect(create).toHaveBeenCalledWith({ workspaceId: target })
    const originalSelectionWhileCreating = sessions.list.getSnapshot().current === old
    expect(originalSelectionWhileCreating).toBe(true)
    creation.resolve(ok({ sessionId: created }))
    await waitFor(() => { expect(select).toHaveBeenCalledWith({ sessionId: created, agentPreset: KENNEL_PRESET }) })
    const bindingBeforeComposition = sessions.binding(created) !== undefined
    expect(bindingBeforeComposition).toBe(true)
    expect(sessions.list.getSnapshot().byId[created]).toMatchObject({ blank: true })
    const originalSelectionWhileComposing = sessions.list.getSnapshot().current === old
    expect(originalSelectionWhileComposing).toBe(true)
    expect(sessions.list.getSnapshot().byId[old]?.agentPreset).toBe('standard')
    workspaces.handleHostEnvelope({ rpcId: 'membership' as never, payload: {
      type: 'host/workspace-changed',
      workspace: { workspaceId: target, path: '/work/alpha', title: 'alpha', createdAt: '2026-10-01', updatedAt: '2026-10-01', sessionIds: [old, created] },
    } })
    composition.resolve(ok({ agentPreset: KENNEL_PRESET }))
    await opening
    expect(sessions.list.getSnapshot().current).toBe(created)
    expect(sessions.list.getSnapshot().byId[created]?.agentPreset).toBe(KENNEL_PRESET)
    expect(sessions.list.getSnapshot().byId[old]?.agentPreset).toBe('standard')
    expect(workspaces.list.getSnapshot().items[0]?.sessionIds).toEqual([old, created])
    await openKennel({ sessions, workspaces, api: api as never })
    expect(create).toHaveBeenCalledOnce()
    expect(select).toHaveBeenCalledOnce()
    await expect({
      target: 'original selected workspace',
      originalBlankPreset: sessions.list.getSnapshot().byId[old]?.agentPreset,
      kennelPreset: sessions.list.getSnapshot().byId[created]?.agentPreset,
      independentSession: created !== old,
      returnedSessionBoundBeforeComposition: bindingBeforeComposition,
      originalSelectionPreservedUntilComposition: originalSelectionWhileCreating && originalSelectionWhileComposing,
      targetWorkspaceRetained: workspaces.list.getSnapshot().items[0]?.sessionIds.includes(created),
      existingKennelReusedWithoutCreateOrSelect: create.mock.calls.length === 1 && select.mock.calls.length === 1,
      transitions,
    }).toMatchFileSnapshot('./__snapshots__/kennel-runtime.snapshot.txt')
    localStorage.clear()
  })
})


function registeredRoom(sessionId: string): GouziRoomSnapshotV1 {
  return {
    version: 1, sessionId, roomPollIntervalMs: 2_000, generatedAt: '2026-10-06T00:00:00.000Z',
    dashboard: dashboard([member()]),
    execution: [{ gouziId: 'g1', generation: 1, projectScopes: ['/work/alpha'], operators: [{ operatorId: 'real.operator', available: true, models: [] }] }],
    tasks: [],
  }
}

function requestUrl(input: string | URL | Request): URL {
  return input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url, 'http://localhost')
}

async function roomRegistration() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root', children: {
      'sidebar.footer.action': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.room.header': { kind: 'chain', scope: 'session-maybe' },
      'conversation.room.content': { kind: 'chain', scope: 'session-maybe' },
      'conversation.room.aside': { kind: 'chain', scope: 'session-maybe' },
      'conversation.room.composer': { kind: 'chain', scope: 'session-maybe' },
    },
  } as never, () => null)
  const fake = fakeSessions({ ids: ['a', 'b'], byId: {
    a: { id: 'a', blank: false, updatedAt: 1, agentPreset: KENNEL_PRESET },
    b: { id: 'b', blank: false, updatedAt: 1, agentPreset: KENNEL_PRESET },
  }, current: 'a' })
  const views = new Map(['a', 'b'].map(id => [id, { removed: false }]))
  const missing = new Set<string>()
  const sends: Array<{ sessionId: string; text: string }> = []
  const older = vi.fn(async (_id: string) => {})
  const ok = <T,>(value: T) => ({ rpcId: 'fixture' as never, result: { ok: true as const, value } })
  const runtimeApi = {
    sessions: {
      list: async () => ok({ items: ['a', 'b'].map(sessionId => ({ sessionId, blank: false, running: false, updatedAt: 1, agentPreset: KENNEL_PRESET })) }),
      history: async () => ok({ events: [], hasMore: false }),
      models: async () => ok({ current: { provider: 'fixture', model: 'fixture' }, routable: true, groups: [], failures: [] }),
    },
  }
  const runtime = new SessionRuntime(ctx, runtimeApi as unknown as ConstructorParameters<typeof SessionRuntime>[1], {
    commands: { list: async () => ({ ok: true, value: [] }), execute: async () => ({ ok: true, value: undefined }) },
  } as never)
  await runtime.refresh()
  const noConversation = new Set<string>()
  const scope = (id: string) => {
    if (missing.has(id) || !views.has(id)) return undefined
    const scoped = runtime.scope(id as SessionId)!
    return noConversation.has(id) ? scoped.isolate('conversation') : scoped
  }
  for (const id of views.keys()) {
    const session = runtime.binding(id as SessionId)!.session
    const getSnapshot = session.getSnapshot.bind(session)
    vi.spyOn(session, 'getSnapshot').mockImplementation(() => ({ ...getSnapshot(), removed: views.get(id)!.removed }))
  }
  const binding = (id: string) => missing.has(id) || !views.has(id) ? undefined : runtime.binding(id as SessionId)
  const rooms = new Map(['a', 'b'].map(id => [id, registeredRoom(id)]))
  const request = vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input)
    if (url.searchParams.has('evidence_ref')) return Response.json({ actualEvidence: url.searchParams.get('evidence_ref') })
    return Response.json(rooms.get(url.searchParams.get('session_id') ?? 'a'))
  })
  const workspaces = kennelWorkspaces([{ workspaceId: 'w', sessionIds: ['a', 'b'], updatedAt: 'now' }])
  ctx.provide('connection', { request, api: fakeApi({ ok: true }).api } as never)
  ctx.provide('workspaces', workspaces)
  ctx.set('sessions', { ...fake.raw, scope, binding } as never)
  const blocks = new Map<string, { reason: string }>()
  class ScopedConversation extends Service {
    readonly blocks = { storeFor: (id: string) => ({ getSnapshot: () => blocks.get(id) }) }
    constructor(owner: Context) { super(owner, 'conversation') }
    async send(text: string): Promise<void> {
      const sessionId = runtime.scopeOf(this.ctx)
      if (sessionId === undefined) throw new Error('fixture send requires a session scope')
      sends.push({ sessionId, text })
    }
    async loadOlder(): Promise<void> {
      const sessionId = runtime.scopeOf(this.ctx)
      if (sessionId === undefined) throw new Error('fixture loadOlder requires a session scope')
      await older(sessionId)
    }
  }
  await ctx.plugin(ScopedConversation).await()
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  const content = slots.entries('conversation.room.content')[0]!
  const face = (id: string | undefined) => (content.inject as unknown as (id: SessionId | undefined) => import('../src/client/KennelRoom.tsx').KennelRoomInjected)(id as SessionId | undefined)
  return { ctx, slots, fiber, fake, views, missing, rooms, request, sends, older, content, face, blocks, runtime, noConversation }
}

describe('Gouzi client registration', () => {
  it('sends ordinary text through a real SessionRuntime scope without requiring property injection', async () => {
    const h = await roomRegistration()
    try {
      const scoped = h.runtime.scope('a' as SessionId)!
      expect(() => scoped.conversation).toThrow('cannot get property "conversation" without inject')
      expect(scoped.get('conversation')).toBeDefined()
      const a = h.face('a')
      h.fake.set({ ...h.fake.raw.list.getSnapshot(), current: 'b' })
      await a.send({ text: 'ordinary task', recipient: null })
      expect(h.sends).toEqual([{ sessionId: 'a', text: encodeKennelMessage('ordinary task', null) }])
      expect(h.request).not.toHaveBeenCalled()
      await a.loadOlder()
      expect(h.older).toHaveBeenCalledExactlyOnceWith('a')
    } finally { await h.fiber.dispose() }
  })

  it('rejects actions when a live session scope has no conversation service', async () => {
    const h = await roomRegistration()
    try {
      const a = h.face('a')
      h.noConversation.add('a')
      await expect(a.send({ text: 'draft', recipient: null })).rejects.toThrow('消息服务不可用')
      await expect(a.loadOlder()).rejects.toThrow('消息服务不可用')
      expect(h.sends).toEqual([])
      expect(h.older).not.toHaveBeenCalled()
      expect(h.request).not.toHaveBeenCalled()
    } finally { await h.fiber.dispose() }
  })

  it('registers the sidebar and Settings plus three kennel-only room chains sharing one store and source per session', async () => {
    expect(inject).toEqual(['slots', 'connection', 'workspaces', 'sessions', 'conversation'])
    const h = await roomRegistration()
    const sidebar = h.slots.entries('sidebar.footer.action')
    expect(sidebar.map(entry => [entry.options.id, entry.options.order])).toEqual([['kennel', 90]])
    const row = (sidebar[0]!.inject as () => { request: unknown; open: () => Promise<void> })()
    expect(row.request).toBe(h.request)
    await row.open(); expect(h.fake.raw.open).toHaveBeenCalledWith('a')
    const settings = h.slots.entries('settings.section')
    expect(settings.map(entry => [entry.options.id, entry.options.order])).toEqual([['gouzi', 38]])
    expect((settings[0]!.options.label as () => string)()).toBe('狗子')
    expect(h.slots.entries('conversation.input.dock')).toEqual([])
    for (const key of ['conversation.room.header', 'conversation.room.content', 'conversation.room.aside', 'conversation.room.composer'] as const) {
      const entry = h.slots.entries(key)[0]!
      expect(entry.store).toBe(h.content.store)
      const select = entry.select as unknown as (owner: {
        agentPreset: string | undefined
        blank: boolean
        inert?: boolean
        blocked?: { reason: string }
      }) => unknown
      expect(select({ agentPreset: KENNEL_PRESET, blank: true })).toBe(true)
      expect(select({ agentPreset: KENNEL_PRESET, blank: false })).toBe(true)
      expect(select({ agentPreset: 'standard', blank: false })).toBe(null)
      expect(select({ agentPreset: undefined, blank: true })).toBe(null)
      const injected = (entry.inject as unknown as (id: SessionId) => import('../src/client/KennelRoom.tsx').KennelRoomInjected)('a' as SessionId)
      expect(injected.hooks.room).toBe(h.face('a').hooks.room)
      expect(Object.keys(injected).sort()).toEqual(['hooks', 'loadOlder', 'readEvidence', 'reload', 'send'])
    }
    expect(h.face('a').hooks.room).not.toBe(h.face('b').hooks.room)
    const handle = h.content.store as ReturnType<typeof import('../src/client/room-store.ts').createKennelRoomStore>
    const storeA = handle.create('a'); const storeB = handle.create('b')
    storeA.actions.draft('draft a'); storeA.actions.recipient({ gouziId: 'g1', generation: 1, mode: 'standard' })
    expect(storeB.getSnapshot()).toMatchObject({ draft: '', recipient: null })
    await h.fiber.dispose()
    for (const key of ['sidebar.footer.action', 'settings.section', 'conversation.room.header', 'conversation.room.content', 'conversation.room.aside', 'conversation.room.composer'] as const) {
      expect(h.slots.entries(key)).toEqual([])
    }
  })

  it('declines the composer while core input is inert or model-blocked and rechecks late blocks before sending', async () => {
    const h = await roomRegistration()
    const entry = h.slots.entries('conversation.room.composer')[0]!
    const select = entry.select as unknown as (owner: {
      agentPreset: string
      blank: boolean
      inert: boolean
      blocked: { reason: string } | undefined
    }) => unknown
    expect(select({ agentPreset: KENNEL_PRESET, blank: true, inert: true, blocked: undefined })).toBe(null)
    expect(select({ agentPreset: KENNEL_PRESET, blank: true, inert: false, blocked: { reason: 'model blocked' } })).toBe(null)
    const a = h.face('a')
    h.blocks.set('a', { reason: '请选择模型' })
    await expect(a.send({ text: 'prompt', recipient: null })).rejects.toThrow('请选择模型')
    expect(h.request).not.toHaveBeenCalled()
    h.blocks.delete('a')
    const reply = deferred<Response>()
    h.request.mockImplementation(() => reply.promise)
    const sending = a.send({ text: 'targeted prompt', recipient: { gouziId: 'g1', generation: 1, mode: 'standard' } })
    h.blocks.set('a', { reason: '模型已不可用' })
    reply.resolve(Response.json(registeredRoom('a')))
    await expect(sending).rejects.toThrow('模型已不可用')
    expect(h.sends).toEqual([])
    await h.fiber.dispose()
  })

  it('observes one source per session while sharing the same session source across all room slots', async () => {
    const h = await roomRegistration()
    const a = h.face('a').hooks.room
    const b = h.face('b').hooks.room
    expect(h.request).not.toHaveBeenCalled()
    const stopA = a.subscribe(vi.fn())
    const stopASecond = h.face('a').hooks.room.subscribe(vi.fn())
    const stopB = b.subscribe(vi.fn())
    await waitFor(() => { expect(a.getSnapshot().room?.sessionId).toBe('a'); expect(b.getSnapshot().room?.sessionId).toBe('b') })
    expect(h.request).toHaveBeenCalledTimes(2)
    expect(h.request.mock.calls.map(call => requestUrl(call[0]).searchParams.get('session_id')).sort()).toEqual(['a', 'b'])
    stopA(); stopASecond(); stopB()
    await h.fiber.dispose()
  })

  it('exposes an explicit reload of the same observed session source after the first read fails', async () => {
    const h = await roomRegistration(); const a = h.face('a')
    h.request.mockRejectedValueOnce(new Error('first read lost'))
    const stop = a.hooks.room.subscribe(vi.fn())
    await waitFor(() => { expect(a.hooks.room.getSnapshot().error).toBe('first read lost') })
    h.rooms.set('a', { ...registeredRoom('a'), roomPollIntervalMs: 250 })
    await a.reload()
    expect(a.hooks.room.getSnapshot()).toMatchObject({ stale: false, error: null, room: { sessionId: 'a', roomPollIntervalMs: 250 } })
    expect(h.request).toHaveBeenCalledTimes(2)
    stop(); await h.fiber.dispose()
    await expect(a.reload()).rejects.toThrow('聊天室已卸载')
  })

  it('rechecks the actual target and sends only to the injected source session, independent of selected session and management permission', async () => {
    const h = await roomRegistration()
    const a = h.face('a')
    const fresh = registeredRoom('a')
    h.rooms.set('a', { ...fresh, dashboard: { ...fresh.dashboard, canManage: false, members: fresh.dashboard.members.map(m => ({ ...m, connection: 'unreachable' })) } })
    h.fake.set({ ...h.fake.raw.list.getSnapshot(), current: 'b' })
    await a.send({ text: 'bounded task', recipient: { gouziId: 'g1', generation: 1, mode: 'standard' } })
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]!.sessionId).toBe('a')
    expect(decodeKennelMessage(h.sends[0]!.text)).toEqual({ text: 'bounded task', recipient: { gouziId: 'g1', generation: 1, mode: 'standard' } })
    const query = requestUrl(h.request.mock.calls[0]![0])
    expect(query.searchParams.get('session_id')).toBe('a')
    await a.loadOlder(); expect(h.older).toHaveBeenCalledExactlyOnceWith('a')
    expect(await a.readEvidence('run/real', 'evidence/real')).toEqual({ actualEvidence: 'evidence/real' })
    const evidence = requestUrl(h.request.mock.calls[1]![0])
    expect([...evidence.searchParams.entries()]).toEqual([['session_id', 'a'], ['run_id', 'run/real'], ['evidence_ref', 'evidence/real']])
    await h.fiber.dispose()
  })

  it.each(['disabled', 'generation', 'unavailable', 'missing', 'read-error'])('rejects fresh %s without forwarding or changing the target', async (failure) => {
    const h = await roomRegistration(); const a = h.face('a')
    const fresh = registeredRoom('a')
    if (failure === 'disabled') h.rooms.set('a', { ...fresh, dashboard: { ...fresh.dashboard, members: fresh.dashboard.members.map(m => ({ ...m, membership: 'archived' })) } })
    if (failure === 'generation') h.rooms.set('a', { ...fresh, execution: fresh.execution.map(e => ({ ...e, generation: 2 })) })
    if (failure === 'unavailable') h.rooms.set('a', { ...fresh, execution: fresh.execution.map(e => ({ ...e, operators: e.operators.map(o => ({ ...o, available: false })) })) })
    if (failure === 'missing') h.rooms.set('a', { ...fresh, execution: [] })
    if (failure === 'read-error') h.request.mockRejectedValue(new Error('fresh read lost'))
    const recipient = { gouziId: 'g1', generation: 1, mode: 'standard' } as const
    await expect(a.send({ text: 'original task', recipient })).rejects.toThrow()
    expect(recipient).toEqual({ gouziId: 'g1', generation: 1, mode: 'standard' })
    expect(h.sends).toEqual([])
    expect(h.request).toHaveBeenCalledOnce()
    await h.fiber.dispose()
  })

  it('fails clearly when a scope disappears or is removed, including after a fresh read', async () => {
    const h = await roomRegistration(); const a = h.face('a')
    expect(() => h.face(undefined)).toThrow('狗窝会话尚未创建')
    h.missing.add('a')
    await expect(a.send({ text: 'draft', recipient: null })).rejects.toThrow('会话已不存在')
    await expect(a.loadOlder()).rejects.toThrow('会话已不存在')
    h.missing.delete('a'); h.views.get('a')!.removed = true
    await expect(a.readEvidence('r', 'e')).rejects.toThrow('会话已移除')
    h.views.get('a')!.removed = false
    const reply = deferred<Response>()
    h.request.mockImplementation(() => reply.promise)
    const sending = a.send({ text: 'draft', recipient: { gouziId: 'g1', generation: 1, mode: 'standard' } })
    h.views.get('a')!.removed = true
    reply.resolve(Response.json(registeredRoom('a')))
    await expect(sending).rejects.toThrow('会话已移除')
    expect(h.sends).toEqual([])
    await h.fiber.dispose()
  })

  it('waits for source quiescence on unload and fences late replies and captured actions', async () => {
    const h = await roomRegistration(); const a = h.face('a')
    const reply = deferred<Response>()
    h.request.mockImplementation(() => reply.promise)
    const listener = vi.fn()
    a.hooks.room.subscribe(listener)
    await waitFor(() => { expect(h.request).toHaveBeenCalledOnce() })
    const signal = h.request.mock.calls[0]![1]!.signal!
    let settled = false
    const disposal = h.fiber.dispose().then(() => { settled = true })
    await waitFor(() => { expect(signal.aborted).toBe(true) })
    expect(settled).toBe(false)
    const notifications = listener.mock.calls.length
    reply.resolve(Response.json(registeredRoom('a')))
    await disposal
    expect(listener).toHaveBeenCalledTimes(notifications)
    expect(a.hooks.room.getSnapshot().room).toBe(null)
    await expect(a.send({ text: 'late draft', recipient: null })).rejects.toThrow('聊天室已卸载')
    await expect(a.loadOlder()).rejects.toThrow('聊天室已卸载')
    expect(h.sends).toEqual([])
  })

  it('aborts and awaits owned evidence reads on unload without delivering a late reply into another selected session', async () => {
    const h = await roomRegistration(); const a = h.face('a')
    const reply = deferred<Response>()
    h.request.mockImplementation(() => reply.promise)
    const reading = a.readEvidence('run/a', 'ref/a')
    const caught = expect(reading).rejects.toThrow('聊天室已卸载')
    const signal = h.request.mock.calls[0]![1]!.signal!
    h.fake.set({ ...h.fake.raw.list.getSnapshot(), current: 'b' })
    let settled = false
    const disposal = h.fiber.dispose().then(() => { settled = true })
    await waitFor(() => { expect(signal.aborted).toBe(true) })
    expect(settled).toBe(false)
    reply.resolve(Response.json({ actualEvidence: 'belongs to a' }))
    await caught; await disposal
    expect(h.sends).toEqual([])
    expect(requestUrl(h.request.mock.calls[0]![0]).searchParams.get('session_id')).toBe('a')
  })

  it('aborts and awaits a fresh send preflight on unload without submitting its late result', async () => {
    const h = await roomRegistration(); const a = h.face('a')
    const reply = deferred<Response>()
    h.request.mockImplementation(() => reply.promise)
    const sending = a.send({ text: 'late task', recipient: { gouziId: 'g1', generation: 1, mode: 'standard' } })
    const caught = expect(sending).rejects.toThrow('聊天室已卸载')
    const signal = h.request.mock.calls[0]![1]!.signal!
    let settled = false
    const disposal = h.fiber.dispose().then(() => { settled = true })
    await waitFor(() => { expect(signal.aborted).toBe(true) })
    expect(settled).toBe(false)
    reply.resolve(Response.json(registeredRoom('a')))
    await caught; await disposal
    expect(h.sends).toEqual([])
  })

  it('escapes copied recipient metadata when submitting ordinary text to the manager', async () => {
    const h = await roomRegistration()
    const quoted = encodeKennelMessage('quoted task', { gouziId: 'g1', generation: 1, mode: 'standard' })
    await h.face('a').send({ text: quoted, recipient: null })
    expect(decodeKennelMessage(h.sends[0]!.text)).toEqual({ text: quoted })
    expect(h.request).not.toHaveBeenCalled()
    await h.fiber.dispose()
  })
})
