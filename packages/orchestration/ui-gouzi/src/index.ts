/** Same-origin HTTP projection and controls for Gouzi execution members. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { authorizeRemoteRequest, type RemoteRequestAuthority } from '@deepseek-ai/dsh-host-remote-auth'
import {
  countsTowardGouziLimit,
  GOUZI_MEMBER_LIMIT,
  GouziAuthorityEpoch,
  GouziHostId,
  GouziId,
  GouziOwnerId,
  type GouziControl,
  type GouziMemberView,
} from '@deepseek-ai/dsh-orchestration'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  GOUZI_AVATARS,
  GOUZI_CONTROL_HEADER,
  GOUZI_DASHBOARD_PATH,
  GOUZI_LOCAL_HOST_ID,
  GOUZI_ROLE_IDS,
  GOUZI_ROOM_POLL_INTERVAL_SCHEMA,
  gouziPrimaryState,
  type GouziAvatar,
  type GouziControlRequest,
  type GouziDashboardV1,
  type GouziErrorV1,
  type GouziFolderListing,
  type GouziHostInspection,
  type GouziHostProjection,
  type GouziMemberProjection,
  type GouziProjectsCheck,
} from './contracts.ts'
import { gouziRoom, gouziRoomEvidence } from './room.ts'
import './host-service.ts'
import type { GouziProjectSource } from './host-service.ts'
import { installKennelDispatch, type KennelDispatchConfig } from './dispatcher.ts'
import { GouziRecipientResolver, installKennelRecipientGuard } from './recipient.ts'

export * from './contracts.ts'
export { GouziHostService, type GouziProcessInfo, type GouziProjectSource, type GouziProvisionInput, type GouziSshTarget } from './host-service.ts'

export const name = 'ui-gouzi'
export const inject = ['orchestrations', 'webServer', 'sessions']

/** Gouzi plugin configuration. */
export interface Config {
  /** AI routing of real user messages in kennel sessions. */
  readonly dispatcher?: KennelDispatchConfig
  /** Browser room read interval in integer milliseconds. */
  readonly roomPollIntervalMs?: number
  /** How long after issue an execution grant may start work, in milliseconds. */
  readonly grantDeadlineMs?: number
}

export const Config: z<Config> = z.object({
  dispatcher: z.object({
    enabled: z.boolean().default(true),
    jev: z.union([z.object({ provider: z.string().required(), model: z.string().required() })]),
    jevProvider: z.string().default('Jev'),
    deepseek: z.object({ provider: z.string().default('deepseek-official'), model: z.string().default('deepseek-flash') }),
    codex: z.object({ operatorId: z.string().default('codex'), model: z.string() }),
    maxTokens: z.number().step(1).min(1).default(512),
    timeoutMs: z.number().step(1).min(1_000).max(300_000).default(60_000),
    maxOutputBytes: z.number().step(1).min(1).default(65_536),
    maxInputBytes: z.number().step(1).min(1).default(65_536),
    contextTokens: z.number().step(1).min(1).default(8_192),
    taskTimeoutMs: z.number().step(1).min(1_000).max(86_400_000).default(600_000),
    taskGenerationLimits: z.object({
      maxTokens: z.number().step(1).min(1).default(4096),
      maxOutputBytes: z.number().step(1).min(1).default(262144),
      maxToolCalls: z.number().step(1).min(0).default(40),
    }),
    workspaceToolLimits: z.object({
      maxToolCalls: z.number().step(1).min(1).default(40),
      maxFileBytes: z.number().step(1).min(1).default(1048576),
      maxOutputBytes: z.number().step(1).min(1).default(262144),
      maxSearchFiles: z.number().step(1).min(1).default(2000),
    }),
    workspaceSnapshotLimits: z.object({
      maxFiles: z.number().step(1).min(1).default(20000),
      maxBytes: z.number().step(1).min(1).default(268435456),
      maxBundleBytes: z.number().step(1).min(1).default(67108864),
      timeoutMs: z.number().step(1).min(1000).default(120000),
    }),
    maxRunCandidates: z.number().step(1).min(1).max(100).default(20),
    titleMaxChars: z.number().step(1).min(1).default(160),
  }),
  roomPollIntervalMs: GOUZI_ROOM_POLL_INTERVAL_SCHEMA,
  grantDeadlineMs: z.number().step(1).min(60_000).max(24 * 60 * 60_000).default(2 * 60 * 60_000),
})

