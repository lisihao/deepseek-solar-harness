import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { PhysicalOperatorError } from '@deepseek-ai/dsh-physical-operator'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebCoordinationMode } from '../src/coordinator-settings.ts'
import type { WebModelCatalog, WebModelPreferences } from '../src/model-catalog.ts'
import {
  CHATGPT_WEB_SETUP_PATH,
  registerWebCoordinatorSetup,
  type WebCoordinatorSetup,
  type WebCoordinatorStatus,
} from '../src/setup.ts'

interface RunningServer {
  readonly disposeRoute: () => void
  readonly fiber: { dispose(): Promise<void> }
  readonly port: number
}

interface SetupFixture {
  endpoint: ReturnType<typeof vi.fn<() => Promise<string>>>
  select: ReturnType<typeof vi.fn<(mode: WebCoordinationMode) => Promise<void>>>
  refreshCatalog: ReturnType<typeof vi.fn<(sessionId?: string) => Promise<WebModelCatalog>>>
  preferences: ReturnType<typeof vi.fn<(sessionId: string) => WebModelPreferences>>
  selectPreferences: ReturnType<typeof vi.fn<(sessionId: string, profile: WebModelPreferences) => Promise<WebModelCatalog | undefined>>>
  setup: WebCoordinatorSetup
  status: WebCoordinatorStatus
  catalog: WebModelCatalog
  profile: WebModelPreferences
}

let running: RunningServer | undefined

afterEach(async () => {
  const current = running
  running = undefined
  current?.disposeRoute()
  await current?.fiber.dispose()
})

function fixture(overrides: Partial<WebCoordinatorStatus> = {}): SetupFixture {
  const value: SetupFixture = {} as SetupFixture
  value.status = {
    mode: 'direct',
    active: false,
    connectorName: 'ChatGPT Web',
    ...overrides,
  }
  value.endpoint = vi.fn<() => Promise<string>>(async () => 'http://127.0.0.1/mcp/dsh/secret-token')
  value.select = vi.fn<(mode: WebCoordinationMode) => Promise<void>>(async (mode) => {
    value.status = { ...value.status, mode }
  })
  value.profile = { model: 'gpt-5', effort: 'high' }
  value.catalog = {
    models: [{ id: 'gpt-5', label: 'GPT-5' }],
    efforts: [{ id: 'high', label: 'High' }],
    selectedModel: 'gpt-5',
    selectedEffort: 'high',
    observedAt: '2026-09-23T00:00:00.000Z',
  }
  value.refreshCatalog = vi.fn<(sessionId?: string) => Promise<WebModelCatalog>>(async () => value.catalog)
  value.preferences = vi.fn<(sessionId: string) => WebModelPreferences>(() => ({ ...value.profile }))
  value.selectPreferences = vi.fn<
    (sessionId: string, profile: WebModelPreferences) => Promise<WebModelCatalog | undefined>
  >(async (_sessionId, next) => {
    value.profile = { ...next }
    return await value.refreshCatalog(_sessionId)
  })
  value.setup = {
    status: () => value.status,
    endpoint: value.endpoint,
    select: value.select,
    refreshCatalog: value.refreshCatalog,
    preferences: value.preferences,
    selectPreferences: value.selectPreferences,
  }
  return value
}

async function start(setup: WebCoordinatorSetup): Promise<number> {
  const ctx = new Context()
  const fiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await fiber.await()
  const disposeRoute = registerWebCoordinatorSetup(ctx, setup)
  running = { disposeRoute, fiber, port: ctx.webServer.port }
  return ctx.webServer.port
}

async function request(
  port: number,
  path = CHATGPT_WEB_SETUP_PATH,
  init?: RequestInit,
): Promise<{ readonly body: unknown; readonly headers: Headers; readonly status: number; readonly text: string }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  const text = await response.text()
  let body: unknown = text
  try { body = JSON.parse(text) as unknown } catch { /* the route always returns JSON; preserve a useful failure body */ }
  return { body, headers: response.headers, status: response.status, text }
}

