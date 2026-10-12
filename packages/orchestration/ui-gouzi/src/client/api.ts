/** Browser calls to the Gouzi Host route. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  GOUZI_CONTROL_HEADER,
  GOUZI_DASHBOARD_PATH,
  type GouziControlRequest,
  type GouziDashboardV1,
  type GouziErrorV1,
  type GouziMemberProjection,
  type GouziProjectsCheck,
} from '../contracts.ts'

/** The authenticated fetch the connection publishes. */
export type BrowserRequest = ConnectionHandle['request']

/** A refused or failed request, with the Host's own explanation. */
export class GouziRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'GouziRequestError'
  }
}

async function failure(response: Response): Promise<GouziRequestError> {
  const detail = await response.json().catch(() => undefined) as Partial<GouziErrorV1> | undefined
  return new GouziRequestError(
    detail?.error ?? 'GOUZI_FAILED',
    detail?.message ?? `狗子请求失败 (${String(response.status)})`,
    response.status,
  )
}

/**
 * Read the member projection.
 * @param request - authenticated fetch.
 * @param signal - optional cancellation signal.
 * @returns the dashboard.
 */
export async function loadGouzi(request: BrowserRequest, signal?: AbortSignal): Promise<GouziDashboardV1> {
  const response = await request(new URL(GOUZI_DASHBOARD_PATH, window.location.origin), {
    cache: 'no-store',
    ...signal === undefined ? {} : { signal },
  })
  if (!response.ok) throw await failure(response)
  return await response.json() as GouziDashboardV1
}

/**
 * Send one control.
 * @param request - authenticated fetch.
 * @param control - the action and its fields.
 * @returns the Host's reply body, whose type the caller knows from the action.
 */
export async function callGouzi<Reply>(request: BrowserRequest, control: GouziControlRequest): Promise<Reply> {
  const response = await request(GOUZI_DASHBOARD_PATH, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', [GOUZI_CONTROL_HEADER]: '1' },
    body: JSON.stringify(control),
  })
  if (!response.ok) throw await failure(response)
  return await response.json() as Reply
}

/**
 * Send a control that answers with a member.
 * @param request - authenticated fetch.
 * @param control - the action and its fields.
 * @returns the member after the action.
 */
export function controlGouzi(request: BrowserRequest, control: GouziControlRequest): Promise<GouziMemberProjection> {
  return callGouzi<GouziMemberProjection>(request, control)
}

/**
 * Check local repository paths without changing member state.
 * @param request - authenticated fetch.
 * @param projects - nonempty absolute paths to check.
 * @returns one validated usability result per requested path, in request order.
 * @throws GouziRequestError - when the Host refuses or the reply does not match the requested paths.
 */
export async function checkGouziProjects(request: BrowserRequest, projects: readonly string[]): Promise<GouziProjectsCheck> {
  const reply = await callGouzi<unknown>(request, { action: 'check-projects', hostId: 'local', projects })
  const values = reply !== null && typeof reply === 'object' && 'projects' in reply ? reply.projects : undefined
  if (!Array.isArray(values) || values.length !== projects.length) {
    throw new GouziRequestError('GOUZI_INVALID_REPLY', '项目检查返回了无效结果，请重试。', 502)
  }
  return { projects: values.map((value: unknown, index) => {
    if (value !== null && typeof value === 'object' && 'path' in value && value.path === projects[index] && 'usable' in value) {
      if (value.usable === true) return { path: value.path as string, usable: true }
      if (value.usable === false && 'message' in value && typeof value.message === 'string' && value.message.length > 0) {
        return { path: value.path as string, usable: false, message: value.message }
      }
    }
    throw new GouziRequestError('GOUZI_INVALID_REPLY', '项目检查返回了无效结果，请重试。', 502)
  }) }
}