/** Label of the machine that runs this Server. */
const LOCAL_HOST_LABEL = '这台 Mac'
const HOST_ADDRESS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u
const HOST_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u
const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]+={0,2}$/u
const PASSWORD_LIMIT = 256
const MAX_BODY_BYTES = 16 * 1024
const NAME_LIMIT = 40

/** A request the caller got wrong, as opposed to a state the system refuses. */
class GouziInputError extends Error {}

/* jscpd:ignore-start -- the independently unloadable Gouzi Host plugin owns its transport boundary; sharing these
 * helpers with orchestration would add a forbidden cross-plugin runtime dependency. */
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const encoded = Buffer.from(JSON.stringify(value))
  response.statusCode = status
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', encoded.byteLength)
  response.end(encoded)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > MAX_BODY_BYTES) throw new GouziInputError('request exceeds 16 KiB')
    chunks.push(value)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // A body that is not JSON is the caller's mistake and is reported as such.
    throw new GouziInputError('request body is not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new GouziInputError('request must be an object')
  return parsed as Record<string, unknown>
}
/* jscpd:ignore-end */

function text(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) throw new GouziInputError(`${key} must be a non-empty string`)
  return value
}

function optionalText(body: Record<string, unknown>, key: string): string | undefined {
  return body[key] === undefined ? undefined : text(body, key)
}

function memberName(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > NAME_LIMIT) throw new GouziInputError(`name must be 1 to ${String(NAME_LIMIT)} characters`)
  return trimmed
}

function avatar(value: string): GouziAvatar {
  if (!(GOUZI_AVATARS as readonly string[]).includes(value)) throw new GouziInputError(`unknown avatar ${value}`)
  return value as GouziAvatar
}

function role(value: string): (typeof GOUZI_ROLE_IDS)[number] {
  if (!(GOUZI_ROLE_IDS as readonly string[]).includes(value)) throw new GouziInputError(`unknown role ${value}`)
  return value as (typeof GOUZI_ROLE_IDS)[number]
}

function sshTarget(body: Record<string, unknown>): { address: string; port: number; user: string } {
  const address = text(body, 'address').trim()
  if (!HOST_ADDRESS_PATTERN.test(address) || address.length > 253) throw new GouziInputError('address must be a host name or IP address')
  const user = text(body, 'user').trim()
  if (!HOST_USER_PATTERN.test(user) || user.length > 64) throw new GouziInputError('user must be a login name')
  const port = body.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) throw new GouziInputError('port must be 1 to 65535')
  return { address, port, user }
}

/**
 * Validate an untrusted control body.
 * @param body - parsed JSON object.
 * @returns the typed request.
 * @throws GouziInputError - when a field is missing or invalid.
 */
