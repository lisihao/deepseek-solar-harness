// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-api-remotes/client'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRuntime, SlotRegistry, WorkspaceRuntime } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, GouziAvatarImage, GouziManager, inject, KennelEntry, KennelHero, KENNEL_PRESET, loadGouzi, openKennel } from '../src/client/index.ts'
import type { GouziFolders } from '../src/client/index.ts'
import { GOUZI_AVATARS, GOUZI_CONTROL_HEADER, type GouziDashboardV1, type GouziMemberProjection } from '../src/contracts.ts'

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
function fakeRequest(state: { roster: GouziDashboardV1; reply?: (body: Record<string, unknown>) => Response }) {
  const posts: Array<{ body: Record<string, unknown>; header: string | null }> = []
  const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void input
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      posts.push({ body, header: new Headers(init.headers).get(GOUZI_CONTROL_HEADER) })
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
    expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('checked', true)
    expect(screen.getByRole('checkbox', { name: /beta/ })).toHaveProperty('checked', false)
    fireEvent.click(screen.getByRole('checkbox', { name: /beta/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /alpha/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /alpha/ }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))

    expect(screen.getByText('领养后 1 / 10')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    await waitFor(() => { expect(harness.posts).toHaveLength(1) })
    expect(harness.posts[0]).toEqual({
      header: '1',
      body: { action: 'adopt', name: 'Pixel', avatarId: 'poodle', role: 'testing', hostId: 'local', projects: ['/work/beta', '/work/alpha'] },
    })
    await waitFor(() => { expect(screen.queryByLabelText('领养一只狗子')).toBeNull() })
  })

  it('preselects the newest project when no recent workspace is known and blocks next when none is selected', async () => {
    const harness = fakeRequest({ roster: dashboard([]) })
    await openProjectStep(harness, fakeFolders([ALPHA, BETA]).folders)
    expect(screen.getByRole('checkbox', { name: /beta/ })).toHaveProperty('checked', true)
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

    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    expect(await screen.findByRole('checkbox', { name: /picked/ })).toHaveProperty('checked', true)
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹…' }))
    await waitFor(() => { expect(pickDirectory).toHaveBeenCalledTimes(3) })
    expect(screen.getAllByRole('checkbox')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    await waitFor(() => { expect(harness.posts[0]!.body.projects).toEqual(['/work/picked']) })
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
    await waitFor(() => { expect(harness.posts).toHaveLength(1) })
    expect(harness.posts[0]!.body).toEqual({ action: 'edit', gouziId: 'g1', name: 'Pixel', avatarId: 'bichon', role: 'research' })
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

  it('browses the remote machine, only offers Git folders, and adopts onto it with the remote paths', async () => {
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
    expect(screen.queryByRole('checkbox', { name: '选择 notes' })).toBeNull()
    expect(screen.getByRole('button', { name: '下一步' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 PetGoGo' }))
    expect(screen.getByLabelText('已选择的项目').textContent).toContain('/Users/lisihao/project/PetGoGo')
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByText('Mac mini')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '领养' }))
    await waitFor(() => { expect(harness.posts.at(-1)!.body.action).toBe('adopt') })
    expect(harness.posts.at(-1)!.body).toEqual({
      action: 'adopt', name: 'Pixel', avatarId: 'shiba', role: 'development', hostId: 'ssh-1', projects: ['/Users/lisihao/project/PetGoGo'],
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
    expect(screen.getByRole('checkbox', { name: /alpha/ })).toHaveProperty('checked', true)
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

describe('the kennel welcome card', () => {
  const kennelSession = { ids: ['k'], byId: { k: { id: 'k', blank: true, updatedAt: 1, agentPreset: KENNEL_PRESET } }, current: 'k' }

  it('introduces the enabled dogs, where they live and what they are doing, on a blank kennel session', async () => {
    const harness = fakeRequest({
      roster: dashboard([
        member({ name: 'Mochi', hostLabel: 'Mac mini' }),
        member({ gouziId: 'g2', name: 'Pixel', role: 'research', state: 'working', activity: 'working' }),
        member({ gouziId: 'g3', name: 'Gone', membership: 'retiring', state: 'retiring' }),
      ]),
    })
    render(<KennelHero request={harness.request} sessions={fakeSessions(kennelSession).sessions} />)
    const card = await screen.findByRole('region', { name: '狗窝' })
    expect(await within(card).findByText('Mochi')).toBeTruthy()
    expect(within(card).getByText('Pixel')).toBeTruthy()
    expect(within(card).queryByText('Gone')).toBeNull()
    expect(card.textContent).toContain('住在 Mac mini')
    expect(card.textContent).toContain('工作中')
    expect(card.textContent).toContain('@名字')
    expect(card.textContent).toContain('这个会话用的是「狗窝」预设')
  })

  it('invites the user to adopt when there are no dogs', async () => {
    const harness = fakeRequest({ roster: dashboard([]) })
    render(<KennelHero request={harness.request} sessions={fakeSessions(kennelSession).sessions} />)
    expect((await screen.findByRole('region', { name: '狗窝' })).textContent).toContain('设置 → 狗子 领养')
  })

  it.each([
    ['another preset', { ids: ['s'], byId: { s: { id: 's', blank: true, updatedAt: 1, agentPreset: 'standard' } }, current: 's' }],
    ['a session with no preset', { ids: ['s'], byId: { s: { id: 's', blank: true, updatedAt: 1 } }, current: 's' }],
    ['no current session', { ids: [], byId: {}, current: undefined }],
  ])('renders nothing for %s', async (_label, state) => {
    const harness = fakeRequest({ roster: dashboard([member()]) })
    const { container } = render(<KennelHero request={harness.request} sessions={fakeSessions(state).sessions} />)
    await waitFor(() => { expect(harness.calls).toHaveBeenCalled() })
    expect(container.textContent).toBe('')
  })

  it('goes away once the kennel session has history', async () => {
    const harness = fakeRequest({ roster: dashboard([member()]) })
    const started = { ids: ['k'], byId: { k: { id: 'k', blank: false, updatedAt: 2, agentPreset: KENNEL_PRESET } }, current: 'k' }
    const { container } = render(<KennelHero request={harness.request} sessions={fakeSessions(started).sessions} />)
    await waitFor(() => { expect(harness.calls).toHaveBeenCalled() })
    expect(container.textContent).toBe('')
  })
})

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

describe('Gouzi client registration', () => {
  it('registers the kennel row in the sidebar and the management page in Settings', async () => {
    expect(inject).toEqual(['slots', 'connection', 'workspaces', 'sessions'])
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    const fetchStub = vi.fn()
    const workspaces = kennelWorkspaces([{ workspaceId: 'w1', sessionIds: ['k'], updatedAt: '2026-10-01' }])
    const fake = fakeSessions({ ids: ['k'], byId: { k: { id: 'k', blank: false, updatedAt: 1, agentPreset: KENNEL_PRESET } } })
    ctx.provide('connection', { request: fetchStub, api: fakeApi({ ok: true }).api } as never)
    ctx.provide('workspaces', workspaces)
    ctx.provide('sessions', fake.sessions)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const sidebar = slots.entries('sidebar.footer.action')
    expect(sidebar.map(entry => [entry.options.id, entry.options.order])).toEqual([['kennel', 90]])
    const row = (sidebar[0]!.inject as () => { request: unknown; open: () => Promise<void> })()
    expect(row.request).toBe(fetchStub)
    await row.open()
    expect(fake.raw.open).toHaveBeenCalledWith('k')

    const settings = slots.entries('settings.section')
    expect(settings.map(entry => [entry.options.id, entry.options.order])).toEqual([['gouzi', 38]])
    expect((settings[0]!.options.label as () => string)()).toBe('狗子')
    const page = (settings[0]!.inject as () => { request: unknown; folders: unknown })()
    expect(page.request).toBe(fetchStub)
    expect(page.folders).toBe(workspaces)

    const dock = slots.entries('conversation.input.dock')
    expect(dock.map(entry => [entry.options.id, entry.options.order])).toEqual([['kennel', 5]])
    const card = (dock[0]!.inject as () => { request: unknown; sessions: unknown })()
    expect(card.request).toBe(fetchStub)
    expect(card.sessions).toBe(fake.sessions)

    await fiber.dispose()
    expect(slots.entries('sidebar.footer.action')).toEqual([])
    expect(slots.entries('settings.section')).toEqual([])
    expect(slots.entries('conversation.input.dock')).toEqual([])
  })
})
