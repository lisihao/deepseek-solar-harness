/** Gouzi Host route: projection, authorization, and the adopt, wake, rest, and retire flows. */

import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GOUZI_AVATAR_IDS, GOUZI_MEMBER_LIMIT, GOUZI_ROLES, OrchestrationError,
  type GouziControl, type GouziHostRecord, type GouziMemberView, type GouziMembership,
} from '@deepseek-ai/dsh-orchestration'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  apply, Config, GOUZI_AVATARS, GOUZI_CONTROL_HEADER, GOUZI_DASHBOARD_PATH, GOUZI_ROLE_IDS, gouziPrimaryState,
  GouziHostService, type GouziHostProjection, type GouziProvisionInput, type GouziSshTarget,
} from '../src/index.ts'

/** In-memory registry with the semantics the Host depends on: the ten-slot limit and the membership flow. */
class FakeControl implements GouziControl {
  hosts: GouziHostRecord[] = []
  members: GouziMemberView[] = []
  calls: string[] = []

  private find(gouziId: string): GouziMemberView {
    const member = this.members.find(value => String(value.gouziId) === gouziId)
    if (member === undefined) throw new OrchestrationError(`gouzi ${gouziId} does not exist`, 'GOUZI_STATE_CONFLICT')
    return member
  }

  private replace(member: GouziMemberView, patch: Partial<GouziMemberView>): GouziMemberView {
    const next = { ...member, ...patch }
    this.members = this.members.map(value => value === member ? next : value)
    return next
  }

  list() { return Promise.resolve({ hosts: this.hosts, members: this.members }) }
  pairHost(host: Omit<GouziHostRecord, 'pairedAt'>) {
    this.calls.push('pairHost')
    const stored = { ...host, pairedAt: 'now' }
    this.hosts = [...this.hosts, stored]
    return Promise.resolve(stored)
  }
  create(input: Parameters<GouziControl['create']>[0]) {
    this.calls.push('create')
    if (this.members.filter(value => value.membership !== 'archived').length >= GOUZI_MEMBER_LIMIT) {
      return Promise.reject(new OrchestrationError('at most 10 gouzi members may exist', 'GOUZI_LIMIT_REACHED'))
    }
    const member = {
      ...input, generation: 1, roleVersion: 1, policyVersion: 1, membership: 'provisioning' as GouziMembership,
      connection: 'unreachable' as const, activity: 'resting' as const, createdAt: 'now', updatedAt: 'now',
    }
    this.members = [...this.members, member]
    return Promise.resolve(member)
  }
  edit(gouziId: string, edit: Parameters<GouziControl['edit']>[1]) {
    this.calls.push('edit')
    return Promise.resolve(this.replace(this.find(gouziId), edit))
  }
  setMembership(gouziId: string, membership: Exclude<GouziMembership, 'archived'>) {
    this.calls.push(`membership:${membership}`)
    return Promise.resolve(this.replace(this.find(gouziId), { membership }))
  }
  setEndpoint(gouziId: string, endpoint: string) {
    this.calls.push('setEndpoint')
    return Promise.resolve(this.replace(this.find(gouziId), { endpoint }))
  }
  archive(gouziId: string, evidence: Parameters<GouziControl['archive']>[1]) {
    this.calls.push(`archive:${JSON.stringify(evidence)}`)
    return Promise.resolve(this.replace(this.find(gouziId), { membership: 'archived' }))
  }
  /** Test hook: the daemon's observation of one member. */
  observe(gouziId: string, patch: Pick<Partial<GouziMemberView>, 'connection' | 'activity'>): void {
    this.replace(this.find(gouziId), patch)
  }
}

class FakeHost extends GouziHostService {
  readonly ownerId = 'owner-test'
  provisioned: GouziProvisionInput[] = []
  started: Array<[string, string]> = []
  stopped: Array<[string, boolean]> = []
  resolved: Array<[string, string]> = []
  sshHosts: GouziHostProjection[] = []
  added: Array<Parameters<GouziHostService['addHost']>[0]> = []
  removed: string[] = []
  failResolve: Error | undefined
  failStart: string | undefined
  failAdd: string | undefined
  treeStopped = true
  order: string[] = []