function parseControl(body: Record<string, unknown>): GouziControlRequest {
  const action = text(body, 'action')
  switch (action) {
    case 'check-projects':
    case 'adopt': {
      const projects = body.projects
      if (!Array.isArray(projects) || projects.length === 0 || projects.some(value => typeof value !== 'string' || !isAbsolute(value))) {
        throw new GouziInputError('projects must list at least one absolute path')
      }
      if (action === 'check-projects') return { action, hostId: text(body, 'hostId'), projects: projects as string[] }
      return {
        action,
        name: memberName(text(body, 'name')),
        avatarId: avatar(text(body, 'avatarId')),
        role: role(text(body, 'role')),
        ...optionalText(body, 'hostId') === undefined ? {} : { hostId: text(body, 'hostId') },
        projects: projects as string[],
      }
    }
    case 'host-inspect': return { action, ...sshTarget(body) }
    case 'host-add': {
      const password = text(body, 'password')
      if (password.length > PASSWORD_LIMIT) throw new GouziInputError(`password must be at most ${String(PASSWORD_LIMIT)} characters`)
      const fingerprint = text(body, 'fingerprint')
      if (!FINGERPRINT_PATTERN.test(fingerprint)) throw new GouziInputError('fingerprint must look like SHA256:...')
      const label = optionalText(body, 'label')?.trim()
      return {
        action,
        ...sshTarget(body),
        password,
        fingerprint,
        ...label === undefined || label.length === 0 ? {} : { label: label.slice(0, NAME_LIMIT) },
      }
    }
    case 'host-remove': return { action, hostId: text(body, 'hostId') }
    case 'browse': {
      const path = optionalText(body, 'path')
      if (path !== undefined && !isAbsolute(path)) throw new GouziInputError('path must be absolute')
      return { action, hostId: text(body, 'hostId'), ...path === undefined ? {} : { path } }
    }
    case 'edit': {
      const name = optionalText(body, 'name')
      const avatarId = optionalText(body, 'avatarId')
      const requestedRole = optionalText(body, 'role')
      if (name === undefined && avatarId === undefined && requestedRole === undefined) {
        throw new GouziInputError('edit needs a name, avatarId, or role')
      }
      return {
        action,
        gouziId: text(body, 'gouziId'),
        ...name === undefined ? {} : { name: memberName(name) },
        ...avatarId === undefined ? {} : { avatarId: avatar(avatarId) },
        ...requestedRole === undefined ? {} : { role: role(requestedRole) },
      }
    }
    case 'wake':
    case 'rest':
    case 'retire':
      return { action, gouziId: text(body, 'gouziId') }
    default:
      throw new GouziInputError(`unknown action ${action}`)
  }
}

function project(member: GouziMemberView, hostLabel: string): GouziMemberProjection {
  return {
    gouziId: String(member.gouziId),
    name: member.name,
    avatarId: member.avatarId,
    role: member.role,
    hostId: String(member.hostId),
    hostLabel,
    membership: member.membership,
    connection: member.connection,
    activity: member.activity,
    state: gouziPrimaryState(member),
    createdAt: member.createdAt,
  }
}

/** The member as the panel shows it, with the name of the machine it lives on. */
async function view(control: GouziControl, member: GouziMemberView): Promise<GouziMemberProjection> {
  const host = (await control.list()).hosts.find(value => String(value.hostId) === String(member.hostId))
  return project(member, host?.label ?? String(member.hostId))
}

function canManage(authority: RemoteRequestAuthority): boolean {
  return authority.scope === 'admin' || authority.scope === 'cockpit'
}

async function projectHosts(ctx: Context): Promise<readonly GouziHostProjection[]> {
  const host = ctx.get('gouziHost')
  const local: GouziHostProjection = { hostId: GOUZI_LOCAL_HOST_ID, label: LOCAL_HOST_LABEL, kind: 'local' }
  return host === undefined ? [local] : [local, ...await host.hosts()]
}

async function dashboard(ctx: Context, control: GouziControl, authority: RemoteRequestAuthority): Promise<GouziDashboardV1> {
  const { members, hosts } = await control.list()
  const labels = new Map(hosts.map(value => [String(value.hostId), value.label]))
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    limit: GOUZI_MEMBER_LIMIT,
    used: members.filter(member => countsTowardGouziLimit(member.membership)).length,
    canManage: canManage(authority),
    hostAvailable: ctx.get('gouziHost') !== undefined,
    // A read-only device learns which machines exist, not how to log in to them.
    hosts: (await projectHosts(ctx)).map(host => canManage(authority) ? host : { hostId: host.hostId, label: host.label, kind: host.kind }),
    members: members
      .filter(member => member.membership !== 'archived')
      .map(member => project(member, labels.get(String(member.hostId)) ?? String(member.hostId))),
  }
}