async function requestWithHeaders(
  port: number,
  headers: Record<string, string>,
): Promise<{ readonly body: unknown; readonly headers: Headers; readonly status: number; readonly text: string }> {
  return await new Promise((resolve, reject) => {
    const client = httpRequest({ host: '127.0.0.1', port, path: CHATGPT_WEB_SETUP_PATH, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => { chunks.push(Buffer.from(chunk as Uint8Array)) })
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = text
        try { body = JSON.parse(text) as unknown } catch { /* preserve an unexpected non-JSON body */ }
        resolve({ body, headers: new Headers(response.headers as Record<string, string>), status: response.statusCode ?? 0, text })
      })
    })
    client.on('error', reject)
    client.end()
  })
}

describe('ChatGPT Web setup route', () => {
  it('returns public status without invoking endpoint setup or exposing its secret', async () => {
    const value = fixture()
    const port = await start(value.setup)

    const response = await request(port)

    expect(response.status).toBe(200)
    expect(response.body).toEqual(value.status)
    expect(value.endpoint).not.toHaveBeenCalled()
    expect(response.text).not.toContain('secret-token')
  })

  it('returns the connector endpoint only for an explicit setup request', async () => {
    const value = fixture()
    const port = await start(value.setup)

    const response = await request(port, `${CHATGPT_WEB_SETUP_PATH}?setup=1`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ...value.status, mcpUrl: 'http://127.0.0.1/mcp/dsh/secret-token' })
    expect(value.endpoint).toHaveBeenCalledTimes(1)
  })

  it('forwards a session to profile and catalog reads without exposing the connector endpoint', async () => {
    const value = fixture()
    const port = await start(value.setup)

    const profile = await request(port, `${CHATGPT_WEB_SETUP_PATH}?session_id=session-42`)
    expect(profile.status).toBe(200)
    expect(profile.body).toEqual({ ...value.status, profile: value.profile })
    expect(value.preferences).toHaveBeenCalledWith('session-42')

    const catalog = await request(
      port,
      `${CHATGPT_WEB_SETUP_PATH}?catalog=1&setup=1&session_id=session-42`,
    )
    expect(catalog.status).toBe(200)
    expect(catalog.body).toEqual({
      ...value.status,
      profile: value.profile,
      catalog: value.catalog,
    })
    expect(value.refreshCatalog).toHaveBeenCalledWith('session-42')
    expect(value.endpoint).not.toHaveBeenCalled()
    expect(catalog.body).not.toHaveProperty('mcpUrl')
    expect(catalog.text).not.toContain('secret-token')
  })

  it('saves a session-scoped profile selection and returns the saved profile', async () => {
    const value = fixture()
    const port = await start(value.setup)

    const response = await request(
      port,
      `${CHATGPT_WEB_SETUP_PATH}?action=profile&session_id=session-42&model=gpt-5-mini&effort=low`,
      { method: 'POST' },
    )

    expect(response.status).toBe(200)
    expect(value.selectPreferences).toHaveBeenCalledWith(
      'session-42',
      { model: 'gpt-5-mini', effort: 'low' },
    )
    expect(value.profile).toEqual({ model: 'gpt-5-mini', effort: 'low' })
    expect(response.body).toEqual({ ...value.status, profile: value.profile })
  })

  it('preserves the saved profile when profile selection fails', async () => {
    const value = fixture()
    const previous = { ...value.profile }
    value.selectPreferences.mockRejectedValue(new Error('profile-secret-token'))
    const port = await start(value.setup)

    const response = await request(
      port,
      `${CHATGPT_WEB_SETUP_PATH}?action=profile&session_id=session-42&model=gpt-5-mini`,
      { method: 'POST' },
    )

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: 'WEB_PROFILE_SELECTION_FAILED' })
    expect(value.profile).toEqual(previous)
    expect(response.text).not.toContain('profile-secret-token')
  })

  it('rejects catalog and profile refresh while busy without invoking callbacks', async () => {
    const value = fixture({ active: true })
    const port = await start(value.setup)

    const catalog = await request(port, `${CHATGPT_WEB_SETUP_PATH}?catalog=1&session_id=session-42`)
    expect(catalog.status).toBe(409)
    expect(catalog.body).toEqual({ error: 'CHATGPT_WEB_BUSY' })
    expect(value.refreshCatalog).not.toHaveBeenCalled()

    const profile = await request(
      port,
      `${CHATGPT_WEB_SETUP_PATH}?action=profile&session_id=session-42&model=gpt-5-mini`,
      { method: 'POST' },
    )
    expect(profile.status).toBe(409)
    expect(profile.body).toEqual({ error: 'CHATGPT_WEB_BUSY' })
    expect(value.selectPreferences).not.toHaveBeenCalled()
  })

  it('maps concurrent callback busy failures to HTTP 409 while keeping other failures at 503', async () => {
    const value = fixture()
    const busy = new PhysicalOperatorError('catalog operation already running', 'OPERATOR_BUSY')
    value.refreshCatalog.mockRejectedValue(busy)
    value.selectPreferences.mockRejectedValue(busy)
    const port = await start(value.setup)

    const catalog = await request(port, `${CHATGPT_WEB_SETUP_PATH}?catalog=1&session_id=session-42`)
    expect(catalog.status).toBe(409)
    expect(catalog.body).toEqual({ error: 'CHATGPT_WEB_BUSY' })

    const profile = await request(
      port,
      `${CHATGPT_WEB_SETUP_PATH}?action=profile&session_id=session-42&model=gpt-5-mini`,
      { method: 'POST' },
    )
    expect(profile.status).toBe(409)
    expect(profile.body).toEqual({ error: 'CHATGPT_WEB_BUSY' })
  })

  it('rejects malformed profile requests before invoking the selector', async () => {
    const value = fixture()
    const port = await start(value.setup)

    const missingSession = await request(
      port,
      `${CHATGPT_WEB_SETUP_PATH}?action=profile&model=gpt-5-mini`,
      { method: 'POST' },
    )
    expect(missingSession.status).toBe(400)
    expect(missingSession.body).toEqual({ error: 'SESSION_ID_REQUIRED' })

    const invalidProfile = await request(
      port,
      `${CHATGPT_WEB_SETUP_PATH}?action=profile&session_id=session-42&model=%20gpt-5-mini`,
      { method: 'POST' },
    )
    expect(invalidProfile.status).toBe(400)
    expect(invalidProfile.body).toEqual({ error: 'INVALID_WEB_PROFILE' })
    expect(value.selectPreferences).not.toHaveBeenCalled()
  })

  it('reports unavailable catalog and profile capabilities as 501', async () => {
    const value = fixture()
    const setup: WebCoordinatorSetup = { ...value.setup }
    delete setup.refreshCatalog
    delete setup.selectPreferences
    const port = await start(setup)

    const catalog = await request(port, `${CHATGPT_WEB_SETUP_PATH}?catalog=1`)
    expect(catalog.status).toBe(501)
    expect(catalog.body).toEqual({ error: 'WEB_CATALOG_UNAVAILABLE' })

    const profile = await request(
      port,
      `${CHATGPT_WEB_SETUP_PATH}?action=profile&session_id=session-42&model=gpt-5-mini`,
      { method: 'POST' },
    )
    expect(profile.status).toBe(501)
    expect(profile.body).toEqual({ error: 'WEB_PROFILE_UNAVAILABLE' })
  })

  it('contains catalog and profile refresh failures without returning secrets', async () => {
    const value = fixture()
    value.refreshCatalog.mockRejectedValue(new Error('catalog-secret-token'))
    value.selectPreferences.mockRejectedValue(new Error('profile-secret-token'))
    const port = await start(value.setup)

    const catalog = await request(port, `${CHATGPT_WEB_SETUP_PATH}?catalog=1&session_id=session-42`)
    expect(catalog.status).toBe(503)
    expect(catalog.body).toEqual({ error: 'WEB_CATALOG_REFRESH_FAILED' })
    expect(catalog.text).not.toContain('catalog-secret-token')

    const profile = await request(
      port,
      `${CHATGPT_WEB_SETUP_PATH}?action=profile&session_id=session-42&model=gpt-5-mini`,
      { method: 'POST' },
    )
    expect(profile.status).toBe(503)
    expect(profile.body).toEqual({ error: 'WEB_PROFILE_SELECTION_FAILED' })
    expect(profile.text).not.toContain('profile-secret-token')
  })

  it('validates POST mode, persists a local selection, and rejects a busy provider', async () => {
    const value = fixture()
    const port = await start(value.setup)

    const invalid = await request(port, `${CHATGPT_WEB_SETUP_PATH}?mode=unknown`, { method: 'POST' })
    expect(invalid.status).toBe(400)
    expect(value.select).not.toHaveBeenCalled()

    const selected = await request(port, `${CHATGPT_WEB_SETUP_PATH}?mode=coordinator`, { method: 'POST' })
    expect(selected.status).toBe(200)
    expect(selected.body).toEqual({ ...value.status, mode: 'coordinator' })
    expect(value.select).toHaveBeenCalledWith('coordinator')

    value.status = { ...value.status, active: true }
    const busy = await request(port, `${CHATGPT_WEB_SETUP_PATH}?mode=direct`, { method: 'POST' })
    expect(busy.status).toBe(409)
    expect(busy.body).toEqual({ error: 'CHATGPT_WEB_BUSY' })
    expect(value.select).toHaveBeenCalledTimes(1)
  })

  it('requires loopback host and origin authorization', async () => {
    const value = fixture()
    const port = await start(value.setup)
    const localHost = `127.0.0.1:${String(port)}`

    const badHost = await requestWithHeaders(port, { host: 'remote.example' })
    expect(badHost.status).toBe(403)
    expect(badHost.body).toEqual({ error: 'LOCAL_OWNER_REQUIRED' })

    const badOrigin = await request(port, undefined, {
      headers: { host: localHost, origin: 'https://remote.example' },
    })
    expect(badOrigin.status).toBe(403)
    expect(badOrigin.body).toEqual({ error: 'LOCAL_OWNER_REQUIRED' })
  })

  it('rejects unsupported methods with the route Allow header', async () => {
    const value = fixture()
    const port = await start(value.setup)

    const response = await request(port, undefined, { method: 'PUT' })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, POST')
  })

  it('contains endpoint and mode-selection failures without returning secrets', async () => {
    const endpoint = vi.fn(async (): Promise<string> => {
      throw new Error('secret-endpoint-token')
    })
    const select = vi.fn(async (): Promise<void> => {
      throw new Error('secret-mode-token')
    })
    const value = fixture()
    value.endpoint.mockImplementation(endpoint)
    value.select.mockImplementation(select)
    const port = await start(value.setup)

    const endpointFailure = await request(port, `${CHATGPT_WEB_SETUP_PATH}?setup=1`)
    expect(endpointFailure.status).toBe(503)
    expect(endpointFailure.body).toEqual({ error: 'CHATGPT_WEB_CONNECTOR_START_FAILED' })
    expect(endpointFailure.text).not.toContain('secret-endpoint-token')

    const selectFailure = await request(port, `${CHATGPT_WEB_SETUP_PATH}?mode=coordinator`, { method: 'POST' })
    expect(selectFailure.status).toBe(503)
    expect(selectFailure.body).toEqual({ error: 'CHATGPT_WEB_MODE_CHANGE_FAILED' })
    expect(selectFailure.text).not.toContain('secret-mode-token')
  })

  it('removes the exact route when its disposer runs', async () => {
    const value = fixture()
    const port = await start(value.setup)
    const before = await request(port)
    expect(before.status).toBe(200)

    const current = running
    if (current === undefined) throw new Error('setup route did not start')
    current.disposeRoute()
    running = { ...current, disposeRoute: () => {} }

    const after = await request(port)
    expect(after.status).toBe(404)
  })
})