  hosts() { return Promise.resolve(this.sshHosts) }
  inspectHost(target: GouziSshTarget) {
    if (target.address === 'unreachable.example') return Promise.reject(new Error('连不上这台机器'))
    return Promise.resolve({ keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc123' })
  }
  addHost(input: Parameters<GouziHostService['addHost']>[0]) {
    this.added.push(input)
    if (this.failAdd !== undefined) return Promise.reject(new Error(this.failAdd))
    const host: GouziHostProjection = {
      hostId: 'ssh-1',
      label: input.label ?? input.address,
      kind: 'ssh',
      address: `${input.user}@${input.address}:${String(input.port)}`,
    }
    this.sshHosts = [...this.sshHosts, host]
    return Promise.resolve(host)
  }
  removeHost(hostId: string) {
    this.removed.push(hostId)
    this.sshHosts = this.sshHosts.filter(host => host.hostId !== hostId)
    return Promise.resolve()
  }
  browse(hostId: string, path?: string) {
    return Promise.resolve({ path: path ?? `/home/${hostId}`, entries: [{ name: 'PetGoGo', path: `${path ?? '/home'}/PetGoGo`, git: true }] })
  }
  resolveRepository(hostId: string, path: string) {
    this.resolved.push([hostId, path])
    if (this.failResolve !== undefined) return Promise.reject(this.failResolve)
    if (path.includes('noorigin')) return Promise.reject(new Error("error: No such remote 'origin'"))
    if (path.includes('missing')) return Promise.reject(new Error(`${path} is not inside a Git repository`))
    return Promise.resolve({ repository: `github.com/lisihao/${path.split('/').pop()!}`, source: path })
  }
  provision(input: GouziProvisionInput) { this.order.push('provision'); this.provisioned.push(input); return Promise.resolve() }
  async start(hostId: string, gouziId: string) {
    this.order.push('start')
    if (this.failStart !== undefined) throw new Error(this.failStart)
    this.started.push([hostId, gouziId])
    await Promise.resolve()
    return { endpoint: hostId === 'local' ? 'http://127.0.0.1:4100/' : 'http://127.0.0.1:4200/', pid: 1234, incarnation: 1 }
  }
  stop(_hostId: string, gouziId: string, options?: { reclaimResident?: boolean }) {
    this.stopped.push([gouziId, options?.reclaimResident === true])
    return Promise.resolve({ processTreeStopped: this.treeStopped })
  }
}

interface Body {
  error?: string
  message?: string
  gouziId: string
  members: Array<{ state: string; name: string; avatarId: string; role: string }>
}
interface Reply { status: number; body: Body }

const fibers: Array<{ dispose(): Promise<void> }> = []
afterEach(async () => { for (const fiber of fibers.splice(0)) await fiber.dispose() })

async function mount(options: { host?: boolean } = {}) {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const control = new FakeControl()
  ctx.provide('webServer', { register: (route: WebRoute) => { routes.push(route); return () => {} } } as never)
  ctx.provide('orchestrations', { gouzi: control } as never)
  ctx.provide('remoteAuth', {
    authenticate: (token: string) => ({
      'admin-token': { deviceId: 'd1', deviceName: 'MacBook', scope: 'admin' },
      'pocket-token': { deviceId: 'd2', deviceName: 'Phone', scope: 'pocket' },
      'gouzi-token': { deviceId: 'd3', deviceName: 'Member', scope: 'gouzi' },
    } as const)[token as 'admin-token'],
  } as never)
  const host = options.host === false ? undefined : new FakeHost(ctx)
  const fiber = ctx.plugin({ name: 'gouzi-test', inject: ['orchestrations', 'webServer'], apply }, Config({ grantDeadlineMs: 600_000 }))
  await fiber.await()
  fibers.push(fiber)
  const route = routes[0]!
  const send = async (
    method: 'GET' | 'POST',
    body?: unknown,
    headers: Record<string, string> = {},
    remote = false,
  ): Promise<Reply> => {
    const request = new PassThrough() as unknown as Parameters<WebRoute['handler']>[0]
    Object.assign(request, {
      url: GOUZI_DASHBOARD_PATH,
      method,
      headers: { host: remote ? 'harness.example' : '127.0.0.1:3080', ...headers },
      socket: { remoteAddress: remote ? '203.0.113.9' : '127.0.0.1' },
    })
    const chunks: Buffer[] = []
    let status = 0
    const recorder = {
      statusCode: 200,
      setHeader: () => {},
      writeHead(value: number) { status = value },
      end(value?: Uint8Array) {
        if (value !== undefined) chunks.push(Buffer.from(value))
        status = status === 0 ? this.statusCode : status
      },
    }
    const response = recorder as unknown as Parameters<WebRoute['handler']>[1]
    ;(request as unknown as PassThrough).end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
    await route.handler(request, response)
    const text = Buffer.concat(chunks).toString()
    return { status: status === 0 ? 200 : status, body: (text.length === 0 ? undefined : JSON.parse(text)) as Body }
  }
  return { control, host, send, route }
}

const CONTROL = { [GOUZI_CONTROL_HEADER]: '1' }
const ADOPT = { action: 'adopt', name: ' Mochi ', avatarId: 'corgi', role: 'testing', projects: ['/work/alpha', '/work/beta'] }

describe('Gouzi Host route', () => {
  it('registers one exact route and pins the wire lists to the orchestration contract', async () => {
    const { route } = await mount()
    expect(route).toMatchObject({ kind: 'exact', path: '/api/gouzi' })
    expect([...GOUZI_AVATARS]).toEqual([...GOUZI_AVATAR_IDS])
    expect([...GOUZI_ROLE_IDS]).toEqual([...GOUZI_ROLES])
  })

  it('projects members without archived ones and counts only members that hold a slot', async () => {
    const { control, send } = await mount()
    await send('POST', { ...ADOPT, name: 'One' }, CONTROL)
    await send('POST', { ...ADOPT, name: 'Two' }, CONTROL)
    const [first] = control.members
    control.observe(String(first!.gouziId), { connection: 'online', activity: 'working' })
    const reply = await send('GET')
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ version: 1, limit: 10, used: 2, canManage: true, hostAvailable: true })
    expect(reply.body.members.map((member: { state: string }) => member.state)).toEqual(['working', 'unreachable'])
    expect(reply.body.members[0]).toEqual(expect.objectContaining({ name: 'One', avatarId: 'corgi', role: 'testing' }))
    expect(reply.body.members[0]).not.toHaveProperty('endpoint')
  })

  it('lets a remote reader view but not manage, and refuses a member credential and a request without the control header', async () => {
    const { send } = await mount()
    const read = await send('GET', undefined, { authorization: 'Bearer pocket-token' }, true)
    expect(read).toMatchObject({ status: 200, body: { canManage: false } })
    expect(await send('POST', ADOPT, { ...CONTROL, authorization: 'Bearer pocket-token' }, true))
      .toMatchObject({ status: 403, body: { error: 'REMOTE_SCOPE_FORBIDDEN' } })
    expect(await send('POST', ADOPT, { ...CONTROL, authorization: 'Bearer gouzi-token' }, true))
      .toMatchObject({ status: 403, body: { error: 'REMOTE_SCOPE_FORBIDDEN' } })
    expect(await send('GET', undefined, {}, true)).toMatchObject({ status: 401, body: { error: 'UNAUTHORIZED' } })
    expect(await send('POST', ADOPT, {})).toMatchObject({ status: 403, body: { error: 'CONTROL_HEADER_REQUIRED' } })
    expect((await send('POST', ADOPT, { ...CONTROL, authorization: 'Bearer admin-token' }, true)).status).toBe(200)
  })

  it('rejects methods other than GET and POST', async () => {
    const { send } = await mount()
    expect((await send('GET')).status).toBe(200)
    const reply = await send('DELETE' as never)
    expect(reply.status).toBe(405)
  })

  it('adopts: resolves projects first, pairs the local host once, creates, provisions, starts, and enables', async () => {
    const { control, host: fakeHost, send } = await mount()
    const host = fakeHost!
    const reply = await send('POST', ADOPT, CONTROL)
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ name: 'Mochi', membership: 'enabled', avatarId: 'corgi', role: 'testing' })
    expect(control.calls).toEqual(['pairHost', 'create', 'setEndpoint', 'membership:enabled'])
    expect(control.hosts).toHaveLength(1)
    expect(host.provisioned).toHaveLength(1)
    expect(host.provisioned[0]).toMatchObject({
      ownerId: 'owner-test', hostId: 'local', generation: 1,
      repositories: [
        { repository: 'github.com/lisihao/alpha', source: '/work/alpha' },
        { repository: 'github.com/lisihao/beta', source: '/work/beta' },
      ],
    })
    expect(host.provisioned[0]!.authorityEpoch).toBe(String(control.hosts[0]!.authorityEpoch))
    expect(control.members[0]).toMatchObject({ grantDeadlineMs: 600_000, endpoint: 'http://127.0.0.1:4100/' })

    await send('POST', { ...ADOPT, name: 'Second' }, CONTROL)
    expect(control.hosts).toHaveLength(1)
  })

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name over forty characters', { name: 'x'.repeat(41) }],
    ['an unknown avatar', { avatarId: 'cat' }],
    ['an unknown role', { role: 'boss' }],
    ['no projects', { projects: [] }],
    ['a relative project path', { projects: ['relative/path'] }],
    ['a non-string project', { projects: [42] }],
    ['a missing action', { action: undefined }],
    ['an unknown action', { action: 'explode' }],
  ])('refuses %s before anything is created', async (_label, patch) => {
    const { control, host: fakeHost, send } = await mount()
    const host = fakeHost!
    const reply = await send('POST', { ...ADOPT, ...patch }, CONTROL)
    expect(reply).toMatchObject({ status: 400, body: { error: 'GOUZI_INVALID' } })
    expect(control.calls).toEqual([])
    expect(host.order).toEqual([])
  })

  it('refuses a body that is not JSON, not an object, or over sixteen kibibytes', async () => {
    const { control, send } = await mount()
    for (const body of ['not json', '[1]', 'null', JSON.stringify({ action: 'adopt', name: 'x'.repeat(20_000) })]) {
      expect(await send('POST', body, CONTROL), body.slice(0, 20)).toMatchObject({ status: 400, body: { error: 'GOUZI_INVALID' } })
    }
    expect(control.calls).toEqual([])
  })

  it('cannot adopt, wake, or retire without a host service, and creates nothing', async () => {
    const { control, send } = await mount({ host: false })
    expect((await send('GET')).body).toMatchObject({ hostAvailable: false, members: [] })
    expect(await send('POST', ADOPT, CONTROL)).toMatchObject({ status: 503, body: { error: 'GOUZI_HOST_UNAVAILABLE' } })
    expect(control.calls).toEqual([])
    control.members = [{ gouziId: 'g1', name: 'Mochi', membership: 'enabled', connection: 'online', activity: 'resting' } as never]
    for (const action of ['wake', 'rest', 'retire']) {
      expect(await send('POST', { action, gouziId: 'g1' }, CONTROL), action).toMatchObject({ status: 503 })
    }
  })

  it('creates nothing when a project cannot be resolved', async () => {
    const { control, host, send } = await mount()
    const reply = await send('POST', { ...ADOPT, projects: ['/work/missing'] }, CONTROL)
    expect(reply).toMatchObject({ status: 409, body: { error: 'GOUZI_PROJECT_UNAVAILABLE' } })
    expect(reply.body.message).toContain('普通目录暂不支持')
    expect(control.calls).toEqual([])
    expect(host!.order).toEqual([])
  })

  it('checks repositories without pairing, creating, provisioning or starting, and rechecks at adoption', async () => {
    const { control, host, send } = await mount()
    const projects = ['/work/missing', '/work/noorigin', '/work/alpha']
    expect(await send('POST', { action: 'check-projects', hostId: 'local', projects }, CONTROL)).toMatchObject({ status: 200, body: { projects: [
      { path: projects[0], usable: false, message: expect.stringContaining('不是 Git 仓库') as unknown },
      { path: projects[1], usable: false, message: expect.stringContaining('没有 origin') as unknown },
      { path: projects[2], usable: true },
    ] } })
    expect(control.calls).toEqual([])
    expect(host!.order).toEqual([])
    host!.failResolve = new Error("error: No such remote 'origin'")
    expect(await send('POST', { ...ADOPT, projects: ['/work/alpha'] }, CONTROL)).toMatchObject({ status: 409, body: { error: 'GOUZI_PROJECT_UNAVAILABLE' } })
    expect(control.calls).toEqual([])
    expect(host!.order).toEqual([])
  })

  it('preserves genuine process failures as failures instead of project usability', async () => {
    const { control, host, send } = await mount()
    host!.failResolve = Object.assign(new Error('Git process timed out'), { killed: true, signal: 'SIGTERM' })
    for (const action of ['check-projects', 'adopt']) {
      expect(await send('POST', { ...ADOPT, action, hostId: 'local' }, CONTROL)).toMatchObject({ status: 502, body: { error: 'GOUZI_FAILED', message: 'Git process timed out' } })
    }
    expect(control.calls).toEqual([])
    expect(host!.order).toEqual([])
  })

  it.each([
    { error: new Error('Invalid URL') },
    { error: new Error('remote repository identity must contain a valid host and repository path') },
    { error: Object.assign(new Error('missing directory'), { code: 'ENOENT', syscall: 'realpath' }) },
    { error: Object.assign(new Error('not a directory'), { code: 'ENOTDIR', syscall: 'realpath' }) },
  ])('reports explicit repository and path failures without member effects: $error.message', async ({ error }) => {
    const { control, host, send } = await mount()
    host!.failResolve = error
    const checked = await send('POST', { action: 'check-projects', hostId: 'local', projects: ['/work/alpha'] }, CONTROL)
    expect(checked).toMatchObject({ status: 200, body: { projects: [{ path: '/work/alpha', usable: false }] } })
    expect(await send('POST', { ...ADOPT, projects: ['/work/alpha'] }, CONTROL))
      .toMatchObject({ status: 409, body: { error: 'GOUZI_PROJECT_UNAVAILABLE' } })
    expect(control.calls).toEqual([])
    expect(host!.order).toEqual([])
  })

  it('preserves an unknown non-timeout resolver process error as a failed request', async () => {
    const { control, host, send } = await mount()
    host!.failResolve = new Error('process execution failed')
    for (const action of ['check-projects', 'adopt']) {
      expect(await send('POST', { ...ADOPT, action, hostId: 'local' }, CONTROL))
        .toMatchObject({ status: 502, body: { error: 'GOUZI_FAILED', message: 'process execution failed' } })
    }
    expect(control.calls).toEqual([])
    expect(host!.order).toEqual([])
  })

  it.each([{ projects: [] }, { projects: ['relative'] }, { projects: [42] }])('refuses invalid project check paths $projects', async ({ projects }) => {
    const { host, send } = await mount()
    expect(await send('POST', { action: 'check-projects', hostId: 'local', projects }, CONTROL)).toMatchObject({ status: 400 })
    expect(host!.resolved).toEqual([])
  })

  it('keeps the member in provisioning when the process fails to start, and a later wake finishes the job', async () => {
    const { control, host: fakeHost, send } = await mount()
    const host = fakeHost!
    host.failStart = 'port already in use'
    const failed = await send('POST', ADOPT, CONTROL)
    expect(failed).toMatchObject({ status: 502, body: { error: 'GOUZI_START_FAILED' } })
    expect(failed.body.message).toContain('port already in use')
    expect(control.members[0]).toMatchObject({ membership: 'provisioning' })

    host.failStart = undefined
    const [member] = control.members
    const woke = await send('POST', { action: 'wake', gouziId: String(member!.gouziId) }, CONTROL)
    expect(woke).toMatchObject({ status: 200, body: { membership: 'enabled' } })
    expect(control.members[0]).toMatchObject({ endpoint: 'http://127.0.0.1:4100/' })
  })

  it('explains the ten-member limit and keeps the roster unchanged', async () => {
    const { control, send } = await mount()
    for (let index = 0; index < GOUZI_MEMBER_LIMIT; index++) await send('POST', { ...ADOPT, name: `Dog ${String(index)}` }, CONTROL)
    const refused = await send('POST', { ...ADOPT, name: 'Eleventh' }, CONTROL)
    expect(refused).toMatchObject({ status: 409, body: { error: 'GOUZI_LIMIT_REACHED' } })
    expect(control.members).toHaveLength(GOUZI_MEMBER_LIMIT)
  })

  it('lists the local host first and every SSH host after it', async () => {
    const { host, send } = await mount()
    expect((await send('GET')).body).toMatchObject({ hosts: [{ hostId: 'local', kind: 'local' }] })
    host!.sshHosts = [{ hostId: 'ssh-1', label: 'Mac mini', kind: 'ssh', address: 'lisihao@mini.local:22' }]
    expect((await send('GET')).body).toMatchObject({ hosts: [{ hostId: 'local' }, { hostId: 'ssh-1', label: 'Mac mini', address: 'lisihao@mini.local:22' }] })
    const reader = await send('GET', undefined, { authorization: 'Bearer pocket-token' }, true)
    expect(reader.body).toMatchObject({ hosts: [{ hostId: 'local' }, { hostId: 'ssh-1', label: 'Mac mini' }] })
    expect(JSON.stringify(reader.body)).not.toContain('mini.local')
  })

  it('inspects an SSH machine, then adds it with the confirmed fingerprint and never echoes the password', async () => {
    const { host, send } = await mount()
    const target = { address: 'mini.local', port: 22, user: 'lisihao' }
    expect(await send('POST', { action: 'host-inspect', ...target }, CONTROL)).toMatchObject({ status: 200, body: { fingerprint: 'SHA256:abc123' } })
    expect(await send('POST', { action: 'host-inspect', ...target, address: 'unreachable.example' }, CONTROL)).toMatchObject({ status: 502 })
    const added = await send('POST', { action: 'host-add', ...target, password: 'secret-pw', fingerprint: 'SHA256:abc123', label: 'Mac mini' }, CONTROL)
    expect(added).toMatchObject({ status: 200, body: { hostId: 'ssh-1', label: 'Mac mini', address: 'lisihao@mini.local:22' } })
    expect(JSON.stringify(added.body)).not.toContain('secret-pw')
    expect(host!.added).toEqual([{ ...target, password: 'secret-pw', fingerprint: 'SHA256:abc123', label: 'Mac mini' }])
    host!.failAdd = '用户名或密码不对'
    expect(await send('POST', { action: 'host-add', ...target, password: 'wrong', fingerprint: 'SHA256:abc123' }, CONTROL))
      .toMatchObject({ status: 502, body: { message: '用户名或密码不对' } })
  })

  it.each([
    ['an address that looks like an option', { address: '-oProxyCommand=evil' }],
    ['an address with a space', { address: 'a b' }],
    ['a login with a slash', { user: 'a/b' }],
    ['port zero', { port: 0 }],
    ['a fractional port', { port: 22.5 }],
    ['a port over 65535', { port: 70_000 }],
    ['a fingerprint that is not SHA256', { fingerprint: 'MD5:aa' }],
    ['a password over 256 characters', { password: 'x'.repeat(257) }],
    ['no password', { password: undefined }],
  ])('refuses to add a host with %s before touching the host service', async (_label, patch) => {
    const { host, send } = await mount()
    const reply = await send('POST', {
      action: 'host-add', address: 'mini.local', port: 22, user: 'lisihao', password: 'pw', fingerprint: 'SHA256:abc123', ...patch,
    }, CONTROL)
    expect(reply).toMatchObject({ status: 400, body: { error: 'GOUZI_INVALID' } })
    expect(host!.added).toEqual([])
  })

  it('lets only a manager add, inspect, browse, or remove hosts', async () => {
    const { send } = await mount()
    const headers = { ...CONTROL, authorization: 'Bearer pocket-token' }
    for (const body of [
      { action: 'host-inspect', address: 'mini.local', port: 22, user: 'lisihao' },
      { action: 'host-remove', hostId: 'ssh-1' },
      { action: 'browse', hostId: 'ssh-1' },
      { action: 'check-projects', hostId: 'local', projects: ['/work/alpha'] },
    ]) {
      expect(await send('POST', body, headers, true), body.action).toMatchObject({ status: 403, body: { error: 'REMOTE_SCOPE_FORBIDDEN' } })
    }
  })

  it('adopts onto an SSH host: resolves the projects there, pairs that host, and starts the member through it', async () => {
    const { control, host, send } = await mount()
    host!.sshHosts = [{ hostId: 'ssh-1', label: 'Mac mini', kind: 'ssh', address: 'lisihao@mini.local:22' }]
    const reply = await send('POST', { ...ADOPT, hostId: 'ssh-1', projects: ['/Users/lisihao/project/PetGoGo'] }, CONTROL)
    expect(reply.status).toBe(200)
    expect(host!.resolved).toEqual([['ssh-1', '/Users/lisihao/project/PetGoGo']])
    expect(control.hosts).toMatchObject([{ hostId: 'ssh-1', label: 'Mac mini', credentialRef: 'GOUZI_HOST_SSH_1' }])
    expect(host!.provisioned[0]).toMatchObject({ hostId: 'ssh-1', repositories: [{ source: '/Users/lisihao/project/PetGoGo' }] })
    expect(host!.started).toEqual([['ssh-1', reply.body.gouziId]])
    expect(control.members[0]).toMatchObject({ hostId: 'ssh-1', endpoint: 'http://127.0.0.1:4200/' })
  })

  it('refuses to adopt onto a host that was never added, and creates nothing', async () => {
    const { control, send } = await mount()
    expect(await send('POST', { ...ADOPT, hostId: 'ssh-ghost' }, CONTROL)).toMatchObject({ status: 400, body: { error: 'GOUZI_INVALID' } })
    expect(control.calls).toEqual([])
  })

  it('wakes, rests, and retires a member through the host it lives on', async () => {
    const { host, send } = await mount()
    host!.sshHosts = [{ hostId: 'ssh-1', label: 'Mac mini', kind: 'ssh' }]
    const id = (await send('POST', { ...ADOPT, hostId: 'ssh-1' }, CONTROL)).body.gouziId
    host!.started.length = 0
    await send('POST', { action: 'wake', gouziId: id }, CONTROL)
    expect(host!.started).toEqual([['ssh-1', id]])
    await send('POST', { action: 'retire', gouziId: id }, CONTROL)
    expect(host!.stopped).toEqual([[id, true]])
  })

  it('browses a host and removes one only when no live member lives there', async () => {
    const { host, send } = await mount()
    host!.sshHosts = [{ hostId: 'ssh-1', label: 'Mac mini', kind: 'ssh' }]
    expect(await send('POST', { action: 'browse', hostId: 'ssh-1', path: '/Users/lisihao/project' }, CONTROL))
      .toMatchObject({ status: 200, body: { path: '/Users/lisihao/project', entries: [{ name: 'PetGoGo', git: true }] } })
    expect(await send('POST', { action: 'browse', hostId: 'ssh-1', path: 'relative' }, CONTROL)).toMatchObject({ status: 400 })
    const id = (await send('POST', { ...ADOPT, hostId: 'ssh-1' }, CONTROL)).body.gouziId
    expect(await send('POST', { action: 'host-remove', hostId: 'ssh-1' }, CONTROL)).toMatchObject({ status: 409, body: { error: 'GOUZI_STATE_CONFLICT' } })
    expect(host!.removed).toEqual([])
    await send('POST', { action: 'retire', gouziId: id }, CONTROL)
    expect(await send('POST', { action: 'host-remove', hostId: 'ssh-1' }, CONTROL)).toMatchObject({ status: 200, body: { removed: true } })
    expect(host!.removed).toEqual(['ssh-1'])
    expect(await send('POST', { action: 'host-remove', hostId: 'local' }, CONTROL)).toMatchObject({ status: 400 })
  })

  it('serializes concurrent adoptions so their steps never interleave', async () => {
    const { host: fakeHost, send } = await mount()
    const host = fakeHost!
    await Promise.all([send('POST', { ...ADOPT, name: 'A' }, CONTROL), send('POST', { ...ADOPT, name: 'B' }, CONTROL)])
    expect(host.order).toEqual(['provision', 'start', 'provision', 'start'])
  })

  it('edits, wakes, rests, and refuses to rest or retire a member that is working', async () => {
    const { control, host: fakeHost, send } = await mount()
    const host = fakeHost!
    const adopted = await send('POST', ADOPT, CONTROL)
    const id = adopted.body.gouziId
    expect((await send('POST', { action: 'edit', gouziId: id, name: ' Pixel ', avatarId: 'poodle', role: 'research' }, CONTROL)).body)
      .toMatchObject({ name: 'Pixel', avatarId: 'poodle', role: 'research' })
    expect(await send('POST', { action: 'edit', gouziId: id }, CONTROL)).toMatchObject({ status: 400 })
    expect(await send('POST', { action: 'wake', gouziId: 'missing' }, CONTROL)).toMatchObject({ status: 400 })

    control.observe(id, { connection: 'online', activity: 'working' })
    expect(await send('POST', { action: 'rest', gouziId: id }, CONTROL)).toMatchObject({ status: 409, body: { error: 'GOUZI_STATE_CONFLICT' } })
    expect(await send('POST', { action: 'retire', gouziId: id }, CONTROL)).toMatchObject({ status: 409 })
    expect(host.stopped).toEqual([])

    control.observe(id, { activity: 'resting' })
    expect((await send('POST', { action: 'rest', gouziId: id }, CONTROL)).status).toBe(200)
    expect(host.stopped).toEqual([[id, false]])
  })

  it('retires: retiring first, then stops the process tree, then archives with evidence', async () => {
    const { control, host: fakeHost, send } = await mount()
    const host = fakeHost!
    const id = (await send('POST', ADOPT, CONTROL)).body.gouziId
    control.calls.length = 0
    const reply = await send('POST', { action: 'retire', gouziId: id }, CONTROL)
    expect(reply.status).toBe(200)
    expect(host.stopped).toEqual([[id, true]])
    expect(control.calls).toEqual([
      'membership:retiring',
      'archive:{"credentialsRevoked":true,"workSettled":true,"processTreeStopped":true}',
    ])
    expect(control.members[0]!.membership).toBe('archived')
    // An archived member is gone from the roster and cannot be retired again.
    expect((await send('GET')).body.members).toEqual([])
    expect(await send('POST', { action: 'retire', gouziId: id }, CONTROL)).toMatchObject({ status: 409 })
    expect(await send('POST', { action: 'wake', gouziId: id }, CONTROL)).toMatchObject({ status: 409 })
  })

  it('keeps the slot when the process tree is not fully stopped', async () => {
    const { control, host: fakeHost, send } = await mount()
    const host = fakeHost!
    const id = (await send('POST', ADOPT, CONTROL)).body.gouziId
    host.treeStopped = false
    expect(await send('POST', { action: 'retire', gouziId: id }, CONTROL)).toMatchObject({ status: 409 })
    expect(control.members[0]!.membership).toBe('retiring')
    // The member can be retired again once the tree is gone.
    host.treeStopped = true
    expect((await send('POST', { action: 'retire', gouziId: id }, CONTROL)).status).toBe(200)
  })
})

describe('gouziPrimaryState', () => {
  it.each([
    [{ membership: 'provisioning', connection: 'unreachable', activity: 'working' }, 'provisioning'],
    [{ membership: 'retiring', connection: 'online', activity: 'working' }, 'retiring'],
    [{ membership: 'archived', connection: 'online', activity: 'resting' }, 'archived'],
    [{ membership: 'enabled', connection: 'unreachable', activity: 'working' }, 'unreachable'],
    [{ membership: 'enabled', connection: 'online', activity: 'working' }, 'working'],
    [{ membership: 'enabled', connection: 'online', activity: 'awaiting-approval' }, 'awaiting-approval'],
    [{ membership: 'enabled', connection: 'online', activity: 'resting' }, 'resting'],
  ] as const)('reduces %j to %s', (member, expected) => {
    expect(gouziPrimaryState(member)).toBe(expected)
  })
})