async function requireMember(control: GouziControl, gouziId: string): Promise<GouziMemberView> {
  const member = (await control.list()).members.find(value => String(value.gouziId) === gouziId)
  if (member === undefined) throw new GouziInputError(`gouzi ${gouziId} does not exist`)
  return member
}

/** Raised for a state the system refuses, so the panel can explain it instead of reporting a fault. */
class GouziRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

function projectUnavailable(path: string, error: unknown): GouziRefusal | undefined {
  const detail = error as { code?: unknown; killed?: unknown; signal?: unknown } | undefined
  if (detail?.killed === true || detail?.signal != null) return undefined
  let reason: string | undefined
  if (detail?.code === 'ENOENT') reason = '这个目录不存在，请选择已有目录'
  else if (detail?.code === 'ENOTDIR') reason = '这个路径不是目录，请选择目录'
  else if (detail?.code === 'EACCES' || detail?.code === 'EPERM') reason = '没有权限访问这个目录，请检查目录权限后重试'
  if (reason === undefined) return undefined
  return new GouziRefusal('GOUZI_PROJECT_UNAVAILABLE', `${path}：${reason}。`)
}

async function resolveProject(host: ReturnType<typeof requireHost>, hostId: string, path: string) {
  try {
    return await host.resolveRepository(hostId, path)
  } catch (error) {
    throw projectUnavailable(path, error) ?? error
  }
}

async function checkProjects(ctx: Context, request: Extract<GouziControlRequest, { action: 'check-projects' }>): Promise<GouziProjectsCheck> {
  const host = requireHost(ctx)
  if (!(await projectHosts(ctx)).some(value => value.hostId === request.hostId)) throw new GouziInputError(`unknown host ${request.hostId}`)
  const projects = await Promise.all(request.projects.map(async (path) => {
    try {
      await resolveProject(host, request.hostId, path)
      return { path, usable: true } as const
    } catch (error) {
      if (!(error instanceof GouziRefusal) || error.code !== 'GOUZI_PROJECT_UNAVAILABLE') throw error
      return { path, usable: false, message: error.message } as const
    }
  }))
  return { projects }
}

