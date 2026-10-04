/** Browser calls to the Gouzi Host route. */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  GOUZI_CONTROL_HEADER,
  GOUZI_DASHBOARD_PATH,
  type GouziControlRequest,
  type GouziDashboardV1,
  type GouziErrorV1,
  type GouziMemberProjection,
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
