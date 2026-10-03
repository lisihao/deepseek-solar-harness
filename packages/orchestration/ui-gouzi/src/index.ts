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
  GOUZI_ROLE_IDS,
  gouziPrimaryState,
  type GouziAvatar,
  type GouziControlRequest,
  type GouziDashboardV1,
  type GouziErrorV1,
  type GouziMemberProjection,
} from './contracts.ts'
import './host-service.ts'

export * from './contracts.ts'
export { GouziHostService, type GouziProcessInfo, type GouziProvisionInput } from './host-service.ts'

export const name = 'ui-gouzi'
export const inject = ['orchestrations', 'webServer']

/** Gouzi plugin configuration. */
export interface Config {
  /** How long after issue an execution grant may start work, in milliseconds. */
  readonly grantDeadlineMs?: number
}

export const Config: z<Config> = z.object({
  grantDeadlineMs: z.number().step(1).min(60_000).max(24 * 60 * 60_000).default(2 * 60 * 60_000),
})

/** The one execution host of the first version: the machine that runs this Server. */
const PILOT_HOST_ID = 'local'
const PILOT_HOST_LABEL = '这台 Mac'
const PILOT_HOST_CREDENTIAL_REF = 'GOUZI_HOST_LOCAL'
const MAX_BODY_BYTES = 16 * 1024
const NAME_LIMIT = 40

/** A request the caller got wrong, as opposed to a state the system refuses. */
class GouziInputError extends Error {}

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

/**
 * Validate an untrusted control body.
 * @param body - parsed JSON object.
 * @returns the typed request.
 * @throws GouziInputError - when a field is missing or invalid.
 */
function parseControl(body: Record<string, unknown>): GouziControlRequest {
  const action = text(body, 'action')
  switch (action) {
    case 'adopt': {
      const projects = body.projects
      if (!Array.isArray(projects) || projects.length === 0 || projects.some(value => typeof value !== 'string' || !isAbsolute(value))) {
        throw new GouziInputError('projects must list at least one absolute path')
      }
      return {
        action,
        name: memberName(text(body, 'name')),
        avatarId: avatar(text(body, 'avatarId')),
        role: role(text(body, 'role')),
        projects: projects as string[],
      }
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

function project(member: GouziMemberView): GouziMemberProjection {
  return {
    gouziId: String(member.gouziId),
    name: member.name,
    avatarId: member.avatarId,
    role: member.role,
    membership: member.membership,
    connection: member.connection,
    activity: member.activity,
    state: gouziPrimaryState(member),
    createdAt: member.createdAt,
  }
}

function canManage(authority: RemoteRequestAuthority): boolean {
  return authority.scope === 'admin' || authority.scope === 'cockpit'
}

async function dashboard(ctx: Context, control: GouziControl, authority: RemoteRequestAuthority): Promise<GouziDashboardV1> {
  const { members } = await control.list()
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    limit: GOUZI_MEMBER_LIMIT,
    used: members.filter(member => countsTowardGouziLimit(member.membership)).length,
    canManage: canManage(authority),
    hostAvailable: ctx.get('gouziHost') !== undefined,
    members: members.filter(member => member.membership !== 'archived').map(project),
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

async function adopt(ctx: Context, control: GouziControl, request: Extract<GouziControlRequest, { action: 'adopt' }>, grantDeadlineMs: number) {
  const host = ctx.get('gouziHost')
  if (host === undefined) throw new GouziRefusal('GOUZI_HOST_UNAVAILABLE', '这台机器上还不能启动狗子')
  // Resolve every project before anything is created, so a bad path leaves no half-made member behind.
  const resolved = await Promise.all(request.projects.map(path => host.resolveRepository(path)))
  const repositories = [...new Map(resolved.map(value => [value.repository, value])).values()]
  const listing = await control.list()
  const pilot = listing.hosts.find(value => String(value.hostId) === PILOT_HOST_ID)
    ?? await control.pairHost({
      hostId: GouziHostId(PILOT_HOST_ID),
      label: PILOT_HOST_LABEL,
      authorityEpoch: GouziAuthorityEpoch(randomUUID()),
      credentialRef: PILOT_HOST_CREDENTIAL_REF,
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
      repositories,
    })
    const process = await host.start(String(gouziId))
    await control.setEndpoint(gouziId, process.endpoint)
    return project(await control.setMembership(gouziId, 'enabled'))
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
  const process = await host.start(gouziId)
  await control.setEndpoint(member.gouziId, process.endpoint)
  return project(member.membership === 'provisioning' ? await control.setMembership(member.gouziId, 'enabled') : await requireMember(control, gouziId))
}

async function rest(ctx: Context, control: GouziControl, gouziId: string) {
  const host = ctx.get('gouziHost')
  if (host === undefined) throw new GouziRefusal('GOUZI_HOST_UNAVAILABLE', '这台机器上还不能启动狗子')
  const member = await requireMember(control, gouziId)
  if (member.activity === 'working') throw new GouziRefusal('GOUZI_STATE_CONFLICT', `${member.name} 正在工作，等它做完再让它休息`)
  await host.stop(gouziId)
  return project(await requireMember(control, gouziId))
}

async function retire(ctx: Context, control: GouziControl, gouziId: string) {
  const host = ctx.get('gouziHost')
  if (host === undefined) throw new GouziRefusal('GOUZI_HOST_UNAVAILABLE', '这台机器上还不能启动狗子')
  const member = await requireMember(control, gouziId)
  if (member.activity === 'working') throw new GouziRefusal('GOUZI_STATE_CONFLICT', `${member.name} 正在工作，等它做完再让它退役`)
  if (member.membership === 'archived') throw new GouziRefusal('GOUZI_STATE_CONFLICT', `${member.name} 已经退役`)
  if (member.membership !== 'retiring') await control.setMembership(member.gouziId, 'retiring')
  const stopped = await host.stop(gouziId, { reclaimResident: true })
  if (!stopped.processTreeStopped) {
    throw new GouziRefusal('GOUZI_STATE_CONFLICT', `${member.name} 的进程还没有完全停下，暂时保留名额`)
  }
  // A loopback member never held a device credential, so there is nothing left to revoke.
  return project(await control.archive(member.gouziId, { credentialsRevoked: true, workSettled: true, processTreeStopped: true }))
}

async function execute(ctx: Context, control: GouziControl, request: GouziControlRequest, grantDeadlineMs: number) {
  switch (request.action) {
    case 'adopt': return adopt(ctx, control, request, grantDeadlineMs)
    case 'edit':
      return project(await control.edit(GouziId(request.gouziId), {
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
  const grantDeadlineMs = config.grantDeadlineMs ?? 2 * 60 * 60_000
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
    if (request.method === 'GET') return { status: 200, body: await dashboard(ctx, control, authority) }
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