async function adopt(ctx: Context, control: GouziControl, request: Extract<GouziControlRequest, { action: 'adopt' }>, grantDeadlineMs: number) {
  const host = ctx.get('gouziHost')
  if (host === undefined) throw new GouziRefusal('GOUZI_HOST_UNAVAILABLE', '这台机器上还不能启动狗子')
  // Resolve every project before anything is created, so a bad path leaves no half-made member behind.
  const hostId = request.hostId ?? GOUZI_LOCAL_HOST_ID
  const known = (await projectHosts(ctx)).find(value => value.hostId === hostId)
  if (known === undefined) throw new GouziInputError(`unknown host ${hostId}`)
  const resolved = await Promise.all(request.projects.map(path => resolveProject(host, hostId, path)))
  const listing = await control.list()
  if (listing.members.filter(member => countsTowardGouziLimit(member.membership)).length >= GOUZI_MEMBER_LIMIT) {
    throw new GouziRefusal('GOUZI_LIMIT_REACHED', `最多只能收养 ${String(GOUZI_MEMBER_LIMIT)} 只狗子，请先退役一只后重试`)
  }
  const prepared: GouziProjectSource[] = []
  for (const project of new Map(resolved.map(value => [value.source, value])).values()) {
    try {
      prepared.push(await host.prepareRepository(hostId, project.source))
    } catch (error) {
      const failure = projectUnavailable(project.source, error)
      const message = failure?.message ?? `${project.source}：${error instanceof Error ? error.message : String(error)}`
      const completed = prepared.length === 0 ? '' : `以下目录已完成准备：${prepared.map(value => value.source).join('、')}。`
      const detail = `${message}${message.endsWith('。') ? '' : '。'}${completed}尚未创建狗子，未占用名额。`
      throw failure === undefined ? new Error(detail) : new GouziRefusal(failure.code, detail)
    }
  }
  const uniqueProjects = new Map<string, GouziProjectSource>()
  for (const project of prepared) if (!uniqueProjects.has(project.projectId)) uniqueProjects.set(project.projectId, project)
  // parseControl requires at least one project; successful preparation and deduplication preserve one.
  const projects = [...uniqueProjects.values()] as [GouziProjectSource, ...GouziProjectSource[]]
  const pilot = listing.hosts.find(value => String(value.hostId) === hostId)
    ?? await control.pairHost({
      hostId: GouziHostId(hostId),
      label: known.label,
      authorityEpoch: GouziAuthorityEpoch(randomUUID()),
      credentialRef: `GOUZI_HOST_${hostId.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_')}`,
    })
  const gouziId = GouziId(`gouzi-${randomUUID()}`)
  const created = await control.create({
    gouziId,
    ownerId: GouziOwnerId(host.ownerId),
    hostId: pilot.hostId,
    name: request.name,
    avatarId: request.avatarId,
    role: request.role,
    grantDeadlineMs,
  })
  try {
    await host.provision({
      gouziId: String(gouziId),
      ownerId: host.ownerId,
      hostId: String(pilot.hostId),
      generation: created.generation,
      authorityEpoch: String(pilot.authorityEpoch),
      projects,
      defaultProjectId: projects[0].projectId,
    })
    const process = await host.start(String(pilot.hostId), String(gouziId))
    await control.setEndpoint(gouziId, process.endpoint)
    return await view(control, await control.setMembership(gouziId, 'enabled'))
  } catch (error) {
    // The member exists and keeps its slot in `provisioning`; waking it retries the start.
    throw new GouziRefusal('GOUZI_START_FAILED', `${request.name} 已创建，但还没能启动：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function wake(ctx: Context, control: GouziControl, gouziId: string) {
  const host = ctx.get('gouziHost')
  if (host === undefined) throw new GouziRefusal('GOUZI_HOST_UNAVAILABLE', '这台机器上还不能启动狗子')
  const member = await requireMember(control, gouziId)
  if (member.membership !== 'provisioning' && member.membership !== 'enabled') {
    throw new GouziRefusal('GOUZI_STATE_CONFLICT', `${member.name} 已经${member.membership === 'retiring' ? '在退役' : '退役'}，不能再唤醒`)
  }
  const process = await host.start(String(member.hostId), gouziId)
  await control.setEndpoint(member.gouziId, process.endpoint)
  return view(control, member.membership === 'provisioning' ? await control.setMembership(member.gouziId, 'enabled') : await requireMember(control, gouziId))
}

async function rest(ctx: Context, control: GouziControl, gouziId: string) {
  const host = ctx.get('gouziHost')
  if (host === undefined) throw new GouziRefusal('GOUZI_HOST_UNAVAILABLE', '这台机器上还不能启动狗子')
  const member = await requireMember(control, gouziId)
  if (member.activity === 'working') throw new GouziRefusal('GOUZI_STATE_CONFLICT', `${member.name} 正在工作，等它做完再让它休息`)
  await host.stop(String(member.hostId), gouziId)
  return view(control, await requireMember(control, gouziId))
}

async function retire(ctx: Context, control: GouziControl, gouziId: string) {
  const host = ctx.get('gouziHost')
  if (host === undefined) throw new GouziRefusal('GOUZI_HOST_UNAVAILABLE', '这台机器上还不能启动狗子')
  const member = await requireMember(control, gouziId)
  if (member.activity === 'working') throw new GouziRefusal('GOUZI_STATE_CONFLICT', `${member.name} 正在工作，等它做完再让它退役`)
  if (member.membership === 'archived') throw new GouziRefusal('GOUZI_STATE_CONFLICT', `${member.name} 已经退役`)
  if (member.membership !== 'retiring') await control.setMembership(member.gouziId, 'retiring')
  const stopped = await host.stop(String(member.hostId), gouziId, { reclaimResident: true })
  if (!stopped.processTreeStopped) {
    throw new GouziRefusal('GOUZI_STATE_CONFLICT', `${member.name} 的进程还没有完全停下，暂时保留名额`)
  }
  // A loopback member never held a device credential, so there is nothing left to revoke.
  return view(control, await control.archive(member.gouziId, { credentialsRevoked: true, workSettled: true, processTreeStopped: true }))
}

function requireHost(ctx: Context) {
  const host = ctx.get('gouziHost')
  if (host === undefined) throw new GouziRefusal('GOUZI_HOST_UNAVAILABLE', '这台机器上还不能启动狗子')
  return host
}

async function removeHost(ctx: Context, control: GouziControl, hostId: string): Promise<{ readonly removed: true }> {
  const host = requireHost(ctx)
  if (hostId === GOUZI_LOCAL_HOST_ID) throw new GouziInputError('the local host cannot be removed')
  const holding = (await control.list()).members.filter(member => String(member.hostId) === hostId && member.membership !== 'archived')
  if (holding.length > 0) {
    throw new GouziRefusal('GOUZI_STATE_CONFLICT', `${holding.map(member => member.name).join('、')} 还住在这台机器上，先让它们退役`)
  }
  await host.removeHost(hostId)
  return { removed: true }
}

type ExecuteResult =
  | GouziMemberProjection
  | GouziHostInspection
  | GouziHostProjection
  | GouziFolderListing
  | GouziProjectsCheck
  | { readonly removed: true }

async function execute(ctx: Context, control: GouziControl, request: GouziControlRequest, grantDeadlineMs: number): Promise<ExecuteResult> {
  switch (request.action) {
    case 'host-inspect': return requireHost(ctx).inspectHost({ address: request.address, port: request.port, user: request.user })
    case 'host-add':
      return requireHost(ctx).addHost({
        address: request.address,
        port: request.port,
        user: request.user,
        password: request.password,
        fingerprint: request.fingerprint,
        ...request.label === undefined ? {} : { label: request.label },
      })
    case 'host-remove': return removeHost(ctx, control, request.hostId)
    case 'browse': return requireHost(ctx).browse(request.hostId, request.path)
    case 'check-projects': return checkProjects(ctx, request)
    case 'adopt': return adopt(ctx, control, request, grantDeadlineMs)
    case 'edit':
      return view(control, await control.edit(GouziId(request.gouziId), {
        ...request.name === undefined ? {} : { name: request.name },
        ...request.avatarId === undefined ? {} : { avatarId: request.avatarId },
        ...request.role === undefined ? {} : { role: request.role },
      }))
    case 'wake': return wake(ctx, control, request.gouziId)
    case 'rest': return rest(ctx, control, request.gouziId)
    case 'retire': return retire(ctx, control, request.gouziId)
  }
}

/** One response to send: a status and a JSON body. */
interface Reply {
  readonly status: number
  readonly body: unknown
}

function refusal(status: number, error: string, message: string): Reply {
  return { status, body: { error, message } satisfies GouziErrorV1 }
}

function failure(error: unknown): Reply {
  if (error instanceof GouziInputError) return refusal(400, 'GOUZI_INVALID', error.message)
  if (error instanceof GouziRefusal) {
    const status = error.code === 'GOUZI_HOST_UNAVAILABLE' ? 503 : error.code === 'GOUZI_START_FAILED' ? 502 : 409
    return refusal(status, error.code, error.message)
  }
  const code = (error as { code?: unknown } | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (typeof code === 'string' && code.startsWith('GOUZI_')) return refusal(409, code, message)
  return refusal(502, 'GOUZI_FAILED', message)
}

/**
 * Register the Gouzi projection and controls.
 * @param ctx - plugin context.
 * @param config - grant lifetime given to every new member.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = Config(config)
  new GouziRecipientResolver(ctx, resolved.dispatcher?.enabled === true)
  if (resolved.dispatcher) installKennelDispatch(ctx, resolved.dispatcher)
  installKennelRecipientGuard(ctx)
  const grantDeadlineMs = config.grantDeadlineMs ?? 2 * 60 * 60_000
  const roomPollIntervalMs = GOUZI_ROOM_POLL_INTERVAL_SCHEMA(config.roomPollIntervalMs)
  // Adoption changes the member count and starts a process; two requests must not interleave.
  let queue: Promise<unknown> = Promise.resolve()

  const answer = async (request: IncomingMessage): Promise<Reply | 'method-not-allowed'> => {
    const remoteAuth = ctx.get('remoteAuth')
    const authority = authorizeRemoteRequest(request, remoteAuth)
    if (authority === undefined) {
      return remoteAuth === undefined
        ? refusal(503, 'REMOTE_AUTH_UNAVAILABLE', '远程认证不可用')
        : refusal(401, 'UNAUTHORIZED', '需要先配对')
    }
    const control = ctx.orchestrations.gouzi
    if (control === undefined) return refusal(503, 'GOUZI_UNAVAILABLE', '当前编排服务不管理狗子')
    if (request.method === 'GET') {
      const query = new URL(request.url ?? GOUZI_DASHBOARD_PATH, 'http://localhost').searchParams
      const sessionId = query.get('session_id')
      const evidenceRef = query.get('evidence_ref')
      const runId = query.get('run_id')
      if (sessionId === null && evidenceRef === null && runId === null) {
        return { status: 200, body: await dashboard(ctx, control, authority) }
      }
      if (sessionId === null || sessionId.trim().length === 0) throw new GouziInputError('session_id must be a non-empty string')
      if (evidenceRef !== null || runId !== null) {
        if (evidenceRef === null || evidenceRef.trim().length === 0 || runId === null || runId.trim().length === 0) {
          throw new GouziInputError('evidence_ref and run_id must be non-empty strings')
        }
        const artifact = await gouziRoomEvidence(ctx.orchestrations, sessionId, runId, evidenceRef)
        return artifact === undefined ? refusal(404, 'GOUZI_EVIDENCE_NOT_FOUND', '这个会话没有保留该证据') : { status: 200, body: artifact }
      }
      return {
        status: 200,
        body: await gouziRoom(ctx.orchestrations, control, sessionId, await dashboard(ctx, control, authority), roomPollIntervalMs),
      }
    }
    if (request.method !== 'POST') return 'method-not-allowed'
    if (request.headers[GOUZI_CONTROL_HEADER] !== '1') return refusal(403, 'CONTROL_HEADER_REQUIRED', '缺少控制头')
    if (!canManage(authority)) return refusal(403, 'REMOTE_SCOPE_FORBIDDEN', '这个设备只能查看')
    const parsed = parseControl(await readBody(request))
    const run = queue.then(() => execute(ctx, control, parsed, grantDeadlineMs))
    queue = run.catch(() => undefined)
    return { status: 200, body: await run }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: GOUZI_DASHBOARD_PATH,
    handler: async (request, response) => {
      let reply: Reply | 'method-not-allowed'
      try {
        reply = await answer(request)
      } catch (error) {
        ctx.logger.warn(error)
        reply = failure(error)
      }
      if (reply === 'method-not-allowed') {
        response.writeHead(405, { Allow: 'GET, POST' })
        response.end()
        return
      }
      sendJson(response, reply.status, reply.body)
    },
  }), 'ui-gouzi: dashboard route')
}
