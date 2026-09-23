/** Local-owner configuration of standalone and MCP-enabled ChatGPT execution. */

import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import { authorizeRemoteRequest } from '@deepseek-ai/dsh-host-remote-auth'
import { PhysicalOperatorError } from '@deepseek-ai/dsh-physical-operator'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WebCoordinationMode } from './coordinator-settings.ts'
import type { WebModelCatalog, WebModelPreferences } from './model-catalog.ts'

/** Same-origin local setup route; never the externally connected MCP endpoint. */
export const CHATGPT_WEB_SETUP_PATH = '/api/chatgpt-web'

/** Public status contains no MCP path credential unless setup was explicitly requested. */
export interface WebCoordinatorStatus {
  readonly mode: WebCoordinationMode
  readonly active: boolean
  readonly connectorName: string
  readonly lastVerifiedAt?: string
  readonly catalog?: WebModelCatalog
}

/** Runtime operations owned by the ChatGPT Provider rather than the HTTP carrier. */
export interface WebCoordinatorSetup {
  status(): WebCoordinatorStatus
  endpoint(): Promise<string>
  select(mode: WebCoordinationMode): Promise<void>
  refreshCatalog?(sessionId?: string): Promise<WebModelCatalog>
  preferences?(sessionId: string): WebModelPreferences
  selectPreferences?(sessionId: string, profile: WebModelPreferences): Promise<WebModelCatalog | undefined>
}

/**
 * Register setup for loopback owners; paired remote clients cannot read the connector secret.
 * @param ctx - Host with optional Remote Auth and installed Web Server.
 * @param setup - Provider-owned configuration operations.
 * @returns disposer for the exact route.
 */
export function registerWebCoordinatorSetup(ctx: Context, setup: WebCoordinatorSetup): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: CHATGPT_WEB_SETUP_PATH,
    handler: async (request, response) => {
      const authority = authorizeRemoteRequest(request, ctx.get('remoteAuth'))
      if (authority?.local !== true) { send(response, 403, { error: 'LOCAL_OWNER_REQUIRED' }); return }
      const url = new URL(request.url ?? CHATGPT_WEB_SETUP_PATH, 'http://127.0.0.1')
      const sessionId = url.searchParams.get('session_id')
      const status = () => ({ ...setup.status(),
        ...sessionId === null || setup.preferences === undefined ? {} : { profile: setup.preferences(sessionId) },
      })
      if (request.method === 'GET') {
        if (url.searchParams.get('catalog') === '1') {
          if (setup.refreshCatalog === undefined) { send(response, 501, { error: 'WEB_CATALOG_UNAVAILABLE' }); return }
          if (setup.status().active) { send(response, 409, { error: 'CHATGPT_WEB_BUSY' }); return }
          try { send(response, 200, { ...status(), catalog: await setup.refreshCatalog(sessionId ?? undefined) }) }
          catch (error) { sendBusyOrFailure(response, error, 'WEB_CATALOG_REFRESH_FAILED') }
          return
        }
        if (url.searchParams.get('setup') !== '1') { send(response, 200, status()); return }
        try { send(response, 200, { ...status(), mcpUrl: await setup.endpoint() }) }
        catch { send(response, 503, { error: 'CHATGPT_WEB_CONNECTOR_START_FAILED' }) }
        return
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST')
        send(response, 405, { error: 'METHOD_NOT_ALLOWED' })
        return
      }
      if (url.searchParams.get('action') === 'profile') {
        if (setup.selectPreferences === undefined) { send(response, 501, { error: 'WEB_PROFILE_UNAVAILABLE' }); return }
        if (sessionId === null || sessionId.length === 0 || sessionId.length > 256) { send(response, 400, { error: 'SESSION_ID_REQUIRED' }); return }
        if (setup.status().active) { send(response, 409, { error: 'CHATGPT_WEB_BUSY' }); return }
        const model = url.searchParams.get('model') ?? undefined
        const effort = url.searchParams.get('effort') ?? undefined
        if ([model, effort].some(value => value !== undefined && (value.length === 0 || value.length > 256 || value.trim() !== value))) {
          send(response, 400, { error: 'INVALID_WEB_PROFILE' }); return
        }
        try {
          await setup.selectPreferences(sessionId, { ...model === undefined ? {} : { model }, ...effort === undefined ? {} : { effort } })
          send(response, 200, status())
        } catch (error) { sendBusyOrFailure(response, error, 'WEB_PROFILE_SELECTION_FAILED') }
        return
      }
      const mode = url.searchParams.get('mode')
      if (mode !== 'direct' && mode !== 'coordinator') { send(response, 400, { error: 'INVALID_WEB_MODE' }); return }
      if (setup.status().active) { send(response, 409, { error: 'CHATGPT_WEB_BUSY' }); return }
      try {
        await setup.select(mode)
        send(response, 200, status())
      } catch { send(response, 503, { error: 'CHATGPT_WEB_MODE_CHANGE_FAILED' }) }
    },
  })
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

function sendBusyOrFailure(response: ServerResponse, error: unknown, failure: string): void {
  if (error instanceof PhysicalOperatorError && error.code === 'OPERATOR_BUSY') {
    send(response, 409, { error: 'CHATGPT_WEB_BUSY' })
    return
  }
  send(response, 503, { error: failure })
}
